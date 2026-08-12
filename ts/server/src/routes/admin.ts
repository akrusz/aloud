/**
 * Admin operator endpoints. Gated by ALOUD_ADMIN_TOKEN and/or
 * ALOUD_ADMIN_EMAILS: when both are unset every route here is DISABLED (404),
 * never open. Two ways in: the static operator token (scripts, curl), or a
 * signed-in session whose verified account email is on the admin list, which is
 * how the operator reaches the panel from a phone without carrying the token
 * (the device only ever holds a 7-day session JWT).
 *
 *   GET  /cloud/v1/admin              control panel HTML (panel.ts)
 *   GET  /cloud/v1/admin/metrics      ledger aggregates + abuse velocity signals
 *   GET  /cloud/v1/admin/accounts     every account with derived balance/spend
 *   GET  /cloud/v1/admin/accounts/:id one account + its full ledger (audit)
 *   POST /cloud/v1/admin/grant        { email, credits } → ledger.grant()
 *
 * The panel page is served unauthenticated (you can't set an auth header by
 * navigating to a URL) but still only when a credential is configured; it
 * carries no data and every action it triggers hits a gated endpoint below.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { Deps } from '../deps.js';
import type { LedgerEntry } from '../credits/store.js';
import { buildMetrics, buildDailyRevenue } from '../admin/metrics.js';
import { buildUsageReport, buildUsageHistory, buildProviderDailyCosts } from '../credits/usage.js';
import { deleteAccount } from '../auth/identity.js';
import { PACK_MARKUP } from '../pricing/meter.js';
import { renderAdminPanel } from '../admin/panel.js';
import { verifySessionToken } from '../auth/session.js';
import { effectiveConfig, applyRuntimeConfig, type ConfigPatch } from '../admin/runtime-config.js';
import type { UsageEvent } from '../credits/usage.js';

function tokenOk(provided: string | undefined, expected: string): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Admin surface is on iff at least one way in is configured. */
function adminEnabled(deps: Deps): boolean {
    return Boolean(deps.config.adminToken) || deps.config.adminEmails.length > 0;
}

/** Returns null when the request is authorized, else the Response to send: 404
 *  when the feature is off (so the endpoints aren't advertised), 401 when the
 *  credential is wrong/missing.
 *
 *  The bearer is either the static admin token or a session JWT for an
 *  allowlisted account. emailVerified is required on the session path: an
 *  email/password signup squatting on an admin address must not pass. */
async function authFailure(c: Context, deps: Deps): Promise<Response | null> {
    if (!adminEnabled(deps)) return c.notFound();
    const header = c.req.header('authorization') ?? '';
    const provided = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : undefined;
    const expected = deps.config.adminToken;
    if (expected && tokenOk(provided, expected)) return null;
    if (provided && deps.config.adminEmails.length > 0) {
        const claims = await verifySessionToken(provided, deps.config.sessionSecret);
        const account = claims ? await deps.store.getAccountById(claims.accountId) : undefined;
        if (
            account &&
            account.deletedAt == null &&
            account.emailVerified &&
            deps.config.adminEmails.includes(account.email.toLowerCase())
        ) {
            return null;
        }
    }
    return c.json(apiError('unauthenticated', 'admin access required'), ERROR_STATUS.unauthenticated);
}

/** Account ids on the ALOUD_ADMIN_EMAILS allowlist, for the excludeAdmin
 *  filter below. Same comparison as the session auth gate (lowercased stored
 *  email vs the lowercased list); empty when only the static token is
 *  configured, in which case the filter is a no-op. */
async function adminAccountIds(deps: Deps): Promise<Set<string>> {
    if (deps.config.adminEmails.length === 0) return new Set();
    const accounts = await deps.store.allAccounts();
    return new Set(
        accounts
            .filter((a) => deps.config.adminEmails.includes(a.email.toLowerCase()))
            .map((a) => a.id)
    );
}

/** Usage events for the report endpoints, minus admin-account rows when the
 *  request carries ?excludeAdmin=1 (the panel's "omit admin" toggle), so the
 *  operator's own testing doesn't pollute the real-user picture. */
async function usageEvents(c: Context, deps: Deps): Promise<UsageEvent[]> {
    const events = await deps.store.allUsage();
    if (c.req.query('excludeAdmin') !== '1') return events;
    const admin = await adminAccountIds(deps);
    return admin.size ? events.filter((e) => !admin.has(e.accountId)) : events;
}

/** Net balance per account id, summing the append-only ledger once. */
function balancesByAccount(entries: LedgerEntry[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.accountId, (m.get(e.accountId) ?? 0) + e.amount);
    return m;
}

export function adminRoutes(deps: Deps): Hono {
    const app = new Hono();

    // The control panel. Served only when admin access is configured, else 404,
    // so the page isn't discoverable on a server with admin disabled. No auth on
    // the HTML itself: the operator pastes the token or signs in on the page.
    // The Google button needs the web OAuth client id, by convention the FIRST
    // entry of GOOGLE_CLIENT_IDS (see .env.example).
    app.get('/', (c) => {
        if (!adminEnabled(deps)) return c.notFound();
        const googleClientId = deps.config.adminEmails.length > 0 ? deps.config.googleClientIds[0] : undefined;
        return c.html(renderAdminPanel(googleClientId));
    });

    app.get('/metrics', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const sinceHours = Number(c.req.query('sinceHours') ?? 24);
        const now = Date.now() / 1000;
        const windowSinceTs = now - Math.max(0, sinceHours) * 3600;

        const [accounts, entries] = await Promise.all([
            deps.store.allAccounts(),
            deps.store.allEntries(),
        ]);
        return c.json(buildMetrics(accounts, entries, now, windowSinceTs));
    });

    // Cost attribution (meditation-pal-rvy): per-service split, cache-hit ratio,
    // per-model cost, and reconstructed per-session economics the ledger can't
    // show. The dataset for calibrating USD_PER_CREDIT and pack sizing against
    // what real sessions cost.
    app.get('/usage', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const sinceHours = Number(c.req.query('sinceHours') ?? 24);
        // Sessions with fewer LLM turns than this drop out of the per-session
        // distributions; drive-by sessions skew the medians.
        const minSessionTurns = Math.max(0, Number(c.req.query('minTurns') ?? 0) || 0);
        // What counts as a real sit for the per-hour block, so the calibration
        // numbers can be read off actual practice instead of trial runs.
        // Absent → DEFAULT_REAL_SIT; a 0 disables that criterion outright.
        const realSit = {
            ...(c.req.query('sitMinutes') != null
                ? { minMinutes: Math.max(0, Number(c.req.query('sitMinutes')) || 0) }
                : {}),
            ...(c.req.query('sitTurns') != null
                ? { minTurns: Math.max(0, Number(c.req.query('sitTurns')) || 0) }
                : {}),
        };
        const now = Date.now() / 1000;
        const windowSinceTs = now - Math.max(0, sinceHours) * 3600;

        const events = await usageEvents(c, deps);
        return c.json(buildUsageReport(events, now, windowSinceTs, { minSessionTurns, realSit }));
    });

    // Daily usage history for the trend charts: sessions, turns, spend, duration
    // per day over the last `days` days, plus gross revenue per day from the
    // ledger's purchase entries (the revenue-vs-cost margin trend). Computed
    // live from retained usage_events (no rollup table at this scale), so it's
    // real history bounded only by how far back the telemetry goes.
    app.get('/usage/history', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30)));
        const now = Date.now() / 1000;
        const excludeAdmin = c.req.query('excludeAdmin') === '1';
        const admin = excludeAdmin ? await adminAccountIds(deps) : new Set<string>();
        let [events, entries] = await Promise.all([deps.store.allUsage(), deps.store.allEntries()]);
        if (admin.size) {
            // The omit-admin toggle drops the operator's purchases too, so the
            // revenue line matches the filtered cost bars.
            events = events.filter((e) => !admin.has(e.accountId));
            entries = entries.filter((e) => !admin.has(e.accountId));
        }
        const revenue = buildDailyRevenue(entries, now, days);
        const buckets = buildUsageHistory(events, now, days).map((b) => ({
            ...b,
            revenueUsd: revenue.get(b.dayStartTs) ?? 0,
        }));
        return c.json({ generatedAt: now, days, buckets });
    });

    // Per-provider, per-UTC-day computed spend: our side of reconciling against
    // the provider cost reports (scripts/reconcile-cloud-spend.mjs,
    // meditation-pal-xejm). Buckets by event time, not session start, so rows
    // line up with the providers' own daily billing buckets. No excludeAdmin
    // here on purpose: the provider bills admin usage too, so filtering it
    // would break the reconciliation.
    app.get('/usage/provider-daily', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const days = Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30)));
        const now = Date.now() / 1000;
        const events = await deps.store.allUsage();
        return c.json({ generatedAt: now, days, rows: buildProviderDailyCosts(events, now, days) });
    });

    // Every account with derived balance, lifetime granted/spent, and whether it
    // has ever purchased, so the operator can find an email to grant to and
    // eyeball free-vs-paid at a glance.
    app.get('/accounts', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const [accounts, entries, usage] = await Promise.all([
            deps.store.allAccounts(),
            deps.store.allEntries(),
            deps.store.allUsage(),
        ]);
        const balances = balancesByAccount(entries);
        // Last metered call per account: "is this person actually using it" at
        // a glance, without opening the ledger.
        const lastActive = new Map<string, number>();
        for (const u of usage) {
            if ((lastActive.get(u.accountId) ?? 0) < u.ts) lastActive.set(u.accountId, u.ts);
        }
        const granted = new Map<string, number>();
        const debited = new Map<string, number>();
        const purchased = new Set<string>();
        for (const e of entries) {
            if (e.kind === 'signup_grant') granted.set(e.accountId, (granted.get(e.accountId) ?? 0) + e.amount);
            else if (e.kind === 'purchase') purchased.add(e.accountId);
            else if (e.kind === 'debit') debited.set(e.accountId, (debited.get(e.accountId) ?? 0) - e.amount);
        }
        // Sign-in methods per account (google/apple/email): how someone signed
        // up, and a would-be duplicate at a glance.
        const providersByAccount = new Map<string, string[]>();
        await Promise.all(
            accounts.map(async (a) => {
                const ids = await deps.store.getIdentitiesForAccount(a.id);
                providersByAccount.set(a.id, ids.map((i) => i.provider));
            })
        );
        const rows = accounts
            .map((a) => ({
                id: a.id,
                email: a.email,
                createdAt: a.createdAt,
                lastActiveTs: lastActive.get(a.id) ?? null,
                balance: balances.get(a.id) ?? 0,
                granted: granted.get(a.id) ?? 0,
                debited: debited.get(a.id) ?? 0,
                purchased: purchased.has(a.id),
                providers: providersByAccount.get(a.id) ?? [],
                deleted: a.deletedAt != null,
            }))
            .sort((x, y) => y.createdAt - x.createdAt);
        return c.json(rows);
    });

    // One account plus its full ledger: the audit trail behind a balance, which
    // is what a billing question needs.
    app.get('/accounts/:id', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const account = await deps.store.getAccountById(c.req.param('id'));
        if (!account) return c.json(apiError('bad_request', 'no such account'), ERROR_STATUS.bad_request);
        const entries = await deps.store.listEntries(account.id);
        const balance = entries.reduce((s, e) => s + e.amount, 0);
        const identities = await deps.store.getIdentitiesForAccount(account.id);
        return c.json({ account: { ...account, providers: identities.map((i) => i.provider) }, balance, entries });
    });

    // Operator account deletion: the same soft-delete as the user's own "delete
    // my account" (auth/identity.deleteAccount). Zero the balance, free the
    // identities so each login can sign in fresh, anonymize + tombstone the row
    // (its ledger FKs survive). Used to clear a duplicate-mailbox account; once
    // the dup is gone, the canonical_email unique index can build.
    app.post('/accounts/:id/delete', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const account = await deps.store.getAccountById(c.req.param('id'));
        if (!account) return c.json(apiError('bad_request', 'no such account'), ERROR_STATUS.bad_request);
        if (account.deletedAt != null) {
            return c.json(apiError('bad_request', 'account is already deleted'), ERROR_STATUS.bad_request);
        }
        await deleteAccount(deps, account);
        return c.json({ id: account.id, deleted: true });
    });

    // Operator-tunable runtime config (free-credit knobs). GET reads the live
    // effective values; PUT patches them, live and persisted, so the operator can
    // stop handing out free credits without a redeploy.
    app.get('/config', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;
        return c.json(effectiveConfig(deps));
    });

    app.put('/config', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        let body: {
            freeSignupCredits?: unknown;
            freeGrantBudgetPerHour?: unknown;
            meteredPaused?: unknown;
            testerEmails?: unknown;
        };
        try {
            body = (await c.req.json()) as typeof body;
        } catch {
            return c.json(apiError('bad_request', 'invalid JSON body'), ERROR_STATUS.bad_request);
        }

        const patch: ConfigPatch = {};
        for (const key of ['freeSignupCredits', 'freeGrantBudgetPerHour'] as const) {
            if (body[key] === undefined) continue;
            const n = Number(body[key]);
            // Non-negative integers only: these are whole-credit knobs, and a
            // stray float/negative shouldn't silently corrupt the grant budget.
            if (!Number.isInteger(n) || n < 0) {
                return c.json(
                    apiError('bad_request', `${key} must be a non-negative integer`),
                    ERROR_STATUS.bad_request
                );
            }
            patch[key] = n;
        }
        if (body.meteredPaused !== undefined) {
            if (typeof body.meteredPaused !== 'boolean') {
                return c.json(apiError('bad_request', 'meteredPaused must be a boolean'), ERROR_STATUS.bad_request);
            }
            patch.meteredPaused = body.meteredPaused;
        }
        if (body.testerEmails !== undefined) {
            if (!Array.isArray(body.testerEmails) || body.testerEmails.some((e) => typeof e !== 'string')) {
                return c.json(apiError('bad_request', 'testerEmails must be an array of strings'), ERROR_STATUS.bad_request);
            }
            patch.testerEmails = body.testerEmails as string[];
        }

        const updated = await applyRuntimeConfig(deps, patch);
        return c.json(updated);
    });

    // Grant credits to an account by email. Appends a signup_grant entry tagged
    // reason 'admin_grant', so the audit trail says who/why without inventing a
    // new ledger kind.
    app.post('/grant', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        let body: { email?: unknown; credits?: unknown };
        try {
            body = (await c.req.json()) as typeof body;
        } catch {
            return c.json(apiError('bad_request', 'invalid JSON body'), ERROR_STATUS.bad_request);
        }
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const credits = Number(body.credits);
        if (!email) return c.json(apiError('bad_request', 'email is required'), ERROR_STATUS.bad_request);
        if (!Number.isFinite(credits) || credits <= 0) {
            return c.json(apiError('bad_request', 'credits must be a positive number'), ERROR_STATUS.bad_request);
        }

        // Canonicalizing lookup (case, +tag, Gmail dots): the operator pastes
        // whatever spelling the user wrote, which may not match the stored one.
        const account = await deps.store.findLiveAccountByEmail(email);
        if (!account) {
            return c.json(apiError('bad_request', `no account with email ${email}`), ERROR_STATUS.bad_request);
        }

        await deps.ledger.grant(account.id, credits, 'admin_grant');
        const balance = await deps.ledger.balance(account.id);
        return c.json({ account: { id: account.id, email: account.email }, granted: credits, balance });
    });

    // ---- Retreat passes (meditation-pal-414) -------------------------------
    // Time-boxed unlimited access for retreat attendees. The operator creates a
    // pass, then adds attendees by email; a member's metered calls bypass billing
    // while the pass is active and in-window. Admin-only: no attendee-facing UI
    // or shareable code.

    // List passes with their rosters and real provider spend so far (summed from
    // usage telemetry tagged with this pass). The spend column is what tells the
    // operator what a retreat cost.
    app.get('/retreats', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const [passes, accounts, usage] = await Promise.all([
            deps.store.listRetreatPasses(),
            deps.store.allAccounts(),
            deps.store.allUsage(),
        ]);
        const emailById = new Map(accounts.map((a) => [a.id, a.email]));
        // Per-account provider spend (only pass-covered usage carries a passId).
        type Spend = { providerCostUsd: number; credits: number; events: number };
        const zero = (): Spend => ({ providerCostUsd: 0, credits: 0, events: 0 });
        const add = (s: Spend, u: { providerCostUsd: number; credits: number }): void => {
            s.providerCostUsd += u.providerCostUsd;
            s.credits += u.credits;
            s.events += 1;
        };
        // byAccount is keyed by pass + account so each attendee's share can be
        // attributed for per-head billing.
        const byPass = new Map<string, Spend>();
        const byAccount = new Map<string, Spend>();
        for (const u of usage) {
            if (!u.passId) continue;
            const p = byPass.get(u.passId) ?? zero();
            add(p, u);
            byPass.set(u.passId, p);
            const key = `${u.passId} ${u.accountId}`;
            const a = byAccount.get(key) ?? zero();
            add(a, u);
            byAccount.set(key, a);
        }
        // Suggested bill: provider cost x the same markup credits are sold at,
        // so a retreat is priced like everything else.
        const billable = (s: Spend): number => s.providerCostUsd * PACK_MARKUP;
        const rows = await Promise.all(
            passes.map(async (p) => {
                const [members, invites] = await Promise.all([
                    deps.store.listRetreatMembers(p.id),
                    deps.store.listRetreatInvites(p.id),
                ]);
                const passSpend = byPass.get(p.id) ?? zero();
                return {
                    ...p,
                    members: members.map((m) => {
                        const s = byAccount.get(`${p.id} ${m.accountId}`) ?? zero();
                        return {
                            accountId: m.accountId,
                            email: emailById.get(m.accountId) ?? '(unknown)',
                            joinedAt: m.joinedAt,
                            spend: s,
                            billableUsd: billable(s),
                        };
                    }),
                    // Pending email invites not yet claimed by a sign-in.
                    invites: invites.map((i) => i.email),
                    spend: passSpend,
                    billableUsd: billable(passSpend),
                };
            })
        );
        return c.json(rows);
    });

    // Create a pass. Dates accept a Unix-seconds number or any Date-parseable
    // string (the panel sends date-input values); the cap is optional and null
    // means truly unlimited.
    app.post('/retreats', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        let body: { label?: unknown; startsAt?: unknown; endsAt?: unknown; perAttendeeDailyCap?: unknown };
        try {
            body = (await c.req.json()) as typeof body;
        } catch {
            return c.json(apiError('bad_request', 'invalid JSON body'), ERROR_STATUS.bad_request);
        }
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        const startsAt = parseTs(body.startsAt);
        const endsAt = parseTs(body.endsAt);
        if (!label) return c.json(apiError('bad_request', 'label is required'), ERROR_STATUS.bad_request);
        if (startsAt === null || endsAt === null) {
            return c.json(apiError('bad_request', 'startsAt and endsAt must be valid dates'), ERROR_STATUS.bad_request);
        }
        if (endsAt <= startsAt) {
            return c.json(apiError('bad_request', 'endsAt must be after startsAt'), ERROR_STATUS.bad_request);
        }
        let cap: number | null = null;
        if (body.perAttendeeDailyCap !== undefined && body.perAttendeeDailyCap !== null) {
            const n = Number(body.perAttendeeDailyCap);
            if (!Number.isFinite(n) || n <= 0) {
                return c.json(apiError('bad_request', 'perAttendeeDailyCap must be a positive number or null'), ERROR_STATUS.bad_request);
            }
            cap = n;
        }
        const pass = {
            id: randomUUID(),
            label,
            startsAt,
            endsAt,
            perAttendeeDailyCap: cap,
            status: 'active' as const,
            createdAt: Date.now() / 1000,
        };
        await deps.store.createRetreatPass(pass);
        return c.json(pass);
    });

    // Add an attendee by email. An existing account becomes a membership right
    // away; otherwise it's a pending invite that binds on first sign-in
    // (meditation-pal-n9kd), so there's no sign-in-first ordering. Same
    // canonicalizing email lookup as grant.
    app.post('/retreats/:id/members', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const pass = await deps.store.getRetreatPass(c.req.param('id'));
        if (!pass) return c.json(apiError('bad_request', 'no such pass'), ERROR_STATUS.bad_request);

        let body: { email?: unknown };
        try {
            body = (await c.req.json()) as typeof body;
        } catch {
            return c.json(apiError('bad_request', 'invalid JSON body'), ERROR_STATUS.bad_request);
        }
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        if (!email) return c.json(apiError('bad_request', 'email is required'), ERROR_STATUS.bad_request);

        const account = await deps.store.findLiveAccountByEmail(email);
        const now = Date.now() / 1000;
        if (account) {
            await deps.store.addRetreatMember({ passId: pass.id, accountId: account.id, joinedAt: now });
            return c.json({ status: 'member', email: account.email });
        }
        // No account yet: pending invite, claimed when they first sign in.
        await deps.store.addRetreatInvite({ passId: pass.id, email: email.toLowerCase(), invitedAt: now });
        return c.json({ status: 'invited', email: email.toLowerCase() });
    });

    // Revoke a pass: coverage stops immediately for every member.
    app.post('/retreats/:id/revoke', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const pass = await deps.store.getRetreatPass(c.req.param('id'));
        if (!pass) return c.json(apiError('bad_request', 'no such pass'), ERROR_STATUS.bad_request);
        await deps.store.revokeRetreatPass(pass.id);
        return c.json({ id: pass.id, status: 'revoked' });
    });

    // Permanently delete a pass and its roster. Revoke stops coverage but leaves
    // the card in the list; this clears it out (spent retreats, durability-probe
    // test markers). Allowed only once the pass is inert, revoked or ended, so a
    // live retreat can't be nuked out from under its attendees by one click.
    app.delete('/retreats/:id', async (c) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;

        const pass = await deps.store.getRetreatPass(c.req.param('id'));
        if (!pass) return c.json(apiError('bad_request', 'no such pass'), ERROR_STATUS.bad_request);
        const inert = pass.status === 'revoked' || pass.endsAt < Date.now() / 1000;
        if (!inert) {
            return c.json(
                apiError('bad_request', 'revoke the pass (or wait for it to end) before deleting'),
                ERROR_STATUS.bad_request
            );
        }
        await deps.store.deleteRetreatPass(pass.id);
        return c.json({ id: pass.id, status: 'deleted' });
    });

    return app;
}

/** Parse a Unix-seconds number or a Date-parseable string (e.g. a date-input
 *  value) to seconds since epoch; null if invalid. */
function parseTs(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
        const ms = Date.parse(v);
        if (Number.isFinite(ms)) return ms / 1000;
    }
    return null;
}

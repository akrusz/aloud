/**
 * Admin operator endpoints. Gated by ALOUD_ADMIN_TOKEN and/or
 * ALOUD_ADMIN_EMAILS: when both are unset every route here is DISABLED (404),
 * never open. Two ways in: the static operator token (scripts, curl), or a
 * signed-in session whose verified account email is on the admin list, which is
 * how the operator reaches the panel from a phone without carrying the token
 * (the device holds a session JWT, honoured here only while under 7 days old).
 *
 * The panel page (GET /cloud/v1/admin, admin/panel.ts) is served
 * unauthenticated (you can't set an auth header by navigating to a URL) but
 * still only when a credential is configured; it carries no data and every
 * action it triggers hits an adminOnly endpoint below.
 */

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Deps } from '../deps.js';
import type { LedgerEntry } from '../credits/store.js';
import { buildMetrics, buildDailyRevenue } from '../admin/metrics.js';
import { buildUsageReport, buildUsageHistory, buildProviderDailyCosts } from '../credits/usage.js';
import { buildIncidentReport } from '../credits/incidents.js';
import { deleteAccount } from '../auth/identity.js';
import { PACK_MARKUP } from '../pricing/meter.js';
import { renderAdminPanel } from '../admin/panel.js';
import { ADMIN_MAX_TOKEN_AGE_SECONDS, verifySessionToken } from '../auth/session.js';
import { effectiveConfig, applyRuntimeConfig, type ConfigPatch } from '../admin/runtime-config.js';
import { errorJson } from '../http.js';

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
        const verified = await verifySessionToken(provided, deps.config.sessionSecret);
        const claims =
            verified && Date.now() / 1000 - verified.issuedAtSeconds <= ADMIN_MAX_TOKEN_AGE_SECONDS
                ? verified
                : undefined;
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
    return errorJson(c, 'unauthenticated', 'admin access required');
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

/** A row filter for the report endpoints: drops admin-account rows when the
 *  request carries ?excludeAdmin=1 (the panel's "omit admin" toggle), so the
 *  operator's own testing doesn't pollute the real-user picture. */
async function adminFilter(c: Context, deps: Deps): Promise<(row: { accountId: string }) => boolean> {
    if (c.req.query('excludeAdmin') !== '1') return () => true;
    const admin = await adminAccountIds(deps);
    return (row) => !admin.has(row.accountId);
}

/** Start of the ?sinceHours window (default `defaultHours`), epoch seconds. */
function windowStart(c: Context, now: number, defaultHours: number): number {
    return now - Math.max(0, Number(c.req.query('sinceHours') ?? defaultHours)) * 3600;
}

/** ?days, clamped to 1..365 (default 30). */
function dayCount(c: Context): number {
    return Math.min(365, Math.max(1, Number(c.req.query('days') ?? 30)));
}

/** The request's JSON body, or null when it doesn't parse to an object. */
async function jsonBody<T extends object>(c: Context): Promise<T | null> {
    try {
        const body: unknown = await c.req.json();
        return body && typeof body === 'object' ? (body as T) : null;
    } catch {
        return null;
    }
}

/** Net balance per account id, summing the append-only ledger once. */
function balancesByAccount(entries: LedgerEntry[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.accountId, (m.get(e.accountId) ?? 0) + e.amount);
    return m;
}

export function adminRoutes(deps: Deps): Hono {
    const app = new Hono();
    const adminOnly: MiddlewareHandler = async (c, next) => {
        const fail = await authFailure(c, deps);
        if (fail) return fail;
        await next();
    };

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

    app.get('/metrics', adminOnly, async (c) => {
        const now = Date.now() / 1000;
        const windowSinceTs = windowStart(c, now, 24);
        const [accounts, entries] = await Promise.all([
            deps.store.allAccounts(),
            deps.store.allEntries(),
        ]);
        return c.json(buildMetrics(accounts, entries, now, windowSinceTs));
    });

    // Incident log (meditation-pal-xtgh): what the app handled quietly on the
    // cloud path - blank completions, upstream failures, 402s, client-reported
    // TTS/playback failures - grouped by kind, newest rows first.
    app.get('/incidents', adminOnly, async (c) => {
        const sinceTs = windowStart(c, Date.now() / 1000, 168);
        const rows = (await deps.store.incidentsSince(sinceTs)).filter(await adminFilter(c, deps));
        // Short account labels for the table (the email's local part), never
        // the whole address in a JSON blob the browser keeps around.
        const accounts = await deps.store.allAccounts();
        const label = new Map(accounts.map((a) => [a.id, a.email.split('@')[0] ?? a.id.slice(0, 8)]));
        const report = buildIncidentReport(rows, sinceTs);
        return c.json({
            ...report,
            recent: report.recent.map((r) => ({ ...r, account: label.get(r.accountId) ?? r.accountId.slice(0, 8) })),
        });
    });

    // Cost attribution (meditation-pal-rvy): per-service split, cache-hit ratio,
    // per-model cost, and reconstructed per-session economics the ledger can't
    // show. The dataset for calibrating USD_PER_CREDIT and pack sizing against
    // what real sessions cost.
    app.get('/usage', adminOnly, async (c) => {
        // ONE session bar panel-wide (DEFAULT_REAL_SIT: 5+ turns AND 5+ min):
        // distributions and per-hour rates filter on it together, or not at
        // all with all=1. sitMinutes/sitTurns stay as curl-level overrides of
        // the bar; a 0 disables that criterion outright.
        const allSessions = c.req.query('all') === '1';
        const realSit = {
            ...(c.req.query('sitMinutes') != null
                ? { minMinutes: Math.max(0, Number(c.req.query('sitMinutes')) || 0) }
                : {}),
            ...(c.req.query('sitTurns') != null
                ? { minTurns: Math.max(0, Number(c.req.query('sitTurns')) || 0) }
                : {}),
        };
        const now = Date.now() / 1000;
        const windowSinceTs = windowStart(c, now, 24);

        // Itemized sessions only for the operator's own accounts: real users
        // appear in aggregate, never as a per-sit line (privacy policy).
        const [events, keep, sessionRowsFor] = await Promise.all([
            deps.store.allUsage(),
            adminFilter(c, deps),
            adminAccountIds(deps),
        ]);
        return c.json(
            buildUsageReport(events.filter(keep), now, windowSinceTs, { allSessions, realSit, sessionRowsFor })
        );
    });

    // Daily usage history for the trend charts: sessions, turns, spend, duration
    // per day over the last `days` days, plus gross revenue per day from the
    // ledger's purchase entries (the revenue-vs-cost margin trend). Computed
    // live from retained usage_events (no rollup table at this scale), so it's
    // real history bounded only by how far back the telemetry goes.
    app.get('/usage/history', adminOnly, async (c) => {
        const days = dayCount(c);
        const now = Date.now() / 1000;
        const [events, entries, keep] = await Promise.all([
            deps.store.allUsage(),
            deps.store.allEntries(),
            adminFilter(c, deps),
        ]);
        // The omit-admin toggle drops the operator's purchases too, so the
        // revenue line matches the filtered cost bars.
        const revenue = buildDailyRevenue(entries.filter(keep), now, days);
        const buckets = buildUsageHistory(events.filter(keep), now, days).map((b) => ({
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
    app.get('/usage/provider-daily', adminOnly, async (c) => {
        const days = dayCount(c);
        const now = Date.now() / 1000;
        const events = await deps.store.allUsage();
        return c.json({ generatedAt: now, days, rows: buildProviderDailyCosts(events, now, days) });
    });

    // Every account with derived balance, lifetime granted/spent, and whether it
    // has ever purchased, so the operator can find an email to grant to and
    // eyeball free-vs-paid at a glance.
    app.get('/accounts', adminOnly, async (c) => {
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
    app.get('/accounts/:id', adminOnly, async (c) => {
        const account = await deps.store.getAccountById(c.req.param('id'));
        if (!account) return errorJson(c, 'bad_request', 'no such account');
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
    app.post('/accounts/:id/delete', adminOnly, async (c) => {
        const account = await deps.store.getAccountById(c.req.param('id'));
        if (!account) return errorJson(c, 'bad_request', 'no such account');
        if (account.deletedAt != null) return errorJson(c, 'bad_request', 'account is already deleted');
        await deleteAccount(deps, account);
        return c.json({ id: account.id, deleted: true });
    });

    // Operator-tunable runtime config (free-credit knobs). GET reads the live
    // effective values; PUT patches them, live and persisted, so the operator can
    // stop handing out free credits without a redeploy.
    app.get('/config', adminOnly, async (c) => {
        return c.json(effectiveConfig(deps));
    });

    app.put('/config', adminOnly, async (c) => {
        const body = await jsonBody<{
            freeSignupCredits?: unknown;
            freeGrantBudgetPerHour?: unknown;
            meteredPaused?: unknown;
            testerEmails?: unknown;
        }>(c);
        if (!body) return errorJson(c, 'bad_request', 'invalid JSON body');

        const patch: ConfigPatch = {};
        for (const key of ['freeSignupCredits', 'freeGrantBudgetPerHour'] as const) {
            if (body[key] === undefined) continue;
            const n = Number(body[key]);
            // Non-negative integers only: these are whole-credit knobs, and a
            // stray float/negative shouldn't silently corrupt the grant budget.
            if (!Number.isInteger(n) || n < 0) {
                return errorJson(c, 'bad_request', `${key} must be a non-negative integer`);
            }
            patch[key] = n;
        }
        if (body.meteredPaused !== undefined) {
            if (typeof body.meteredPaused !== 'boolean') {
                return errorJson(c, 'bad_request', 'meteredPaused must be a boolean');
            }
            patch.meteredPaused = body.meteredPaused;
        }
        if (body.testerEmails !== undefined) {
            if (!Array.isArray(body.testerEmails) || body.testerEmails.some((e) => typeof e !== 'string')) {
                return errorJson(c, 'bad_request', 'testerEmails must be an array of strings');
            }
            patch.testerEmails = body.testerEmails as string[];
        }

        const updated = await applyRuntimeConfig(deps, patch);
        return c.json(updated);
    });

    // Grant credits to an account by email. Appends a signup_grant entry tagged
    // reason 'admin_grant', so the audit trail says who/why without inventing a
    // new ledger kind.
    app.post('/grant', adminOnly, async (c) => {
        const body = await jsonBody<{ email?: unknown; credits?: unknown }>(c);
        if (!body) return errorJson(c, 'bad_request', 'invalid JSON body');
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        const credits = Number(body.credits);
        if (!email) return errorJson(c, 'bad_request', 'email is required');
        if (!Number.isFinite(credits) || credits <= 0) {
            return errorJson(c, 'bad_request', 'credits must be a positive number');
        }

        // Canonicalizing lookup (case, +tag, Gmail dots): the operator pastes
        // whatever spelling the user wrote, which may not match the stored one.
        const account = await deps.store.findLiveAccountByEmail(email);
        if (!account) return errorJson(c, 'bad_request', `no account with email ${email}`);

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
    app.get('/retreats', adminOnly, async (c) => {
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
    app.post('/retreats', adminOnly, async (c) => {
        const body = await jsonBody<{
            label?: unknown;
            startsAt?: unknown;
            endsAt?: unknown;
            perAttendeeDailyCap?: unknown;
        }>(c);
        if (!body) return errorJson(c, 'bad_request', 'invalid JSON body');
        const label = typeof body.label === 'string' ? body.label.trim() : '';
        const startsAt = parseTs(body.startsAt);
        const endsAt = parseTs(body.endsAt);
        if (!label) return errorJson(c, 'bad_request', 'label is required');
        if (startsAt === null || endsAt === null) {
            return errorJson(c, 'bad_request', 'startsAt and endsAt must be valid dates');
        }
        if (endsAt <= startsAt) return errorJson(c, 'bad_request', 'endsAt must be after startsAt');
        let cap: number | null = null;
        if (body.perAttendeeDailyCap !== undefined && body.perAttendeeDailyCap !== null) {
            const n = Number(body.perAttendeeDailyCap);
            if (!Number.isFinite(n) || n <= 0) {
                return errorJson(c, 'bad_request', 'perAttendeeDailyCap must be a positive number or null');
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
    app.post('/retreats/:id/members', adminOnly, async (c) => {
        const pass = await deps.store.getRetreatPass(c.req.param('id'));
        if (!pass) return errorJson(c, 'bad_request', 'no such pass');

        const body = await jsonBody<{ email?: unknown }>(c);
        if (!body) return errorJson(c, 'bad_request', 'invalid JSON body');
        const email = typeof body.email === 'string' ? body.email.trim() : '';
        if (!email) return errorJson(c, 'bad_request', 'email is required');

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
    app.post('/retreats/:id/revoke', adminOnly, async (c) => {
        const pass = await deps.store.getRetreatPass(c.req.param('id'));
        if (!pass) return errorJson(c, 'bad_request', 'no such pass');
        await deps.store.revokeRetreatPass(pass.id);
        return c.json({ id: pass.id, status: 'revoked' });
    });

    // Permanently delete a pass and its roster. Revoke stops coverage but leaves
    // the card in the list; this clears it out (spent retreats, durability-probe
    // test markers). Allowed only once the pass is inert, revoked or ended, so a
    // live retreat can't be nuked out from under its attendees by one click.
    app.delete('/retreats/:id', adminOnly, async (c) => {
        const pass = await deps.store.getRetreatPass(c.req.param('id'));
        if (!pass) return errorJson(c, 'bad_request', 'no such pass');
        const inert = pass.status === 'revoked' || pass.endsAt < Date.now() / 1000;
        if (!inert) return errorJson(c, 'bad_request', 'revoke the pass (or wait for it to end) before deleting');
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

/**
 * Admin operator endpoints (dev ask). Gated by ALOUD_ADMIN_TOKEN — when that's
 * unset every route here is DISABLED (404), never open. Separate from user
 * auth: this is operator access, not account access.
 *
 *   GET  /cloud/v1/admin            — the control panel HTML (panel.ts)
 *   GET  /cloud/v1/admin/metrics    — ledger aggregates + abuse velocity signals
 *   GET  /cloud/v1/admin/accounts   — every account with derived balance/spend
 *   GET  /cloud/v1/admin/accounts/:id — one account + its full ledger (audit)
 *   POST /cloud/v1/admin/grant      — { email, credits } → ledger.grant()
 *
 * The panel page itself is served unauthenticated (you can't set an auth header
 * by navigating to a URL) but still only when a token is configured; it carries
 * no data and every action it triggers hits a token-gated endpoint below.
 */

import { Hono } from 'hono';
import type { Context } from 'hono';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { Deps } from '../deps.js';
import type { Account, LedgerEntry } from '../credits/store.js';
import { buildMetrics } from '../admin/metrics.js';
import { buildUsageReport } from '../credits/usage.js';
import { ADMIN_PANEL_HTML } from '../admin/panel.js';
import { effectiveConfig, applyRuntimeConfig, type ConfigPatch } from '../admin/runtime-config.js';

function tokenOk(provided: string | undefined, expected: string): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

/** Returns null when the request is authorized; otherwise the Response to send
 *  (404 when the feature is off, 401 when the token is wrong/missing). Keeping
 *  the disabled case as 404 means the endpoints aren't advertised. */
function authFailure(c: Context, expected: string | undefined) {
    if (!expected) return c.notFound();
    const header = c.req.header('authorization') ?? '';
    const provided = header.toLowerCase().startsWith('bearer ') ? header.slice(7) : undefined;
    if (!tokenOk(provided, expected)) {
        return c.json(apiError('unauthenticated', 'admin token required'), ERROR_STATUS.unauthenticated);
    }
    return null;
}

/** Net balance per account id, summing the append-only ledger once. */
function balancesByAccount(entries: LedgerEntry[]): Map<string, number> {
    const m = new Map<string, number>();
    for (const e of entries) m.set(e.accountId, (m.get(e.accountId) ?? 0) + e.amount);
    return m;
}

export function adminRoutes(deps: Deps): Hono {
    const app = new Hono();

    // The control panel. Served when a token is configured (else 404, so the
    // page isn't discoverable on a server with admin disabled). No auth on the
    // HTML itself — the operator pastes the token into the page.
    app.get('/', (c) => {
        if (!deps.config.adminToken) return c.notFound();
        return c.html(ADMIN_PANEL_HTML);
    });

    app.get('/metrics', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
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

    // Cost attribution (meditation-pal-rvy): the per-service split, cache-hit
    // ratio, per-model cost, and reconstructed per-session economics the ledger
    // can't show. This is the dataset for calibrating USD_PER_CREDIT and pack
    // sizing against what real sessions actually cost.
    app.get('/usage', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
        if (fail) return fail;

        const sinceHours = Number(c.req.query('sinceHours') ?? 24);
        const now = Date.now() / 1000;
        const windowSinceTs = now - Math.max(0, sinceHours) * 3600;

        const events = await deps.store.allUsage();
        return c.json(buildUsageReport(events, now, windowSinceTs));
    });

    // Every account with derived balance, lifetime granted/spent, and whether
    // it has ever purchased (so the operator can find an email to grant to and
    // eyeball free-vs-paid at a glance).
    app.get('/accounts', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
        if (fail) return fail;

        const [accounts, entries] = await Promise.all([
            deps.store.allAccounts(),
            deps.store.allEntries(),
        ]);
        const balances = balancesByAccount(entries);
        const granted = new Map<string, number>();
        const debited = new Map<string, number>();
        const purchased = new Set<string>();
        for (const e of entries) {
            if (e.kind === 'signup_grant') granted.set(e.accountId, (granted.get(e.accountId) ?? 0) + e.amount);
            else if (e.kind === 'purchase') purchased.add(e.accountId);
            else if (e.kind === 'debit') debited.set(e.accountId, (debited.get(e.accountId) ?? 0) - e.amount);
        }
        const rows = accounts
            .map((a) => ({
                id: a.id,
                email: a.email,
                createdAt: a.createdAt,
                balance: balances.get(a.id) ?? 0,
                granted: granted.get(a.id) ?? 0,
                debited: debited.get(a.id) ?? 0,
                purchased: purchased.has(a.id),
            }))
            .sort((x, y) => y.createdAt - x.createdAt);
        return c.json(rows);
    });

    // One account plus its full ledger — the audit trail behind a balance,
    // which is exactly what a billing question needs.
    app.get('/accounts/:id', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
        if (fail) return fail;

        const account = await deps.store.getAccountById(c.req.param('id'));
        if (!account) return c.json(apiError('bad_request', 'no such account'), ERROR_STATUS.bad_request);
        const entries = await deps.store.listEntries(account.id);
        const balance = entries.reduce((s, e) => s + e.amount, 0);
        return c.json({ account, balance, entries });
    });

    // Operator-tunable runtime config (free-credit knobs). GET reads the live
    // effective values; PUT patches them (live + persisted). Lets the operator
    // stop handing out free credits while testing without a redeploy.
    app.get('/config', (c) => {
        const fail = authFailure(c, deps.config.adminToken);
        if (fail) return fail;
        return c.json(effectiveConfig(deps));
    });

    app.put('/config', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
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
            // Non-negative integers only — these are whole-credit knobs, and a
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

    // Grant credits to an account by email. Looks the account up (trial-scale
    // scan), then appends a signup_grant entry tagged reason 'admin_grant' so
    // the audit trail says who/why without inventing a new ledger kind.
    app.post('/grant', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
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

        const accounts = await deps.store.allAccounts();
        const account = findByEmail(accounts, email);
        if (!account) {
            return c.json(apiError('bad_request', `no account with email ${email}`), ERROR_STATUS.bad_request);
        }

        await deps.ledger.grant(account.id, credits, 'admin_grant');
        const balance = await deps.ledger.balance(account.id);
        return c.json({ account: { id: account.id, email: account.email }, granted: credits, balance });
    });

    // ---- Retreat passes (meditation-pal-414) -------------------------------
    // Operator-created, time-boxed unlimited access for retreat attendees. The
    // operator creates a pass, then adds attendees by email; a member's metered
    // calls bypass billing while the pass is active and in-window. Admin-only —
    // there's no attendee-facing UI or shareable code.

    // List passes, each with its attendee roster and the real provider spend so
    // far (summed from the usage telemetry tagged with this pass). The spend
    // column is what tells the operator what a retreat actually cost.
    app.get('/retreats', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
        if (fail) return fail;

        const [passes, accounts, usage] = await Promise.all([
            deps.store.listRetreatPasses(),
            deps.store.allAccounts(),
            deps.store.allUsage(),
        ]);
        const emailById = new Map(accounts.map((a) => [a.id, a.email]));
        const spend = new Map<string, { providerCostUsd: number; credits: number; events: number }>();
        for (const u of usage) {
            if (!u.passId) continue;
            const s = spend.get(u.passId) ?? { providerCostUsd: 0, credits: 0, events: 0 };
            s.providerCostUsd += u.providerCostUsd;
            s.credits += u.credits;
            s.events += 1;
            spend.set(u.passId, s);
        }
        const rows = await Promise.all(
            passes.map(async (p) => {
                const members = await deps.store.listRetreatMembers(p.id);
                return {
                    ...p,
                    members: members.map((m) => ({
                        accountId: m.accountId,
                        email: emailById.get(m.accountId) ?? '(unknown)',
                        joinedAt: m.joinedAt,
                    })),
                    spend: spend.get(p.id) ?? { providerCostUsd: 0, credits: 0, events: 0 },
                };
            })
        );
        return c.json(rows);
    });

    // Create a pass. Dates accept a Unix-seconds number or any Date-parseable
    // string (the panel sends date-input values); the cap is optional and null
    // means truly unlimited.
    app.post('/retreats', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
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

    // Add an attendee to a pass by email — reuses the same case-insensitive
    // account lookup as grant. The attendee must have signed in at least once
    // (so an account exists to attach coverage to).
    app.post('/retreats/:id/members', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
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

        const accounts = await deps.store.allAccounts();
        const account = findByEmail(accounts, email);
        if (!account) {
            return c.json(
                apiError('bad_request', `no account with email ${email} — they must sign in once first`),
                ERROR_STATUS.bad_request
            );
        }
        await deps.store.addRetreatMember({ passId: pass.id, accountId: account.id, joinedAt: Date.now() / 1000 });
        return c.json({ added: { accountId: account.id, email: account.email } });
    });

    // Revoke a pass — coverage stops immediately for every member.
    app.post('/retreats/:id/revoke', async (c) => {
        const fail = authFailure(c, deps.config.adminToken);
        if (fail) return fail;

        const pass = await deps.store.getRetreatPass(c.req.param('id'));
        if (!pass) return c.json(apiError('bad_request', 'no such pass'), ERROR_STATUS.bad_request);
        await deps.store.revokeRetreatPass(pass.id);
        return c.json({ id: pass.id, status: 'revoked' });
    });

    return app;
}

/** Parse a timestamp input: a Unix-seconds number, or a Date-parseable string
 *  (e.g. a date-input value). Returns seconds since epoch, or null if invalid. */
function parseTs(v: unknown): number | null {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim()) {
        const ms = Date.parse(v);
        if (Number.isFinite(ms)) return ms / 1000;
    }
    return null;
}

/** Case-insensitive email match (emails are case-insensitive in practice). */
function findByEmail(accounts: Account[], email: string): Account | undefined {
    const needle = email.toLowerCase();
    return accounts.find((a) => a.email.toLowerCase() === needle);
}

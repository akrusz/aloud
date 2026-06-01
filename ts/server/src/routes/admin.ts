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
import { timingSafeEqual } from 'node:crypto';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { Deps } from '../deps.js';
import type { Account, LedgerEntry } from '../credits/store.js';
import { buildMetrics } from '../admin/metrics.js';
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

        let body: { freeSignupCredits?: unknown; freeGrantBudgetPerHour?: unknown };
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

    return app;
}

/** Case-insensitive email match (emails are case-insensitive in practice). */
function findByEmail(accounts: Account[], email: string): Account | undefined {
    const needle = email.toLowerCase();
    return accounts.find((a) => a.email.toLowerCase() === needle);
}

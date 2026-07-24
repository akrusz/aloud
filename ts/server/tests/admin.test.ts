/**
 * Admin HTTP surface: token gating (off → 404, wrong token → 401), the panel
 * page, the accounts/ledger reads, and the grant-by-email action. Drives the
 * real Hono app against an injected MemoryCreditsStore — no network.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { loadRuntimeOverrides, isMeteredBlocked } from '../src/admin/runtime-config.js';
import { issueSessionToken } from '../src/auth/session.js';
import { renderAdminPanel } from '../src/admin/panel.js';
import type { Account } from '../src/credits/store.js';

const TOKEN = 'super-secret-admin-token';

function seedAccount(store: MemoryCreditsStore, id: string, email: string, emailVerified = true): Promise<void> {
    const account: Account = {
        id,
        email,
        emailVerified,
        createdAt: 1000,
    };
    return store.createAccount(account);
}

function makeApp(opts: { token?: string; adminEmails?: string } = {}) {
    const store = new MemoryCreditsStore();
    const env: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-test', ALOUD_ENABLE_DEV_AUTH: '1' };
    if (opts.token !== undefined) env['ALOUD_ADMIN_TOKEN'] = opts.token;
    if (opts.adminEmails !== undefined) env['ALOUD_ADMIN_EMAILS'] = opts.adminEmails;
    const config = loadConfig(env);
    const deps = buildDeps(config, { store });
    return { app: createApp(deps), store, ledger: deps.ledger, config };
}

function authed(extra: Record<string, string> = {}) {
    return { authorization: `Bearer ${TOKEN}`, ...extra };
}

describe('admin routes — gating', () => {
    it('404s every admin route when ALOUD_ADMIN_TOKEN is unset', async () => {
        const { app } = makeApp(); // no token configured
        for (const path of ['/cloud/v1/admin', '/cloud/v1/admin/metrics', '/cloud/v1/admin/accounts']) {
            const res = await app.request(path, { headers: authed() });
            expect(res.status).toBe(404);
        }
        const grant = await app.request('/cloud/v1/admin/grant', {
            method: 'POST',
            headers: authed({ 'content-type': 'application/json' }),
            body: JSON.stringify({ email: 'x@y.com', credits: 10 }),
        });
        expect(grant.status).toBe(404);
    });

    it('401s data endpoints with a missing or wrong token', async () => {
        const { app } = makeApp({ token: TOKEN });
        const noTok = await app.request('/cloud/v1/admin/metrics');
        expect(noTok.status).toBe(401);
        const wrong = await app.request('/cloud/v1/admin/metrics', {
            headers: { authorization: 'Bearer nope' },
        });
        expect(wrong.status).toBe(401);
    });

    it('serves the panel HTML (unauthenticated) when a token is configured', async () => {
        const { app } = makeApp({ token: TOKEN });
        const res = await app.request('/cloud/v1/admin');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
        const html = await res.text();
        expect(html).toContain('aloud');
        expect(html).not.toContain(TOKEN); // token is never baked into the page
    });
});

describe('admin routes — session (ALOUD_ADMIN_EMAILS) auth', () => {
    // loadConfig's dev fallback secret — what the test app signs sessions with.
    const SECRET = 'dev-insecure-secret';

    it('accepts a session token for a verified allowlisted account', async () => {
        const { app, store } = makeApp({ adminEmails: 'Admin@Example.com' });
        await seedAccount(store, 'adm', 'admin@example.com');
        const jwt = await issueSessionToken('adm', SECRET);
        const res = await app.request('/cloud/v1/admin/metrics', {
            headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.status).toBe(200);
    });

    it('rejects a session for an account not on the list', async () => {
        const { app, store } = makeApp({ adminEmails: 'admin@example.com' });
        await seedAccount(store, 'usr', 'stranger@example.com');
        const jwt = await issueSessionToken('usr', SECRET);
        const res = await app.request('/cloud/v1/admin/metrics', {
            headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.status).toBe(401);
    });

    it('rejects an allowlisted but UNVERIFIED email (no squatting via email signup)', async () => {
        const { app, store } = makeApp({ adminEmails: 'admin@example.com' });
        await seedAccount(store, 'adm', 'admin@example.com', false);
        const jwt = await issueSessionToken('adm', SECRET);
        const res = await app.request('/cloud/v1/admin/metrics', {
            headers: { authorization: `Bearer ${jwt}` },
        });
        expect(res.status).toBe(401);
    });

    it('serves the panel with no static token configured (emails only)', async () => {
        const { app } = makeApp({ adminEmails: 'admin@example.com' });
        const res = await app.request('/cloud/v1/admin');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/html');
    });

    it('injects the Google client id into the panel; blank when unconfigured', () => {
        const html = renderAdminPanel('web-id.apps.googleusercontent.com');
        expect(html).toContain('"web-id.apps.googleusercontent.com"');
        expect(renderAdminPanel(undefined)).toContain('var GOOGLE_CLIENT_ID = ""');
    });

    it('still rejects garbage bearers, and the static token keeps working alongside', async () => {
        const { app } = makeApp({ token: TOKEN, adminEmails: 'admin@example.com' });
        const garbage = await app.request('/cloud/v1/admin/metrics', {
            headers: { authorization: 'Bearer not-a-jwt-not-the-token' },
        });
        expect(garbage.status).toBe(401);
        const viaToken = await app.request('/cloud/v1/admin/metrics', { headers: authed() });
        expect(viaToken.status).toBe(200);
    });
});

describe('admin routes — data', () => {
    let h: ReturnType<typeof makeApp>;

    beforeEach(async () => {
        h = makeApp({ token: TOKEN });
        await seedAccount(h.store, 'a1', 'Alice@Example.com');
        await seedAccount(h.store, 'a2', 'bob@example.com');
        await h.ledger.grant('a1', 20);
        await h.ledger.purchase('a2', 100, 'pack');
        await h.ledger.debit('a2', 15, 'llm');
    });

    it('lists accounts with derived balance, granted, spent, and paid flag', async () => {
        const res = await h.app.request('/cloud/v1/admin/accounts', { headers: authed() });
        expect(res.status).toBe(200);
        const rows = (await res.json()) as Array<{
            email: string; balance: number; granted: number; debited: number; purchased: boolean;
        }>;
        const alice = rows.find((r) => r.email === 'Alice@Example.com')!;
        const bob = rows.find((r) => r.email === 'bob@example.com')!;
        expect(alice.balance).toBe(20);
        expect(alice.granted).toBe(20);
        expect(alice.purchased).toBe(false);
        expect(bob.balance).toBe(85); // 100 purchased - 15 debited
        expect(bob.debited).toBe(15);
        expect(bob.purchased).toBe(true);
    });

    it('returns one account plus its full ledger', async () => {
        const res = await h.app.request('/cloud/v1/admin/accounts/a2', { headers: authed() });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { balance: number; entries: unknown[] };
        expect(body.balance).toBe(85);
        expect(body.entries).toHaveLength(2);
    });

    it('404-style bad_request for an unknown account id', async () => {
        const res = await h.app.request('/cloud/v1/admin/accounts/nope', { headers: authed() });
        expect(res.status).toBe(400);
    });

    it('serves the cost-attribution report (per-service split + cache ratio)', async () => {
        // Two metered calls on one account: a near-free cached LLM turn and a
        // TTS leg. The report must split cost by service and surface the ratio.
        await h.store.appendUsage({
            id: 'u1', accountId: 'a1', sessionId: null, passId: null, ts: 1_000_000,
            kind: 'llm', provider: 'google', model: 'gemini-2.5-flash-lite',
            tokensIn: 100, tokensOut: 20, cacheRead: 900, cacheCreation: 0,
            seconds: 0, chars: 0, providerCostUsd: 0.0002, credits: 0.004,
        });
        await h.store.appendUsage({
            id: 'u2', accountId: 'a1', sessionId: null, passId: null, ts: 1_000_010,
            kind: 'tts', provider: 'google', model: 'Leda',
            tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 0,
            seconds: 0, chars: 400, providerCostUsd: 0.012, credits: 0.24,
        });

        const res = await h.app.request('/cloud/v1/admin/usage?sinceHours=1000000', { headers: authed() });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            events: number;
            byService: Array<{ kind: string; providerCostUsd: number; events: number }>;
            llmCacheHitRatio: number;
            sessions: { count: number };
        };
        expect(body.events).toBe(2);
        const tts = body.byService.find((s) => s.kind === 'tts')!;
        expect(tts.providerCostUsd).toBeCloseTo(0.012, 9);
        // 900 cacheRead / (100 in + 900 cacheRead) = 0.9
        expect(body.llmCacheHitRatio).toBeCloseTo(0.9, 9);
        // Both calls 10s apart → one reconstructed session.
        expect(body.sessions.count).toBe(1);
    });

    it('gates the usage report behind the admin token', async () => {
        const res = await h.app.request('/cloud/v1/admin/usage');
        expect(res.status).toBe(401);
    });

    it('excludeAdmin=1 drops admin-account usage from the report and the history', async () => {
        // Fresh app with an email allowlist: the filter matches accounts whose
        // stored email (case-insensitively) is on ALOUD_ADMIN_EMAILS.
        const h2 = makeApp({ token: TOKEN, adminEmails: 'admin@example.com' });
        await seedAccount(h2.store, 'adm', 'Admin@Example.com');
        await seedAccount(h2.store, 'usr', 'user@example.com');
        const base = {
            sessionId: null, passId: null, kind: 'llm' as const, provider: 'google',
            model: 'gemini-2.5-flash-lite', tokensIn: 100, tokensOut: 20, cacheRead: 0,
            cacheCreation: 0, seconds: 0, chars: 0, providerCostUsd: 0.01, credits: 0.2,
        };
        const now = Date.now() / 1000;
        await h2.store.appendUsage({ id: 'ua', accountId: 'adm', ts: now - 60, ...base });
        await h2.store.appendUsage({ id: 'ub', accountId: 'usr', ts: now - 60, ...base });

        const all = await h2.app.request('/cloud/v1/admin/usage?sinceHours=1000000', { headers: authed() });
        expect(((await all.json()) as { events: number }).events).toBe(2);

        const filtered = await h2.app.request('/cloud/v1/admin/usage?sinceHours=1000000&excludeAdmin=1', { headers: authed() });
        expect(((await filtered.json()) as { events: number }).events).toBe(1);

        const hist = await h2.app.request('/cloud/v1/admin/usage/history?days=7&excludeAdmin=1', { headers: authed() });
        const { buckets } = (await hist.json()) as { buckets: Array<{ sessions: number; events: number }> };
        expect(buckets.reduce((s, b) => s + b.events, 0)).toBe(1);
        expect(buckets.reduce((s, b) => s + b.sessions, 0)).toBe(1);
    });
});

describe('admin routes — grant', () => {
    let h: ReturnType<typeof makeApp>;

    beforeEach(async () => {
        h = makeApp({ token: TOKEN });
        await seedAccount(h.store, 'a1', 'alice@example.com');
        await h.ledger.grant('a1', 20);
    });

    async function grant(body: unknown, token = TOKEN) {
        return h.app.request('/cloud/v1/admin/grant', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('grants credits by email (case-insensitive) and returns the new balance', async () => {
        const res = await grant({ email: 'ALICE@example.com', credits: 50 });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { balance: number; granted: number };
        expect(body.granted).toBe(50);
        expect(body.balance).toBe(70); // 20 + 50
        expect(await h.ledger.balance('a1')).toBe(70);
    });

    it('tags the ledger entry reason admin_grant for the audit trail', async () => {
        await grant({ email: 'alice@example.com', credits: 5 });
        const entries = await h.store.listEntries('a1');
        expect(entries.some((e) => e.reason === 'admin_grant' && e.amount === 5)).toBe(true);
    });

    it('rejects unknown email, non-positive credits, and missing fields', async () => {
        expect((await grant({ email: 'ghost@example.com', credits: 10 })).status).toBe(400);
        expect((await grant({ email: 'alice@example.com', credits: 0 })).status).toBe(400);
        expect((await grant({ email: 'alice@example.com', credits: -5 })).status).toBe(400);
        expect((await grant({ credits: 10 })).status).toBe(400);
    });

    it('requires the admin token', async () => {
        expect((await grant({ email: 'alice@example.com', credits: 10 }, 'wrong')).status).toBe(401);
    });
});

describe('admin routes — runtime config', () => {
    let h: ReturnType<typeof makeApp>;

    beforeEach(() => {
        h = makeApp({ token: TOKEN });
    });

    async function getConfig() {
        const res = await h.app.request('/cloud/v1/admin/config', { headers: authed() });
        return { status: res.status, body: (await res.json()) as Record<string, number> };
    }
    async function putConfig(body: unknown, token = TOKEN) {
        return h.app.request('/cloud/v1/admin/config', {
            method: 'PUT',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('reports the live effective config', async () => {
        const { status, body } = await getConfig();
        expect(status).toBe(200);
        expect(body['freeSignupCredits']).toBe(20); // env/default seeded in loadConfig
        expect(typeof body['freeGrantBudgetPerHour']).toBe('number');
        expect(body['usdPerCredit']).toBeGreaterThan(0);
    });

    it('zeroing signup credits stops the grant on the next signup', async () => {
        const put = await putConfig({ freeSignupCredits: 0 });
        expect(put.status).toBe(200);
        expect(((await put.json()) as Record<string, number>)['freeSignupCredits']).toBe(0);

        // A fresh dev sign-in now grants nothing.
        const signin = await h.app.request('/cloud/v1/auth/dev', { method: 'POST' });
        const auth = (await signin.json()) as { account: { creditsRemaining: number } };
        expect(auth.account.creditsRemaining).toBe(0);
    });

    it('persists the override to the store (survives a rebuild from the same store)', async () => {
        await putConfig({ freeSignupCredits: 7, freeGrantBudgetPerHour: 0 });
        // Rebuild the app against the SAME store (simulates a restart): the boot
        // loader should re-apply the persisted overrides.
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', ANTHROPIC_API_KEY: 'sk-test', ALOUD_ADMIN_TOKEN: TOKEN });
        const deps = buildDeps(config, { store: h.store });
        await loadRuntimeOverrides(deps);
        expect(deps.config.freeSignupCredits).toBe(7);
        expect(deps.grantBreaker.budget).toBe(0);
    });

    it('rejects negative or non-integer values, and a wrong token', async () => {
        expect((await putConfig({ freeSignupCredits: -1 })).status).toBe(400);
        expect((await putConfig({ freeSignupCredits: 1.5 })).status).toBe(400);
        expect((await putConfig({ freeGrantBudgetPerHour: -5 })).status).toBe(400);
        expect((await putConfig({ freeSignupCredits: 10 }, 'wrong')).status).toBe(401);
    });

    it('404s config when no token is configured', async () => {
        const { app } = makeApp(); // no token
        expect((await app.request('/cloud/v1/admin/config', { headers: authed() })).status).toBe(404);
    });
});

describe('metered pause (soft launch)', () => {
    function pauseApp() {
        const store = new MemoryCreditsStore();
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', ANTHROPIC_API_KEY: 'sk-test', ALOUD_ADMIN_TOKEN: TOKEN });
        const deps = buildDeps(config, { store });
        return { app: createApp(deps), deps };
    }
    async function devToken(app: ReturnType<typeof createApp>): Promise<string> {
        const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
        return ((await res.json()) as { token: string }).token;
    }
    function setPause(app: ReturnType<typeof createApp>, body: unknown) {
        return app.request('/cloud/v1/admin/config', {
            method: 'PUT',
            headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify(body),
        });
    }

    it('returns the canned apology (cost 0) for a blocked non-tester instead of billing', async () => {
        const { app } = pauseApp();
        const token = await devToken(app);
        await setPause(app, { meteredPaused: true });
        const res = await app.request('/cloud/v1/llm/complete', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                provider: 'anthropic',
                model: 'claude-sonnet-5',
                messages: [{ role: 'user', content: 'hi' }],
                stream: false,
            }),
        });
        // Graceful 200 (not a 4xx/5xx) — the session can keep its turn and save.
        expect(res.status).toBe(200);
        const body = (await res.json()) as { text: string; creditsCharged: number };
        expect(body.creditsCharged).toBe(0);
        expect(body.text.toLowerCase()).toContain('free credit');
    });

    it('exempts a tester email (case-insensitively) and still blocks strangers', async () => {
        const { app, deps } = pauseApp();
        await setPause(app, { meteredPaused: true, testerEmails: ['Dev@Localhost'] });
        expect(isMeteredBlocked(deps, 'dev@localhost')).toBe(false);
        expect(isMeteredBlocked(deps, 'stranger@example.com')).toBe(true);
    });

    it('persists pause + testers across a rebuild from the same store', async () => {
        const { app, deps } = pauseApp();
        await setPause(app, { meteredPaused: true, testerEmails: ['A@B.com'] });
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', ANTHROPIC_API_KEY: 'sk-test', ALOUD_ADMIN_TOKEN: TOKEN });
        const deps2 = buildDeps(config, { store: deps.store });
        await loadRuntimeOverrides(deps2);
        expect(deps2.config.meteredPaused).toBe(true);
        expect(deps2.config.testerEmails).toEqual(['a@b.com']); // normalized lowercase
    });

    it('not blocked when the pause is off', async () => {
        const { deps } = pauseApp();
        expect(isMeteredBlocked(deps, 'anyone@example.com')).toBe(false);
    });
});

describe('admin routes — retreats', () => {
    function post(app: ReturnType<typeof makeApp>['app'], path: string, body: unknown) {
        return app.request(path, {
            method: 'POST',
            headers: authed({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
        });
    }

    it('creates a pass, validates its inputs, and lists it', async () => {
        const { app } = makeApp({ token: TOKEN });

        const bad = await post(app, '/cloud/v1/admin/retreats', { label: '', startsAt: 1000, endsAt: 2000 });
        expect(bad.status).toBe(400); // missing label
        const backwards = await post(app, '/cloud/v1/admin/retreats', { label: 'R', startsAt: 2000, endsAt: 1000 });
        expect(backwards.status).toBe(400); // end before start

        const res = await post(app, '/cloud/v1/admin/retreats', {
            label: 'Spring Retreat', startsAt: 1000, endsAt: 9999, perAttendeeDailyCap: 40,
        });
        expect(res.status).toBe(200);
        const pass = (await res.json()) as { id: string; status: string; perAttendeeDailyCap: number };
        expect(pass.status).toBe('active');
        expect(pass.perAttendeeDailyCap).toBe(40);

        const list = (await (await app.request('/cloud/v1/admin/retreats', { headers: authed() })).json()) as Array<{
            id: string; label: string; members: unknown[];
        }>;
        expect(list).toHaveLength(1);
        expect(list[0]!.label).toBe('Spring Retreat');
        expect(list[0]!.members).toEqual([]);
    });

    it('adds a known email as a member, an unknown one as a pending invite, then revokes', async () => {
        const { app, store } = makeApp({ token: TOKEN });
        await seedAccount(store, 'acct-1', 'yogi@example.com');
        const pass = (await (
            await post(app, '/cloud/v1/admin/retreats', { label: 'R', startsAt: 1000, endsAt: 9_999_999_999 })
        ).json()) as { id: string };

        // No account yet → pending invite (no sign-in-first ordering).
        const invited = await post(app, `/cloud/v1/admin/retreats/${pass.id}/members`, { email: 'Ghost@Example.com' });
        expect(invited.status).toBe(200);
        expect((await invited.json()) as { status: string }).toMatchObject({ status: 'invited', email: 'ghost@example.com' });

        // Has an account → member straight away (case-insensitive).
        const member = await post(app, `/cloud/v1/admin/retreats/${pass.id}/members`, { email: 'YOGI@example.com' });
        expect((await member.json()) as { status: string }).toMatchObject({ status: 'member' });

        // Tag a usage row to the pass so the list surfaces real spend + bill.
        await store.appendUsage({
            id: 'u1', accountId: 'acct-1', sessionId: null, passId: pass.id, ts: 1_500,
            kind: 'llm', provider: 'google', model: 'gemini-2.5-flash-lite',
            tokensIn: 10, tokensOut: 5, cacheRead: 0, cacheCreation: 0, seconds: 0, chars: 0,
            providerCostUsd: 0.02, credits: 0.4,
        });

        const list = (await (await app.request('/cloud/v1/admin/retreats', { headers: authed() })).json()) as Array<{
            members: Array<{ email: string; spend: { providerCostUsd: number }; billableUsd: number }>;
            invites: string[];
            spend: { providerCostUsd: number; events: number };
            billableUsd: number;
        }>;
        expect(list[0]!.members.map((m) => m.email)).toEqual(['yogi@example.com']);
        expect(list[0]!.invites).toEqual(['ghost@example.com']);
        expect(list[0]!.spend.providerCostUsd).toBeCloseTo(0.02);
        expect(list[0]!.billableUsd).toBeCloseTo(0.05); // 0.02 × 2.5 markup
        // Per-attendee spend + bill attributed to the one member.
        expect(list[0]!.members[0]!.spend.providerCostUsd).toBeCloseTo(0.02);
        expect(list[0]!.members[0]!.billableUsd).toBeCloseTo(0.05);

        const revoked = await post(app, `/cloud/v1/admin/retreats/${pass.id}/revoke`, {});
        expect(revoked.status).toBe(200);
        const after = (await (await app.request('/cloud/v1/admin/retreats', { headers: authed() })).json()) as Array<{
            status: string;
        }>;
        expect(after[0]!.status).toBe('revoked');
    });

    it('refuses to delete a live pass, but deletes it once revoked (clears it from the list)', async () => {
        const { app } = makeApp({ token: TOKEN });
        const pass = (await (
            await post(app, '/cloud/v1/admin/retreats', { label: 'R', startsAt: 1000, endsAt: 9_999_999_999 })
        ).json()) as { id: string };

        const del = (id: string) =>
            app.request(`/cloud/v1/admin/retreats/${id}`, { method: 'DELETE', headers: authed() });

        // Live pass → refused (must revoke or wait for it to end first).
        const early = await del(pass.id);
        expect(early.status).toBe(400);
        let list = (await (await app.request('/cloud/v1/admin/retreats', { headers: authed() })).json()) as unknown[];
        expect(list).toHaveLength(1);

        // Revoke makes it inert → delete now clears it from the list entirely.
        await post(app, `/cloud/v1/admin/retreats/${pass.id}/revoke`, {});
        const gone = await del(pass.id);
        expect(gone.status).toBe(200);
        list = (await (await app.request('/cloud/v1/admin/retreats', { headers: authed() })).json()) as unknown[];
        expect(list).toEqual([]);
    });

    it('404s the retreat routes when the admin token is unset', async () => {
        const { app } = makeApp();
        const res = await app.request('/cloud/v1/admin/retreats', { headers: authed() });
        expect(res.status).toBe(404);
    });
});

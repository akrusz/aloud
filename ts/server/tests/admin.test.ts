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
import { loadRuntimeOverrides } from '../src/admin/runtime-config.js';
import type { Account } from '../src/credits/store.js';

const TOKEN = 'super-secret-admin-token';

function seedAccount(store: MemoryCreditsStore, id: string, email: string): Promise<void> {
    const account: Account = {
        id,
        googleSub: `sub-${id}`,
        email,
        emailVerified: true,
        createdAt: 1000,
    };
    return store.createAccount(account);
}

function makeApp(opts: { token?: string } = {}) {
    const store = new MemoryCreditsStore();
    const env: Record<string, string> = { ANTHROPIC_API_KEY: 'sk-test' };
    if (opts.token !== undefined) env['ALOUD_ADMIN_TOKEN'] = opts.token;
    const config = loadConfig(env);
    const deps = buildDeps(config, { store });
    return { app: createApp(deps), store, ledger: deps.ledger };
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
        const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ALOUD_ADMIN_TOKEN: TOKEN });
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

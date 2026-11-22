/**
 * The read-only admin token (ALOUD_ADMIN_READ_TOKEN): it reaches the routes
 * routes/admin.ts marks readable, gets 403 on every other admin route, and is
 * nobody anywhere else. ROUTES must hold a decision for every registered admin
 * route, so one added without a decision fails here.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { issueSessionToken } from '../src/auth/session.js';
import { recordIncident } from '../src/credits/incidents.js';
import type { UsageEvent } from '../src/credits/usage.js';
import type { Hono } from 'hono';

const FULL = 'full-admin-token-0123456789abcdef0123456789abcdef';
const READ = 'read-admin-token-0123456789abcdef0123456789abcdef';
/** loadConfig's dev fallback secret, which the test app signs sessions with. */
const SECRET = 'dev-insecure-secret';
const ADMIN = '/cloud/v1/admin';

type Decision = 'readable' | 'refused' | 'page';

/** Every admin route and what the read token may do there. */
const ROUTES: Record<string, Decision> = {
    // HTML shells, no data, no auth; unchanged by the read token.
    [`GET ${ADMIN}`]: 'page',
    [`GET ${ADMIN}/calls`]: 'page',
    // Reports: no side effect; real users aggregate or redacted.
    [`GET ${ADMIN}/metrics`]: 'readable',
    [`GET ${ADMIN}/usage`]: 'readable',
    [`GET ${ADMIN}/usage/history`]: 'readable',
    [`GET ${ADMIN}/usage/provider-daily`]: 'readable',
    [`GET ${ADMIN}/incidents`]: 'readable',
    [`GET ${ADMIN}/sessions`]: 'readable',
    [`GET ${ADMIN}/sessions/:id`]: 'readable',
    [`GET ${ADMIN}/config`]: 'readable',
    // Real users' emails, balances, ledgers and retreat rosters.
    [`GET ${ADMIN}/accounts`]: 'refused',
    [`GET ${ADMIN}/accounts/:id`]: 'refused',
    [`GET ${ADMIN}/retreats`]: 'refused',
    // Writes.
    [`POST ${ADMIN}/accounts/:id/delete`]: 'refused',
    [`PUT ${ADMIN}/config`]: 'refused',
    [`POST ${ADMIN}/grant`]: 'refused',
    [`POST ${ADMIN}/retreats`]: 'refused',
    [`POST ${ADMIN}/retreats/:id/members`]: 'refused',
    [`POST ${ADMIN}/retreats/:id/revoke`]: 'refused',
    [`DELETE ${ADMIN}/retreats/:id`]: 'refused',
};

/** "METHOD /path" for every route registered on the app, middleware aside. */
function registered(app: Hono<any>, under?: string): string[] {
    const keys = app.routes
        .filter((r) => r.method !== 'ALL' && (under === undefined || r.path === under || r.path.startsWith(`${under}/`)))
        .map((r) => `${r.method} ${r.path}`);
    return [...new Set(keys)].sort();
}

function usage(id: string, accountId: string, sessionId: string, ts: number): UsageEvent {
    return {
        id, accountId, sessionId, passId: null, ts,
        kind: 'llm', provider: 'anthropic', model: 'claude-opus-5', purpose: null,
        tokensIn: 100, tokensOut: 20, cacheRead: 900, cacheCreation: 0, cacheCreation1h: 0,
        seconds: 0, chars: 0, providerCostUsd: 0.01, credits: 0.2,
    };
}

async function setup(env: Record<string, string> = {}) {
    const store = new MemoryCreditsStore();
    const config = loadConfig({
        ANTHROPIC_API_KEY: 'sk-test',
        ALOUD_ADMIN_TOKEN: FULL,
        ALOUD_ADMIN_EMAILS: 'admin@example.com',
        ALOUD_ADMIN_READ_TOKEN: READ,
        ALOUD_TESTER_EMAILS: 'friend@example.com',
        ...env,
    });
    const deps = buildDeps(config, { store });
    const app = createApp(deps);
    const now = Date.now() / 1000;
    await store.createAccount({ id: 'adm', email: 'admin@example.com', emailVerified: true, createdAt: now - 60, signupIp: '198.51.100.7' });
    await store.createAccount({ id: 'usr', email: 'jane.doe@example.com', emailVerified: true, createdAt: now - 60, signupIp: '203.0.113.9' });
    await deps.ledger.grant('usr', 20);
    await store.appendUsage(usage('a', 'adm', 'mine', now - 120));
    await store.appendUsage(usage('b', 'usr', 'theirs', now - 120));
    await recordIncident(store, { accountId: 'adm', kind: 'llm_empty', source: 'server', sessionId: 'mine' });
    await recordIncident(store, { accountId: 'usr', kind: 'llm_error', source: 'server', sessionId: 'theirs', detail: 'upstream 502' });
    await store.createRetreatPass({
        id: 'pass1', label: 'R', startsAt: now - 3600, endsAt: now + 3600,
        perAttendeeDailyCap: null, status: 'active', createdAt: now - 3600,
    });
    const send = (method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) =>
        app.request(path, {
            method,
            headers: {
                ...(token ? { authorization: `Bearer ${token}` } : {}),
                ...(body === undefined ? {} : { 'content-type': 'application/json' }),
                ...headers,
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
    return { app, store, deps, send };
}

/** A concrete request for a route key: real ids, and a body a full admin's
 *  call would accept, so a refusal can't be a validation error in disguise. */
function requestFor(key: string): { method: string; path: string; body?: unknown } {
    const [method, pattern] = key.split(' ') as [string, string];
    const path = pattern
        .replace('/sessions/:id', '/sessions/mine')
        .replace('/accounts/:id', '/accounts/usr')
        .replace('/retreats/:id', '/retreats/pass1');
    const bodies: Record<string, unknown> = {
        [`PUT ${ADMIN}/config`]: { freeSignupCredits: 0, meteredPaused: true },
        [`POST ${ADMIN}/grant`]: { email: 'jane.doe@example.com', credits: 1000 },
        [`POST ${ADMIN}/retreats`]: { label: 'Mine', startsAt: 1000, endsAt: 9_999_999_999 },
        [`POST ${ADMIN}/retreats/:id/members`]: { email: 'jane.doe@example.com' },
    };
    return { method, path, ...(key in bodies ? { body: bodies[key] } : {}) };
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('read token: route decisions', () => {
    it('has a decision for every registered admin route, and no stale ones', async () => {
        const { app } = await setup();
        expect(registered(app, ADMIN)).toEqual(Object.keys(ROUTES).sort());
    });

    it('reaches every readable route, gets 403 on every other, and changes nothing', async () => {
        const { store, deps, send } = await setup();
        const configBefore = { free: deps.config.freeSignupCredits, paused: deps.config.meteredPaused };
        for (const [key, decision] of Object.entries(ROUTES)) {
            const { method, path, body } = requestFor(key);
            const res = await send(method, path, READ, body);
            if (decision === 'refused') {
                expect(res.status, key).toBe(403);
                const err = (await res.json()) as { error: { code: string; message: string } };
                expect(err.error.code, key).toBe('forbidden');
                expect(err.error.message, key).toMatch(/read-only/);
            } else {
                expect(res.status, key).toBe(200);
            }
        }
        expect(await deps.ledger.balance('usr')).toBe(20);
        expect((await store.getAccountById('usr'))!.deletedAt).toBeUndefined();
        expect({ free: deps.config.freeSignupCredits, paused: deps.config.meteredPaused }).toEqual(configBefore);
        const passes = await store.listRetreatPasses();
        expect(passes.map((p) => [p.id, p.status])).toEqual([['pass1', 'active']]);
        expect(await store.listRetreatMembers('pass1')).toEqual([]);
    });

    it('keeps 401 for a wrong token everywhere, so "wrong token" and "cannot do this" differ', async () => {
        const { send } = await setup();
        for (const [key, decision] of Object.entries(ROUTES)) {
            if (decision === 'page') continue;
            const { method, path, body } = requestFor(key);
            expect((await send(method, path, `${READ}x`, body)).status, key).toBe(401);
            expect((await send(method, path, undefined, body)).status, key).toBe(401);
        }
    });
});

describe('read token: redactions', () => {
    it('metrics: signup IPs are withheld from the read token, counts kept', async () => {
        const { send } = await setup();
        type M = { abuse: { distinctSignupIps: number; topSignupIps: Array<{ ip: string; signups: number }> } };
        const read = (await (await send('GET', `${ADMIN}/metrics`, READ)).json()) as M;
        expect(read.abuse.distinctSignupIps).toBe(2);
        expect(read.abuse.topSignupIps.map((r) => r.ip)).toEqual(['redacted', 'redacted']);
        expect(JSON.stringify(read)).not.toMatch(/198\.51|203\.0/);
        const full = (await (await send('GET', `${ADMIN}/metrics`, FULL)).json()) as M;
        expect(full.abuse.topSignupIps.map((r) => r.ip).sort()).toEqual(['198.51.100.7', '203.0.113.9']);
    });

    it("incidents: a real user's rows lose their account id and label; the operator's keep theirs", async () => {
        const { send } = await setup();
        type I = { recent: Array<{ kind: string; accountId: string; account: string; detail: string }>; byKind: Array<{ accounts: number }> };
        const read = (await (await send('GET', `${ADMIN}/incidents`, READ)).json()) as I;
        const byKind = Object.fromEntries(read.recent.map((r) => [r.kind, r]));
        expect(byKind['llm_error']).toMatchObject({ accountId: '', account: 'user', detail: 'upstream 502' });
        expect(byKind['llm_empty']).toMatchObject({ accountId: 'adm', account: 'admin' });
        expect(JSON.stringify(read)).not.toMatch(/jane|usr/);
        const full = (await (await send('GET', `${ADMIN}/incidents`, FULL)).json()) as I;
        expect(full.recent.find((r) => r.kind === 'llm_error')).toMatchObject({ accountId: 'usr', account: 'jane.doe' });
    });

    it('config: tester emails become a count for the read token; no secret in either answer', async () => {
        const { send } = await setup();
        const read = (await (await send('GET', `${ADMIN}/config`, READ)).json()) as Record<string, unknown>;
        expect(read['testerEmails']).toBeUndefined();
        expect(read['testerEmailCount']).toBe(1);
        expect(read['freeSignupCredits']).toBe(20);
        expect(read['minClientVersion']).toBeDefined();
        const full = (await (await send('GET', `${ADMIN}/config`, FULL)).json()) as Record<string, unknown>;
        expect(full['testerEmails']).toEqual(['friend@example.com']);
        for (const body of [read, full]) expect(JSON.stringify(body)).not.toMatch(/sk-test|dev-insecure|full-admin|read-admin/);
    });

    it('sessions and usage itemize only the operator\'s own accounts, for any credential', async () => {
        const { send } = await setup();
        const sessions = (await (await send('GET', `${ADMIN}/sessions`, READ)).json()) as { sessions: Array<{ sessionId: string }> };
        expect(sessions.sessions.map((s) => s.sessionId)).toEqual(['mine']);
        expect((await send('GET', `${ADMIN}/sessions/theirs`, READ)).status).toBe(404);
        const report = (await (await send('GET', `${ADMIN}/usage?sinceHours=1&all=1`, READ)).json()) as { sessionRows: Array<{ accountId: string }>; accounts: number };
        expect(report.accounts).toBe(2);
        expect(report.sessionRows.map((r) => r.accountId)).toEqual(['adm']);
    });
});

describe('read token: the full credentials are unchanged', () => {
    it('the full token still reads everything and still writes', async () => {
        const { send, deps } = await setup();
        for (const key of [`GET ${ADMIN}/accounts`, `GET ${ADMIN}/accounts/:id`, `GET ${ADMIN}/retreats`]) {
            const { method, path } = requestFor(key);
            expect((await send(method, path, FULL)).status, key).toBe(200);
        }
        const grant = await send('POST', `${ADMIN}/grant`, FULL, { email: 'jane.doe@example.com', credits: 5 });
        expect(grant.status).toBe(200);
        expect(await deps.ledger.balance('usr')).toBe(25);
    });

    it('an allowlisted session is still a full admin; a stranger is still a 401', async () => {
        const { send, store } = await setup();
        const admin = await issueSessionToken('adm', SECRET);
        expect((await send('GET', `${ADMIN}/accounts`, admin)).status).toBe(200);
        expect((await send('PUT', `${ADMIN}/config`, admin, { freeSignupCredits: 3 })).status).toBe(200);
        await store.createAccount({ id: 'str', email: 'stranger@example.com', emailVerified: true, createdAt: 1 });
        const stranger = await issueSessionToken('str', SECRET);
        expect((await send('GET', `${ADMIN}/metrics`, stranger)).status).toBe(401);
        expect((await send('GET', `${ADMIN}/accounts`, stranger)).status).toBe(401);
    });
});

describe('read token: attacker checks', () => {
    it('path tricks land on a route and take that route\'s gate, never a neighbour\'s', async () => {
        const { send } = await setup();
        expect((await send('GET', `${ADMIN}/accounts/`, READ)).status).toBe(404);
        expect((await send('GET', `${ADMIN}/ACCOUNTS`, READ)).status).toBe(404);
        expect((await send('GET', `${ADMIN}/Metrics`, READ)).status).toBe(404);
        expect((await send('GET', `${ADMIN}/metrics/../accounts`, READ)).status).toBe(403);
        expect((await send('GET', `${ADMIN}/sessions/..%2Faccounts`, READ)).status).toBe(404);
        expect((await send('GET', `${ADMIN}//accounts`, READ)).status).toBe(404);
    });

    it('HEAD follows the GET gate; method-override headers and params are ignored', async () => {
        const { send, deps } = await setup();
        const headMetrics = await send('HEAD', `${ADMIN}/metrics`, READ);
        expect(headMetrics.status).toBe(200);
        expect(await headMetrics.text()).toBe('');
        expect((await send('HEAD', `${ADMIN}/accounts`, READ)).status).toBe(403);
        const overridden = await send('POST', `${ADMIN}/config`, READ, { freeSignupCredits: 0 }, { 'x-http-method-override': 'PUT' });
        expect(overridden.status).toBe(404);
        expect((await send('GET', `${ADMIN}/config?_method=PUT&freeSignupCredits=0`, READ)).status).toBe(200);
        expect((await send('GET', `${ADMIN}/grant`, READ, undefined, { 'x-http-method-override': 'POST' })).status).toBe(404);
        expect(deps.config.freeSignupCredits).toBe(20);
    });

    it('scheme case is tolerated as before; two credentials in one header match neither', async () => {
        const { app } = await setup();
        const get = (path: string, authorization: string) => app.request(path, { headers: { authorization } });
        expect((await get(`${ADMIN}/metrics`, `bearer ${READ}`)).status).toBe(200);
        expect((await get(`${ADMIN}/accounts`, `BEARER ${READ}`)).status).toBe(403);
        expect((await get(`${ADMIN}/accounts`, `Bearer ${READ}, Bearer ${FULL}`)).status).toBe(401);
        expect((await get(`${ADMIN}/accounts`, READ)).status).toBe(401);
    });

    it('is nobody outside the admin routes: every other route treats it as a garbage bearer', async () => {
        // No network: a route that would call out fails the same way for both.
        vi.stubGlobal('fetch', async () => {
            throw new Error('no network in this test');
        });
        const { app, send } = await setup();
        const garbage = 'x'.repeat(READ.length);
        const others = registered(app).filter((k) => !k.split(' ')[1]!.startsWith(ADMIN));
        expect(others.length).toBeGreaterThan(20);
        for (const key of others) {
            const [method, pattern] = key.split(' ') as [string, string];
            const path = pattern.replace(/:[A-Za-z]+/g, 'x').replace('*', 'x');
            const body = method === 'GET' || method === 'HEAD' ? undefined : {};
            const asRead = await send(method, path, READ, body);
            const asGarbage = await send(method, path, garbage, body);
            expect(asRead.status, key).toBe(asGarbage.status);
        }
        expect((await send('GET', '/cloud/v1/me', READ)).status).toBe(401);
    });
});

describe('read token: configuration', () => {
    const base = { ANTHROPIC_API_KEY: 'sk-test', ALOUD_ADMIN_TOKEN: FULL };

    it('is taken when long, distinct, and admin is on', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(loadConfig({ ...base, ALOUD_ADMIN_READ_TOKEN: READ }).adminReadToken).toBe(READ);
        expect(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ALOUD_ADMIN_EMAILS: 'a@b.c', ALOUD_ADMIN_READ_TOKEN: READ }).adminReadToken).toBe(READ);
        expect(warn).not.toHaveBeenCalled();
    });

    it('an empty value is unset, silently (the .env.example template line)', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(loadConfig({ ...base, ALOUD_ADMIN_READ_TOKEN: '' }).adminReadToken).toBeUndefined();
        expect(warn).not.toHaveBeenCalled();
    });

    it.each([
        ['short', { ...base, ALOUD_ADMIN_READ_TOKEN: 'too-short-0123456789' }, /shorter than 32/],
        ['the full token', { ...base, ALOUD_ADMIN_READ_TOKEN: FULL }, /same as ALOUD_ADMIN_TOKEN/],
        ['without admin on', { ANTHROPIC_API_KEY: 'sk-test', ALOUD_ADMIN_READ_TOKEN: READ }, /admin is off/],
    ])('is dropped with a warning (and the server still starts) when %s', (_name, env, reason) => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const config = loadConfig(env);
        expect(config.adminReadToken).toBeUndefined();
        expect(warn).toHaveBeenCalledTimes(1);
        const line = String(warn.mock.calls[0]![0]);
        expect(line).toMatch(/ALOUD_ADMIN_READ_TOKEN ignored/);
        expect(line).toMatch(reason);
        expect(line).not.toContain(env.ALOUD_ADMIN_READ_TOKEN);
    });

    it('is dropped in production too, rather than refusing to start', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const prod = {
            ALOUD_ENV: 'production', ALOUD_SESSION_SECRET: 's', GOOGLE_CLIENT_IDS: 'g', ALOUD_DB_PATH: '/tmp/x.db',
            ALOUD_CORS_ORIGINS: 'https://x', ANTHROPIC_API_KEY: 'sk', ALOUD_ADMIN_TOKEN: FULL,
        };
        expect(loadConfig({ ...prod, ALOUD_ADMIN_READ_TOKEN: FULL }).adminReadToken).toBeUndefined();
        expect(loadConfig({ ...prod, ALOUD_ADMIN_READ_TOKEN: READ }).adminReadToken).toBe(READ);
    });

    it('turns nothing on alone: with no full credential every admin route stays 404, to it too', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const app = createApp(buildDeps(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ALOUD_ADMIN_READ_TOKEN: READ })));
        for (const key of Object.keys(ROUTES)) {
            const { method, path, body } = requestFor(key);
            const res = await app.request(path, {
                method,
                headers: { authorization: `Bearer ${READ}`, 'content-type': 'application/json' },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            expect(res.status, key).toBe(404);
        }
    });
});

/**
 * The per-call view (admin/calls.ts + its routes): a session's calls in order,
 * cold cache rewrites flagged, facilitation spend split by token type, and -
 * the privacy line - only admin accounts' sessions ever itemized.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { buildSessionDetail, buildSessionList } from '../src/admin/calls.js';
import type { UsageEvent } from '../src/credits/usage.js';
import type { Incident } from '../src/credits/incidents.js';

const TOKEN = 'admin-token';
const FABLE = { provider: 'anthropic', model: 'claude-fable-5-1' };

function ev(over: Partial<UsageEvent> & Pick<UsageEvent, 'id' | 'ts'>): UsageEvent {
    return {
        accountId: 'adm', sessionId: 's1', passId: null, purpose: 'facilitation', kind: 'llm',
        ...FABLE, tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0,
        seconds: 0, chars: 0, providerCostUsd: 0, credits: 0,
        ...over,
    };
}

/** Warm turn, a 6-minute silence, then a cold rewrite; plus STT and a Haiku call. */
const SIT: UsageEvent[] = [
    ev({ id: 'a', ts: 1000, cacheCreation: 2300, tokensOut: 20, providerCostUsd: 0.03 }),
    ev({ id: 'b', ts: 1040, cacheRead: 2300, cacheCreation: 60, tokensOut: 16, providerCostUsd: 0.002 }),
    ev({ id: 'stt', ts: 1035, kind: 'stt', purpose: null, provider: 'google', model: 'chirp', seconds: 8, providerCostUsd: 0.001 }),
    ev({ id: 'util', ts: 1041, purpose: 'utility', model: 'claude-haiku-4-5-20251001', tokensIn: 300, providerCostUsd: 0.0005 }),
    ev({ id: 'c', ts: 1400, cacheCreation: 2400, cacheCreation1h: 400, tokensOut: 18, providerCostUsd: 0.04 }),
];

describe('buildSessionDetail', () => {
    const d = buildSessionDetail(SIT, [], 's1')!;

    it('orders the calls and times facilitation gaps against the previous facilitation call', () => {
        expect(d.calls.map((c) => c.role)).toEqual(['facilitation', 'stt', 'facilitation', 'utility', 'facilitation']);
        const fac = d.calls.filter((c) => c.role === 'facilitation');
        expect(fac.map((c) => c.gapSec)).toEqual([null, 40, 360]);
    });

    it('flags a call that wrote more cache than it read, never the first', () => {
        expect(d.calls.filter((c) => c.cold).map((c) => c.ts)).toEqual([1400]);
        expect(d.session.coldCalls).toBe(1);
    });

    it('splits spend by leg and facilitation spend by token type', () => {
        expect(d.session.turns).toBe(3);
        expect(d.session.costUsd.facilitation).toBeCloseTo(0.072);
        expect(d.session.costUsd.stt).toBeCloseTo(0.001);
        expect(d.session.costUsd.utility).toBeCloseTo(0.0005);
        expect(d.facilitationTokens).toEqual({ input: 0, output: 54, cacheRead: 2300, cacheWrite: 4360, cacheWrite1h: 400 });
        // Fable: $50/M out, $0.25/M read, $12.50/M 5m write, $20/M 1h write.
        expect(d.facilitationCosts.output).toBeCloseTo(54 * 50e-6);
        expect(d.facilitationCosts.cacheWrite).toBeCloseTo(4360 * 12.5e-6);
        expect(d.facilitationCosts.cacheWrite1h).toBeCloseTo(400 * 20e-6);
    });

    it("carries the session's own incidents only", () => {
        const inc = (id: string, sessionId: string): Incident => ({
            id, ts: 1400, accountId: 'adm', sessionId, kind: 'llm_max_tokens', source: 'server',
            provider: 'anthropic', model: 'claude-fable-5-1', detail: 'finish=max_tokens',
        });
        expect(buildSessionDetail(SIT, [inc('i1', 's1'), inc('i2', 's2')], 's1')!.incidents.map((i) => i.id)).toEqual(['i1']);
    });

    it('returns null for an unknown session', () => {
        expect(buildSessionDetail(SIT, [], 'nope')).toBeNull();
    });
});

describe('buildSessionList', () => {
    it('lists sessions newest first, skipping rows without a session id and older starts', () => {
        const rows = [
            ...SIT,
            ev({ id: 'x', ts: 5000, sessionId: 's2' }),
            ev({ id: 'y', ts: 9000, sessionId: null }),
            ev({ id: 'z', ts: 10, sessionId: 'old' }),
        ];
        expect(buildSessionList(rows, 500).map((s) => s.sessionId)).toEqual(['s2', 's1']);
    });
});

describe('per-call routes', () => {
    async function setup() {
        const store = new MemoryCreditsStore();
        const config = loadConfig({
            ANTHROPIC_API_KEY: 'sk-test',
            ALOUD_ADMIN_TOKEN: TOKEN,
            ALOUD_ADMIN_EMAILS: 'admin@example.com',
        });
        const app = createApp(buildDeps(config, { store }));
        await store.createAccount({ id: 'adm', email: 'admin@example.com', emailVerified: true, createdAt: 1 });
        await store.createAccount({ id: 'usr', email: 'user@example.com', emailVerified: true, createdAt: 1 });
        const now = Date.now() / 1000;
        await store.appendUsage(ev({ id: 'a', ts: now - 60, sessionId: 'mine' }));
        await store.appendUsage(ev({ id: 'b', ts: now - 60, sessionId: 'theirs', accountId: 'usr' }));
        const get = (path: string) => app.request(`/cloud/v1/admin${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
        return { app, get };
    }

    it('lists and itemizes admin-account sessions only', async () => {
        const { get } = await setup();
        const list = (await (await get('/sessions')).json()) as { sessions: Array<{ sessionId: string; account: string }> };
        expect(list.sessions.map((s) => [s.sessionId, s.account])).toEqual([['mine', 'admin']]);
        expect((await get('/sessions/mine')).status).toBe(200);
        expect((await get('/sessions/theirs')).status).toBe(404);
    });

    it('gates the data and serves the page shell', async () => {
        const { app } = await setup();
        expect((await app.request('/cloud/v1/admin/sessions')).status).toBe(401);
        const page = await app.request('/cloud/v1/admin/calls');
        expect(page.status).toBe(200);
        expect(await page.text()).toContain('aloud - calls');
    });
});

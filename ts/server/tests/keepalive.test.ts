/**
 * POST /cloud/v1/llm/keepalive (meditation-pal-wb0j): a max_tokens 0 read
 * that keeps a quiet session's prompt cache alive. Checked like a turn,
 * billed at the provider's cost, tagged purpose 'keepalive', and a no-op that
 * charges nothing wherever a ping can't help.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps, type Deps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { Forwarder, type ForwardOptions } from '../src/providers/forward.js';
import type { AuthResponse, KeepAliveResponse } from '../src/contract.js';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { priceLlmTurn } from '../src/pricing/meter.js';
import { RateGuard } from '../src/quota/freetier.js';
import type { CompletionResult, Message } from '@aloud/core/llm';

const SYSTEM = 'You are a meditation facilitator.';
const MESSAGES: Message[] = [
    { role: 'user', content: 'Open the session warmly.' },
    { role: 'assistant', content: 'Welcome.' },
    { role: 'user', content: 'I feel scattered.' },
];

const WARM: CompletionResult = {
    text: '',
    finishReason: 'max_tokens',
    tokensUsed: 4,
    inputTokens: 4,
    outputTokens: 0,
    cacheReadTokens: 6000,
    cacheCreationTokens: 0,
    cacheCreation1hTokens: 0,
};

interface Ping {
    messages: Message[];
    opts: ForwardOptions & { system?: string };
}

function fakeForwarder(result: CompletionResult | Error = WARM): { forwarder: Forwarder; pings: Ping[] } {
    const pings: Ping[] = [];
    const forwarder = {
        async keepAlive(messages: Message[], opts: ForwardOptions & { system?: string }) {
            pings.push({ messages, opts });
            if (result instanceof Error) throw result;
            return result;
        },
        async complete() {
            throw new Error('a ping never asks for a reply');
        },
        // eslint-disable-next-line require-yield
        async *stream() {
            throw new Error('a ping never asks for a reply');
        },
    } as unknown as Forwarder;
    return { forwarder, pings };
}

interface Harness {
    deps: Deps;
    app: ReturnType<typeof createApp>;
    token: string;
    accountId: string;
}

async function setup(forwarder: Forwarder, env: Record<string, string> = {}): Promise<Harness> {
    const config = loadConfig({
        ALOUD_ENABLE_DEV_AUTH: '1',
        ANTHROPIC_API_KEY: 'sk-test',
        GEMINI_API_KEY: 'gk-test',
        ALOUD_FREE_SIGNUP_CREDITS: '20',
        ...env,
    });
    const deps = buildDeps(config, { store: new MemoryCreditsStore() });
    deps.forwarder = forwarder;
    const app = createApp(deps);
    const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    const token = ((await res.json()) as AuthResponse).token;
    const accountId = (await deps.store.allAccounts())[0]!.id;
    return { deps, app, token, accountId };
}

function keepalive(h: Harness, body: Record<string, unknown> = {}, token = h.token) {
    return h.app.request('/cloud/v1/llm/keepalive', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            messages: MESSAGES,
            system: SYSTEM,
            sessionId: 'sess-1',
            ...body,
        }),
    });
}

describe('POST /cloud/v1/llm/keepalive', () => {
    it('forwards the request, bills its exact provider cost and records a keepalive row', async () => {
        const { forwarder, pings } = fakeForwarder();
        const h = await setup(forwarder);
        const res = await keepalive(h);
        expect(res.status).toBe(200);
        const body = (await res.json()) as KeepAliveResponse;

        expect(pings).toEqual([{ messages: MESSAGES, opts: { provider: 'anthropic', model: 'claude-opus-5-5', system: SYSTEM } }]);
        const cost = priceLlmTurn('anthropic', 'claude-opus-5-5', {
            tokensIn: 4,
            tokensOut: 0,
            cacheRead: 6000,
            cacheCreation: 0,
            cacheCreation1h: 0,
        });
        expect(cost.credits).toBeGreaterThan(0);
        expect(cost.credits).toBeLessThan(0.1);
        expect(body.kept).toBe(true);
        expect(body.creditsCharged).toBeCloseTo(cost.credits, 12);
        expect(body.creditsRemaining).toBeCloseTo(20 - cost.credits, 12);
        expect(await h.deps.ledger.balance(h.accountId)).toBeCloseTo(20 - cost.credits, 12);

        const usage = await h.deps.store.allUsage();
        expect(usage).toHaveLength(1);
        expect(usage[0]).toMatchObject({
            accountId: h.accountId,
            sessionId: 'sess-1',
            purpose: 'keepalive',
            kind: 'llm',
            provider: 'anthropic',
            model: 'claude-opus-5-5',
            tokensIn: 4,
            tokensOut: 0,
            cacheRead: 6000,
            cacheCreation: 0,
            passId: null,
        });
        expect(usage[0]!.providerCostUsd).toBeCloseTo(cost.providerCostUsd, 15);
        expect(usage[0]!.credits).toBeCloseTo(cost.credits, 12);
    });

    it('a ping that found no entry is billed for what it wrote, and answers kept: false', async () => {
        const cold: CompletionResult = { ...WARM, cacheReadTokens: 0, cacheCreationTokens: 6000 };
        const h = await setup(fakeForwarder(cold).forwarder);
        const body = (await (await keepalive(h)).json()) as KeepAliveResponse;
        expect(body.kept).toBe(false);
        const cost = priceLlmTurn('anthropic', 'claude-opus-5-5', { tokensIn: 4, cacheCreation: 6000 });
        expect(body.creditsCharged).toBeCloseTo(cost.credits, 12);
        expect((await h.deps.store.allUsage())[0]!.purpose).toBe('keepalive');
    });

    it('answers a model of another provider at once: nothing forwarded, looked up or charged', async () => {
        const { forwarder, pings } = fakeForwarder();
        const h = await setup(forwarder);
        const res = await keepalive(h, { provider: 'google', model: 'gemini-3.5-flash-lite' });
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ kept: false, creditsCharged: 0 });
        expect(pings).toHaveLength(0);
        expect(await h.deps.store.allUsage()).toHaveLength(0);
        expect(await h.deps.ledger.balance(h.accountId)).toBe(20);
    });

    it('checks the request as /complete does', async () => {
        const { forwarder, pings } = fakeForwarder();
        const h = await setup(forwarder);
        const notAllowed = await keepalive(h, { model: 'claude-not-a-model' });
        expect(notAllowed.status).toBe(400);
        expect(((await notAllowed.json()) as { error: { code: string } }).error.code).toBe('model_not_allowed');
        expect((await keepalive(h, { messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })).status).toBe(400);
        expect((await keepalive(h, { system: 42 })).status).toBe(400);
        expect((await keepalive(h, { provider: 'nobody' })).status).toBe(400);
        expect((await keepalive(h, {}, 'not-a-token')).status).toBe(401);
        expect(pings).toHaveLength(0);
    });

    it('does nothing and charges nothing for a paused account', async () => {
        const { forwarder, pings } = fakeForwarder();
        const h = await setup(forwarder, { ALOUD_METERED_PAUSED: '1' });
        const body = (await (await keepalive(h)).json()) as KeepAliveResponse;
        expect(body).toEqual({ kept: false, creditsCharged: 0, creditsRemaining: 20 });
        expect(pings).toHaveLength(0);
        expect(await h.deps.store.allUsage()).toHaveLength(0);
    });

    it('does nothing and charges nothing on an empty balance', async () => {
        const { forwarder, pings } = fakeForwarder();
        const h = await setup(forwarder);
        await h.deps.ledger.debit(h.accountId, 20, 'test: spend it all');
        const body = (await (await keepalive(h)).json()) as KeepAliveResponse;
        expect(body).toEqual({ kept: false, creditsCharged: 0, creditsRemaining: 0 });
        expect(pings).toHaveLength(0);
        expect(await h.deps.store.allUsage()).toHaveLength(0);
        // And no incident row: a quiet no-op, not a refusal.
        expect(await h.deps.store.incidentsSince(0)).toHaveLength(0);
    });

    it('does nothing when the balance could not cover the prompt written again in full', async () => {
        const { forwarder, pings } = fakeForwarder();
        const h = await setup(forwarder);
        await h.deps.ledger.debit(h.accountId, 19.99, 'test: nearly empty');
        const long = [{ role: 'user', content: 'x'.repeat(30_000) }];
        const body = (await (await keepalive(h, { messages: long })).json()) as KeepAliveResponse;
        expect(body.kept).toBe(false);
        expect(body.creditsCharged).toBe(0);
        expect(pings).toHaveLength(0);
        expect(h.deps.upfrontPending.openFor(h.accountId)).toBe(0);
    });

    it('a retreat pass covers it: no debit, the row tagged with the pass', async () => {
        const h = await setup(fakeForwarder().forwarder);
        const now = Date.now() / 1000;
        await h.deps.store.createRetreatPass({
            id: 'pass-1',
            label: 'Spring Retreat',
            startsAt: now - 100,
            endsAt: now + 3600,
            perAttendeeDailyCap: null,
            status: 'active',
            createdAt: now - 200,
        });
        await h.deps.store.addRetreatMember({ passId: 'pass-1', accountId: h.accountId, joinedAt: now - 50 });
        const body = (await (await keepalive(h)).json()) as KeepAliveResponse;
        expect(body.kept).toBe(true);
        expect(body.creditsCharged).toBe(0);
        expect(await h.deps.ledger.balance(h.accountId)).toBe(20);
        const row = (await h.deps.store.allUsage())[0]!;
        expect(row.passId).toBe('pass-1');
        expect(row.purpose).toBe('keepalive');
        expect(row.credits).toBeGreaterThan(0);
    });

    it('shares the per-account rate guard', async () => {
        const { forwarder, pings } = fakeForwarder();
        const h = await setup(forwarder);
        h.deps.rateGuard = new RateGuard(1);
        expect((await keepalive(h)).status).toBe(200);
        expect((await keepalive(h)).status).toBe(429);
        expect(pings).toHaveLength(1);
    });

    it('an upstream failure charges nothing and leaves one content-free incident', async () => {
        const h = await setup(fakeForwarder(new Error('Anthropic API error 400: bad')).forwarder);
        const res = await keepalive(h);
        expect(res.status).toBe(502);
        expect(await h.deps.ledger.balance(h.accountId)).toBe(20);
        expect(await h.deps.store.allUsage()).toHaveLength(0);
        expect(h.deps.upfrontPending.openFor(h.accountId)).toBe(0);
        const incidents = await h.deps.store.incidentsSince(0);
        expect(incidents).toHaveLength(1);
        expect(incidents[0]!.kind).toBe('llm_error');
        expect(incidents[0]!.detail).toMatch(/^keepalive: /);
        expect(incidents[0]!.detail).not.toContain('scattered');
    });
});

describe('Forwarder.keepAlive', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    it("sends the turn's request byte for byte, but max_tokens 0 and not streamed", async () => {
        const bodies: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            bodies.push(JSON.parse(init!.body as string));
            return new Response(
                JSON.stringify({ content: [{ type: 'text', text: 'Mm.' }], stop_reason: 'end_turn', usage: { input_tokens: 4, output_tokens: 2 } }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            );
        }) as typeof fetch;
        const forwarder = new Forwarder({ anthropic: 'sk-test' });
        const opts = { provider: 'anthropic' as const, model: 'claude-opus-5-5', system: SYSTEM };
        await forwarder.complete(MESSAGES, { ...opts, maxTokens: 1024 });
        await forwarder.keepAlive(MESSAGES, opts);
        const [turn, ping] = bodies as [Record<string, unknown>, Record<string, unknown>];
        expect(ping['max_tokens']).toBe(0);
        const { max_tokens: _a, ...turnRest } = turn;
        const { max_tokens: _b, ...pingRest } = ping;
        expect(pingRest).toEqual(turnRest);
    });

    it('refuses a provider with no keep-alive', async () => {
        const forwarder = new Forwarder({ google: 'gk-test' });
        await expect(
            forwarder.keepAlive(MESSAGES, { provider: 'google', model: 'gemini-3.5-flash-lite' })
        ).rejects.toThrow(/no keep-alive/);
    });
});

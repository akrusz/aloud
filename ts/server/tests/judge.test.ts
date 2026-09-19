import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { Hono } from 'hono';
import { createApp } from '../src/app.js';
import { judgeRoutes } from '../src/routes/judge.js';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import type { AuthResponse, JudgeResponse } from '../src/contract.js';
import { VOICE_COMMAND_IDS } from '@aloud/core/facilitation';

// Stub TypeSafe so the route never hits the network; records what was asked.
let calls: Array<{ auth: string | null; body: any }> = [];
let reply: (body: any) => Response;
const realFetch = globalThis.fetch;

beforeEach(() => {
    calls = [];
    // Answers every question asked, so one stub serves all three classifiers.
    reply = (body) =>
        new Response(
            JSON.stringify({
                model: 'jev-1.13.0',
                answers: Object.fromEntries(Object.keys(body.questions).map((k) => [k, { type: 'noul', noul: 0.93 }])),
                usage: { input_tokens: 400, output_tokens: 12 },
            }),
            { status: 200 }
        );
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('api.typesafe.ai')) {
            const body = JSON.parse(String(init?.body));
            calls.push({ auth: new Headers(init?.headers).get('authorization'), body });
            return reply(body);
        }
        return realFetch(url, init);
    }) as typeof fetch;
});

afterAll(() => {
    globalThis.fetch = realFetch;
});

function app(env: Record<string, string> = { TYPESAFE_API_KEY: 'ts-test' }) {
    const store = new MemoryCreditsStore();
    const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', OPENAI_API_KEY: 'sk-test', ...env });
    return { a: createApp(buildDeps(config, { store })), store };
}

async function devToken(a: ReturnType<typeof createApp>): Promise<string> {
    const res = await a.request('/cloud/v1/auth/dev', { method: 'POST' });
    return ((await res.json()) as AuthResponse).token;
}

function post(a: ReturnType<typeof createApp>, token: string | null, body: unknown) {
    return a.request('/cloud/v1/judge', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
}

describe('POST /cloud/v1/judge', () => {
    it('asks the named classifier as a noul over the utterance and returns P(yes)', async () => {
        const { a } = app();
        const res = await post(a, await devToken(a), { classifier: 'resume', text: "  Okay, I'm back.  " });
        expect(res.status).toBe(200);
        const data = (await res.json()) as JudgeResponse;
        expect(data.answers).toEqual({ addressed: 0.93, done: 0.93 });
        expect(data.model).toBe('jev-1.13.0');

        expect(calls).toHaveLength(1);
        expect(calls[0]!.auth).toBe('Bearer ts-test');
        expect(calls[0]!.body.model).toBe('jev-latest');
        expect(calls[0]!.body.state.utterance).toBe("Okay, I'm back.");
        expect(calls[0]!.body.state).not.toHaveProperty('earlier_in_this_silence');
        expect(calls[0]!.body.questions.done.type).toBe('noul');
        expect(calls[0]!.body.questions.done.criteria.true.examples).toContain("Let's keep going.");
    });

    it('passes earlier utterances for resume only, clamped to the most recent', async () => {
        const { a } = app();
        const token = await devToken(a);
        const earlier = ['one', 2, 'two', 'three', 'four', 'five', 'six', 'seven'];
        await post(a, token, { classifier: 'resume', text: 'Alright.', earlier });
        expect(calls[0]!.body.state.earlier_in_this_silence).toEqual(['two', 'three', 'four', 'five', 'six', 'seven']);
        await post(a, token, { classifier: 'hold-confirm', text: 'Yes.', earlier });
        expect(calls[1]!.body.state).not.toHaveProperty('earlier_in_this_silence');
    });

    it('answers the voice-command set as one request, one ask per command', async () => {
        const { a } = app();
        const res = await post(a, await devToken(a), { classifier: 'command', text: 'Set a timer for ten minutes.' });
        expect(res.status).toBe(200);
        expect(Object.keys(((await res.json()) as JudgeResponse).answers).sort()).toEqual(
            [...VOICE_COMMAND_IDS].sort()
        );
        expect(calls).toHaveLength(1);
        expect((await post(a, await devToken(a), { classifier: 'end-confirm', text: 'Yes.' })).status).toBe(200);
    });

    it('records usage at provider cost without charging credits', async () => {
        const { a, store } = app();
        await post(a, await devToken(a), { classifier: 'hold-confirm', text: 'Yes, please.', sessionId: 's1' });
        const events = await store.allUsage();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: 'llm', provider: 'typesafe', sessionId: 's1', tokensIn: 400, credits: 0 });
        expect(events[0]!.providerCostUsd).toBeCloseTo(400 * 42e-9, 12);
    });

    it('requires auth', async () => {
        const { a } = app();
        expect((await post(a, null, { classifier: 'resume', text: 'hi' })).status).toBe(401);
        expect(calls).toHaveLength(0);
    });

    it('rejects an unknown classifier or empty text without calling upstream', async () => {
        const { a } = app();
        const token = await devToken(a);
        expect((await post(a, token, { classifier: 'anything', text: 'hi' })).status).toBe(400);
        expect((await post(a, token, { classifier: 'resume', text: '   ' })).status).toBe(400);
        expect(calls).toHaveLength(0);
    });

    it('is a provider error when no key is configured, so clients fall back', async () => {
        const { a } = app({});
        const res = await post(a, await devToken(a), { classifier: 'resume', text: 'hi' });
        expect(res.status).toBe(502);
        expect(calls).toHaveLength(0);
    });

    it('is a provider error on an upstream failure or a malformed answer', async () => {
        const { a } = app();
        const token = await devToken(a);
        reply = () => new Response('overloaded', { status: 529 });
        expect((await post(a, token, { classifier: 'resume', text: 'hi' })).status).toBe(502);
        // One of resume's two asks missing: a partial answer is a failure, not a no.
        reply = () => new Response(JSON.stringify({ answers: { done: { type: 'noul', noul: 0.9 } } }), { status: 200 });
        expect((await post(a, token, { classifier: 'resume', text: 'hi' })).status).toBe(502);
    });

    it('has its own rate budget: exhausting it leaves LLM turns alone, and vice versa', async () => {
        const { a } = app();
        const token = await devToken(a);
        let last = 200;
        for (let i = 0; i < 95 && last === 200; i++) last = (await post(a, token, { classifier: 'resume', text: 'hi' })).status;
        expect(last).toBe(429);
        const llm = await a.request('/cloud/v1/llm/complete', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({}),
        });
        // Refused for its empty body, not for rate: the shared guard is untouched.
        expect(llm.status).toBe(400);
    });

    it('records one content-free judge_error a minute, with a count of the rest', async () => {
        const { a, store } = app();
        const token = await devToken(a);
        reply = () => new Response('you said: my secret utterance', { status: 529 });
        for (let i = 0; i < 4; i++) await post(a, token, { classifier: 'command', text: 'my secret utterance' });
        const rows = (await store.incidentsSince(0)).filter((r) => r.kind === 'judge_error');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ provider: 'typesafe', model: 'command', detail: 'http_529' });
        expect(JSON.stringify(rows)).not.toContain('secret');
    });

    it('carries the suppressed count into the next window', async () => {
        const store = new MemoryCreditsStore();
        const deps = buildDeps(loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', OPENAI_API_KEY: 'sk-test', TYPESAFE_API_KEY: 'ts-test' }), { store });
        const token = await devToken(createApp(deps));
        let clock = 1_000_000;
        const routes = new Hono().route('/j', judgeRoutes(deps, () => clock));
        const fail = () =>
            routes.request('/j', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ classifier: 'resume', text: 'hi' }),
            });
        reply = () => new Response('', { status: 429 });
        await fail();
        await fail();
        await fail();
        clock += 61_000;
        await fail();
        const details = (await store.incidentsSince(0)).filter((r) => r.kind === 'judge_error').map((r) => r.detail);
        expect(details.sort()).toEqual(['http_429', 'http_429 (+2 more since the last row)']);
    });

    it('advertises itself on /health only when configured', async () => {
        expect(((await (await app().a.request('/health')).json()) as { judge: boolean }).judge).toBe(true);
        expect(((await (await app({}).a.request('/health')).json()) as { judge: boolean }).judge).toBe(false);
    });
});

/**
 * What an account can make the server spend past its balance.
 *
 * The LLM hold is deliberately smaller than a turn's estimate at a small
 * balance, and the settle absorbs the difference, so a near-empty account still
 * finishes its last turn (meditation-pal-hd24). Unbounded, that was also a way
 * to run an oversized prompt on the priciest model for nothing, many at once.
 * These pin the ceiling (MAX_UNCOVERED_CREDITS) and its upfront-leg twin: STT
 * and TTS calls arriving together must not each be admitted on one balance.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps, type Deps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { InFlightSum } from '../src/quota/in-flight.js';
import {
    estimateTurnCredits,
    holdTarget,
    MAX_OUTPUT_TOKENS,
    MAX_UNCOVERED_CREDITS,
    SESSION_HOLD_CREDITS,
} from '../src/pricing/meter.js';
import type { Forwarder } from '../src/providers/forward.js';
import type { AuthResponse } from '../src/contract.js';

describe('InFlightSum', () => {
    it('admits up to the ceiling and gives the room back on release', () => {
        const sum = new InFlightSum();
        const a = sum.tryAdd('acct', 6, 10);
        expect(a).not.toBeNull();
        expect(sum.tryAdd('acct', 5, 10)).toBeNull(); // 6 + 5 > 10
        const b = sum.tryAdd('acct', 4, 10);
        expect(b).not.toBeNull();
        a!();
        a!(); // idempotent: a second release must not free someone else's room
        expect(sum.openFor('acct')).toBeCloseTo(4, 9);
        b!();
        expect(sum.openFor('acct')).toBe(0);
    });

    it('keeps accounts apart', () => {
        const sum = new InFlightSum();
        expect(sum.tryAdd('a', 10, 10)).not.toBeNull();
        expect(sum.tryAdd('b', 10, 10)).not.toBeNull();
    });

    it('always admits nothing-to-add, never a non-number', () => {
        const sum = new InFlightSum();
        expect(sum.tryAdd('a', 0, 0)).not.toBeNull();
        expect(sum.tryAdd('a', -3, 0)).not.toBeNull();
        expect(sum.tryAdd('a', NaN, 10)).toBeNull();
        expect(sum.tryAdd('a', Infinity, 10)).toBeNull();
        expect(sum.openFor('a')).toBe(0);
    });
});

describe('holdTarget', () => {
    it('is the estimate up to the cap, as before', () => {
        expect(holdTarget(0.4)).toBe(0.4);
        expect(holdTarget(SESSION_HOLD_CREDITS)).toBe(SESSION_HOLD_CREDITS);
        expect(holdTarget(SESSION_HOLD_CREDITS + 3)).toBe(SESSION_HOLD_CREDITS);
    });
    it('grows past cap + ceiling so an oversized turn is never under-held by more than the ceiling', () => {
        const estimate = SESSION_HOLD_CREDITS + MAX_UNCOVERED_CREDITS + 15;
        expect(holdTarget(estimate)).toBe(estimate - MAX_UNCOVERED_CREDITS);
    });
});

// ---- the LLM route -----------------------------------------------------------

const PROVIDER = 'anthropic';
const MODEL = 'claude-3-opus-20240229'; // the priciest input rate in the table

/** Counts forwards and answers each with a turn whose real cost is far above
 *  any balance these tests grant, the way a cold, maximal prompt would bill. */
function costlyForwarder(log: { calls: number }, gate?: Promise<void>): Forwarder {
    const result = {
        text: 'Breathe.',
        finishReason: 'stop' as const,
        inputTokens: 150_000,
        outputTokens: 400,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
    };
    return {
        async complete() {
            log.calls++;
            if (gate) await gate;
            return result;
        },
        async *stream() {
            log.calls++;
            if (gate) await gate;
            yield { ...result, done: true };
        },
    } as unknown as Forwarder;
}

async function llmSetup(forwarder: Forwarder, credits: number) {
    const config = loadConfig({
        ALOUD_ENABLE_DEV_AUTH: '1',
        ANTHROPIC_API_KEY: 'sk-test',
        ALOUD_FREE_SIGNUP_CREDITS: '0',
    });
    const deps = buildDeps(config);
    deps.forwarder = forwarder;
    const app = createApp(deps);
    const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    const token = ((await res.json()) as AuthResponse).token;
    const accountId = (await deps.store.allAccounts())[0]!.id;
    if (credits > 0) await deps.ledger.grant(accountId, credits, 'test');
    return { deps, app, token, accountId };
}

function complete(app: ReturnType<typeof createApp>, token: string, body: Record<string, unknown>) {
    return app.request('/cloud/v1/llm/complete', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider: PROVIDER, model: MODEL, ...body }),
    });
}

/** An ordinary sit's turn: a few-thousand-token system prompt and some turns. */
const ordinary = {
    system: 'x'.repeat(9_000),
    messages: [
        { role: 'user', content: 'y'.repeat(300) },
        { role: 'assistant', content: 'z'.repeat(300) },
        { role: 'user', content: 'y'.repeat(300) },
    ],
};

/** A prompt sized to cost several dollars uncached on this model. */
const oversized = { messages: [{ role: 'user', content: 'x'.repeat(600_000) }] };

describe('POST /cloud/v1/llm/complete: overdraft ceiling', () => {
    it("still serves a near-empty account's last ordinary turn, absorbing the overage", async () => {
        const log = { calls: 0 };
        const { deps, app, token, accountId } = await llmSetup(costlyForwarder(log), 0.05);
        // The premise: this turn estimates well past the balance, and under the ceiling.
        const estimate = estimateTurnCredits(
            PROVIDER,
            MODEL,
            [ordinary.system, ...ordinary.messages.map((m) => m.content)],
            MAX_OUTPUT_TOKENS
        );
        expect(estimate).toBeGreaterThan(0.05);
        expect(estimate).toBeLessThan(MAX_UNCOVERED_CREDITS);

        const res = await complete(app, token, ordinary);
        expect(res.status).toBe(200);
        expect(log.calls).toBe(1);
        // Debited what there was, never below zero.
        expect(await deps.ledger.balance(accountId)).toBe(0);
        expect(deps.overdraft.openFor(accountId)).toBe(0);
    });

    it('refuses an oversized prompt a small balance cannot stand behind, before any provider call', async () => {
        const log = { calls: 0 };
        const { deps, app, token, accountId } = await llmSetup(costlyForwarder(log), 0.05);
        const res = await complete(app, token, oversized);
        expect(res.status).toBe(402);
        expect(((await res.json()) as { error: { code: string } }).error.code).toBe('insufficient_credits');
        expect(log.calls).toBe(0);
        // Nothing held, nothing left open.
        expect(await deps.ledger.balance(accountId)).toBeCloseTo(0.05, 9);
        expect(deps.overdraft.openFor(accountId)).toBe(0);
    });

    it('serves the same oversized prompt to an account that can pay for it, holding enough to cover it', async () => {
        const log = { calls: 0 };
        const { deps, app, token, accountId } = await llmSetup(costlyForwarder(log), 500);
        const res = await complete(app, token, oversized);
        expect(res.status).toBe(200);
        expect(log.calls).toBe(1);
        // Charged the real cost: 150K in at $15/M + 400 out at $75/M = $2.28.
        expect(await deps.ledger.balance(accountId)).toBeCloseTo(500 - 2.28 / 0.05, 6);
    });

    it('bounds a burst on one small balance to the ceiling, not to the rate limit', async () => {
        const log = { calls: 0 };
        let open!: () => void;
        const gate = new Promise<void>((r) => (open = r));
        const { deps, app, token, accountId } = await llmSetup(costlyForwarder(log, gate), 0.05);

        // Each turn estimates at a couple of credits; before the ceiling every
        // one of these held half of what the last left and was forwarded.
        const perTurn = estimateTurnCredits(
            PROVIDER,
            MODEL,
            [ordinary.system, ...ordinary.messages.map((m) => m.content)],
            MAX_OUTPUT_TOKENS
        );
        const burst = Array.from({ length: 30 }, () => complete(app, token, ordinary));
        // Let every request reach its gate before any provider call returns.
        await new Promise((r) => setTimeout(r, 50));
        expect(log.calls).toBeGreaterThan(0);
        expect(log.calls).toBeLessThanOrEqual(Math.floor(MAX_UNCOVERED_CREDITS / (perTurn - 0.05)) + 1);
        expect(deps.overdraft.openFor(accountId)).toBeLessThanOrEqual(MAX_UNCOVERED_CREDITS);

        open();
        const statuses = (await Promise.all(burst)).map((r) => r.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(log.calls);
        expect(statuses.filter((s) => s === 402)).toHaveLength(30 - log.calls);
        expect(await deps.ledger.balance(accountId)).toBe(0);
        expect(deps.overdraft.openFor(accountId)).toBe(0);
    });

    it('gives the room back when the provider call fails', async () => {
        const failing = {
            async complete() {
                throw new Error('upstream 500');
            },
        } as unknown as Forwarder;
        const { deps, app, token, accountId } = await llmSetup(failing, 0.05);
        const res = await complete(app, token, ordinary);
        expect(res.status).toBe(502);
        expect(deps.overdraft.openFor(accountId)).toBe(0);
        expect(await deps.ledger.balance(accountId)).toBeCloseTo(0.05, 9);
    });

    it('gives the room back when a stream ends without usage', async () => {
        const truncated = {
            async *stream() {
                yield { text: 'Breathe', done: false };
            },
        } as unknown as Forwarder;
        const { deps, app, token, accountId } = await llmSetup(truncated, 0.05);
        const res = await complete(app, token, { ...ordinary, stream: true });
        await res.text();
        expect(deps.overdraft.openFor(accountId)).toBe(0);
        expect(await deps.ledger.balance(accountId)).toBeCloseTo(0.05, 9);
    });
});

describe('POST /cloud/v1/llm/complete: request shape', () => {
    it('rejects content that is not a string (blocks would be forwarded but estimate as nothing)', async () => {
        const log = { calls: 0 };
        const { app, token } = await llmSetup(costlyForwarder(log), 20);
        for (const content of [[{ type: 'text', text: 'x'.repeat(100_000) }], { text: 'hi' }, 42, null]) {
            const res = await complete(app, token, { messages: [{ role: 'user', content }] });
            expect(res.status).toBe(400);
        }
        const badRole = await complete(app, token, { messages: [{ role: 'tool', content: 'hi' }] });
        expect(badRole.status).toBe(400);
        const badSystem = await complete(app, token, { system: ['x'], messages: [{ role: 'user', content: 'hi' }] });
        expect(badSystem.status).toBe(400);
        expect(log.calls).toBe(0);
    });

    it('treats a non-numeric maxTokens as unspecified instead of holding NaN', async () => {
        const log = { calls: 0 };
        const { deps, app, token, accountId } = await llmSetup(costlyForwarder(log), 500);
        const res = await complete(app, token, { ...ordinary, maxTokens: 'lots' });
        expect(res.status).toBe(200);
        const balance = await deps.ledger.balance(accountId);
        expect(Number.isFinite(balance)).toBe(true);
        expect(balance).toBeLessThan(500); // and it was charged
        for (const entry of await deps.store.listEntries(accountId)) {
            expect(Number.isFinite(entry.amount)).toBe(true);
        }
    });
});

describe('Ledger', () => {
    function ledgerDeps(): Deps {
        return buildDeps(loadConfig({ ANTHROPIC_API_KEY: 'sk-test' }));
    }
    async function account(d: Deps): Promise<string> {
        await d.store.createAccount({ id: 'acct', email: 'a@example.com', emailVerified: true, createdAt: 1 });
        return 'acct';
    }

    it('refuses a non-finite amount, which would turn every later balance check into a pass', async () => {
        const d = ledgerDeps();
        const id = await account(d);
        await d.ledger.grant(id, 5, 'test');
        await expect(d.ledger.placeHold(id, NaN, 'turn')).rejects.toThrow(/non-finite/);
        await expect(d.ledger.grant(id, Infinity, 'test')).rejects.toThrow(/non-finite/);
        expect(await d.ledger.balance(id)).toBe(5);
    });

    it('debitUpTo takes what is there and never overdraws', async () => {
        const d = ledgerDeps();
        const id = await account(d);
        await d.ledger.grant(id, 1, 'test');
        expect(await d.ledger.debitUpTo(id, 0.4, 'tts')).toBeCloseTo(0.4, 9);
        expect(await d.ledger.debitUpTo(id, 5, 'tts')).toBeCloseTo(0.6, 9);
        expect(await d.ledger.debitUpTo(id, 5, 'tts')).toBe(0);
        expect(await d.ledger.balance(id)).toBeCloseTo(0, 9);
    });
});

// ---- the upfront legs --------------------------------------------------------

const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
const realFetch = globalThis.fetch;
let ttsCalls = 0;
let sttCalls = 0;
let releaseProvider: () => void = () => undefined;
let providerGate: Promise<void> | null = null;
let failProvider = false;

beforeEach(() => {
    ttsCalls = 0;
    sttCalls = 0;
    providerGate = null;
    failProvider = false;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        const tts = u.includes('texttospeech.googleapis.com');
        const stt = u.includes('api.openai.com');
        if (!tts && !stt) return realFetch(url, init);
        if (tts) ttsCalls++;
        else sttCalls++;
        if (providerGate) await providerGate;
        if (failProvider) return new Response('boom', { status: 500 });
        return tts
            ? new Response(JSON.stringify({ audioContent: Buffer.from(FAKE_MP3).toString('base64') }), { status: 200 })
            : new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = realFetch;
});

async function upfrontSetup(credits: number) {
    const config = loadConfig({
        ALOUD_ENABLE_DEV_AUTH: '1',
        GOOGLE_TTS_API_KEY: 'tts-key',
        OPENAI_API_KEY: 'sk-test',
        ALOUD_FREE_SIGNUP_CREDITS: '0',
    });
    const deps = buildDeps(config);
    const app = createApp(deps);
    const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    const token = ((await res.json()) as AuthResponse).token;
    const accountId = (await deps.store.allAccounts())[0]!.id;
    await deps.ledger.grant(accountId, credits, 'test');
    return { deps, app, token, accountId };
}

const SPEECH = 'so long, and thanks for all the breaths. '.repeat(40); // ~1,640 chars

function speak(app: ReturnType<typeof createApp>, token: string) {
    return app.request('/cloud/v1/tts', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: SPEECH, voice: 'Leda' }),
    });
}

describe('upfront legs: calls arriving together', () => {
    it('admits only as many syntheses as the balance covers', async () => {
        // One synthesis of SPEECH on Leda costs ~1 credit; fund two and a bit.
        const probe = await upfrontSetup(50);
        const first = await speak(probe.app, probe.token);
        const cost = Number(first.headers.get('X-Credits-Charged'));
        expect(cost).toBeGreaterThan(0);

        const { deps, app, token, accountId } = await upfrontSetup(cost * 2.5);
        ttsCalls = 0;
        providerGate = new Promise<void>((r) => (releaseProvider = r));
        const burst = Array.from({ length: 12 }, () => speak(app, token));
        await new Promise((r) => setTimeout(r, 50));
        expect(ttsCalls).toBe(2); // before: all twelve
        releaseProvider();
        const statuses = (await Promise.all(burst)).map((r) => r.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(2);
        expect(statuses.filter((s) => s === 402)).toHaveLength(10);
        expect(await deps.ledger.balance(accountId)).toBeCloseTo(cost * 0.5, 6);
        expect(deps.upfrontPending.openFor(accountId)).toBe(0);
    });

    it('frees the reservation when the provider fails, so the next call is not refused', async () => {
        const probe = await upfrontSetup(50);
        const cost = Number((await speak(probe.app, probe.token)).headers.get('X-Credits-Charged'));

        const { deps, app, token, accountId } = await upfrontSetup(cost * 1.2);
        failProvider = true;
        expect((await speak(app, token)).status).toBe(502);
        expect(deps.upfrontPending.openFor(accountId)).toBe(0);
        failProvider = false;
        expect((await speak(app, token)).status).toBe(200);
    });

    it('holds STT to the same rule', async () => {
        const pcm = new Int16Array(16_000 * 30); // 30 s of silence
        const send = (app: ReturnType<typeof createApp>, token: string) =>
            app.request('/cloud/v1/stt?sample_rate=16000&format=i16', {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` },
                body: pcm.buffer,
            });
        const probe = await upfrontSetup(50);
        const probed = (await (await send(probe.app, probe.token)).json()) as { creditsCharged: number };
        const cost = probed.creditsCharged;
        expect(cost).toBeGreaterThan(0);

        const { deps, app, token, accountId } = await upfrontSetup(cost * 1.5);
        sttCalls = 0;
        providerGate = new Promise<void>((r) => (releaseProvider = r));
        const burst = Array.from({ length: 8 }, () => send(app, token));
        await new Promise((r) => setTimeout(r, 50));
        expect(sttCalls).toBe(1);
        releaseProvider();
        const statuses = (await Promise.all(burst)).map((r) => r.status);
        expect(statuses.filter((s) => s === 200)).toHaveLength(1);
        expect(deps.upfrontPending.openFor(accountId)).toBe(0);
    });
});

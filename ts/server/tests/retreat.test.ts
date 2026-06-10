/**
 * Retreat-pass metering bypass (meditation-pal-414). A member of an active pass
 * uses the cloud without being held or debited; usage is still recorded (tagged
 * with the pass) for per-retreat attribution, and the per-attendee daily cap
 * falls back to normal metering once spent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps, type Deps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { AuthResponse, CompleteResponse, TranscribeResponse } from '../src/contract.js';
import type { Forwarder } from '../src/providers/forward.js';
import { activeRetreatCoverage } from '../src/credits/retreat.js';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';

const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // "ID3"
const realFetch = globalThis.fetch;

// One fetch stub for both metered upstreams the routes reach directly (STT to
// Fireworks, TTS to Google) — the LLM path is stubbed via deps.forwarder below.
beforeEach(() => {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('fireworks.ai') || u.includes('groq.com')) {
            return new Response(JSON.stringify({ text: 'hello world' }), { status: 200 });
        }
        if (u.includes('texttospeech.googleapis.com')) {
            return new Response(
                JSON.stringify({ audioContent: Buffer.from(FAKE_MP3).toString('base64') }),
                { status: 200 }
            );
        }
        return realFetch(url, init);
    }) as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = realFetch;
});

/** A forwarder that never touches the network: a fixed turn with a real token
 *  split, so pricing yields a positive (would-be) cost. */
function fakeForwarder(): Forwarder {
    const result = {
        text: 'Breathe.',
        finishReason: 'stop' as const,
        inputTokens: 1000,
        outputTokens: 100,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
    };
    return {
        async complete() {
            return result;
        },
        async *stream() {
            yield { text: result.text, done: true, ...result };
        },
    } as unknown as Forwarder;
}

interface Harness {
    deps: Deps;
    app: ReturnType<typeof createApp>;
    token: string;
    accountId: string;
}

async function setup(
    opts: { member?: boolean; cap?: number | null; startOffset?: number; endOffset?: number } = {}
): Promise<Harness> {
    const config = loadConfig({
        ALOUD_ENABLE_DEV_AUTH: '1',
        GEMINI_API_KEY: 'gk-test',
        GOOGLE_TTS_API_KEY: 'tts-key',
        FIREWORKS_API_KEY: 'fw-test',
        ALOUD_FREE_SIGNUP_CREDITS: '20',
    });
    const deps = buildDeps(config, { store: new MemoryCreditsStore() });
    deps.forwarder = fakeForwarder();
    const app = createApp(deps);

    const tokRes = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    const token = ((await tokRes.json()) as AuthResponse).token;
    const accountId = (await deps.store.allAccounts())[0]!.id;

    if (opts.member !== false) {
        const now = Date.now() / 1000;
        await deps.store.createRetreatPass({
            id: 'pass-1',
            label: 'Spring Retreat',
            startsAt: now + (opts.startOffset ?? -100),
            endsAt: now + (opts.endOffset ?? 3600),
            perAttendeeDailyCap: opts.cap ?? null,
            status: 'active',
            createdAt: now - 200,
        });
        await deps.store.addRetreatMember({ passId: 'pass-1', accountId, joinedAt: now - 50 });
    }
    return { deps, app, token, accountId };
}

function complete(h: Harness) {
    return h.app.request('/cloud/v1/llm/complete', {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
            provider: 'google',
            model: 'gemini-2.5-flash-lite',
            messages: [{ role: 'user', content: 'hi' }],
        }),
    });
}

describe('retreat pass — LLM metering bypass', () => {
    it('covers a member: no charge, balance untouched, usage tagged with the pass', async () => {
        const h = await setup();
        const res = await complete(h);
        expect(res.status).toBe(200);
        const body = (await res.json()) as CompleteResponse;

        expect(body.creditsCharged).toBe(0);
        expect(body.creditsRemaining).toBe(20); // free-signup grant, unspent
        expect(await h.deps.ledger.balance(h.accountId)).toBe(20);

        // The ledger has only the signup grant — no hold, no settle.
        const entries = await h.deps.store.listEntries(h.accountId);
        expect(entries.every((e) => e.kind === 'signup_grant')).toBe(true);

        // Usage is still recorded, attributed to the pass, with the would-be cost.
        const usage = await h.deps.store.allUsage();
        expect(usage).toHaveLength(1);
        expect(usage[0]!.passId).toBe('pass-1');
        expect(usage[0]!.credits).toBeGreaterThan(0);
    });

    it('meters normally when the account has no pass', async () => {
        const h = await setup({ member: false });
        const res = await complete(h);
        const body = (await res.json()) as CompleteResponse;

        expect(body.creditsCharged).toBeGreaterThan(0);
        expect(body.creditsRemaining).toBeLessThan(20);
        expect(await h.deps.ledger.balance(h.accountId)).toBeLessThan(20);
        expect((await h.deps.store.allUsage())[0]!.passId).toBeNull();
    });

    it('reverts to metering once the pass window has ended', async () => {
        const h = await setup({ startOffset: -7200, endOffset: -3600 }); // ended an hour ago
        const res = await complete(h);
        const body = (await res.json()) as CompleteResponse;
        expect(body.creditsCharged).toBeGreaterThan(0);
        expect(await h.deps.ledger.balance(h.accountId)).toBeLessThan(20);
        expect((await h.deps.store.allUsage())[0]!.passId).toBeNull();
    });

    it('falls back to metering once the per-attendee daily cap is spent', async () => {
        const h = await setup({ cap: 1 });
        // Pre-load 2 credits of usage in the trailing window — over the cap of 1.
        await h.deps.store.appendUsage({
            id: 'pre', accountId: h.accountId, sessionId: null, passId: 'pass-1',
            ts: Date.now() / 1000, kind: 'llm', provider: 'google', model: 'gemini-2.5-flash-lite',
            tokensIn: 0, tokensOut: 0, cacheRead: 0, cacheCreation: 0, seconds: 0, chars: 0,
            providerCostUsd: 0.1, credits: 2,
        });

        const res = await complete(h);
        const body = (await res.json()) as CompleteResponse;
        // Cap exhausted → no longer covered → charged against the user's balance.
        expect(body.creditsCharged).toBeGreaterThan(0);
        expect(await h.deps.ledger.balance(h.accountId)).toBeLessThan(20);
    });
});

describe('retreat pass — STT metering bypass', () => {
    it('covers a member: free transcription, balance untouched, usage tagged', async () => {
        const h = await setup();
        const res = await h.app.request('/cloud/v1/stt?sample_rate=16000', {
            method: 'POST',
            headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/octet-stream' },
            body: new Float32Array(16_000 * 10).buffer, // 10s of audio
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as TranscribeResponse;
        expect(body.text).toBe('hello world');
        expect(body.creditsCharged).toBe(0);
        expect(body.creditsRemaining).toBe(20);
        expect(await h.deps.ledger.balance(h.accountId)).toBe(20);

        const usage = await h.deps.store.allUsage();
        expect(usage).toHaveLength(1);
        expect(usage[0]!.kind).toBe('stt');
        expect(usage[0]!.passId).toBe('pass-1');
        expect(usage[0]!.credits).toBeGreaterThan(0);
    });
});

describe('retreat pass — TTS metering bypass', () => {
    it('covers a member: free synthesis, balance untouched, usage tagged', async () => {
        const h = await setup();
        const res = await h.app.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'Breathe in.' }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('X-Credits-Charged')).toBe('0');
        expect(Number(res.headers.get('X-Credits-Remaining'))).toBe(20);
        expect(await h.deps.ledger.balance(h.accountId)).toBe(20);

        const usage = await h.deps.store.allUsage();
        expect(usage).toHaveLength(1);
        expect(usage[0]!.kind).toBe('tts');
        expect(usage[0]!.passId).toBe('pass-1');
        expect(usage[0]!.credits).toBeGreaterThan(0);
    });
});

describe('retreat pass — /me retreatCovered flag', () => {
    function me(h: Harness) {
        return h.app.request('/cloud/v1/me', { headers: { authorization: `Bearer ${h.token}` } });
    }

    it('is true for a covered member', async () => {
        const h = await setup();
        const body = (await (await me(h)).json()) as { retreatCovered: boolean };
        expect(body.retreatCovered).toBe(true);
    });

    it('is false without a pass, and false once the window has ended', async () => {
        const none = await setup({ member: false });
        expect(((await (await me(none)).json()) as { retreatCovered: boolean }).retreatCovered).toBe(false);

        const expired = await setup({ startOffset: -7200, endOffset: -3600 });
        expect(((await (await me(expired)).json()) as { retreatCovered: boolean }).retreatCovered).toBe(false);
    });
});

describe('retreat invite — binds on first sign-in', () => {
    it('an emailed invite becomes coverage when that address signs up', async () => {
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', ALOUD_FREE_SIGNUP_CREDITS: '0' });
        const store = new MemoryCreditsStore();
        const app = createApp(buildDeps(config, { store }));
        const now = Date.now() / 1000;
        await store.createRetreatPass({
            id: 'p', label: 'R', startsAt: now - 100, endsAt: now + 3600,
            perAttendeeDailyCap: null, status: 'active', createdAt: now - 200,
        });
        // Operator invites an email that has no account yet.
        await store.addRetreatInvite({ passId: 'p', email: 'newyogi@example.com', invitedAt: now - 50 });

        // That person signs up (different case) → invite binds during sign-in.
        const res = await app.request('/cloud/v1/auth/email/signup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: 'NewYogi@example.com', password: 'hunter2hunter2' }),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { account: { id: string; retreatCovered: boolean } };
        expect(body.account.retreatCovered).toBe(true);

        // Membership now exists and the invite is consumed.
        expect((await store.listRetreatMembers('p')).map((m) => m.accountId)).toEqual([body.account.id]);
        expect(await store.invitesForEmail('newyogi@example.com')).toEqual([]);
    });
});

describe('activeRetreatCoverage — cap boundary', () => {
    it('covers under the cap and falls back at/over it', async () => {
        const store = new MemoryCreditsStore();
        await store.createAccount({ id: 'a', email: 'a@e.com', emailVerified: true, createdAt: 0 });
        await store.createRetreatPass({
            id: 'p', label: 'R', startsAt: 0, endsAt: 1e12, perAttendeeDailyCap: 5,
            status: 'active', createdAt: 0,
        });
        await store.addRetreatMember({ passId: 'p', accountId: 'a', joinedAt: 0 });
        const now = 1_000_000;

        // No usage yet → covered.
        expect((await activeRetreatCoverage(store, 'a', now))?.id).toBe('p');

        // 4 credits in-window → still under 5 → covered.
        await store.appendUsage({
            id: 'u1', accountId: 'a', sessionId: null, passId: 'p', ts: now - 10,
            kind: 'llm', provider: 'google', model: 'm', tokensIn: 0, tokensOut: 0,
            cacheRead: 0, cacheCreation: 0, seconds: 0, chars: 0, providerCostUsd: 0, credits: 4,
        });
        expect(await activeRetreatCoverage(store, 'a', now)).not.toBeNull();

        // +1 more reaches the cap of 5 → no longer covered.
        await store.appendUsage({
            id: 'u2', accountId: 'a', sessionId: null, passId: 'p', ts: now - 5,
            kind: 'llm', provider: 'google', model: 'm', tokensIn: 0, tokensOut: 0,
            cacheRead: 0, cacheCreation: 0, seconds: 0, chars: 0, providerCostUsd: 0, credits: 1,
        });
        expect(await activeRetreatCoverage(store, 'a', now)).toBeNull();
    });
});

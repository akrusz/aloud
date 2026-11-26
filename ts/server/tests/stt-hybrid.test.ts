import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { HYBRID_SHORT_MAX_SEC, hybridDeadlineMs } from '../src/providers/stt-hybrid.js';
import type { AuthResponse, TranscribeResponse } from '../src/contract.js';

/**
 * A request for Parakeet through /cloud/v1/stt (providers/stt-hybrid.ts): a
 * short clip goes to gpt-transcribe, a longer one to Parakeet with
 * gpt-transcribe behind it on a failure or past the deadline, and every
 * request a provider bills is metered at its own rate. No network: fetch is
 * stubbed, and each stubbed request rejects when its signal aborts.
 */

const PARAKEET = 'moondream/parakeet-ultra';
const GPT = 'gpt-transcribe';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/audio/transcriptions';

/** Parakeet bills the exact second at list plus OpenRouter's fee;
 *  gpt-transcribe whole seconds rounded up. $0.05 a credit. */
const parakeetCredits = (s: number): number => (s * 0.06 * 1.055) / 3600 / 0.05;
const gptCredits = (s: number): number => (Math.ceil(s) * 0.27) / 3600 / 0.05;

interface Call {
    model: string;
    language: string | null;
    prompt: string | null;
    aborted: boolean;
}

let calls: Call[] = [];
/** How the upstream answers each request. */
let answer: (call: Call) => Response | Promise<Response>;
const realFetch = globalThis.fetch;

const heard = (text: string): Response => new Response(JSON.stringify({ text }), { status: 200 });
const refused = (status: number): Response =>
    new Response(JSON.stringify({ error: { message: `Provider returned ${status}` } }), { status });
const never = (): Promise<Response> => new Promise(() => {});

beforeEach(() => {
    calls = [];
    answer = (call) => heard(`heard by ${call.model}`);
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        let call: Call;
        if (u === OPENROUTER_URL) {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            call = {
                model: String(body['model']),
                language: (body['language'] as string | undefined) ?? null,
                prompt: (body['prompt'] as string | undefined) ?? null,
                aborted: false,
            };
        } else if (u.includes('api.openai.com') || u.includes('groq.com')) {
            const form = init?.body as FormData;
            call = {
                model: String(form.get('model')),
                language: form.get('language') as string | null,
                prompt: form.get('prompt') as string | null,
                aborted: false,
            };
        } else {
            return realFetch(url, init);
        }
        calls.push(call);
        const signal = init?.signal;
        return new Promise<Response>((resolve, reject) => {
            signal?.addEventListener('abort', () => {
                call.aborted = true;
                reject(new DOMException('This operation was aborted', 'AbortError'));
            });
            Promise.resolve()
                .then(() => answer(call))
                .then(resolve, reject);
        });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
    vi.useRealTimers();
});

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

/** Let the request run until `cond` holds. setImmediate, which the fake
 *  timers here leave real. */
async function until(cond: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
    expect(cond()).toBe(true);
}

async function hybridApp(env: Record<string, string> = {}) {
    const config = loadConfig({
        ALOUD_ENABLE_DEV_AUTH: '1',
        OPENAI_API_KEY: 'sk-test',
        OPENROUTER_API_KEY: 'or-test',
        ALOUD_FREE_SIGNUP_CREDITS: '20',
        ...env,
    });
    const deps = buildDeps(config);
    const a = createApp(deps);
    const res = await a.request('/cloud/v1/auth/dev', { method: 'POST' });
    const token = ((await res.json()) as AuthResponse).token;
    const accountId = (await deps.store.allAccounts())[0]!.id;
    const post = (seconds: number, query = '', headers: Record<string, string> = {}, model = PARAKEET) =>
        a.request(`/cloud/v1/stt?sample_rate=16000&format=i16&model=${encodeURIComponent(model)}${query || '&lang=en'}`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream', ...headers },
            body: new Int16Array(Math.round(seconds * 16_000)).buffer,
        });
    const usage = async () =>
        (await deps.store.allUsage()).map((r) => ({ model: r.model, provider: r.provider, seconds: r.seconds, credits: r.credits }));
    const incidents = async () => {
        await new Promise((r) => setImmediate(r)); // incident writes are fire-and-forget
        return (await deps.store.incidentsSince(0)).map((i) => ({ kind: i.kind, model: i.model, detail: i.detail }));
    };
    const sttDebits = async () => (await deps.store.listEntries(accountId)).filter((e) => e.reason?.startsWith('stt:'));
    return { deps, accountId, post, usage, incidents, sttDebits };
}

describe('a short Parakeet clip goes to gpt-transcribe', () => {
    it(`at ${HYBRID_SHORT_MAX_SEC} s or less, unprompted, billed as gpt-transcribe`, async () => {
        const { post, usage, incidents } = await hybridApp();
        for (const seconds of [1.2, HYBRID_SHORT_MAX_SEC]) {
            const res = await post(seconds, '', { 'x-stt-prior': encodeURIComponent('and then') });
            expect(res.status).toBe(200);
            const body = (await res.json()) as TranscribeResponse;
            expect(body).toMatchObject({ text: `heard by ${GPT}`, model: GPT, route: 'reroute' });
            expect(body.creditsCharged).toBeCloseTo(gptCredits(seconds), 12);
        }
        expect(calls).toEqual([
            { model: GPT, language: 'en', prompt: null, aborted: false },
            { model: GPT, language: 'en', prompt: null, aborted: false },
        ]);
        expect(await usage()).toEqual([
            { model: GPT, provider: 'openai', seconds: 2, credits: expect.closeTo(gptCredits(1.2), 12) },
            { model: GPT, provider: 'openai', seconds: 3, credits: expect.closeTo(gptCredits(3), 12) },
        ]);
        expect(await incidents()).toEqual([]);
    });

    it('on setup listening too: free, and without the setup vocabulary', async () => {
        const { post, usage } = await hybridApp();
        const body = (await (await post(2, '&lang=en&setup=1')).json()) as TranscribeResponse;
        expect(body).toMatchObject({ model: GPT, route: 'reroute', creditsCharged: 0 });
        expect(calls).toEqual([{ model: GPT, language: 'en', prompt: null, aborted: false }]);
        expect(await usage()).toEqual([{ model: GPT, provider: 'openai', seconds: 2, credits: 0 }]);
    });

    it('holds credits at gpt-transcribe rates, refusing before any call when they do not fit', async () => {
        const { deps, accountId, post } = await hybridApp({ ALOUD_FREE_SIGNUP_CREDITS: '0' });
        // Covers 2 s of Parakeet, not 2 s of gpt-transcribe.
        await deps.ledger.grant(accountId, (parakeetCredits(2) + gptCredits(2)) / 2, 'test');
        const res = await post(2);
        expect(res.status).toBe(402);
        expect(calls).toEqual([]);
    });

    it('leaves Parakeet alone where the backend offers no gpt-transcribe', async () => {
        const { post } = await hybridApp({ OPENAI_API_KEY: '', GROQ_API_KEY: 'gsk-test' });
        const body = (await (await post(2)).json()) as TranscribeResponse;
        expect(body.model).toBe(PARAKEET);
        expect(body.route).toBeUndefined();
        expect(calls.map((c) => c.model)).toEqual([PARAKEET]);
    });

    it('leaves every other model alone, Chinese Grok included', async () => {
        const { post } = await hybridApp();
        await post(2, '&lang=zh', {}, 'x-ai/grok-stt-2.0');
        await post(2, '&lang=zh', {}, GPT);
        expect(calls.map((c) => c.model)).toEqual(['x-ai/grok-stt-2.0', GPT]);
    });
});

describe('a longer Parakeet clip stays on Parakeet', () => {
    it('just past the cut: Parakeet alone, billed by the exact second', async () => {
        const { post, usage, incidents } = await hybridApp();
        const body = (await (await post(3.01)).json()) as TranscribeResponse;
        expect(body).toMatchObject({ text: `heard by ${PARAKEET}`, model: PARAKEET });
        expect(body.route).toBeUndefined();
        expect(body.creditsCharged).toBeCloseTo(parakeetCredits(3.01), 12);
        expect(calls.map((c) => c.model)).toEqual([PARAKEET]);
        expect(await usage()).toEqual([
            { model: PARAKEET, provider: 'openrouter', seconds: 3.01, credits: expect.closeTo(parakeetCredits(3.01), 12) },
        ]);
        expect(await incidents()).toEqual([]);
    });

    it('holds enough for both models, refusing before any call when that does not fit', async () => {
        const { deps, accountId, post } = await hybridApp({ ALOUD_FREE_SIGNUP_CREDITS: '0' });
        await deps.ledger.grant(accountId, parakeetCredits(10) + gptCredits(10) / 2, 'test');
        expect((await post(10)).status).toBe(402);
        expect(calls).toEqual([]);
        await deps.ledger.grant(accountId, gptCredits(10), 'test');
        expect((await post(10)).status).toBe(200);
    });
});

describe('a Parakeet failure is retried on gpt-transcribe', () => {
    it.each([429, 500, 502])('a %i: answered by gpt-transcribe, the refusal unbilled', async (status) => {
        const { post, usage, incidents, sttDebits } = await hybridApp();
        answer = (call) => (call.model === PARAKEET ? refused(status) : heard('my shoulders are softening'));
        const res = await post(6);
        expect(res.status).toBe(200);
        const body = (await res.json()) as TranscribeResponse;
        expect(body).toMatchObject({ text: 'my shoulders are softening', model: GPT, route: 'fallback' });
        expect(body.creditsCharged).toBeCloseTo(gptCredits(6), 12);
        expect(calls).toEqual([
            { model: PARAKEET, language: 'en', prompt: null, aborted: false },
            { model: GPT, language: 'en', prompt: null, aborted: false },
        ]);
        expect(await usage()).toEqual([{ model: GPT, provider: 'openai', seconds: 6, credits: expect.closeTo(gptCredits(6), 12) }]);
        expect((await sttDebits()).map((e) => e.reason)).toEqual(['stt:openai:6.0s']);
        const rows = await incidents();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'stt_fallback', model: PARAKEET });
        expect(rows[0]!.detail).toMatch(new RegExp(`^6\\.0s: served=${GPT} at=\\d+ms; ${PARAKEET} failed at \\d+ms: .*${status}`));
        expect(rows[0]!.detail).not.toContain('shoulders');
    });

    it('a dropped connection may have been billed, so both are metered', async () => {
        const { post, usage, sttDebits } = await hybridApp();
        answer = (call) => {
            if (call.model === PARAKEET) throw new TypeError('fetch failed');
            return heard('still here');
        };
        const body = (await (await post(6)).json()) as TranscribeResponse;
        expect(body).toMatchObject({ model: GPT, route: 'fallback' });
        expect(body.creditsCharged).toBeCloseTo(parakeetCredits(6) + gptCredits(6), 12);
        expect((await usage()).map((r) => r.model)).toEqual([PARAKEET, GPT]);
        expect((await sttDebits()).map((e) => e.reason)).toEqual(['stt:openrouter:6.0s+openai:6.0s']);
    });

    it('both failing is a 502 that charges nothing', async () => {
        const { accountId, deps, post, usage, incidents } = await hybridApp();
        answer = () => refused(503);
        const res = await post(6);
        expect(res.status).toBe(502);
        expect(calls.map((c) => c.model)).toEqual([PARAKEET, GPT]);
        expect(await usage()).toEqual([]);
        expect(await deps.ledger.balance(accountId)).toBe(20);
        const rows = await incidents();
        expect(rows.map((r) => r.kind).sort()).toEqual(['stt_error', 'stt_fallback']);
        expect(rows.find((r) => r.kind === 'stt_fallback')!.detail).toContain('served=none');
    });
});

describe('a Parakeet stall is hedged on gpt-transcribe at the deadline', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });

    it('sends nothing more before the deadline, nor after Parakeet answers in time', async () => {
        const { post, incidents } = await hybridApp();
        const parakeet = deferred<Response>();
        answer = () => parakeet.promise;
        const pending = post(5);
        await until(() => calls.length === 1);
        await vi.advanceTimersByTimeAsync(hybridDeadlineMs(5) - 1);
        expect(calls).toHaveLength(1);
        parakeet.resolve(heard('in time'));
        const body = (await (await pending).json()) as TranscribeResponse;
        expect(body).toMatchObject({ text: 'in time', model: PARAKEET });
        expect(body.route).toBeUndefined();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(calls).toHaveLength(1);
        expect(await incidents()).toEqual([]);
    });

    it('gpt-transcribe first: its answer wins, Parakeet is aborted, both are metered', async () => {
        const { post, usage, incidents, sttDebits } = await hybridApp();
        answer = (call) => (call.model === PARAKEET ? never() : heard('a warmth in my chest'));
        const pending = post(5);
        await until(() => calls.length === 1);
        expect(hybridDeadlineMs(5)).toBe(3_500);
        await vi.advanceTimersByTimeAsync(3_499);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        const res = await pending;
        expect(res.status).toBe(200);
        const body = (await res.json()) as TranscribeResponse;
        expect(body).toMatchObject({ text: 'a warmth in my chest', model: GPT, route: 'hedge' });
        expect(calls).toEqual([
            { model: PARAKEET, language: 'en', prompt: null, aborted: true },
            { model: GPT, language: 'en', prompt: null, aborted: false },
        ]);
        // OpenRouter bills an aborted non-streaming request in full.
        expect(body.creditsCharged).toBeCloseTo(parakeetCredits(5) + gptCredits(5), 12);
        expect(await usage()).toEqual([
            { model: PARAKEET, provider: 'openrouter', seconds: 5, credits: expect.closeTo(parakeetCredits(5), 12) },
            { model: GPT, provider: 'openai', seconds: 5, credits: expect.closeTo(gptCredits(5), 12) },
        ]);
        expect((await sttDebits()).map((e) => e.reason)).toEqual(['stt:openrouter:5.0s+openai:5.0s']);
        const rows = await incidents();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ kind: 'stt_hedge', model: PARAKEET });
        expect(rows[0]!.detail).toMatch(new RegExp(`^5\\.0s: deadline=3500ms served=${GPT} at=\\d+ms$`));
    });

    it('Parakeet first: its answer wins, gpt-transcribe is aborted, both are metered', async () => {
        const { post, usage, incidents } = await hybridApp();
        const parakeet = deferred<Response>();
        answer = (call) => (call.model === PARAKEET ? parakeet.promise : never());
        const pending = post(5);
        await until(() => calls.length === 1);
        await vi.advanceTimersByTimeAsync(hybridDeadlineMs(5));
        await until(() => calls.length === 2);
        parakeet.resolve(heard('late but here'));
        const body = (await (await pending).json()) as TranscribeResponse;
        expect(body).toMatchObject({ text: 'late but here', model: PARAKEET, route: 'hedge' });
        expect(calls.map((c) => [c.model, c.aborted])).toEqual([
            [PARAKEET, false],
            [GPT, true],
        ]);
        expect(body.creditsCharged).toBeCloseTo(parakeetCredits(5) + gptCredits(5), 12);
        expect((await usage()).map((r) => r.model)).toEqual([PARAKEET, GPT]);
        const rows = await incidents();
        expect(rows.map((r) => r.kind)).toEqual(['stt_hedge']);
        expect(rows[0]!.detail).toContain(`served=${PARAKEET}`);
    });

    it('Parakeet refusing after the deadline leaves gpt-transcribe to answer, the refusal unbilled', async () => {
        const { post, usage, incidents } = await hybridApp();
        const parakeet = deferred<Response>();
        const gpt = deferred<Response>();
        answer = (call) => (call.model === PARAKEET ? parakeet.promise : gpt.promise);
        const pending = post(5);
        await until(() => calls.length === 1);
        await vi.advanceTimersByTimeAsync(hybridDeadlineMs(5));
        await until(() => calls.length === 2);
        parakeet.resolve(refused(429));
        await new Promise((r) => setImmediate(r));
        gpt.resolve(heard('settling'));
        const body = (await (await pending).json()) as TranscribeResponse;
        expect(body).toMatchObject({ text: 'settling', model: GPT, route: 'hedge' });
        expect(body.creditsCharged).toBeCloseTo(gptCredits(5), 12);
        expect((await usage()).map((r) => r.model)).toEqual([GPT]);
        const rows = await incidents();
        expect(rows.map((r) => r.kind)).toEqual(['stt_hedge']);
        expect(rows[0]!.detail).toContain(`${PARAKEET} failed`);
    });

    it('gpt-transcribe failing after the deadline leaves Parakeet to answer', async () => {
        const { post, usage } = await hybridApp();
        const parakeet = deferred<Response>();
        answer = (call) => (call.model === PARAKEET ? parakeet.promise : refused(500));
        const pending = post(5);
        await until(() => calls.length === 1);
        await vi.advanceTimersByTimeAsync(hybridDeadlineMs(5));
        await until(() => calls.length === 2);
        await new Promise((r) => setImmediate(r));
        parakeet.resolve(heard('here'));
        const body = (await (await pending).json()) as TranscribeResponse;
        expect(body).toMatchObject({ text: 'here', model: PARAKEET, route: 'hedge' });
        expect(body.creditsCharged).toBeCloseTo(parakeetCredits(5), 12);
        expect((await usage()).map((r) => r.model)).toEqual([PARAKEET]);
    });

    it('scales the deadline with the audio: 3 s plus 0.1 s a second', async () => {
        expect(hybridDeadlineMs(4)).toBe(3_400);
        expect(hybridDeadlineMs(60)).toBe(9_000);
        const { post } = await hybridApp();
        answer = (call) => (call.model === PARAKEET ? never() : heard('ok'));
        const pending = post(60);
        await until(() => calls.length === 1);
        await vi.advanceTimersByTimeAsync(8_999);
        expect(calls).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(((await (await pending).json()) as TranscribeResponse).route).toBe('hedge');
    });
});

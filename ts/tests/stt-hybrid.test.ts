import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The Hybrid hosted choice through the real picker and engine: each pass goes
 * to GPT or Parakeet by the seconds of audio it sends (HYBRID_GPT_MAX_SEC),
 * and a pass Parakeet refuses with a provider error goes once more to GPT
 * (WhisperPcmSttEngineOptions.cloudFallback). Not on a dropped connection, a
 * timeout, or any other refusal.
 */

vi.mock('../ui/src/cloud-auth.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../ui/src/cloud-auth.js')>()),
    ensureCloudToken: vi.fn(async () => 'token'),
    clearCloudToken: vi.fn(async () => {}),
}));

const clips: Array<{ label: string; model: string | null; fallback: boolean; text: string }> = [];
vi.mock('../ui/src/stt-clip-recorder.js', () => ({
    recordSttClip: (c: { label: string; model: string | null; fallback: boolean; text: string }) =>
        clips.push({ label: c.label, model: c.model, fallback: c.fallback, text: c.text }),
}));

import { createSttForChoice, HYBRID_GPT_MAX_SEC, setupHostedChoice } from '../ui/src/adapters/stt-picker.js';
import { CLOUD_FINAL_RETRY_BUDGET_MS, WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';

const GPT = 'gpt-transcribe';
const PARAKEET = 'moondream/parakeet-ultra';
const RATE = 16_000;

type TranscribeResult = { ok: true; text: string } | { ok: false; error: unknown };
type Transcribe = (frames: Float32Array[], label: 'spec' | 'final', rate: number) => Promise<TranscribeResult>;

/** Every transcription request: the model it named, its audio's bytes, and
 *  whether it carried a prior. */
let sent: Array<{ model: string | null; bytes: number; prior: boolean }> = [];
/** How the server answers a request naming `model`. */
let answer: (model: string | null) => Response | Promise<Response>;

const heard = (text: string): Response => new Response(JSON.stringify({ text }), { status: 200 });
const refused = (code: string, status: number): Response =>
    new Response(JSON.stringify({ error: { code, message: 'refused' } }), { status });
const providerError = (): Response => refused('provider_error', 502);

beforeEach(() => {
    sent = [];
    clips.length = 0;
    answer = (model) => heard(`heard by ${model}`);
    vi.spyOn(WhisperPcmSttEngine, 'isAvailable').mockReturnValue(true);
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: unknown, init?: RequestInit) => {
            const u = new URL(String(url), 'http://127.0.0.1');
            const headers = (init?.headers ?? {}) as Record<string, string>;
            const model = u.searchParams.get('model');
            sent.push({ model, bytes: (init!.body as ArrayBuffer).byteLength, prior: 'x-stt-prior' in headers });
            return answer(model);
        })
    );
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** A Hybrid engine's private transcription pass. */
async function hybridPass(opts: Parameters<typeof createSttForChoice>[1] = {}): Promise<Transcribe> {
    const engine = await createSttForChoice('aloud-hybrid', { language: 'en', ...opts });
    expect(engine).toBeInstanceOf(WhisperPcmSttEngine);
    return (engine as unknown as { transcribe: Transcribe }).transcribe.bind(engine);
}

/** `samples` of tone at the wire rate, so the pass sends exactly that many. */
const audio = (samples: number): Float32Array[] => [new Float32Array(samples).map((_, i) => Math.sin(i / 10) * 0.2)];
const seconds = (sec: number): Float32Array[] => audio(Math.round(sec * RATE));

describe('Hybrid routes each pass by the seconds of audio it sends', () => {
    it('sends up to 3.0 s to GPT and anything longer to Parakeet', async () => {
        expect(HYBRID_GPT_MAX_SEC).toBe(3);
        const transcribe = await hybridPass();
        await transcribe(seconds(1.2), 'spec', RATE);
        await transcribe(audio(3 * RATE), 'final', RATE);
        await transcribe(audio(3 * RATE + 1), 'final', RATE);
        await transcribe(seconds(8), 'spec', RATE);
        expect(sent.map((s) => s.model)).toEqual([GPT, GPT, PARAKEET, PARAKEET]);
    });

    it('makes whole, unprompted passes on either model', async () => {
        const engine = await createSttForChoice('aloud-hybrid', { language: 'en' });
        expect((engine as unknown as { opts: { incremental: boolean } }).opts.incremental).toBe(false);
        const transcribe = (engine as unknown as { transcribe: Transcribe }).transcribe.bind(engine);
        await transcribe(seconds(1), 'final', RATE);
        await transcribe(seconds(5), 'final', RATE);
        expect(sent.map((s) => s.prior)).toEqual([false, false]);
    });

    it('records which model transcribed each clip, and no fallback', async () => {
        const transcribe = await hybridPass();
        await transcribe(seconds(2), 'spec', RATE);
        await transcribe(seconds(6), 'final', RATE);
        expect(clips).toEqual([
            { label: 'spec', model: GPT, fallback: false, text: `heard by ${GPT}` },
            { label: 'final', model: PARAKEET, fallback: false, text: `heard by ${PARAKEET}` },
        ]);
    });

    it('listens on GPT on the setup screen, whatever the clip length', async () => {
        const transcribe = await hybridPass({
            setupListening: true,
            hostedChoice: (built) => setupHostedChoice(built, 'aloud-hybrid', false, 'en'),
        });
        await transcribe(seconds(1), 'final', RATE);
        await transcribe(seconds(9), 'final', RATE);
        expect(sent.map((s) => s.model)).toEqual([GPT, GPT]);
    });
});

describe('Hybrid falls back to GPT when Parakeet refuses a pass', () => {
    it.each(['spec', 'final'] as const)(
        'a %s pass Parakeet answers with a provider error goes once more to GPT, same audio',
        async (label) => {
            answer = (model) => (model === PARAKEET ? providerError() : heard('my shoulders are softening'));
            const transcribe = await hybridPass();
            const result = await transcribe(seconds(5), label, RATE);
            expect(result).toMatchObject({ ok: true, text: 'my shoulders are softening' });
            expect(sent.map((s) => s.model)).toEqual([PARAKEET, GPT]);
            expect(sent[1]!.bytes).toBe(sent[0]!.bytes);
            expect(clips).toEqual([{ label, model: GPT, fallback: true, text: 'my shoulders are softening' }]);
        }
    );

    it('a speculative pass both refuse fails, after one request to each', async () => {
        answer = () => providerError();
        const transcribe = await hybridPass();
        const result = await transcribe(seconds(5), 'spec', RATE);
        expect(result.ok).toBe(false);
        expect(sent.map((s) => s.model)).toEqual([PARAKEET, GPT]);
        expect(clips).toEqual([]);
    });

    it('a final both refuse keeps re-sending as before, to GPT, never Parakeet again', async () => {
        // Date too: the retry budget is counted on Date.now (net-retry.ts).
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        answer = () => providerError();
        const transcribe = await hybridPass();
        const pending = transcribe(seconds(5), 'final', RATE);
        await vi.advanceTimersByTimeAsync(CLOUD_FINAL_RETRY_BUDGET_MS + 5_000);
        const result = await pending;
        expect(result.ok).toBe(false);
        expect(sent[0]!.model).toBe(PARAKEET);
        expect(sent.length).toBeGreaterThan(2);
        expect(sent.slice(1).every((s) => s.model === GPT)).toBe(true);
    });

    it('a final whose fallback drops its connection rides it out on GPT', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let gptTries = 0;
        answer = (model) => {
            if (model === PARAKEET) return providerError();
            if (++gptTries === 1) throw new TypeError('The network connection was lost.');
            return heard('still here');
        };
        const transcribe = await hybridPass();
        const pending = transcribe(seconds(5), 'final', RATE);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await pending).toMatchObject({ ok: true, text: 'still here' });
        expect(sent.map((s) => s.model)).toEqual([PARAKEET, GPT, GPT]);
    });

    it('a dropped connection to Parakeet is not a refusal: a final re-sends to Parakeet', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let tries = 0;
        answer = () => {
            if (++tries === 1) throw new TypeError('Failed to fetch');
            return heard('back again');
        };
        const transcribe = await hybridPass();
        const pending = transcribe(seconds(5), 'final', RATE);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(await pending).toMatchObject({ ok: true, text: 'back again' });
        expect(sent.map((s) => s.model)).toEqual([PARAKEET, PARAKEET]);
        expect(clips[0]).toMatchObject({ model: PARAKEET, fallback: false });
    });

    it('a dropped connection to Parakeet fails a speculative pass, with no fallback', async () => {
        answer = () => {
            throw new TypeError('Failed to fetch');
        };
        const transcribe = await hybridPass();
        expect((await transcribe(seconds(5), 'spec', RATE)).ok).toBe(false);
        expect(sent.map((s) => s.model)).toEqual([PARAKEET]);
    });

    it('our own timeout on a Parakeet pass is not a refusal', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        answer = () => new Promise<Response>(() => {});
        const transcribe = await hybridPass();
        const pending = transcribe(seconds(5), 'spec', RATE);
        await vi.advanceTimersByTimeAsync(46_000);
        expect((await pending).ok).toBe(false);
        expect(sent.map((s) => s.model)).toEqual([PARAKEET]);
    });

    it.each([
        ['our rate guard', 429, 'quota_exceeded'],
        ['out of credits', 402, 'insufficient_credits'],
    ])('%s (%i) is not a provider error: no fallback', async (_why, status, code) => {
        answer = () => refused(code, status);
        const transcribe = await hybridPass();
        expect((await transcribe(seconds(5), 'spec', RATE)).ok).toBe(false);
        expect(sent.map((s) => s.model)).toEqual([PARAKEET]);
    });

    it('a short pass GPT refuses has nowhere to go', async () => {
        answer = () => providerError();
        const transcribe = await hybridPass();
        expect((await transcribe(seconds(2), 'spec', RATE)).ok).toBe(false);
        expect(sent.map((s) => s.model)).toEqual([GPT]);
    });
});

describe('the server names the model that answered', () => {
    const served = (text: string, model: string, route?: string): Response =>
        new Response(JSON.stringify({ text, model, ...(route ? { route } : {}) }), { status: 200 });

    it.each([
        ['reroute', 2, GPT, false],
        ['fallback', 5, GPT, true],
        ['hedge', 5, GPT, false],
        ['hedge', 5, PARAKEET, false],
    ] as const)('a Parakeet pass the server answered by %s records %s seconds as %s', async (route, sec, model, fallback) => {
        answer = () => served('settling', model, route);
        const engine = await createSttForChoice('aloud-parakeet', { language: 'en' });
        const transcribe = (engine as unknown as { transcribe: Transcribe }).transcribe.bind(engine);
        expect(await transcribe(seconds(sec), 'final', RATE)).toMatchObject({ ok: true, text: 'settling' });
        expect(sent.map((s) => s.model)).toEqual([PARAKEET]);
        expect(clips).toEqual([{ label: 'final', model, fallback, text: 'settling' }]);
    });

    it('an answer naming no model keeps the model asked for', async () => {
        const transcribe = await hybridPass();
        await transcribe(seconds(5), 'final', RATE);
        expect(clips[0]).toMatchObject({ model: PARAKEET, fallback: false });
    });
});

describe('only Hybrid falls back', () => {
    it.each(['aloud-gpt-transcribe', 'aloud-parakeet'] as const)('%s keeps a refused pass on its model', async (choice) => {
        answer = () => providerError();
        const engine = await createSttForChoice(choice, { language: 'en' });
        const transcribe = (engine as unknown as { transcribe: Transcribe }).transcribe.bind(engine);
        expect((await transcribe(seconds(5), 'spec', RATE)).ok).toBe(false);
        expect(sent).toHaveLength(1);
    });
});

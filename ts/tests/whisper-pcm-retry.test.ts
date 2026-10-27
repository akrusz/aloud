import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { CLOUD_FINAL_RETRY_BUDGET_MS, WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';

/**
 * Hosted STT on a dropped connection (net-retry.ts): the final pass keeps the
 * turn's audio and re-sends it, so what the meditator said isn't lost to a
 * cell handover. Speculative passes and the desktop's loopback Whisper don't.
 */

type TranscribeResult = { ok: true; text: string } | { ok: false; error: unknown };
type Transcribe = (frames: Float32Array[], label: 'spec' | 'final', rate: number) => Promise<TranscribeResult>;

/** The engine's private transcription pass, on one second of tone. */
function transcribe(engine: WhisperPcmSttEngine, label: 'spec' | 'final'): Promise<TranscribeResult> {
    const frame = new Float32Array(16_000).map((_, i) => Math.sin(i / 10) * 0.2);
    const fn = (engine as unknown as { transcribe: Transcribe }).transcribe.bind(engine);
    return fn([frame], label, 16_000);
}

const heard = (): Response => new Response(JSON.stringify({ text: 'my shoulders are softening' }), { status: 200 });

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
    vi.useRealTimers();
});

describe('WhisperPcmSttEngine on a dropped connection', () => {
    it('hosted final pass re-sends the same audio and returns the transcript', async () => {
        const bodies: ArrayBuffer[] = [];
        const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
            bodies.push(init!.body as ArrayBuffer);
            if (bodies.length === 1) throw new TypeError('The network connection was lost.');
            return heard();
        });
        const engine = new WhisperPcmSttEngine({ fetchImpl, finalRetryBudgetMs: CLOUD_FINAL_RETRY_BUDGET_MS });

        const pending = transcribe(engine, 'final');
        await vi.advanceTimersByTimeAsync(600);
        const result = await pending;

        expect(result).toMatchObject({ ok: true, text: 'my shoulders are softening' });
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(bodies[1]!.byteLength).toBe(bodies[0]!.byteLength);
    });

    it('a speculative pass does not re-send', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        });
        const engine = new WhisperPcmSttEngine({ fetchImpl, finalRetryBudgetMs: CLOUD_FINAL_RETRY_BUDGET_MS });

        const result = await transcribe(engine, 'spec');
        expect(result.ok).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('the loopback (desktop) engine fails fast by default', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        });
        const engine = new WhisperPcmSttEngine({ fetchImpl });

        const result = await transcribe(engine, 'final');
        expect(result.ok).toBe(false);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('still self-heals a stale token inside each attempt', async () => {
        const seen: string[] = [];
        let token = 'stale';
        const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
            const auth = (init!.headers as Record<string, string>)['authorization']!;
            seen.push(auth);
            if (seen.length === 1) throw new TypeError('Load failed');
            if (auth === 'Bearer stale') return new Response('expired', { status: 401 });
            return heard();
        });
        const engine = new WhisperPcmSttEngine({
            fetchImpl,
            finalRetryBudgetMs: CLOUD_FINAL_RETRY_BUDGET_MS,
            authProvider: async () => token,
            onAuthError: async () => {
                token = 'fresh';
            },
        });

        const pending = transcribe(engine, 'final');
        await vi.advanceTimersByTimeAsync(600);
        expect(await pending).toMatchObject({ ok: true });
        expect(seen).toEqual(['Bearer stale', 'Bearer stale', 'Bearer fresh']);
    });
});

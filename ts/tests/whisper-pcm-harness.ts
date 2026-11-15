import { vi, beforeEach, afterEach, expect } from 'vitest';

import type { SttEvent } from '../src/platform/stt.js';

/**
 * WhisperPcmSttEngine driven frame by frame: a fake mic feeds the capture
 * callback on fake time, and a fake endpoint records what each POST sent.
 *
 * A test file calls useWhisperHarness() at its top level and mocks Silero
 * itself (vi.mock is per file):
 *
 *   vi.mock('../ui/src/adapters/silero-vad.js', () => ({
 *       loadSileroVad: async () => ({ broken: true }),
 *   }));
 *
 * `broken` puts the engine on its energy speech decision, so a loud frame is
 * speech and a near-zero frame is quiet.
 */

// 32 kHz by default: a 4096-sample frame is 128 ms (shorter than the
// engine's 200 ms poll, as at 48 kHz) and decimates to exactly 2048 wire
// samples, so the first sample of each 2048-block carries its captured frame's
// tag back. 64 kHz (64 ms frames, 1024-sample blocks) works the same way.
export const RATE = 32_000;
const FRAME = 4096;
const WIRE_RATE = 16_000;
/** A frame at the default rate. */
export const FRAME_MS = (FRAME / RATE) * 1000;
export const FETCH_MS = 1000;
let rate = RATE;
/** A talking frame's amplitude: well over every gate. */
export const SPEECH = 0.2;

export type Post = {
    seconds: number;
    /** The captured frames it carried, by tag, in order. */
    tags: number[];
    /** The x-stt-prior header, decoded; null when absent. */
    prior: string | null;
};

export const heard = (text: string): Response => new Response(JSON.stringify({ text }), { status: 200 });

export const rig = {
    talking: false,
    /** A frame's square-wave amplitude, by its tag, in place of SPEECH while
     *  talking and digital silence otherwise. Called once per frame, in order. */
    amplitude: null as ((tag: number) => number) | null,
    posts: [] as Post[],
    /** The answer to the nth POST (from 1). Throwing is a dropped connection. */
    reply: (n: number): Response => heard(`pass ${n}`),
    /** How long each POST is in flight. */
    fetchMs: FETCH_MS,
};

/** Which spoken phrase (from 1) each talking frame belongs to. */
const phraseOf = new Map<number, number>();
let phrases = 0;
let wasTalking = false;
let nextTag = 0;

type Processor = { onaudioprocess: ((e: unknown) => void) | null };
let processor: Processor | null;
let mic: ReturnType<typeof setInterval> | null = null;

class FakeContext {
    state = 'running';
    sampleRate = rate;
    destination = {};
    addEventListener(): void {}
    async resume(): Promise<void> {}
    close(): Promise<void> {
        return Promise.resolve();
    }
    createMediaStreamSource() {
        return { connect(): void {}, disconnect(): void {} };
    }
    createScriptProcessor(): Processor {
        processor = { onaudioprocess: null };
        return Object.assign(processor, { connect(): void {}, disconnect(): void {} });
    }
}

/** One captured frame: a square wave, with a tag in sample 0 small enough to
 *  leave a silent frame quiet. */
function frame(): Float32Array {
    const tag = nextTag++;
    if (rig.talking) {
        if (!wasTalking) phrases++;
        phraseOf.set(tag, phrases);
    }
    wasTalking = rig.talking;
    const amp = rig.amplitude ? rig.amplitude(tag) : rig.talking ? SPEECH : 0;
    const f = new Float32Array(FRAME);
    if (amp) for (let i = 0; i < FRAME; i++) f[i] = i % 4 < 2 ? amp : -amp;
    f[0] = (tag * 16 + 8) / 0x7fff;
    return f;
}

const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const pcm = new Int16Array(init!.body as ArrayBuffer);
    const tags: number[] = [];
    const block = (FRAME * WIRE_RATE) / rate;
    for (let i = 0; i < pcm.length; i += block) tags.push(Math.floor(pcm[i]! / 16));
    const prior = (init!.headers as Record<string, string>)['x-stt-prior'];
    rig.posts.push({
        seconds: pcm.length / WIRE_RATE,
        tags,
        prior: prior === undefined ? null : decodeURIComponent(prior),
    });
    const n = rig.posts.length;
    // In flight long enough for speech frames to land during the pass.
    await new Promise((r) => setTimeout(r, rig.fetchMs));
    return rig.reply(n);
}) as typeof fetch;

export function useWhisperHarness(): void {
    beforeEach(() => {
        processor = null;
        rig.talking = false;
        rig.amplitude = null;
        rig.posts = [];
        rig.reply = (n) => heard(`pass ${n}`);
        rig.fetchMs = FETCH_MS;
        phraseOf.clear();
        phrases = 0;
        wasTalking = false;
        nextTag = 0;
        vi.useFakeTimers({
            toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance', 'Date'],
        });
        vi.spyOn(console, 'info').mockImplementation(() => {});
        vi.stubGlobal('AudioContext', FakeContext);
        vi.stubGlobal('navigator', {
            mediaDevices: {
                getUserMedia: async () => {
                    const track = {
                        muted: false,
                        readyState: 'live',
                        stop(): void {},
                        getSettings: () => ({}),
                        addEventListener(): void {},
                    };
                    return { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
                },
            },
        });
    });

    afterEach(() => {
        if (mic) clearInterval(mic);
        mic = null;
        vi.useRealTimers();
        vi.restoreAllMocks();
        vi.unstubAllGlobals();
    });
}

/** The words a POST "said": one per phrase any of its frames came from
 *  ("One. Two."), so a phrase sent twice reads twice once joined. */
export function said(post: Post): string {
    const words = ['One.', 'Two.', 'Three.', 'Four.', 'Five.'];
    const heardPhrases = new Set(post.tags.map((t) => phraseOf.get(t)).filter((p) => p !== undefined));
    return [...heardPhrases].map((p) => words[p - 1]).join(' ');
}

export type Engine = { start(): AsyncIterable<SttEvent> };
const capturing = (engine: Engine): boolean => (engine as unknown as { capturing: boolean }).capturing;

export async function engineWithMic(opts: Record<string, unknown>, sampleRate = RATE): Promise<Engine> {
    const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
    rate = sampleRate;
    const engine = new WhisperPcmSttEngine({ fetchImpl, ...opts });
    await engine.prime();
    mic = setInterval(() => {
        processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame() } });
    }, (FRAME / rate) * 1000);
    // Fill the onset pre-buffer with room tone, as between real turns.
    await vi.advanceTimersByTimeAsync(2500);
    return engine;
}

/** Start a turn; resolves once it is capturing. Fake time stands still while
 *  start() loads, so no frame lands before the turn opens. */
export async function listen(engine: Engine): Promise<{ events: SttEvent[]; done: () => boolean }> {
    const events: SttEvent[] = [];
    let finished = false;
    void (async () => {
        for await (const ev of engine.start()) events.push(ev);
        finished = true;
    })();
    for (let i = 0; i < 1000 && !capturing(engine); i++) await new Promise((r) => setImmediate(r));
    expect(capturing(engine)).toBe(true);
    return { events, done: () => finished };
}

export async function advance(ms: number, stopWhen: () => boolean = () => false): Promise<void> {
    for (let t = 0; t < ms && !stopWhen(); t += 50) await vi.advanceTimersByTimeAsync(50);
}

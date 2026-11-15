import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import type { SttEvent } from '../src/platform/stt.js';

/**
 * The max utterance cap is a runaway valve (background speech, a TV, speaker
 * echo holding the VAD open): the turn it ends is final. Speech still going
 * during that final pass starts the NEXT turn from the onset pre-buffer; it
 * must not reopen this one, or each pass re-sends (and hosted STT bills) the
 * whole buffer again. meditation-pal-uuh4.
 */

// `broken` puts the engine on its energy speech decision, so a loud frame is
// speech and a near-zero frame is quiet.
vi.mock('../ui/src/adapters/silero-vad.js', () => ({
    loadSileroVad: async () => ({ broken: true }),
}));

// 32 kHz: a 4096-sample frame is 128 ms (shorter than the engine's 200 ms
// poll, as at 48 kHz) and decimates to exactly 2048 wire samples, so the
// first sample of each 2048-block carries its captured frame's tag back.
const RATE = 32_000;
const FRAME = 4096;
const WIRE_BLOCK = 2048;
const WIRE_RATE = 16_000;
const FRAME_MS = (FRAME / RATE) * 1000;
const FETCH_MS = 1000;
const CAP_MS = 3000;

type Processor = { onaudioprocess: ((e: unknown) => void) | null };
let processor: Processor | null;

class FakeContext {
    state = 'running';
    sampleRate = RATE;
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

let talking: boolean;
let nextTag: number;
let mic: ReturnType<typeof setInterval> | null = null;

/** One captured frame: a loud square wave while talking, else zeros, with a
 *  tag in sample 0 small enough to leave a quiet frame quiet. */
function frame(): Float32Array {
    const f = new Float32Array(FRAME);
    if (talking) for (let i = 0; i < FRAME; i++) f[i] = i % 4 < 2 ? 0.2 : -0.2;
    f[0] = (nextTag++ * 16 + 8) / 0x7fff;
    return f;
}

type Post = { seconds: number; tags: number[] };
let posts: Post[];

const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    const pcm = new Int16Array(init!.body as ArrayBuffer);
    const tags: number[] = [];
    for (let i = 0; i < pcm.length; i += WIRE_BLOCK) tags.push(Math.floor(pcm[i]! / 16));
    posts.push({ seconds: pcm.length / WIRE_RATE, tags });
    // In flight long enough for speech frames to land during the pass.
    await new Promise((r) => setTimeout(r, FETCH_MS));
    return new Response(JSON.stringify({ text: `pass ${posts.length}` }), { status: 200 });
}) as typeof fetch;

beforeEach(() => {
    processor = null;
    talking = false;
    nextTag = 0;
    posts = [];
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

type Engine = { start(): AsyncIterable<SttEvent> };
const capturing = (engine: Engine): boolean => (engine as unknown as { capturing: boolean }).capturing;

async function engineWithMic(opts: Record<string, unknown>): Promise<Engine> {
    const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
    const engine = new WhisperPcmSttEngine({ fetchImpl, ...opts });
    await engine.prime();
    mic = setInterval(() => {
        processor?.onaudioprocess?.({ inputBuffer: { getChannelData: () => frame() } });
    }, FRAME_MS);
    // Fill the onset pre-buffer with room tone, as between real turns.
    await vi.advanceTimersByTimeAsync(2500);
    return engine;
}

/** Start a turn; resolves once it is capturing. Fake time stands still while
 *  start() loads, so no frame lands before the turn opens. */
async function listen(engine: Engine): Promise<{ events: SttEvent[]; done: () => boolean }> {
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

async function advance(ms: number, stopWhen: () => boolean = () => false): Promise<void> {
    for (let t = 0; t < ms && !stopWhen(); t += 50) await vi.advanceTimersByTimeAsync(50);
}

describe('the max utterance cap', () => {
    // Where the cut lands against the engine's 200 ms poll decides whether a
    // frame arrives between the cut and the final pass's snapshot, so sweep
    // the speech onset across one poll period.
    it.each([0, 25, 50, 75, 100, 125, 150, 175])(
        'ends the turn with one final pass; continuing speech starts the next turn (phase %ims)',
        async (phaseMs) => {
            const engine = await engineWithMic({ maxUtteranceMs: CAP_MS });
            const first = await listen(engine);
            await vi.advanceTimersByTimeAsync(phaseMs);
            talking = true;
            await advance(CAP_MS + 4000, first.done);
            expect(first.done()).toBe(true);

            expect(posts).toHaveLength(1);
            const [cut] = posts as [Post];
            // The cap plus the onset margin (LEAD_KEEP_MS), each rounded up to
            // whole frames.
            expect(cut.seconds).toBeGreaterThanOrEqual(CAP_MS / 1000);
            expect(cut.seconds).toBeLessThanOrEqual((CAP_MS + 500 + 2 * FRAME_MS) / 1000);
            expect(first.events).toEqual([
                { type: 'final', text: 'pass 1', seconds: cut.seconds, startedDuringTts: false },
            ]);

            // Still talking: the next turn opens on the pre-buffer, which picks
            // up right after the cut frame, with no frame sent twice.
            const second = await listen(engine);
            await advance(1000);
            talking = false;
            await advance(15_000, second.done);
            expect(second.done()).toBe(true);

            const later = posts.slice(1);
            expect(later.length).toBeGreaterThan(0);
            const firstTags = new Set(cut.tags);
            for (const p of later) expect(p.tags.some((t) => firstTags.has(t))).toBe(false);
            expect(later[0]!.tags[0]).toBe(cut.tags.at(-1)! + 1);
            expect(second.events.at(-1)).toMatchObject({ type: 'final' });
        }
    );
});

describe('speech that continues past a silence-window submit', () => {
    it('reopens the turn, and the final pass carries all of it', async () => {
        const engine = await engineWithMic({
            speculation: false,
            silenceBaseMs: 1000,
            silenceMaxMs: 1000,
            silenceRampRate: 0,
        });
        const turn = await listen(engine);
        talking = true;
        await advance(1500);
        talking = false;
        // The window closes about 1s into the pause and the pass goes out.
        await advance(1300);
        expect(posts).toHaveLength(1);
        // The meditator picks up again while that pass is in flight.
        talking = true;
        await advance(1500);
        talking = false;
        await advance(8000, turn.done);
        expect(turn.done()).toBe(true);

        expect(posts).toHaveLength(2);
        const [before, after] = posts as [Post, Post];
        expect(after.tags[0]).toBe(before.tags[0]);
        expect(after.tags.at(-1)!).toBeGreaterThan(before.tags.at(-1)! + 5);
        expect(turn.events).toEqual([
            { type: 'partial', text: 'pass 1', startedDuringTts: false },
            {
                type: 'final',
                text: 'pass 2',
                seconds: before.seconds + after.seconds,
                startedDuringTts: false,
            },
        ]);
    });
});

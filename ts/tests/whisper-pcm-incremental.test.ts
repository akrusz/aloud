import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
    advance,
    engineWithMic,
    FRAME_MS,
    heard,
    listen,
    rig,
    said,
    SPEECH,
    useWhisperHarness,
    type Engine,
    type Post,
} from './whisper-pcm-harness.js';
import { WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';

/**
 * Incremental passes (WhisperPcmSttEngineOptions.incremental): each pass
 * sends only the audio the passes before it have not transcribed, with the
 * text so far in `x-stt-prior`, and the replies are joined. The fake endpoint
 * answers each POST with the phrases its frames came from (harness `said`),
 * so a phrase sent twice reads twice in the turn's text.
 */

// `broken` puts the engine on its energy speech decision, so a loud frame is
// speech and a near-zero frame is quiet.
vi.mock('../ui/src/adapters/silero-vad.js', () => ({
    loadSileroVad: async () => ({ broken: true }),
}));

const clips = vi.hoisted(() => [] as { label: string; from: number; text: string }[]);
vi.mock('../ui/src/stt-clip-recorder.js', () => ({
    recordSttClip: (clip: { label: string; from: number; text: string }) => clips.push(clip),
}));

useWhisperHarness();
beforeEach(() => {
    clips.length = 0;
});

type Internals = { utteranceDone: boolean; speechStarted: boolean; lastSpeechMs: number };

const windowed = { silenceBaseMs: 4000, silenceMaxMs: 4000, silenceRampRate: 0 };
const incremental = { incremental: true, ...windowed };
const saysWhatItHeard = (n: number): Response => heard(said(rig.posts[n - 1]!));
const final = (text: string, seconds: number) => ({ type: 'final', text, seconds, startedDuringTts: false });
const partial = (text: string) => ({ type: 'partial', text, startedDuringTts: false });

/** Room tone under the speech gate and the hint bar, fading, so that among
 *  equally plain chunks the latest is the quietest. */
const fadingHum = (quietFrames: number): number => Math.max(0.002, 0.008 - 0.0003 * quietFrames);

function expectNoFrameTwice(posts: Post[]): void {
    const all = posts.flatMap((p) => p.tags);
    expect(new Set(all).size).toBe(all.length);
}

/** `n` phrases, each pause between them answered by one speculative pass,
 *  then quiet until the turn ends. */
async function phrases(turn: { done: () => boolean }, n = 2): Promise<void> {
    const before = rig.posts.length;
    for (let i = 1; i <= n; i++) {
        rig.talking = true;
        await advance(1500);
        rig.talking = false;
        if (i === n) break;
        await advance(2500);
        expect(rig.posts).toHaveLength(before + i);
    }
    await advance(12_000, turn.done);
    expect(turn.done()).toBe(true);
}

describe('incremental passes', () => {
    it('send each piece once, from where the last ended, and reuse the joined text for the final', async () => {
        rig.reply = saysWhatItHeard;
        const engine = await engineWithMic(incremental);
        const turn = await listen(engine);
        await phrases(turn);

        expect(rig.posts).toHaveLength(2);
        const [first, second] = rig.posts as [Post, Post];
        expect(first.prior).toBeNull();
        expect(second.tags[0]).toBe(first.tags.at(-1)! + 1);
        expect(second.prior).toBe('One.');
        expectNoFrameTwice(rig.posts);
        expect(turn.events).toEqual([
            partial('One.'),
            partial('One. Two.'),
            final('One. Two.', first.seconds + second.seconds),
        ]);
    });

    it('cut at the quietest chunk of the pass\'s last half second, and send the rest next time', async () => {
        rig.reply = saysWhatItHeard;
        // Each pause gets one chunk of digital silence, its 4th quiet frame:
        // inside the last half second of whichever range the pass sees.
        const notches: number[] = [];
        let quiet = -1;
        rig.amplitude = (tag) => {
            if (rig.talking) {
                quiet = 0;
                return SPEECH;
            }
            if (quiet < 0) return 0;
            quiet++;
            if (quiet === 4) {
                notches.push(tag);
                return 0;
            }
            return fadingHum(quiet);
        };
        const engine = await engineWithMic(incremental);
        const turn = await listen(engine);
        await phrases(turn);

        expect(rig.posts).toHaveLength(2);
        const [first, second] = rig.posts as [Post, Post];
        expect(first.tags.at(-1)).toBe(notches[0]! - 1);
        // The notch and the frame withheld after it open the next piece (the
        // rest of the pause is compacted away).
        expect(second.tags.slice(0, 2)).toEqual([notches[0], notches[0]! + 1]);
        expectNoFrameTwice(rig.posts);
        expect(turn.events.at(-1)).toEqual(final('One. Two.', first.seconds + second.seconds));
    });

    it('commit a piece that is only a number: a spoken "seven" comes back as "7."', async () => {
        rig.reply = (n) => heard(n === 1 ? "Hmm, I'd say..." : '7.');
        const engine = await engineWithMic(incremental);
        const turn = await listen(engine);
        await phrases(turn);

        expect(rig.posts).toHaveLength(2);
        const [first, second] = rig.posts as [Post, Post];
        expect(turn.events).toEqual([
            partial("Hmm, I'd say..."),
            partial("Hmm, I'd say... 7."),
            final("Hmm, I'd say... 7.", first.seconds + second.seconds),
        ]);
    });

    it.each([
        // A dropped connection is the next describe's: it carried a prior.
        ['fails with a 500', (): Response => new Response('upstream', { status: 500 })],
        ['comes back empty', (): Response => heard('')],
        ['hears no words', (): Response => heard('[BLANK_AUDIO]')],
    ])('move nothing when a pass %s: the next sends that piece again, with the same prior', async (_, second) => {
        rig.reply = (n) => (n === 2 ? second() : saysWhatItHeard(n));
        const engine = await engineWithMic(incremental);
        const turn = await listen(engine);
        await phrases(turn);

        expect(rig.posts).toHaveLength(3);
        const [first, failed, last] = rig.posts as [Post, Post, Post];
        expect(failed.tags[0]).toBe(first.tags.at(-1)! + 1);
        expect(last.tags[0]).toBe(failed.tags[0]);
        expect(failed.prior).toBe('One.');
        expect(last.prior).toBe('One.');
        expect(turn.events.at(-1)).toMatchObject({ type: 'final', text: 'One. Two.' });
    });

    describe('a soft sound past the seam (under the speech gate, over the hint bar)', () => {
        // A hum the noise floor learns lifts the energy speech gate to about
        // 0.023, so SOFT is a speech hint the VAD doesn't count as speech.
        const HUM = 0.008;
        const SOFT = 0.02;

        async function hummingTurn(engine: Engine) {
            const turn = await listen(engine);
            await advance(3000);
            return turn;
        }

        it('sends a small final piece from the seam, joined on', async () => {
            rig.reply = (n) => heard(n === 1 ? 'One.' : 'And softly.');
            const softTags: number[] = [];
            let soft = false;
            rig.amplitude = (tag) => {
                if (rig.talking) return SPEECH;
                if (soft) softTags.push(tag);
                return soft ? SOFT : HUM;
            };
            const engine = await engineWithMic(incremental);
            const turn = await hummingTurn(engine);
            rig.talking = true;
            await advance(1500);
            rig.talking = false;
            await advance(2000);
            expect(rig.posts).toHaveLength(1);
            soft = true;
            await advance(300);
            soft = false;
            await advance(10_000, turn.done);
            expect(turn.done()).toBe(true);

            expect(rig.posts).toHaveLength(2);
            const [first, piece] = rig.posts as [Post, Post];
            expect(piece.tags[0]).toBe(first.tags.at(-1)! + 1);
            expect(piece.prior).toBe('One.');
            expect(softTags.length).toBeGreaterThan(0);
            expect(piece.tags).toEqual(expect.arrayContaining(softTags));
            expect(said(piece)).toBe('');
            expect(turn.events.at(-1)).toEqual(final('One. And softly.', first.seconds + piece.seconds));
        });

        it('counts one in the withheld half second, which no pass has sent', async () => {
            rig.reply = (n) => heard(n === 1 ? 'One.' : 'Mm.');
            // The 4th quiet frame is the seam (silence), the 5th a soft sound,
            // both inside the last half second the first pass sees.
            let notch = -1;
            let softTag = -1;
            let quiet = -1;
            rig.amplitude = (tag) => {
                if (rig.talking) {
                    quiet = 0;
                    return SPEECH;
                }
                if (quiet >= 0) quiet++;
                if (quiet === 4) notch = tag;
                if (quiet === 5) softTag = tag;
                return quiet === 4 ? 0 : quiet === 5 ? SOFT : HUM;
            };
            const engine = await engineWithMic(incremental);
            const turn = await hummingTurn(engine);
            rig.talking = true;
            await advance(1500);
            rig.talking = false;
            await advance(12_000, turn.done);
            expect(turn.done()).toBe(true);

            expect(rig.posts).toHaveLength(2);
            const [first, piece] = rig.posts as [Post, Post];
            expect(first.tags).not.toContain(softTag);
            expect(piece.tags.slice(0, 2)).toEqual([notch, softTag]);
            expect(turn.events.at(-1)).toEqual(final('One. Mm.', first.seconds + piece.seconds));
        });

        /** One phrase whose pause the first pass answers, then quiet to the
         *  submit, with one soft frame just before or just after it. */
        async function softAroundTheSubmit(where: 'before' | 'after') {
            rig.reply = (n) => heard(n === 1 ? 'One.' : 'Mm.');
            let softTag = -1;
            let softNext = false;
            rig.amplitude = (tag) => {
                if (rig.talking) return SPEECH;
                if (!softNext) return HUM;
                softNext = false;
                softTag = tag;
                return SOFT;
            };
            const engine = await engineWithMic(incremental);
            const inner = engine as unknown as Internals & { processor: { onaudioprocess: (e: unknown) => void } };
            const handle = inner.processor.onaudioprocess;
            inner.processor.onaudioprocess = (e) => {
                const silence = performance.now() - inner.lastSpeechMs;
                if (where === 'before' && inner.speechStarted && !inner.utteranceDone && softTag < 0) {
                    softNext = silence >= windowed.silenceBaseMs - FRAME_MS;
                }
                const wasDone = inner.utteranceDone;
                handle(e);
                // A second frame straight after the one that submitted, before
                // any timer runs: start()'s poll has not read the submit yet.
                if (where === 'after' && !wasDone && inner.utteranceDone) {
                    softNext = true;
                    handle(e);
                }
            };
            const turn = await hummingTurn(engine);
            rig.talking = true;
            await advance(1500);
            rig.talking = false;
            await advance(12_000, turn.done);
            expect(turn.done()).toBe(true);
            expect(softTag).toBeGreaterThan(0);
            return { turn, softTag };
        }

        it('heard after the submit, before the poll reads it, sends nothing: the text so far stands', async () => {
            const { turn } = await softAroundTheSubmit('after');

            expect(rig.posts).toHaveLength(1);
            expect(turn.events.at(-1)).toEqual(final('One.', rig.posts[0]!.seconds));
        });

        it('heard on the frame before the submit, sends a final piece with it', async () => {
            const { turn, softTag } = await softAroundTheSubmit('before');

            expect(rig.posts).toHaveLength(2);
            const [first, piece] = rig.posts as [Post, Post];
            expect(piece.tags).toContain(softTag);
            expect(turn.events.at(-1)).toEqual(final('One. Mm.', first.seconds + piece.seconds));
        });
    });

    it('reopen a final provisionally: the next pass starts at the last seam, and each phrase reads once', async () => {
        // A speculative pass fails, so the silence window sends a final, and
        // the meditator speaks again while it is in flight.
        rig.reply = (n) => (n === 2 ? new Response('upstream', { status: 500 }) : saysWhatItHeard(n));
        const engine = await engineWithMic({
            incremental: true,
            silenceBaseMs: 2000,
            silenceMaxMs: 2000,
            silenceRampRate: 0,
        });
        const turn = await listen(engine);
        rig.talking = true;
        await advance(1500);
        rig.talking = false;
        await advance(1500);
        rig.talking = true;
        await advance(1500);
        rig.talking = false;
        await advance(2300);
        expect(rig.posts).toHaveLength(3);
        rig.talking = true;
        await advance(1500);
        rig.talking = false;
        await advance(10_000, turn.done);
        expect(turn.done()).toBe(true);

        expect(rig.posts).toHaveLength(4);
        const [first, failed, reopened, after] = rig.posts as [Post, Post, Post, Post];
        const seam = first.tags.at(-1)! + 1;
        expect([failed.tags[0], reopened.tags[0], after.tags[0]]).toEqual([seam, seam, seam]);
        expect(after.tags.at(-1)!).toBeGreaterThan(reopened.tags.at(-1)!);
        expect(after.prior).toBe('One.');
        expect(turn.events).toEqual([
            partial('One.'),
            partial('One. Two.'),
            partial('One. Two. Three.'),
            final(
                'One. Two. Three.',
                first.seconds + reopened.seconds + after.seconds
            ),
        ]);
    });

    it('send no prior on a turn\'s first pass, the second turn\'s included', async () => {
        rig.reply = saysWhatItHeard;
        const engine = await engineWithMic(incremental);
        for (let n = 1; n <= 2; n++) {
            const turn = await listen(engine);
            rig.talking = true;
            await advance(1500);
            rig.talking = false;
            await advance(8000, turn.done);
            expect(turn.done()).toBe(true);
            expect(rig.posts).toHaveLength(n);
            expect(rig.posts[n - 1]!.prior).toBeNull();
        }
        expect(said(rig.posts[1]!)).toBe('Two.');
    });

    it('do not send a final piece under a quarter second: the text so far stands', async () => {
        // 64 kHz: 64 ms chunks, so a cap cut on the first frame after the
        // seam leaves a two-chunk piece. The fade puts the seam on the last
        // chunk the pass saw.
        rig.fetchMs = 0;
        let quiet = -1;
        rig.amplitude = () => {
            if (rig.talking) {
                quiet = 0;
                return SPEECH;
            }
            if (quiet < 0) return 0;
            return fadingHum(++quiet);
        };
        const engine = await engineWithMic(incremental, 64_000);
        rig.reply = (n) => {
            if (n === 1) {
                // Speech again, and the cap (read every frame) cuts the turn
                // on the next one.
                rig.talking = true;
                (engine as unknown as { opts: { maxUtteranceMs: number } }).opts.maxUtteranceMs = 0;
            }
            return saysWhatItHeard(n);
        };
        const turn = await listen(engine);
        rig.talking = true;
        await advance(1000);
        rig.talking = false;
        await advance(5000, turn.done);
        expect(turn.done()).toBe(true);

        expect(rig.posts).toHaveLength(1);
        expect(turn.events).toEqual([partial('One.'), final('One.', rig.posts[0]!.seconds)]);
    });
});

describe('a server that refuses x-stt-prior (older than the client)', () => {
    // Its CORS allowlist fails the preflight of any request carrying the
    // header, and the fetch rejects with no answer.
    const oldServer = (n: number): Response => {
        if (rig.posts[n - 1]!.prior !== null) throw new TypeError('Load failed');
        return saysWhatItHeard(n);
    };
    const hosted = { ...incremental, finalRetryBudgetMs: 30_000 };
    const latchWarnings = (warn: { mock: { calls: unknown[][] } }) =>
        warn.mock.calls.filter(([m]) => String(m).includes('x-stt-prior'));

    it('costs one request: the turn starts over in full passes, and so does every turn after it', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        rig.reply = oldServer;
        const engine = await engineWithMic(hosted);
        const first = await listen(engine);
        await phrases(first);

        expect(rig.posts.map((p) => p.prior)).toEqual([null, 'One.', null]);
        const [spec, , full] = rig.posts as [Post, Post, Post];
        expect(full.tags[0]).toBe(spec.tags[0]);
        expect(first.events).toEqual([partial('One.'), final('One. Two.', spec.seconds + full.seconds)]);
        expect(clips.at(-1)).toMatchObject({ label: 'final', from: 0, text: 'One. Two.' });

        const second = await listen(engine);
        await phrases(second);

        expect(rig.posts).toHaveLength(5);
        const [a, b] = rig.posts.slice(3) as [Post, Post];
        expect([a.prior, b.prior]).toEqual([null, null]);
        expect(b.tags[0]).toBe(a.tags[0]);
        expect(second.events).toEqual([
            partial('Three.'),
            partial('Three. Four.'),
            final('Three. Four.', a.seconds + b.seconds),
        ]);
        expect(latchWarnings(warn)).toHaveLength(1);
    });

    it('on the final, sends the turn again at once in full, and that pass rides out a dropped connection', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        // A 500 latches nothing, so the final carries the prior; the full
        // pass's first try then meets a dropped connection.
        rig.reply = (n) => {
            if (n === 2) return new Response('upstream', { status: 500 });
            if (n === 4) throw new TypeError('Load failed');
            return oldServer(n);
        };
        const engine = await engineWithMic(hosted);
        const turn = await listen(engine);
        await phrases(turn);

        expect(rig.posts.map((p) => p.prior)).toEqual([null, 'One.', 'One.', null, null]);
        const [spec, , , , full] = rig.posts as [Post, Post, Post, Post, Post];
        expect(full.tags[0]).toBe(spec.tags[0]);
        expect(turn.events.at(-1)).toEqual(final('One. Two.', spec.seconds + full.seconds));
    });

    it('latches nothing on a rejected pass that carried no prior', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        rig.reply = (n) => {
            if (n === 1) throw new TypeError('Load failed');
            return saysWhatItHeard(n);
        };
        const engine = await engineWithMic(hosted);
        const turn = await listen(engine);
        await phrases(turn, 3);

        expect(rig.posts.map((p) => p.prior)).toEqual([null, null, 'One. Two.']);
        const [, second, third] = rig.posts as [Post, Post, Post];
        expect(third.tags[0]).toBe(second.tags.at(-1)! + 1);
        expect(turn.events.at(-1)).toEqual(final('One. Two. Three.', second.seconds + third.seconds));
        expect(latchWarnings(warn)).toHaveLength(0);
    });
});

describe('full passes (incremental off)', () => {
    it('send every pass from the turn\'s start, with no prior', async () => {
        rig.reply = (n) => heard(n === 1 ? 'One.' : 'One. Two.');
        const engine = await engineWithMic(windowed);
        const turn = await listen(engine);
        await phrases(turn);

        expect(rig.posts).toHaveLength(2);
        const [first, second] = rig.posts as [Post, Post];
        expect(second.tags[0]).toBe(first.tags[0]);
        expect(rig.posts.map((p) => p.prior)).toEqual([null, null]);
        expect(turn.events.at(-1)).toEqual(final('One. Two.', first.seconds + second.seconds));
    });
});

describe('the x-stt-prior header', () => {
    type Transcribe = (
        frames: Float32Array[],
        label: 'spec' | 'final',
        rate: number,
        piece?: { prior: string; fromSec: number }
    ) => Promise<{ ok: boolean }>;

    async function sentWith(options: { incremental: boolean }, prior: string) {
        const sent: { url: string; headers: Record<string, string> }[] = [];
        const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
            sent.push({ url: String(url), headers: init!.headers as Record<string, string> });
            return heard('and heavy.');
        });
        const engine = new WhisperPcmSttEngine({ ...options, fetchImpl });
        const transcribe = (engine as unknown as { transcribe: Transcribe }).transcribe.bind(engine);
        const result = await transcribe([new Float32Array(16_000).fill(0.1)], 'spec', 16_000, {
            prior,
            fromSec: 2,
        });
        return { result, ...sent[0]! };
    }

    it('carries the tail of the text so far, encoded, and never rides the URL', async () => {
        const prior = 'I feel warm & still, 很温暖.';
        const { result, url, headers } = await sentWith({ incremental: true }, prior);
        expect(result.ok).toBe(true);
        expect(headers['x-stt-prior']).toBe(encodeURIComponent(prior));
        expect(url).not.toContain('warm');
        expect(url).not.toContain(encodeURIComponent('warm'));
    });

    it('is left off a piece whose text will not encode, and the pass still runs', async () => {
        const { result, headers } = await sentWith({ incremental: true }, 'I feel \ud83d');
        expect(result.ok).toBe(true);
        expect(headers['x-stt-prior']).toBeUndefined();
    });

    it('is never sent on full passes', async () => {
        const { headers } = await sentWith({ incremental: false }, 'I feel warm.');
        expect(headers['x-stt-prior']).toBeUndefined();
    });
});

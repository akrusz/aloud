import { describe, expect, it } from 'vitest';
import { withGain } from '../src/providers/mp3-gain.js';
import { SENTENCE_MARKS, sentenceMarkTimes } from '../src/providers/mp3-marks.js';
import { concat, frame, run } from './fake-mp3.js';

const QUIET = 120;
const SPEECH = 160;
const FRAME_S = 0.024;

/** Frames for [gain, seconds] spans, at Azure's 24 ms a frame. */
const shape = (...spans: [number, number][]) => concat(...spans.map(([gain, s]) => run(Math.round(s / FRAME_S), gain)));

/** Where a sentence that starts at frame `k` counts from. */
const from = (k: number) => Math.round((k * FRAME_S - SENTENCE_MARKS.leadS) * 100) / 100;

/** The offset of `part` in `text`. */
const at = (text: string, part: string) => text.indexOf(part);

describe('sentenceMarkTimes', () => {
    const text = 'Notice where the breath is easiest. Stay with that spot for a while. What do you find there?';
    // Speech in proportion to the text, a pause at each sentence end, and one
    // inside the first sentence.
    const clip = shape(
        [QUIET, 0.24],
        [SPEECH, 0.96],
        [QUIET, 0.48],
        [SPEECH, 1.2],
        [QUIET, 0.96],
        [SPEECH, 2.16],
        [QUIET, 1.2],
        [SPEECH, 1.92],
        [QUIET, 0.24]
    );
    const marks = [at(text, 'Stay'), at(text, 'What')];

    it('finds each sentence start in the pause at its sentence end, ahead of the first sound', () => {
        // Speech runs start at frames 10, 70, 160 and 300.
        expect(sentenceMarkTimes(clip, text, marks)).toEqual([from(160), from(300)]);
    });

    it('answers only the marks asked about, fitting every sentence end in the text', () => {
        // "Take your time." merged into the next chunk by the client: only
        // its start is asked about, and the pause after it still belongs to it.
        const reply = 'Notice where the breath is easiest to feel. Take your time. Let it move on its own.';
        const take = shape(
            [QUIET, 0.24],
            [SPEECH, 2.3],
            [QUIET, 0.6],
            [SPEECH, 0.72],
            [QUIET, 1.2],
            [SPEECH, 1.4],
            [QUIET, 0.3]
        );
        const starts = [10, 10 + 96 + 25, 10 + 96 + 25 + 30 + 50];
        expect(sentenceMarkTimes(take, reply, [at(reply, 'Take')])).toEqual([from(starts[1]!)]);
        expect(sentenceMarkTimes(take, reply, [at(reply, 'Let')])).toEqual([from(starts[2]!)]);
    });

    it('reads the level under the gain the route put on the clip', () => {
        const want = sentenceMarkTimes(clip, text, marks);
        expect(sentenceMarkTimes(withGain(clip, 3), text, marks, 3)).toEqual(want);
        expect(sentenceMarkTimes(withGain(clip, -4.5), text, marks, -4.5)).toEqual(want);
        // Left uncompensated, a quieter clip's speech falls under the bar.
        expect(sentenceMarkTimes(withGain(clip, -40), text, marks)).toBeNull();
    });

    it('counts time as played: a leading Xing/Info frame is not audio', () => {
        const info = frame(0);
        info.set([0x49, 0x6e, 0x66, 0x6f], 4 + 9);
        expect(sentenceMarkTimes(concat(info, clip), text, marks)).toEqual(sentenceMarkTimes(clip, text, marks));
    });

    it('declines marks that do not fit the text, a stream it cannot walk, and too few pauses', () => {
        expect(sentenceMarkTimes(clip, text, [0])).toBeNull();
        expect(sentenceMarkTimes(clip, text, [marks[1]!, marks[0]!])).toBeNull();
        expect(sentenceMarkTimes(clip, text, [text.length])).toBeNull();
        expect(sentenceMarkTimes(clip, text, [1.5])).toBeNull();
        expect(sentenceMarkTimes(new Uint8Array([0x49, 0x44, 0x33, 0x04]), text, marks)).toBeNull();
        expect(sentenceMarkTimes(shape([QUIET, 0.2], [SPEECH, 3], [QUIET, 0.2]), text, marks)).toBeNull();
        expect(sentenceMarkTimes(clip, text, [])).toEqual([]);
    });
});

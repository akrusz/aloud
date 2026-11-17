import { describe, expect, it } from 'vitest';
import { PAUSE_CAP_S, capPauses, findPauses, pauseMarks } from '../scripts/voice-clips/cadence.js';
import { repeatedWords } from '../scripts/voice-clips/transcript.js';

const RATE = 24_000;

/** Speech as 220Hz tone, pauses as silence, in seconds. */
function clip(...parts: Array<{ say: number } | { pause: number }>): Float32Array {
    const out: number[] = [];
    for (const p of parts) {
        const n = Math.round(('say' in p ? p.say : p.pause) * RATE);
        for (let i = 0; i < n; i++) out.push('say' in p ? 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE) : 0);
    }
    return Float32Array.from(out);
}

const energy = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0);
const lengths = (x: Float32Array, text: string) =>
    findPauses(x, RATE, text).map((p) => [Number((p.endS - p.startS).toFixed(1)), p.kind]);

// 11 + 11 + 14 spoken characters: the comma sits 31% in, the full stop 61%.
const TEXT = 'One two three, four five six. Seven eight nine.';
const lead = { pause: 0.2 };

describe('setup clip cadence', () => {
    it('finds the marks inside a line, not the one that ends it', () => {
        expect(pauseMarks('Okay, noting mode.')).toEqual([{ at: 4 / 14, kind: 'clause' }]);
        expect(pauseMarks(TEXT).map((m) => m.kind)).toEqual(['clause', 'sentence']);
        expect(pauseMarks('就这些。准备好了，就说“开始”。').map((m) => m.kind)).toEqual(['sentence', 'clause']);
        expect(pauseMarks('No marks here')).toEqual([]);
    });

    it('matches each pause to the mark it falls at, by where it sits in the speech', () => {
        const x = clip(lead, { say: 1.1 }, { pause: 1.5 }, { say: 1.1 }, { pause: 2 }, { say: 0.9 }, { pause: 0.9 }, { say: 0.5 }, lead);
        expect(lengths(x, TEXT)).toEqual([
            [1.5, 'clause'],
            [2, 'sentence'],
            [0.9, 'word'],
        ]);
    });

    it('gives a mark the longest pause near it, so a slower stretch cannot move it', () => {
        // Both pauses sit near the comma (31%): the long one is its pause.
        const x = clip(lead, { say: 0.97 }, { pause: 1.2 }, { say: 0.25 }, { pause: 0.3 }, { say: 2.38 }, lead);
        expect(lengths(x, 'One two three, four five six seven eight nine.').map(([, kind]) => kind)).toEqual(['clause', 'word']);
    });

    it('cuts each pause down to its cap and keeps every bit of the speech', () => {
        const x = clip(lead, { say: 1.1 }, { pause: 1.5 }, { say: 1.1 }, { pause: 2 }, { say: 0.9 }, { pause: 0.9 }, { say: 0.5 }, lead);
        const y = capPauses(x, RATE, TEXT);
        expect(lengths(y, TEXT)).toEqual([
            [PAUSE_CAP_S.clause, 'clause'],
            [PAUSE_CAP_S.sentence, 'sentence'],
            [PAUSE_CAP_S.word, 'word'],
        ]);
        const cut = 1.5 - PAUSE_CAP_S.clause + (2 - PAUSE_CAP_S.sentence) + (0.9 - PAUSE_CAP_S.word);
        expect(y.length / RATE).toBeCloseTo(x.length / RATE - cut, 1);
        expect(energy(y) / energy(x)).toBeCloseTo(1, 3);
    });

    it('leaves a clip with no long pause as it is', () => {
        const x = clip(lead, { say: 1 }, { pause: 0.5 }, { say: 1 }, { pause: 0.3 }, { say: 1 }, lead);
        expect(capPauses(x, RATE, TEXT)).toBe(x);
    });
});

describe('setup clip transcript check', () => {
    const line =
        "Felt sense follows a six step process where you'll investigate something that's on your mind by putting it into words and feeling into your body's responses, in order to get to the root of it.";

    it('passes a take heard as written, Whisper spelling aside', () => {
        expect(repeatedWords(line, line.replace('six step', 'six-step').replace(',', ''))).toEqual([]);
        expect(repeatedWords('Welcome to aloud, the meditation app.', 'Welcome to a loud, the meditation app.')).toEqual([]);
    });

    it('catches a word said again, its start, or its stem', () => {
        expect(repeatedWords(line, line.replace('into words', 'into words, words'))).toEqual(['words']);
        expect(repeatedWords(line, line.replace('it into words', 'it in into words'))).toEqual(['in']);
        expect(repeatedWords(line, line.replace('and feeling', 'and feeler feeling').replace('get to the', 'get to the to the'))).toEqual([
            'feeler',
            'to',
            'the',
        ]);
    });

    it('catches the whole line said twice', () => {
        expect(repeatedWords('Okay, noting mode.', 'Okay, noting mode. Okay, noting mode.')).toEqual(['okay', 'noting', 'mode']);
    });
});

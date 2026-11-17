import { describe, expect, it } from 'vitest';
import { PAUSE_CAP_S, capPauses, findPauses, pauseMarks } from '../scripts/voice-clips/cadence.js';
import { missingWords, repeatedWords, transcriptFaults, words } from '../scripts/voice-clips/transcript.js';

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

describe('setup clip lost words', () => {
    const focus =
        "Back to Exploration, which is the best place to start. Choosing a focus tells me where you plan to put your attention: the body, emotions, or parts of yourself. Or leave it blank if you aren't sure.";

    it('writes numbers as digits and ok as okay, both sides alike', () => {
        expect(words('Timer set for forty-five minutes.')).toEqual(['timer', 'set', 'for', '45', 'minutes']);
        expect(words('A six step process, OK?')).toEqual(['a', '6', 'step', 'process', 'okay']);
    });

    // What Whisper heard in Harper's committed clips (2026-11-16).
    it("fails a take that lost its first word, as Harper's softvoice does", () => {
        expect(missingWords(focus, focus.replace('Back to Exploration', 'to exploration'))).toEqual(['back']);
        expect(missingWords('Timer set for fifteen minutes.', "I'm her set for 15 minutes.")).toEqual(['timer']);
        expect(missingWords('The timer is off.', 'Timer is off.')).toEqual(['the']);
        expect(missingWords("That's part of exploration.", "It's part of exploration.")).toEqual(["that's"]);
        expect(missingWords('That can\'t change right now.', "Can't change right now.")).toEqual(['that']);
    });

    // What Whisper heard in Ethan's, which are whole.
    it("passes Whisper's own slips", () => {
        expect(missingWords('Parts focus is on.', 'Hearts focuses on.')).toEqual([]);
        expect(missingWords('Spacious is off.', 'Bacious is off.')).toEqual([]);
        expect(missingWords('Okay, all set.', "Okay, I'll set.")).toEqual([]);
        expect(missingWords('Check-ins are off.', 'Checkins are off.')).toEqual([]);
        expect(missingWords('Timer set for forty-five minutes.', 'Timer set for 45 minutes.')).toEqual([]);
        expect(missingWords('OK, that\'s the basics.', "Okay, that's the basics.")).toEqual([]);
        expect(missingWords('Welcome to aloud, the meditation app.', 'Welcome to Allowed, the meditation app.')).toEqual([]);
        expect(missingWords('Guidance set to following.', 'Guide and set to following.')).toEqual([]);
        expect(missingWords('The clock will show time in session.', 'The clock will show time and session.')).toEqual([]);
    });

    it('fails lost words inside a line past a tenth of it, and leaves a two-word line alone', () => {
        expect(missingWords('Timer set for five minutes.', 'Timer for minutes.')).toEqual(['set', '5']);
        const four = focus.replace('tells me where you', 'tells where').replace('the body', 'body').replace('Or leave', 'leave');
        expect(missingWords(focus, four)).toEqual(['me', 'you', 'the', 'or']);
        expect(missingWords(focus, focus.replace('tells me where', 'tells where'))).toEqual([]);
        expect(missingWords('Never mind.', 'Mind.')).toEqual([]);
    });

    it('reports lost words on any line and repeats on a long one', () => {
        expect(transcriptFaults('The timer is off.', 'Timer is off.', false).join()).toMatch(/"the" not heard/);
        expect(transcriptFaults('Okay, noting mode.', 'Okay, noting mode. Okay, noting mode.', false)).toEqual([]);
        expect(transcriptFaults(focus, focus.replace('Choosing a', 'Choosing a a'), true).join()).toMatch(/said again/);
        expect(transcriptFaults(focus, focus, true)).toEqual([]);
    });
});

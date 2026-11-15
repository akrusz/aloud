import { describe, expect, it } from 'vitest';
import { joinTranscripts, priorPrompt } from '../src/platform/stt-stitch.js';

describe('joinTranscripts', () => {
    it('joins with one space, trimming both sides', () => {
        expect(joinTranscripts('  I feel warm.  ', '  And heavy. ')).toBe('I feel warm. And heavy.');
    });

    it('returns the other side when one is empty', () => {
        expect(joinTranscripts('', 'And heavy.')).toBe('And heavy.');
        expect(joinTranscripts('I feel warm.', '   ')).toBe('I feel warm.');
        expect(joinTranscripts('', '')).toBe('');
    });

    it('puts no space between CJK on both sides of the join', () => {
        expect(joinTranscripts('我觉得很温暖，', '也很沉重。')).toBe('我觉得很温暖，也很沉重。');
        expect(joinTranscripts('很温暖。', '然后')).toBe('很温暖。然后');
    });

    it('keeps the space when only one side is CJK', () => {
        expect(joinTranscripts('很温暖。', 'OK.')).toBe('很温暖。 OK.');
        expect(joinTranscripts('It is warm.', '然后')).toBe('It is warm. 然后');
    });

    it('drops a period the next piece continues past in lowercase', () => {
        expect(joinTranscripts('There is a warmth.', 'in my belly.')).toBe('There is a warmth in my belly.');
    });

    it('keeps the period before a capital, an ellipsis, or other punctuation', () => {
        expect(joinTranscripts('I feel warm.', 'And heavy.')).toBe('I feel warm. And heavy.');
        expect(joinTranscripts('I feel...', 'warm.')).toBe('I feel... warm.');
        expect(joinTranscripts('I feel warm?', 'and heavy.')).toBe('I feel warm? and heavy.');
        expect(joinTranscripts('I feel warm,', 'and heavy.')).toBe('I feel warm, and heavy.');
        expect(joinTranscripts('很温暖。', 'and heavy.')).toBe('很温暖。 and heavy.');
    });

    it('reopens a clip closed on a word no sentence ends on: drops its period and the capital after', () => {
        expect(joinTranscripts('I want to think about.', 'My brother.')).toBe('I want to think about my brother.');
        expect(joinTranscripts('There is a sort of.', 'Heavy feeling.')).toBe('There is a sort of heavy feeling.');
        expect(joinTranscripts("And then I've.", 'Found it.')).toBe("And then I've found it.");
    });

    it('keeps the capital on "I", and leaves a question, an ellipsis, or a finished clause alone', () => {
        expect(joinTranscripts('I sat with the.', "I'm not sure.")).toBe("I sat with the. I'm not sure.");
        expect(joinTranscripts('I sat with the.', 'I mean warmth.')).toBe('I sat with the. I mean warmth.');
        expect(joinTranscripts('Is it about?', 'My brother.')).toBe('Is it about? My brother.');
        expect(joinTranscripts('It is sort of...', 'Heavy.')).toBe('It is sort of... Heavy.');
        expect(joinTranscripts('I feel warm.', 'My belly too.')).toBe('I feel warm. My belly too.');
    });

    it('keeps a phrase the speaker says twice', () => {
        expect(joinTranscripts("I'm just really happy.", "I'm just really happy.")).toBe(
            "I'm just really happy. I'm just really happy."
        );
    });
});

describe('priorPrompt', () => {
    it('returns short text whole', () => {
        expect(priorPrompt('  I feel warm.  ')).toBe('I feel warm.');
    });

    it('cuts to the last maxChars, advancing past a split word', () => {
        // last 12 chars: "ery warm now" - cut inside "very".
        expect(priorPrompt('It is very warm now', 12)).toBe('warm now');
    });

    it('keeps a cut that lands on a word boundary', () => {
        // last 8 chars: "warm now" - "very " ends just before it.
        expect(priorPrompt('It is very warm now', 8)).toBe('warm now');
        // last 9 chars: " warm now" - starts on the space.
        expect(priorPrompt('It is very warm now', 9)).toBe('warm now');
    });

    it('cuts CJK by characters', () => {
        expect(priorPrompt('我觉得很温暖也很沉重', 4)).toBe('也很沉重');
    });

    it('counts an emoji as one character and never splits it', () => {
        // "😊 calm" is 6 code points but 7 UTF-16 units: a 6-wide cut counted
        // by units starts on the emoji's low surrogate.
        const text = 'I feel 😊 calm';
        expect(() => encodeURIComponent(text.slice(text.length - 6))).toThrow(URIError);
        expect(priorPrompt(text, 6)).toBe('😊 calm');
        expect(() => encodeURIComponent(priorPrompt(text, 6))).not.toThrow();
    });

    it('defaults to 400 characters', () => {
        const text = 'word '.repeat(200).trim();
        const out = priorPrompt(text);
        expect(out.length).toBeLessThanOrEqual(400);
        expect(out.startsWith('word')).toBe(true);
        expect(text.endsWith(out)).toBe(true);
    });
});

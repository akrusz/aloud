import { describe, expect, it } from 'vitest';
import { transcriptLooksIncomplete } from '../src/facilitation/end-of-turn.js';

describe('transcriptLooksIncomplete', () => {
    it('treats terminated sentences as complete', () => {
        expect(transcriptLooksIncomplete('I feel a tingling in my feet.')).toBe(false);
        expect(transcriptLooksIncomplete('Is that what you mean?')).toBe(false);
        expect(transcriptLooksIncomplete("That's wonderful!")).toBe(false);
        expect(transcriptLooksIncomplete('Just resting here…')).toBe(false);
        expect(transcriptLooksIncomplete('He said "I am done."')).toBe(false);
    });

    it('flags missing terminal punctuation (Whisper punctuates finished thoughts)', () => {
        expect(transcriptLooksIncomplete("I've never had a really bad time doing")).toBe(true);
        expect(transcriptLooksIncomplete('And yet there is this')).toBe(true);
    });

    it('flags trailing commas and mid-clause connectives even with a period', () => {
        expect(transcriptLooksIncomplete('I noticed it again,')).toBe(true);
        expect(transcriptLooksIncomplete('It reminds me of the.')).toBe(true);
        expect(transcriptLooksIncomplete('It was kind of.')).toBe(true);
        expect(transcriptLooksIncomplete('I was thinking about.')).toBe(true);
        expect(transcriptLooksIncomplete('It happens when I breathe out and.')).toBe(true);
    });

    it('is not fooled by quotes/brackets around the terminator', () => {
        expect(transcriptLooksIncomplete('She said "let it happen."')).toBe(false);
    });

    it('treats empty or whitespace input as not incomplete', () => {
        expect(transcriptLooksIncomplete('')).toBe(false);
        expect(transcriptLooksIncomplete('   ')).toBe(false);
    });

    it('does not flag complete one-word turns', () => {
        expect(transcriptLooksIncomplete('Okay.')).toBe(false);
        expect(transcriptLooksIncomplete('Yes.')).toBe(false);
    });
});

it('flags "then" as a dangling tail (measured cut at an 8s pause)', async () => {
    const { transcriptLooksIncomplete } = await import('../src/facilitation/end-of-turn.js');
    expect(transcriptLooksIncomplete('I think part of me is afraid that if I really feel this, then.')).toBe(true);
});

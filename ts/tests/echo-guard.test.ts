import { describe, it, expect } from 'vitest';

import { looksLikeTtsEcho, previewLooksLikeTtsEcho } from '../src/facilitation/echo-guard.js';

describe('looksLikeTtsEcho', () => {
    // Both real captures from the beta echo report (meditation-pal-p8lx):
    // trailing fragments of the facilitator's sentence came back as turns.
    it('catches a trailing fragment of the just-spoken sentence', () => {
        const spoken =
            'What is the quality of that tension? Is it more like a tightness, ' +
            'or maybe a buzzing sensation?';
        expect(looksLikeTtsEcho('tightness or maybe a buzzing sensation?', spoken)).toBe(true);
    });

    it('catches a mid-sentence fragment with differing punctuation/casing', () => {
        const spoken =
            'Right... what is it like when you just notice those two things ' +
            'together—the tightness and that buzzing?';
        expect(looksLikeTtsEcho('The tightness and that buzzing?', spoken)).toBe(true);
    });

    it('matches across sentence-chunk boundaries in the spoken tail', () => {
        // The tail accumulates per TTS chunk; echo can straddle two chunks.
        const spoken = 'Take a slow breath. Let the belly soften as you exhale.';
        expect(looksLikeTtsEcho('breath let the belly soften', spoken)).toBe(true);
    });

    it('never drops short utterances, even verbatim ones', () => {
        // "yes", "the tension" — repeating a few of the facilitator's words is
        // normal meditator speech, not echo evidence.
        const spoken = 'Is it more like a tightness? Yes, stay with the tension.';
        expect(looksLikeTtsEcho('yes', spoken)).toBe(false);
        expect(looksLikeTtsEcho('the tension', spoken)).toBe(false);
    });

    it('does not drop paraphrases or reordered words', () => {
        const spoken = 'Is it more like a tightness, or maybe a buzzing sensation?';
        expect(looksLikeTtsEcho('maybe the tightness is more like buzzing', spoken)).toBe(false);
        expect(looksLikeTtsEcho('I feel a buzzing kind of tightness somewhere', spoken)).toBe(false);
    });

    it('does not drop the user echoing words with their own continuation', () => {
        const spoken = 'Is it more like a tightness, or maybe a buzzing sensation?';
        expect(
            looksLikeTtsEcho('a buzzing sensation in my hands and feet too', spoken)
        ).toBe(false);
    });

    it('does not match an utterance longer than everything spoken', () => {
        expect(looksLikeTtsEcho('one two three four five', 'one two three')).toBe(false);
    });

    // meditation-pal-oxmt: a phone loudspeaker leaking into the recognizer
    // comes back close to the spoken text but rarely verbatim.
    it('catches echo the recognizer mangled a word or two', () => {
        const spoken =
            'Notice where the breath meets the body, and let your attention rest there.';
        expect(
            looksLikeTtsEcho('notice where the breath meets your body and let attention rest there', spoken)
        ).toBe(true);
    });

    it('catches echo with a dropped word and a stray filler', () => {
        const spoken = 'Take a slow breath and let the belly soften as you exhale.';
        expect(looksLikeTtsEcho('take a slow breath let the belly soften uh as you exhale', spoken)).toBe(
            true
        );
    });

    it('does not fuzzy-match words scattered across the whole tail', () => {
        const spoken =
            'Take a slow breath. Notice the tightness in your shoulders. ' +
            'Is there a softness anywhere? Let the belly settle as you exhale.';
        expect(looksLikeTtsEcho('the tightness in my shoulders feels like a knot', spoken)).toBe(false);
        expect(looksLikeTtsEcho('I noticed a softness in the belly as I breathe', spoken)).toBe(false);
    });

    it('handles empty inputs', () => {
        expect(looksLikeTtsEcho('', 'whatever was spoken here today')).toBe(false);
        expect(looksLikeTtsEcho('some words were said here', '')).toBe(false);
    });
});

describe('previewLooksLikeTtsEcho', () => {
    const spoken = 'You might start by just noticing what is present for you right now.';

    it('hides a partial of a word or two that is a run of the spoken text', () => {
        // Too short for the turn-level guard, which is why it used to flash up.
        expect(looksLikeTtsEcho('just noticing', spoken)).toBe(false);
        expect(previewLooksLikeTtsEcho('just noticing', spoken)).toBe(true);
        expect(previewLooksLikeTtsEcho('You', spoken)).toBe(true);
        expect(previewLooksLikeTtsEcho('Just noticing what...', spoken)).toBe(true);
    });

    it('shows a short partial that is not what was spoken', () => {
        expect(previewLooksLikeTtsEcho('wait', spoken)).toBe(false);
        expect(previewLooksLikeTtsEcho('noticing just', spoken)).toBe(false);
        expect(previewLooksLikeTtsEcho('', spoken)).toBe(false);
    });

    it('judges a longer partial as the turn would be judged', () => {
        expect(previewLooksLikeTtsEcho('just noticing what is present', spoken)).toBe(true);
        expect(previewLooksLikeTtsEcho('I notice a warmth in my chest', spoken)).toBe(false);
    });
});

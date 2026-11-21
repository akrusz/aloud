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

describe('partOfLineNear', () => {
    const tip = "By the way, you can say 'back' or 'next' to control this tour.";
    it('keeps the words near where the line has got to, generously', async () => {
        const { partOfLineNear } = await import('../src/facilitation/echo-guard.js');
        // 20 words over 20s: one a second, 4s behind and 1.5s ahead.
        const line = Array.from({ length: 20 }, (_, i) => `w${i}`).join(' ');
        expect(partOfLineNear(line, 10, 20)).toBe('w6 w7 w8 w9 w10 w11');
        expect(partOfLineNear(line, 0.5, 20)).toBe('w0 w1');
        expect(partOfLineNear(line, 19.9, 20)).toBe('w15 w16 w17 w18 w19');
    });
    it('still lets go "next" over the short line that teaches it, once the line is near it', async () => {
        const { partOfLineNear, looksLikePartOfLine } = await import('../src/facilitation/echo-guard.js');
        expect(partOfLineNear(tip, 4.5, 4.63)).toContain("'back' or 'next'");
        for (const at of [2, 3, 4.5]) expect(looksLikePartOfLine('Next.', partOfLineNear(tip, at, 4.63))).toBe(true);
    });
    it('is the whole line where its length is not known', async () => {
        const { partOfLineNear } = await import('../src/facilitation/echo-guard.js');
        expect(partOfLineNear(tip, 2, 0)).toBe(tip);
        expect(partOfLineNear(tip, 2, Number.NaN)).toBe(tip);
    });
    it('counts zh by its characters', async () => {
        const { partOfLineNear } = await import('../src/facilitation/echo-guard.js');
        const zh = '一二三四五六七八九十';
        expect(partOfLineNear(zh, 9.5, 10)).toBe('六七八九十');
    });
});

describe('looksLikePartOfLine', () => {
    const tip = "By the way, you can say 'back' or 'next' to control this tour.";
    it('takes any run of the line, however short, as the line', async () => {
        const { looksLikePartOfLine } = await import('../src/facilitation/echo-guard.js');
        expect(looksLikePartOfLine('Next.', tip)).toBe(true);
        expect(looksLikePartOfLine('back or next', tip)).toBe(true);
        expect(looksLikePartOfLine('By the way, you can say back or next to control this tour.', tip)).toBe(true);
    });
    it('lets through what the line does not say', async () => {
        const { looksLikePartOfLine } = await import('../src/facilitation/echo-guard.js');
        expect(looksLikePartOfLine('repeat', tip)).toBe(false);
        expect(looksLikePartOfLine('next please', tip)).toBe(false);
        expect(looksLikePartOfLine('Harper', "And I'm Ethan. Say which of us you'd like, or tap our name.")).toBe(false);
        expect(looksLikePartOfLine('', tip)).toBe(false);
    });
    it('reads zh by its characters', async () => {
        const { looksLikePartOfLine } = await import('../src/facilitation/echo-guard.js');
        const zhTip = '顺便说一下，你可以说“上一步”或“下一步”来控制这个导览。';
        expect(looksLikePartOfLine('下一步。', zhTip)).toBe(true);
        expect(looksLikePartOfLine('重复', zhTip)).toBe(false);
    });
});

describe('looksLikeSpokenTail', () => {
    const line = 'Guidance set to following.';
    it('catches the end of the line and nothing else of it', async () => {
        const { looksLikeSpokenTail } = await import('../src/facilitation/echo-guard.js');
        expect(looksLikeSpokenTail('following', line)).toBe(true);
        expect(looksLikeSpokenTail('Set to following.', line)).toBe(true);
        expect(looksLikeSpokenTail('guidance', line)).toBe(false);
        expect(looksLikeSpokenTail('guidance set', line)).toBe(false);
        expect(looksLikeSpokenTail('balanced', line)).toBe(false);
        expect(looksLikeSpokenTail('', line)).toBe(false);
    });
    it('lets a request through that a line happened to mention', async () => {
        const { looksLikeSpokenTail } = await import('../src/facilitation/echo-guard.js');
        const tour = "You can also set things up by talking: say 'twenty minutes' and I'll set a timer. That's the basics. Say begin when you're ready.";
        expect(looksLikeSpokenTail('twenty minutes', tour)).toBe(false);
        expect(looksLikeSpokenTail("when you're ready", tour)).toBe(true);
        // The tour's last line asks for "begin" short of its end: what a
        // reopening mic catches of it is dropped, and never starts a session.
        expect(looksLikeSpokenTail("Begin when you're ready.", tour)).toBe(true);
    });
    it('takes more than the last few words as the person', async () => {
        const { looksLikeSpokenTail } = await import('../src/facilitation/echo-guard.js');
        expect(looksLikeSpokenTail('Okay the timer is set', 'Okay, the timer is set.')).toBe(false);
    });
    it('reads zh by its characters', async () => {
        const { looksLikeSpokenTail } = await import('../src/facilitation/echo-guard.js');
        expect(looksLikeSpokenTail('跟随', '引导设为跟随。')).toBe(true);
        expect(looksLikeSpokenTail('均衡', '引导设为跟随。')).toBe(false);
    });
});

import { describe, expect, it } from 'vitest';
import { opensWithReturn } from '../src/facilitation/return-command.js';

describe('opensWithReturn', () => {
    it('takes "I\'m back" and the report after it, punctuated or not', () => {
        for (const text of [
            "I'm back it was a lot of tingling and it settled now",
            "I'm back, it was a lot of tingling and it settled now.",
            "i'm back it was a lot of tingling and it settled now",
            "I'm back. The warmth in my chest settled into something steady.",
            "I'm back the warmth in my chest settled into something steady",
            "I'm back it's been a while and it's been quiet and steady I'm still here",
            "okay I'm back that was really peaceful",
            "Alright I'm back my shoulders let go about halfway through",
            "I'm back I drifted a lot but it was nice",
            'I am back now it was sad and then it passed',
            "Okay I'm back so the tightness moved up into my throat",
            "I'm back and it settled",
            "Um I'm back, you can talk now.",
            "I'm back thanks for waiting",
            // A recognizer's curly apostrophe; one that drops it.
            'I’m back, it settled.',
            'im back it settled',
            '"I\'m back," it settled.',
        ]) {
            expect(opensWithReturn(text), text).toBe(true);
        }
    });

    it('takes a bare return', () => {
        for (const text of ["I'm back.", "I'm back", "Okay, I'm back.", "okay i'm back", "Um, I'm back now.", "Hey I'm back", "uh okay I'm back now"]) {
            expect(opensWithReturn(text), text).toBe(true);
        }
    });

    it('leaves "back" about a place, a wander or a body part to the classifiers', () => {
        for (const text of [
            // To oneself: where attention went.
            "I'm back in my body now",
            "I'm back in my body now.",
            "I'm back to the breath again",
            'Back to the breath.',
            'okay back to the breath',
            "I'm back at the knot in my stomach",
            "I'm back thinking about work again",
            "I'm back and forth between sleepy and alert",
            "I'm back here in the chest",
            "I'm back now in the belly",
            // "there" may be the place ("I'm back there"), so even this one.
            'I am back now there was some sadness and then it passed',
            // The noting meditator's word, and a return that is not the opening.
            "I'm back again",
            "and I'm back",
            "Lost in thought again okay I'm back",
            "It settled now I'm back",
            // Wondering, not telling.
            "I'm back?",
            // Not a return at all.
            'Hm, lots of tingling.',
            'My back is really tight.',
            'It keeps coming back, that tightness.',
            'I keep going back to that conversation with my sister.',
            "I'm not back yet",
            "I'm background noise",
            '',
        ]) {
            expect(opensWithReturn(text), text).toBe(false);
        }
    });

    it('leaves the frightened "I\'m back there" to the trouble check', () => {
        expect(opensWithReturn("I'm back there. I can see his face.")).toBe(false);
        expect(opensWithReturn("I'm back there I can see his face")).toBe(false);
        expect(opensWithReturn('我又回到那里了，我看到他的脸。')).toBe(false);
    });

    it('takes 我回来了, with or without punctuation, in either script', () => {
        for (const text of [
            '我回来了',
            '我回来了。',
            '嗯，我回来了。',
            '好了 我回来了',
            '我回来啦',
            '我回来了刚才有很多刺痛感现在平静下来了',
            '我回来了，胸口暖暖的。',
            '我回來了，剛才很平靜。',
            'OK，我回来了',
        ]) {
            expect(opensWithReturn(text), text).toBe(true);
        }
    });

    it('leaves the zh look-alikes alone', () => {
        for (const text of [
            '那种紧张又回来了。',
            '回到呼吸上。',
            '我回到身体里了。',
            '我又回来了',
            '我回来了吗？',
            '我回来了一点',
            '我回来到身体里',
            '感觉回来了',
        ]) {
            expect(opensWithReturn(text), text).toBe(false);
        }
    });
});

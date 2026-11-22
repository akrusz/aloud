import { describe, expect, it } from 'vitest';
import { skipHesitation } from '../src/facilitation/hesitation.js';

describe('skipHesitation', () => {
    it('drops the hesitation sounds an utterance opens on, stretched or not', () => {
        const cases: Array<[string, string]> = [
            ['Uh, next.', 'next.'],
            ['Um, never mind.', 'never mind.'],
            ['UHH next', 'next'],
            ['Umm... begin', 'begin'],
            ['Uhm, yes', 'yes'],
            ['Er, yes', 'yes'],
            ['Erm, yes', 'yes'],
            ['Ah, yes', 'yes'],
            ['Hmm. No.', 'No.'],
            ['Hm, no', 'no'],
            ['Mmm, okay', 'okay'],
            ['Uh, um, next', 'next'],
            ['嗯，下一步', '下一步'],
            ['嗯嗯 好的', '好的'],
            ['呃……开始', '开始'],
            ['额，继续', '继续'],
        ];
        for (const [said, rest] of cases) expect(skipHesitation(said), said).toBe(rest);
    });

    it('leaves an utterance that is only hesitation as it was', () => {
        for (const said of ['Uh.', 'Um', 'Hmm...', 'Mm-hmm.', '嗯', '嗯。', '嗯嗯', '']) expect(skipHesitation(said), said).toBe(said);
    });

    it('leaves words that only begin like one, a later one, and "oh"', () => {
        for (const said of ['Umbrella', 'Ahead of time', 'Errands', 'Hmmmph', 'next, uh', 'Oh, next', 'M, next', 'Eh, next']) {
            expect(skipHesitation(said), said).toBe(said);
        }
    });
});

import { describe, expect, it } from 'vitest';
import { heardExcerpt } from '../ui/src/heard-excerpt.js';

describe('heardExcerpt', () => {
    it('shows a short mishearing whole, without its full stop', () => {
        expect(heardExcerpt('Beautiful.')).toBe('Beautiful');
        expect(heardExcerpt('Doctor give me the prescription')).toBe('Doctor give me the prescription');
    });

    it('shows the opening of a sentence', () => {
        expect(heardExcerpt('We should begin to think about dinner.')).toBe('We should begin to think about…');
        expect(heardExcerpt('Well, I got it, you got it, right?')).toBe('Well, I got it, you got…');
    });

    it('cuts a few very long words by length', () => {
        const shown = heardExcerpt('Supercalifragilisticexpialidocious antidisestablishmentarianism today')!;
        expect(shown.endsWith('…')).toBe(true);
        expect(shown.length).toBeLessThanOrEqual(41);
    });

    it('shows nothing of the room talking', () => {
        expect(
            heardExcerpt('Like honestly, I think that door may be easier to do the one-way door.')
        ).toBeNull();
        expect(heardExcerpt('   ')).toBeNull();
    });

    it('counts an unspaced script by the character', () => {
        expect(heardExcerpt('下一步。')).toBe('下一步');
        expect(heardExcerpt('能不能把注意焦点改成情绪与感受基调')).toBe('能不能把注意焦点改成情绪…');
        expect(heardExcerpt('这可能是全世界最好吃的飞机餐，米其林三星大厨打造，昂贵酒水无限畅饮')).toBeNull();
    });
});

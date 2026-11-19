import { describe, expect, it } from 'vitest';
import { heardNote } from '../ui/src/heard-note.js';

describe('heardNote', () => {
    it('shows what was heard, without its full stop', () => {
        expect(heardNote('Beautiful.')).toBe('Beautiful');
        expect(heardNote('We should begin to think about dinner.')).toBe('We should begin to think about dinner');
    });

    it('shows nothing of the room talking', () => {
        expect(heardNote('Like honestly, I think that door may be easier to do the one-way door.')).toBeNull();
        expect(heardNote('   ')).toBeNull();
    });

    it('counts an unspaced script by the character', () => {
        expect(heardNote('下一步。')).toBe('下一步');
        expect(heardNote('能不能把注意焦点改成情绪与感受基调')).toBe('能不能把注意焦点改成情绪与感受基调');
        expect(heardNote('这可能是全世界最好吃的飞机餐，米其林三星大厨打造，昂贵酒水无限畅饮')).toBeNull();
    });
});

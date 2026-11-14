import { describe, it, expect } from 'vitest';
import { DailyCap } from '../src/quota/freetier.js';

describe('DailyCap', () => {
    it('allows up to the cap per account, then refuses until the UTC day turns', () => {
        let t = Date.UTC(2026, 8, 19, 23, 0);
        const cap = new DailyCap(2, () => t);
        expect(cap.allow('a')).toBe(true);
        expect(cap.allow('a')).toBe(true);
        expect(cap.allow('a')).toBe(false);
        expect(cap.allow('b')).toBe(true);
        t += 2 * 60 * 60 * 1000;
        expect(cap.allow('a')).toBe(true);
    });

    it('counts amounts, refusing one that would cross the cap without counting it', () => {
        const cap = new DailyCap(10, () => Date.UTC(2026, 10, 14, 12));
        expect(cap.allow('a', 7)).toBe(true);
        expect(cap.fits('a', 4)).toBe(false);
        expect(cap.allow('a', 4)).toBe(false);
        expect(cap.fits('a', 3)).toBe(true);
        expect(cap.allow('a', 3)).toBe(true);
        expect(cap.fits('a')).toBe(false);
    });

    it('a zero cap allows nothing', () => {
        expect(new DailyCap(0).allow('a')).toBe(false);
    });
});

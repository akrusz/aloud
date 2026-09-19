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
});

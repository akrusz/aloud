import { describe, it, expect } from 'vitest';
import { FreeGrantBreaker } from '../src/quota/freetier.js';

describe('FreeGrantBreaker', () => {
    it('grants up to the budget, then refuses', () => {
        const b = new FreeGrantBreaker(100, 3_600_000, () => 0);
        expect(b.tryConsume(20)).toBe(true); // 20
        expect(b.tryConsume(20)).toBe(true); // 40
        expect(b.tryConsume(20)).toBe(true); // 60
        expect(b.tryConsume(20)).toBe(true); // 80
        expect(b.tryConsume(20)).toBe(true); // 100 (exactly at budget)
        expect(b.tryConsume(20)).toBe(false); // would exceed -> refused
    });

    it('drains as the window rolls forward', () => {
        let now = 0;
        const b = new FreeGrantBreaker(40, 1000, () => now);
        expect(b.tryConsume(40)).toBe(true); // full
        expect(b.tryConsume(20)).toBe(false); // over
        now = 1001; // window passed
        expect(b.tryConsume(20)).toBe(true); // old grant expired -> room again
    });

    it('does not record refused grants against the budget', () => {
        let now = 0;
        const b = new FreeGrantBreaker(30, 1000, () => now);
        expect(b.tryConsume(20)).toBe(true); // 20 used
        expect(b.tryConsume(20)).toBe(false); // would be 40 > 30 -> refused, not recorded
        expect(b.tryConsume(10)).toBe(true); // 20 + 10 = 30, still fits
    });
});

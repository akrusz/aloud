/**
 * The ☁️ rate badge rounds ONCE, to nearest. The old rule floored the badge
 * while the server had already ceiled the model leg, so the same catalog was
 * rounded in both directions at once and a voice's badge disagreed with the
 * session pill that summed it.
 */
import { describe, it, expect } from 'vitest';
import { rateBadge, rateSuffix, rateUnits } from '../ui/src/credit-rate.js';

describe('rateUnits', () => {
    it('rounds to nearest, not down', () => {
        expect(rateUnits(2.76)).toBe(3);
        expect(rateUnits(3.8)).toBe(4);
        expect(rateUnits(9.21)).toBe(9);
        expect(rateUnits(1.5)).toBe(2); // .5 goes up
    });

    it('returns 0 for free options AND for a paid rate under half a credit', () => {
        // Same number, two meanings - which is why rateBadge, not rateUnits, is
        // what callers should render.
        expect(rateUnits(0)).toBe(0);
        expect(rateUnits(null)).toBe(0);
        expect(rateUnits(0.08)).toBe(0); // Flash Lite
    });
});

describe('rateBadge', () => {
    it('shows a whole-credit badge for ordinary rates', () => {
        expect(rateBadge(2.76)).toBe('3☁️');
        expect(rateBadge(0.92)).toBe('1☁️');
    });

    it('distinguishes too-cheap-to-round from free', () => {
        expect(rateBadge(0.08)).toBe('<1☁️');
        expect(rateBadge(0)).toBe('');
        expect(rateBadge(undefined)).toBe('');
    });

    it('suffixes a dropdown label, or nothing when free', () => {
        expect(rateSuffix(4.61)).toBe(' (5☁️)');
        expect(rateSuffix(0.08)).toBe(' (<1☁️)');
        expect(rateSuffix(0)).toBe('');
    });
});

describe('badges compose', () => {
    it('sums unrounded legs then rounds once, so parts match the total', () => {
        // Sonnet 2.76 + Neural2 3.8 + STT 1: under the old floor-the-parts rule
        // the badges read 2 + 3 + 1 = 6 against a pill of 7.
        const legs = [2.76, 3.8, 1];
        const total = legs.reduce((a, b) => a + b, 0);
        expect(rateUnits(total)).toBe(8);
        expect(legs.map(rateUnits).reduce((a, b) => a + b, 0)).toBe(8);
    });
});

/**
 * The ☁ rate badge rounds ONCE, to nearest. The old rule floored the badge
 * while the server had already ceiled the model leg, so the same catalog was
 * rounded in both directions at once and a voice's badge disagreed with the
 * session pill that summed it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { RATE_EMOJI, rateBadge, rateSuffix, rateUnits } from '../ui/src/credit-rate.js';

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
        expect(rateBadge(2.76)).toBe('3☁');
        expect(rateBadge(0.92)).toBe('1☁');
    });

    it('distinguishes too-cheap-to-round from free', () => {
        expect(rateBadge(0.08)).toBe('<1☁');
        expect(rateBadge(0)).toBe('');
        expect(rateBadge(undefined)).toBe('');
    });

    it('suffixes a dropdown label, or nothing when free', () => {
        expect(rateSuffix(4.61)).toBe(' (5☁)');
        expect(rateSuffix(0.08)).toBe(' (<1☁)');
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

describe('the ☁ glyph', () => {
    // ☁ + U+FE0F asks for the color emoji, and a browser may then skip the
    // aloud-cloud font and draw the platform emoji. The two look identical in
    // an editor, so a pasted ☁️ would slip back in unseen.
    it('is a bare U+2601 everywhere in the UI, never the emoji form', () => {
        expect(RATE_EMOJI).toBe('\u2601');
        const here = dirname(fileURLToPath(import.meta.url));
        const files: string[] = [join(here, '../ui/index.html')];
        const walk = (dir: string): void => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) walk(p);
                else if (/\.(ts|css|html)$/.test(name)) files.push(p);
            }
        };
        walk(join(here, '../ui/src'));
        const offenders = files.filter((f) => readFileSync(f, 'utf8').includes('\u2601\uFE0F'));
        expect(offenders).toEqual([]);
    });
});

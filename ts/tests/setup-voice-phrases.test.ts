/**
 * The labelled phrases the synthetic-speech corpus is said from
 * (scripts/setup-voice/phrases.ts), read as written: every request does what
 * its label says, and nothing a room says does anything.
 */

import { describe, expect, it } from 'vitest';
import { parseBeginRequest } from '../src/facilitation/begin-command.js';
import { parseSetupCommand } from '../src/facilitation/setup-command.js';
import { NEGATIVES, PHRASES } from '../scripts/setup-voice/phrases.js';

const sorted = (actions: readonly object[]): string[] => actions.map((a) => JSON.stringify(a)).sort();

describe('the setup-voice corpus, as written', () => {
    it('reads every request as labelled', () => {
        expect(PHRASES.length).toBeGreaterThan(150);
        for (const phrase of PHRASES) {
            if (phrase.expect === 'begin') {
                expect(parseBeginRequest(phrase.text), phrase.text).toEqual(phrase.begin ?? {});
            } else if (phrase.expect === null) {
                expect(parseSetupCommand(phrase.text), phrase.text).toBeNull();
            } else {
                expect(parseBeginRequest(phrase.text), phrase.text).toBeNull();
                expect(sorted(parseSetupCommand(phrase.text) ?? []), phrase.text).toEqual(sorted(phrase.expect));
            }
        }
    });

    it('leaves alone everything a room says', () => {
        expect(NEGATIVES.length).toBeGreaterThan(40);
        for (const phrase of NEGATIVES) {
            expect(parseBeginRequest(phrase.text), phrase.text).toBeNull();
            expect(parseSetupCommand(phrase.text), phrase.text).toBeNull();
        }
    });
});

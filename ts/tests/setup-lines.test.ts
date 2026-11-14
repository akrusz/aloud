import { describe, expect, it } from 'vitest';
import {
    SETUP_LINES,
    SETUP_LINE_IDS,
    setupLineText,
    setupOutcomeLines,
    type SetupOutcome,
} from '../src/facilitation/index.js';

describe('the spoken lines', () => {
    it('are written the way the app writes', () => {
        for (const id of SETUP_LINE_IDS) {
            for (const lang of ['en', 'zh'] as const) {
                const text = SETUP_LINES[id][lang];
                expect(text.trim(), `${id} ${lang}`).toBe(text);
                expect(text.length, `${id} ${lang}`).toBeGreaterThan(0);
                expect(text, `${id} ${lang}`).not.toMatch(/[—–]/);
            }
            const en = SETUP_LINES[id].en;
            // The softvoice house voices clip an opening "Right".
            expect(en, id).not.toMatch(/^right\b/i);
            expect(en, id).not.toMatch(/\bsit\b(?! with)/i);
            expect(en[0], id).toBe(en[0]!.toUpperCase());
        }
    });

    it("fill in the speaking voice's name", () => {
        expect(setupLineText('voice-intro-first', 'en', { name: 'Harper' })).toBe("Hi, I'm Harper. This is how I sound.");
        expect(setupLineText('voice-intro-first', 'zh', { name: 'Serena' })).toContain('Serena');
        expect(setupLineText('mode-noting', 'fr')).toBe(SETUP_LINES['mode-noting'].en);
    });
});

describe('setupOutcomeLines', () => {
    const ids = (outcomes: SetupOutcome[]): string[] => setupOutcomeLines(outcomes, 'en').map((line) => line.id);

    it('has a line for every outcome', () => {
        const every: SetupOutcome[] = [
            { kind: 'mode', mode: 'exploration' },
            { kind: 'mode', mode: 'noting' },
            { kind: 'mode', mode: 'felt_sense' },
            { kind: 'length', minutes: 20 },
            { kind: 'length', minutes: 7 },
            { kind: 'no-timer' },
            { kind: 'focus', focus: 'body_sensations', on: true },
            { kind: 'focus', focus: 'emotions', on: false },
            { kind: 'focus', focus: 'inner_parts', on: true },
            { kind: 'quality', quality: 'feeling_good', on: true },
            { kind: 'quality', quality: 'playful', on: false },
            { kind: 'cleared', group: 'focus' },
            { kind: 'cleared', group: 'quality' },
            { kind: 'guidance', step: 0 },
            { kind: 'guidance', step: 4 },
            { kind: 'verbosity', value: 'low' },
            { kind: 'intention', set: true },
            { kind: 'intention', set: false },
            { kind: 'checkins', on: true },
            { kind: 'stop-listening' },
            { kind: 'help' },
            { kind: 'elsewhere', mode: 'exploration' },
            { kind: 'elsewhere', mode: 'felt_sense' },
            { kind: 'elsewhere', mode: null },
            { kind: 'unavailable' },
        ];
        for (const outcome of every) {
            for (const lang of ['en', 'zh']) {
                const [line] = setupOutcomeLines([outcome], lang);
                expect(line, JSON.stringify(outcome)).toBeDefined();
                expect(SETUP_LINE_IDS, JSON.stringify(outcome)).toContain(line!.id);
                expect(line!.text.length).toBeGreaterThan(0);
            }
        }
    });

    it('plays the plain timer clip for a length that has none of its own, with the exact words beside it', () => {
        expect(setupOutcomeLines([{ kind: 'length', minutes: 25 }], 'en')).toEqual([
            { id: 'timer-set', text: 'Timer set for 25 minutes.' },
        ]);
        expect(setupOutcomeLines([{ kind: 'length', minutes: 60 }], 'en')[0]!.id).toBe('timer-60');
        expect(setupOutcomeLines([{ kind: 'length', minutes: 25 }], 'zh')[0]!.text).toBe('计时25分钟。');
    });

    it('does not announce a clear that only made room', () => {
        expect(
            ids([
                { kind: 'cleared', group: 'quality' },
                { kind: 'quality', quality: 'spacious', on: true },
            ])
        ).toEqual(['vibe-spacious-on']);
        expect(ids([{ kind: 'cleared', group: 'quality' }])).toEqual(['vibe-cleared']);
        // Clearing the vibes says so when what follows is a focus.
        expect(
            ids([
                { kind: 'cleared', group: 'quality' },
                { kind: 'focus', focus: 'emotions', on: true },
            ])
        ).toEqual(['vibe-cleared', 'focus-emotions-on']);
    });

    it('says a thing once, and sums up a long request', () => {
        expect(
            ids([
                { kind: 'elsewhere', mode: 'exploration' },
                { kind: 'elsewhere', mode: 'exploration' },
            ])
        ).toEqual(['belongs-exploration']);
        expect(
            ids([
                { kind: 'mode', mode: 'exploration' },
                { kind: 'length', minutes: 10 },
                { kind: 'quality', quality: 'playful', on: true },
                { kind: 'quality', quality: 'loving', on: true },
            ])
        ).toEqual(['all-set']);
    });
});

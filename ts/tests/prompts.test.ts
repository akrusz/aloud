import { describe, it, expect } from 'vitest';

import {
    BASE_SYSTEM_PROMPT,
    CHECK_IN_PROMPTS,
    DIRECTIVENESS_ADDITIONS,
    FOCUS_PROMPTS,
    PromptBuilder,
    QUALITY_PROMPTS,
    parseHoldSignal,
} from '../src/facilitation/prompts.js';

const DETERMINISTIC_RNG = () => 0; // always picks the first element

describe('parseHoldSignal', () => {
    it('extracts hold and strips the prefix', () => {
        expect(parseHoldSignal('[HOLD] resting here')).toEqual({
            signal: 'hold',
            cleanText: 'resting here',
        });
    });

    it('is case-insensitive on the marker', () => {
        expect(parseHoldSignal('[hold] ok')).toEqual({ signal: 'hold', cleanText: 'ok' });
    });

    it('trims surrounding whitespace before checking', () => {
        expect(parseHoldSignal('   [HOLD]   stay   ')).toEqual({
            signal: 'hold',
            cleanText: 'stay',
        });
    });

    it('returns "none" when no prefix present', () => {
        expect(parseHoldSignal('what do you notice?')).toEqual({
            signal: 'none',
            cleanText: 'what do you notice?',
        });
    });
});

describe('PromptBuilder.buildSystemPrompt', () => {
    it('uses open_awareness focus by default when none selected', () => {
        const builder = new PromptBuilder();
        const prompt = builder.buildSystemPrompt();
        expect(prompt).toContain(BASE_SYSTEM_PROMPT);
        expect(prompt).toContain(FOCUS_PROMPTS.open_awareness);
    });

    it('composes selected focuses and qualities', () => {
        const builder = new PromptBuilder({
            config: {
                focuses: ['body_sensations', 'emotions'],
                qualities: ['compassionate'],
            },
        });
        const prompt = builder.buildSystemPrompt();
        expect(prompt).toContain(FOCUS_PROMPTS.body_sensations);
        expect(prompt).toContain(FOCUS_PROMPTS.emotions);
        expect(prompt).toContain(QUALITY_PROMPTS.compassionate);
        // No open_awareness fallback when focuses are explicit
        expect(prompt).not.toContain(FOCUS_PROMPTS.open_awareness);
    });

    it('appends custom instructions at the end', () => {
        const builder = new PromptBuilder({
            config: { customInstructions: 'do the thing' },
        });
        const prompt = builder.buildSystemPrompt();
        expect(prompt).toContain('Additional instructions:');
        expect(prompt).toContain('do the thing');
    });

    it('picks the nearest directiveness key', () => {
        const builder = new PromptBuilder({ config: { directiveness: 6 } });
        const prompt = builder.buildSystemPrompt();
        // 6 is equidistant from 5 and 7 — reduce() keeps the first match (5)
        expect(prompt).toContain(DIRECTIVENESS_ADDITIONS[5]!);

        const builderHigh = new PromptBuilder({ config: { directiveness: 9 } });
        expect(builderHigh.buildSystemPrompt()).toContain(DIRECTIVENESS_ADDITIONS[10]!);
    });
});

describe('PromptBuilder.getSessionOpener', () => {
    it('returns a minimal opener when directiveness is very low', () => {
        const builder = new PromptBuilder({
            config: { directiveness: 0 },
            random: DETERMINISTIC_RNG,
        });
        expect(builder.getSessionOpener()).toBe("I'm here.");
    });

    it('expands the pool when focuses and qualities add options', () => {
        // With rng returning 0, the opener is whatever's first in the pool.
        // We can verify the pool grows by picking a different rng value.
        const builder = new PromptBuilder({
            config: { focuses: ['body_sensations'], qualities: ['playful'], directiveness: 5 },
        });
        const seen = new Set<string>();
        for (let i = 0; i < 50; i++) {
            const rng = () => i / 50;
            const b = new PromptBuilder({
                config: { focuses: ['body_sensations'], qualities: ['playful'], directiveness: 5 },
                random: rng,
            });
            seen.add(b.getSessionOpener());
        }
        expect(seen.size).toBeGreaterThan(5);
        expect(builder.getSessionOpener()).toBeTruthy();
    });
});

describe('PromptBuilder.buildOpenerPrompt', () => {
    it('mentions focus, vibe, and intention when provided', () => {
        const builder = new PromptBuilder({
            config: { focuses: ['emotions'], qualities: ['loving'], directiveness: 3 },
        });
        const prompt = builder.buildOpenerPrompt('settle');
        expect(prompt).toContain('focus areas: emotions');
        expect(prompt).toContain('vibe: loving');
        expect(prompt).toContain('intention: "settle"');
        expect(prompt).toContain("Don't direct their attention too specifically");
    });

    it('uses minimal copy when directiveness is very low', () => {
        const builder = new PromptBuilder({ config: { directiveness: 0 } });
        const prompt = builder.buildOpenerPrompt();
        expect(prompt).toContain('Keep it very minimal');
    });

    it('invites suggestion when directiveness is high', () => {
        const builder = new PromptBuilder({ config: { directiveness: 9 } });
        const prompt = builder.buildOpenerPrompt();
        expect(prompt).toContain('suggest where to begin');
    });
});

describe('PromptBuilder.getCheckInPrompt', () => {
    it('returns a non-empty phrase from the pool', () => {
        const builder = new PromptBuilder({ random: DETERMINISTIC_RNG });
        expect(builder.getCheckInPrompt()).toBe(CHECK_IN_PROMPTS[0]);
    });
});

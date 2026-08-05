import { describe, it, expect } from 'vitest';

import {
    BASE_SYSTEM_PROMPT,
    CHECK_IN_PROMPTS,
    DIMENSIONS_PREAMBLE,
    DIRECTIVENESS_ADDITIONS,
    FOCUS_PROMPTS,
    HOLD_SIGNAL_FRAGMENT,
    PromptBuilder,
    QUALITY_PROMPTS,
    WAIT_SIGNAL_FRAGMENT,
    defaultWaitSeconds,
    parseHoldSignal,
} from '../src/facilitation/prompts.js';
import { listModes } from '../src/facilitation/modes.js';

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

    it('places the dimensions preamble before the dimension sections', () => {
        const prompt = new PromptBuilder({
            config: { focuses: ['body_sensations'], qualities: ['playful'] },
        }).buildSystemPrompt();
        expect(prompt).toContain(DIMENSIONS_PREAMBLE);
        expect(prompt.indexOf(DIMENSIONS_PREAMBLE)).toBeLessThan(
            prompt.indexOf(FOCUS_PROMPTS.body_sensations)
        );
    });

    it('includes the [WAIT] fragment only when waitSignal is on', () => {
        expect(new PromptBuilder().buildSystemPrompt()).not.toContain(WAIT_SIGNAL_FRAGMENT);
        expect(
            new PromptBuilder({ config: { waitSignal: true } }).buildSystemPrompt()
        ).toContain(WAIT_SIGNAL_FRAGMENT);
    });

    // Off, the client ignores a [HOLD] bid, so the model must not make one:
    // otherwise it promises silence it can't deliver (gg50).
    it('drops the [HOLD] fragment when holdSignal is off, in every mode', () => {
        expect(new PromptBuilder().buildSystemPrompt()).toContain(HOLD_SIGNAL_FRAGMENT);
        for (const mode of listModes()) {
            const prompt = new PromptBuilder({ config: { holdSignal: false }, mode }).buildSystemPrompt();
            expect(prompt).not.toContain(HOLD_SIGNAL_FRAGMENT);
            expect(prompt).not.toContain('[HOLD]');
            expect(prompt.trim().length).toBeGreaterThan(0);
        }
    });

    it('leaves the prompt byte-identical when holdSignal is on', () => {
        expect(new PromptBuilder({ config: { holdSignal: true } }).buildSystemPrompt()).toBe(
            new PromptBuilder().buildSystemPrompt()
        );
    });

    it('biases the [WAIT] default by guidance level (20m/8m/5m/90s/30s)', () => {
        const at = (directiveness: number) =>
            new PromptBuilder({ config: { waitSignal: true, directiveness } }).buildSystemPrompt();
        expect(at(10)).toContain('[WAIT:30s]');
        expect(at(7)).toContain('[WAIT:90s]');
        expect(at(5)).toContain('[WAIT:5m]');
        expect(at(3)).toContain('[WAIT:8m]');
        expect(at(0)).toContain('[WAIT:20m]');
        // Off entirely when the signal is off, regardless of guidance.
        expect(
            new PromptBuilder({ config: { directiveness: 10 } }).buildSystemPrompt()
        ).not.toContain('[WAIT:30s]');
    });

    it('defaultWaitSeconds maps the five slider stops', () => {
        expect([0, 3, 5, 7, 10].map(defaultWaitSeconds)).toEqual([1200, 480, 300, 90, 30]);
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
        expect(prompt).toContain('Additional instructions from the meditator:');
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

/**
 * A system prompt must never contain a role-labeled transcript. Turn boundaries
 * belong to the protocol; demonstrating them in prompt text invites the model to
 * continue the alternation past its own turn and write the meditator's next line
 * (which then lands in history and re-teaches the pattern). Cost us a real
 * session: an "Example exchanges: / User: … / Assistant: …" block in
 * BASE_SYSTEM_PROMPT. Examples are fine - the labeled transcript SHAPE is not.
 */
describe('no role-labeled transcripts in assembled prompts', () => {
    const ROLE_LABEL_LINE = /^\s*(?:user|assistant|human|system)\s*:/im;

    const everySection = [
        ...Object.values(FOCUS_PROMPTS),
        ...Object.values(QUALITY_PROMPTS),
        ...Object.values(DIRECTIVENESS_ADDITIONS),
        BASE_SYSTEM_PROMPT,
        DIMENSIONS_PREAMBLE,
        WAIT_SIGNAL_FRAGMENT,
    ].filter((s): s is string => typeof s === 'string');

    it.each(everySection.map((s, i) => [i, s]))('section %i is clean', (_i, section) => {
        expect(section).not.toMatch(ROLE_LABEL_LINE);
    });

    it.each(listModes().map((m) => [m.id, m]))('mode %s composes clean', (_id, mode) => {
        const builder = new PromptBuilder({
            mode,
            config: {
                focuses: ['body', 'emotions', 'parts', 'open_awareness'],
                qualities: Object.keys(QUALITY_PROMPTS) as never,
                directiveness: 7,
                verbosity: 'high',
                waitSignal: true,
                customInstructions: 'be gentle',
            },
        });
        expect(builder.buildSystemPrompt()).not.toMatch(ROLE_LABEL_LINE);
    });
});

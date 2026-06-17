import { describe, expect, it } from 'vitest';
import {
    getMode,
    listModes,
    parseTurnSignals,
    StagedModeController,
    EXPLORATION_MODE,
    NOTING_MODE,
    NEXT_PREFIX,
    BACK_PREFIX,
    type ModeSpec,
} from '../src/facilitation/modes.js';
import { FELT_SENSE_MODE } from '../src/facilitation/felt-sense.js';
import { BASE_SYSTEM_PROMPT, PromptBuilder } from '../src/facilitation/prompts.js';

describe('mode registry', () => {
    it('resolves the built-in modes by id', () => {
        expect(getMode('exploration')).toBe(EXPLORATION_MODE);
        expect(getMode('noting')).toBe(NOTING_MODE);
        expect(getMode('felt_sense')).toBe(FELT_SENSE_MODE);
    });

    it('returns undefined for unknown or missing ids', () => {
        expect(getMode('zen_archery')).toBeUndefined();
        expect(getMode(undefined)).toBeUndefined();
    });

    it('lists every registered mode', () => {
        const ids = listModes().map((m) => m.id);
        expect(ids).toEqual(['exploration', 'noting', 'felt_sense']);
    });

    it('exploration mode keeps the classic base prompt', () => {
        expect(EXPLORATION_MODE.basePrompt).toBe(BASE_SYSTEM_PROMPT);
        // No composes overrides — all dimensions still apply.
        expect(EXPLORATION_MODE.composes).toBeUndefined();
        expect(EXPLORATION_MODE.phases).toBeUndefined();
    });
});

describe('parseTurnSignals', () => {
    it('passes plain text through untouched', () => {
        const r = parseTurnSignals('What do you notice?');
        expect(r).toEqual({ hold: false, stage: 'none', cleanText: 'What do you notice?' });
    });

    it('parses a leading [HOLD] like parseHoldSignal', () => {
        const r = parseTurnSignals("[HOLD] I'll be right here");
        expect(r.hold).toBe(true);
        expect(r.stage).toBe('none');
        expect(r.cleanText).toBe("I'll be right here");
    });

    it('parses [NEXT] and [BACK]', () => {
        expect(parseTurnSignals('[NEXT] Which of these wants your attention?').stage).toBe('advance');
        expect(parseTurnSignals('[BACK] Let it set things down again.').stage).toBe('back');
    });

    it('combines a stage token with [HOLD] in either order', () => {
        for (const raw of [
            '[NEXT] [HOLD] Take all the time you need.',
            '[HOLD] [NEXT] Take all the time you need.',
            '[HOLD][NEXT] Take all the time you need.',
        ]) {
            const r = parseTurnSignals(raw);
            expect(r.hold).toBe(true);
            expect(r.stage).toBe('advance');
            expect(r.cleanText).toBe('Take all the time you need.');
        }
    });

    it('is case-insensitive, like the [HOLD] parser', () => {
        const r = parseTurnSignals('[next] And now?');
        expect(r.stage).toBe('advance');
        expect(r.cleanText).toBe('And now?');
    });

    it('first stage token wins when the model contradicts itself', () => {
        const r = parseTurnSignals('[BACK] [NEXT] hm');
        expect(r.stage).toBe('back');
        expect(r.cleanText).toBe('hm');
    });

    it('ignores tokens that are not leading', () => {
        const r = parseTurnSignals('We can go [NEXT] later.');
        expect(r.stage).toBe('none');
        expect(r.cleanText).toBe('We can go [NEXT] later.');
    });
});

const TINY_STAGED: ModeSpec = {
    id: 'test_staged',
    label: 'Test',
    basePrompt: 'base',
    phases: [
        { id: 'one', label: 'first', summary: 'the first step', prompt: 'Guidance one.' },
        { id: 'two', label: 'second', summary: 'the middle step', prompt: 'Guidance two.' },
        { id: 'three', label: 'third', summary: 'the last step', prompt: 'Guidance three.' },
    ],
};

describe('StagedModeController', () => {
    it('starts at the first phase by default', () => {
        const c = new StagedModeController(TINY_STAGED);
        expect(c.phase.id).toBe('one');
        expect(c.phaseIndex).toBe(0);
    });

    it('resumes from a persisted phase id, falling back on unknown ids', () => {
        expect(new StagedModeController(TINY_STAGED, 'two').phase.id).toBe('two');
        expect(new StagedModeController(TINY_STAGED, 'renamed-away').phase.id).toBe('one');
    });

    it('throws for a mode without phases', () => {
        expect(() => new StagedModeController(EXPLORATION_MODE)).toThrow(/no phases/);
    });

    it('advances and clamps at the last phase', () => {
        const c = new StagedModeController(TINY_STAGED);
        expect(c.apply('advance')).toBe(true);
        expect(c.apply('advance')).toBe(true);
        expect(c.phase.id).toBe('three');
        expect(c.apply('advance')).toBe(false);
        expect(c.phase.id).toBe('three');
    });

    it('goes back and clamps at the first phase', () => {
        const c = new StagedModeController(TINY_STAGED, 'two');
        expect(c.apply('back')).toBe(true);
        expect(c.phase.id).toBe('one');
        expect(c.apply('back')).toBe(false);
    });

    it("apply('none') never moves", () => {
        const c = new StagedModeController(TINY_STAGED, 'two');
        expect(c.apply('none')).toBe(false);
        expect(c.phase.id).toBe('two');
    });

    it('promptSection carries the arc, the active guidance, and the protocol', () => {
        const c = new StagedModeController(TINY_STAGED, 'two');
        const section = c.promptSection();
        expect(section).toContain('Guidance two.');
        expect(section).not.toContain('Guidance one.');
        expect(section).toContain('1. first: the first step');
        expect(section).toContain('2. second: the middle step  <- you are here');
        expect(section).toContain(NEXT_PREFIX);
        expect(section).toContain(BACK_PREFIX);
        expect(section).toContain('When unsure, stay');
    });

    it('omits [NEXT] guidance on the last phase and [BACK] on the first', () => {
        const first = new StagedModeController(TINY_STAGED).promptSection();
        expect(first).not.toContain(`Start with ${BACK_PREFIX}`);
        expect(first).toContain(`Start with ${NEXT_PREFIX}`);

        const last = new StagedModeController(TINY_STAGED, 'three').promptSection();
        expect(last).not.toContain(`Start with ${NEXT_PREFIX}`);
        expect(last).toContain(`Start with ${BACK_PREFIX}`);
    });
});

describe('PromptBuilder with a mode', () => {
    it('a staged mode swaps the base prompt and drops the exploration dimensions', () => {
        const builder = new PromptBuilder({
            mode: FELT_SENSE_MODE,
            config: {
                focuses: ['body_sensations'],
                qualities: ['playful'],
                directiveness: 10,
                verbosity: 'low',
                customInstructions: 'SECRET-CUSTOM',
            },
        });
        const prompt = builder.buildSystemPrompt();
        expect(prompt).toContain('felt-sense session');
        expect(prompt).not.toContain(BASE_SYSTEM_PROMPT.slice(0, 60));
        // None of the user-tunable exploration dimensions compose...
        expect(prompt).not.toContain('Attention focus');
        expect(prompt).not.toContain('Facilitator vibe');
        expect(prompt).not.toContain('Actively direct the meditation');
        expect(prompt).not.toContain('SECRET-CUSTOM');
        // ...but verbosity always does.
        expect(prompt).toContain('Keep responses very brief');
    });

    it('includes the stage section right after the base prompt', () => {
        const c = new StagedModeController(FELT_SENSE_MODE);
        const builder = new PromptBuilder({ mode: FELT_SENSE_MODE });
        const prompt = builder.buildSystemPrompt(c.promptSection());
        expect(prompt).toContain('Settling in (clearing a space)');
        expect(prompt.indexOf('felt-sense session')).toBeLessThan(
            prompt.indexOf('Settling in (clearing a space)')
        );
    });

    it('mode pools drive the opener and check-ins', () => {
        const builder = new PromptBuilder({ mode: FELT_SENSE_MODE, random: () => 0 });
        expect(FELT_SENSE_MODE.openers).toContain(builder.getSessionOpener());
        expect(FELT_SENSE_MODE.checkIns).toContain(builder.getCheckInPrompt());
        const openerPrompt = builder.buildOpenerPrompt('the job decision');
        expect(openerPrompt).toContain(FELT_SENSE_MODE.openerPrompt as string);
        expect(openerPrompt).toContain('the job decision');
    });

    it('no mode (or exploration) keeps the classic behavior', () => {
        const config = {
            focuses: ['body_sensations' as const],
            qualities: ['playful' as const],
            directiveness: 3,
            verbosity: 'medium' as const,
            customInstructions: 'extra',
        };
        const bare = new PromptBuilder({ config }).buildSystemPrompt();
        const exploration = new PromptBuilder({ config, mode: EXPLORATION_MODE }).buildSystemPrompt();
        expect(exploration).toBe(bare);
        expect(bare).toContain('Attention focus');
        expect(bare).toContain('Facilitator vibe');
        expect(bare).toContain('Additional instructions:\nextra');
    });
});

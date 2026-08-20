import { describe, expect, it } from 'vitest';
import {
    getMode,
    listModes,
    parseTurnSignals,
    scrubControlTokens,
    StagedModeController,
    EXPLORATION_MODE,
    NOTING_MODE,
    NEXT_PREFIX,
    BACK_PREFIX,
    type ModeSpec,
    stripRoleLeak,
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
        expect(r).toEqual({
            hold: false,
            stage: 'none',
            waitSec: null,
            cleanText: 'What do you notice?',
        });
    });

    it('parses [WAIT:Nm] into seconds (minutes default, seconds accepted)', () => {
        expect(parseTurnSignals('[WAIT:12m] Let it unfold.').waitSec).toBe(720);
        expect(parseTurnSignals('[WAIT:5] Rest here.').waitSec).toBe(300);
        expect(parseTurnSignals('[WAIT:90s] Almost there.').waitSec).toBe(90);
        expect(parseTurnSignals('[wait: 3 min] ok').waitSec).toBe(180);
    });

    it('combines [WAIT] with other tokens; first WAIT wins', () => {
        const r = parseTurnSignals('[HOLD] [WAIT:10m] [WAIT:2m] Quietly now.');
        expect(r.hold).toBe(true);
        expect(r.waitSec).toBe(600);
        expect(r.cleanText).toBe('Quietly now.');
    });

    it('never honors a mid-text [WAIT], but scrubs it from the spoken text', () => {
        const r = parseTurnSignals('We can [WAIT:5m] later.');
        expect(r.waitSec).toBeNull();
        expect(r.cleanText).toBe('We can later.');
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

    it('ignores tokens that are not leading (but scrubs them from speech)', () => {
        const r = parseTurnSignals('We can go [NEXT] later.');
        expect(r.stage).toBe('none');
        expect(r.cleanText).toBe('We can go later.');
    });

    it('honors a token a leaked reasoning block was sitting in front of', () => {
        const r = parseTurnSignals('<think>They want quiet.</think>[HOLD] I am right here.');
        expect(r.hold).toBe(true);
        expect(r.cleanText).toBe('I am right here.');
    });
});

describe('scrubControlTokens', () => {
    it('removes known tokens anywhere, tidying spacing and punctuation', () => {
        expect(scrubControlTokens('Sure. [HOLD] Want some quiet?')).toBe('Sure. Want some quiet?');
        expect(scrubControlTokens('Take a breath [WAIT:10m].')).toBe('Take a breath.');
        expect(scrubControlTokens('One[NEXT]two [pass] three')).toBe('One two three');
    });

    it('leaves unknown bracketed text alone', () => {
        expect(scrubControlTokens('It felt like [something] shifted.')).toBe(
            'It felt like [something] shifted.'
        );
    });

    it('drops tag-shaped leftovers the model invented', () => {
        expect(scrubControlTokens('[PAUSE] Let it settle.')).toBe('Let it settle.');
        expect(scrubControlTokens('Rest here. <SILENCE>')).toBe('Rest here.');
    });

    it('drops a reasoning block with its contents, and stray markup without', () => {
        expect(scrubControlTokens('<think>They sound tense.</think> Rest here.')).toBe(
            'Rest here.'
        );
        expect(scrubControlTokens('<thinking>\nmulti\nline\n</thinking>Rest here.')).toBe(
            'Rest here.'
        );
        // Not a reasoning block: the tags go, the words stay.
        expect(scrubControlTokens('<p>Rest <em>here</em>.</p>')).toBe('Rest here.');
        expect(scrubControlTokens('Rest here.<br/>')).toBe('Rest here.');
    });

    it('leaves prose that merely uses angle brackets alone', () => {
        expect(scrubControlTokens('Breathe in <3 counts.')).toBe('Breathe in <3 counts.');
        expect(scrubControlTokens('It felt like 3 < 5 somehow.')).toBe(
            'It felt like 3 < 5 somehow.'
        );
    });

    it('never strands the decoration a removed token was wrapped in', () => {
        expect(scrubControlTokens('([NEXT]) Move on now.')).toBe('Move on now.');
        expect(scrubControlTokens('**[HOLD]** Bolded.')).toBe('Bolded.');
        expect(scrubControlTokens('[[HOLD]] Doubled.')).toBe('Doubled.');
        expect(scrubControlTokens('- [HOLD] Bulleted.')).toBe('Bulleted.');
        expect(scrubControlTokens('[HOLD]: Colon after.')).toBe('Colon after.');
    });
});

// Models render the tokens imperfectly. Each near-miss costs twice: the signal
// is not honored AND the token gets spoken, so both halves are asserted.
describe('parseTurnSignals on mangled tokens', () => {
    const cases: Array<[string, string]> = [
        ['[ HOLD ] Inner spaces.', 'Inner spaces.'],
        ['[HOLD Missing close.', 'Missing close.'],
        ['HOLD] Missing open.', 'Missing open.'],
        ['<HOLD> Angle brackets.', 'Angle brackets.'],
        ['{HOLD} Braces.', 'Braces.'],
        ['(HOLD) All-caps parens.', 'All-caps parens.'],
        ['**[HOLD]** Bolded.', 'Bolded.'],
        ['"[HOLD]" Quoted.', 'Quoted.'],
        ['[[HOLD]] Doubled.', 'Doubled.'],
    ];
    it.each(cases)('honors and strips %j', (raw, clean) => {
        const r = parseTurnSignals(raw);
        expect(r.hold).toBe(true);
        expect(r.cleanText).toBe(clean);
    });

    it('accepts a mangled stage token', () => {
        expect(parseTurnSignals('([NEXT]) Move on now.').stage).toBe('advance');
        expect(parseTurnSignals('[ BACK ] Set it down again.').stage).toBe('back');
    });

    it('swallows a malformed [WAIT] rather than speaking it', () => {
        for (const raw of ['[WAIT] Bare wait.', '[WAIT:] Empty wait.']) {
            const r = parseTurnSignals(raw);
            expect(r.waitSec).toBeNull();
            expect(r.cleanText).not.toMatch(/[[\]<>]/);
        }
    });

    // The other half of being loose: ordinary facilitation language that merely
    // contains a token word must survive intact. Lowercase "(hold)" is the one
    // that forces the paren form to stay case-sensitive.
    it.each([
        'Back to the breath whenever you are ready.',
        'Hold that for a moment.',
        'Gently (hold) the breath there.',
        "What's next for you?",
        'Pass no judgment on what arises.',
        'Wait: what is here right now?',
        'It felt like [something] shifted.',
    ])('leaves %j untouched', (line) => {
        expect(parseTurnSignals(line)).toEqual({
            hold: false,
            stage: 'none',
            waitSec: null,
            cleanText: line,
        });
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
        // None of the user-tunable exploration dimensions compose — the
        // protocol defines attention, tone, guidance, and brevity itself —
        // and the dimensions preamble goes with them.
        expect(prompt).not.toContain('Attention focus');
        expect(prompt).not.toContain('Facilitator vibe');
        expect(prompt).not.toContain('Actively direct the meditation');
        expect(prompt).not.toContain('Keep responses very brief');
        expect(prompt).not.toContain('How this session is tuned');
        expect(prompt).not.toContain('SECRET-CUSTOM');
    });

    it('a checkinPaceSlider mode maps directiveness to the [WAIT] bias only', () => {
        expect(FELT_SENSE_MODE.checkinPaceSlider).toBe(true);
        // The session view feeds the pace value through config.directiveness;
        // with directiveness not composing, its only effect is the wait bias.
        const at = (directiveness: number) =>
            new PromptBuilder({
                mode: FELT_SENSE_MODE,
                config: { waitSignal: true, directiveness },
            }).buildSystemPrompt();
        expect(at(3)).toContain('[WAIT:8m]');
        expect(at(10)).toContain('[WAIT:30s]');
        expect(at(10)).not.toContain('Actively direct the meditation');
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
        expect(bare).toContain('Additional instructions from the meditator:\nextra');
    });
});

describe('stripRoleLeak', () => {
    // The actual leak from the field report (Opus, exploration mode).
    const REAL = `What's the skeptical part saying as it comes back? user I have this suspicion that I don't want to notice anything, that I somehow want to just get past it. assistant So there's a wanting to skip ahead, past the noticing.`;

    it('truncates the field-report leak at the fabricated turn', () => {
        expect(stripRoleLeak(REAL)).toBe(
            "What's the skeptical part saying as it comes back?"
        );
    });

    it.each([
        ['chat delimiter', 'Resting here.<|im_start|>user\nokay', 'Resting here.'],
        ['line-start label', 'Just be with it.\nAssistant: What now?', 'Just be with it.'],
        ['newline-separated bare word', 'What do you notice?\n\nuser "I feel warm"', 'What do you notice?'],
        // The Aug 2026 Opus 4.5 leak: markers fused to their neighbors with no
        // whitespace, which the old \s+-separated pattern let straight through
        // into the transcript AND history.
        [
            'fused marker',
            'If that twinge could answer — what does it need?usernothing is coming up.',
            'If that twinge could answer — what does it need?',
        ],
        [
            'fused marker before a capital',
            "Yeah, so let's just be with that.assistant Yes. Just letting it be here.",
            "Yeah, so let's just be with that.",
        ],
        ['marker alone on a line', 'What does it need?\nuser\nnothing is coming up', 'What does it need?'],
    ])('truncates a %s', (_name, input, want) => {
        expect(stripRoleLeak(input)).toBe(want);
    });

    // False positives truncate a real reply mid-sit, so these matter more than
    // catching every leak.
    it.each([
        'What does that feel like in your nervous system?',
        'Something human is happening there. Can you stay with it?',
        'Notice the user of that thought. Who is noticing?',
        'You are the assistant to your own attention here.',
        "There's tension in my shoulders. Users of this practice often find that.",
        'Just letting that continue, however it wants to.',
        'What would you say to that part? "I see you," maybe.',
    ])('leaves ordinary facilitation untouched: %s', (text) => {
        expect(stripRoleLeak(text)).toBe(text);
    });
});

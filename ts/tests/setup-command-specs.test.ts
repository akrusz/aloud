import { describe, expect, it } from 'vitest';
import {
    isJudgeId,
    jevRequest,
    judgeSpec,
    judgeState,
    type JudgeAnswers,
    type JudgeId,
    type UtteranceJudge,
} from '../src/facilitation/utterance-judge.js';
import {
    judgeSetupCommand,
    mightBeSetupRequest,
    resolveSetupAnswers,
    SETUP_GATE_ASK,
    SETUP_GATE_BAR,
    SETUP_JUDGE_MAX_WORDS,
    SETUP_SPECS,
} from '../src/facilitation/setup-command-specs.js';

const ASKS = SETUP_SPECS['setup-command'].asks;
const bar = (key: string): number => ASKS[key]!.threshold;
/** Every ask at zero, then a clear yes (or the given score) on the named ones. */
function answers(yes: Record<string, number | true> = {}): JudgeAnswers {
    const out: JudgeAnswers = Object.fromEntries(Object.keys(ASKS).map((k) => [k, 0]));
    for (const [k, v] of Object.entries(yes)) out[k] = v === true ? Math.min(1, bar(k) + 0.05) : v;
    return out;
}
const resolve = (yes: Record<string, number | true>, text = 'Could you change that, please?') =>
    resolveSetupAnswers(answers(yes), text);

describe('setup judge ids', () => {
    it('are judge ids the server answers, with their questions built in core', () => {
        expect(isJudgeId('setup-gate')).toBe(true);
        expect(isJudgeId('setup-command')).toBe(true);
        expect(judgeSpec('setup-command')).toBe(SETUP_SPECS['setup-command']);
        expect(Object.keys(jevRequest('setup-gate', 'Make it spacious.').questions)).toEqual([SETUP_GATE_ASK]);
        expect(Object.keys(jevRequest('setup-command', 'Make it spacious.').questions).sort()).toEqual(
            Object.keys(ASKS).sort()
        );
    });

    it('send nothing but the situation and the utterance, whatever context is passed', () => {
        const state = judgeState('setup-command', 'Make it spacious.', {
            earlier: ['before'],
            before: { facilitator: 'You can end the session.' },
        });
        expect(state).toEqual({ situation: SETUP_SPECS['setup-command'].situation, utterance: 'Make it spacious.' });
    });
});

describe('mightBeSetupRequest', () => {
    it('keeps empty and wordless text off the wire', () => {
        for (const text of ['', '   ', '...', '20']) expect(mightBeSetupRequest(text), text).toBe(false);
    });

    it('never sends anything with begin or start in it, as a word or inside one', () => {
        for (const text of [
            "Let's begin with spacious.",
            'Start a noting session',
            'restart the timer please',
            'BEGIN',
            '开始体会模式',
        ]) {
            expect(mightBeSetupRequest(text), text).toBe(false);
        }
    });

    it('takes no lone word: sound is all the judge would have to go on', () => {
        for (const text of ['Notice.', 'Explosion.', 'nothing', '开']) expect(mightBeSetupRequest(text), text).toBe(false);
        expect(mightBeSetupRequest('Effort less.')).toBe(true);
        expect(mightBeSetupRequest('开扩')).toBe(true);
    });

    it('stops at a sentence', () => {
        const words = (n: number) => Array.from({ length: n }, () => 'spacious').join(' ');
        expect(mightBeSetupRequest(words(SETUP_JUDGE_MAX_WORDS))).toBe(true);
        expect(mightBeSetupRequest(words(SETUP_JUDGE_MAX_WORDS + 1))).toBe(false);
        expect(mightBeSetupRequest('开阔'.repeat(13))).toBe(false);
    });
});

describe('resolveSetupAnswers', () => {
    it('is nothing when nothing clears, or only a bar-short score', () => {
        expect(resolve({})).toBeNull();
        expect(resolve({ vibe_spacious: bar('vibe_spacious') - 0.01 })).toBeNull();
    });

    it('is nothing when only the modifiers fire', () => {
        expect(resolve({ remove: true })).toBeNull();
        expect(resolve({ replace: true })).toBeNull();
    });

    it('treats a partial answer as a failure, not a no', () => {
        const partial = answers({ vibe_spacious: true });
        delete partial['help'];
        expect(resolveSetupAnswers(partial, 'Make it spacious.')).toBeNull();
        expect(resolveSetupAnswers({ ...answers({ vibe_spacious: true }), help: Number.NaN }, 'x y')).toBeNull();
    });

    it('drops everything when it may have been a request to begin', () => {
        expect(resolve({ mode_noting: true, begin: true }, 'Big in a noting session.')).toBeNull();
    });

    it('takes one mode, never two, and never a mode taken away', () => {
        expect(resolve({ mode_noting: true })).toEqual([{ kind: 'mode', mode: 'noting' }]);
        expect(resolve({ mode_noting: true, mode_exploration: true })).toBeNull();
        expect(resolve({ mode_noting: true, remove: true })).toBeNull();
    });

    it('gives vibes and focuses their polarity from remove', () => {
        expect(resolve({ vibe_playful: true })).toEqual([{ kind: 'quality', quality: 'playful', on: true }]);
        expect(resolve({ vibe_playful: true, focus_body: true, remove: true })).toEqual([
            { kind: 'focus', focus: 'body_sensations', on: false },
            { kind: 'quality', quality: 'playful', on: false },
        ]);
    });

    it('clears a group before what replaces it, and leaves values out when replace and remove both fire', () => {
        expect(resolve({ vibe_spacious: true, replace: true })).toEqual([
            { kind: 'clear', group: 'quality' },
            { kind: 'quality', quality: 'spacious', on: true },
        ]);
        expect(resolve({ vibe_loving: true, replace: true, remove: true })).toBeNull();
    });

    it('keeps the higher of two asks Jev scores together', () => {
        expect(resolve({ vibe_compassionate: 0.97, vibe_loving: 0.9 })).toEqual([
            { kind: 'quality', quality: 'compassionate', on: true },
        ]);
        expect(resolve({ mode_felt_sense: 0.79, vibe_feeling_good: 0.78 })).toEqual([{ kind: 'mode', mode: 'felt_sense' }]);
    });

    it('lets a word in the text pick guidance or response length when both clear', () => {
        const both = { guide_less: 0.85, shorter: 0.9 };
        expect(resolve(both, 'Not so much guidance this time.')).toEqual([{ kind: 'guidance', to: 'down' }]);
        expect(resolve(both, "I'd rather you led less.")).toEqual([{ kind: 'guidance', to: 'down' }]);
        expect(resolve({ guide_more: 0.95, longer: 0.92 }, 'Could you say a bit more?')).toEqual([
            { kind: 'verbosity', to: 'up' },
        ]);
        // No word for either side: the score decides.
        expect(resolve(both, 'Less, please.')).toEqual([{ kind: 'verbosity', to: 'down' }]);
    });

    it('cancels opposites that both clear', () => {
        expect(resolve({ guide_more: true, guide_less: true })).toBeNull();
        expect(resolve({ shorter: true, longer: true })).toBeNull();
    });

    it('takes a length only with minutes in the text, and not one added to a timer', () => {
        expect(resolve({ length: true }, 'Can we do about fifteen minutes today?')).toEqual([{ kind: 'length', minutes: 15 }]);
        expect(resolve({ length: true }, 'Let us keep it short today.')).toBeNull();
        expect(resolve({ length: true }, 'Five more minutes.')).toBeNull();
        // "more" that belongs to something else is not "add to the timer".
        expect(resolve({ length: true, guide_more: true }, 'Twenty minutes with more guidance.')).toEqual([
            { kind: 'length', minutes: 20 },
            { kind: 'guidance', to: 'up' },
        ]);
    });

    it('weighs a length against no timer only when it has minutes', () => {
        expect(resolve({ length: true, no_timer: true }, "No clock, I'll go as long as I like.")).toEqual([
            { kind: 'no-timer' },
        ]);
        expect(resolve({ length: true, no_timer: true }, 'No timer, or maybe ten minutes.')).toBeNull();
    });

    it('turns check-ins on, or off beside remove', () => {
        expect(resolve({ checkins: true })).toEqual([{ kind: 'checkins', on: true }]);
        expect(resolve({ checkins: true, remove: true })).toEqual([{ kind: 'checkins', on: false }]);
    });

    it('answers help only when nothing else was asked, and stops listening last', () => {
        expect(resolve({ help: true })).toEqual([{ kind: 'help' }]);
        expect(resolve({ help: true, vibe_playful: true })).toEqual([{ kind: 'quality', quality: 'playful', on: true }]);
        expect(resolve({ help: true, stop_listening: true })).toEqual([{ kind: 'stop-listening' }]);
        expect(resolve({ stop_listening: true, mode_noting: true })).toEqual([
            { kind: 'mode', mode: 'noting' },
            { kind: 'stop-listening' },
        ]);
    });
});

describe('judgeSetupCommand', () => {
    function fakeJudge(script: Partial<Record<JudgeId, JudgeAnswers | Error>>) {
        const calls: Array<[JudgeId, string]> = [];
        const judge: UtteranceJudge = {
            async judge(id, utterance) {
                calls.push([id, utterance]);
                const reply = script[id];
                if (!reply) throw new Error(`no ${id}`);
                if (reply instanceof Error) throw reply;
                return reply;
            },
        };
        return { judge, calls };
    }
    const gateYes = { [SETUP_GATE_ASK]: SETUP_GATE_BAR + 0.1 };

    it('runs the gate, then the set, on the trimmed text', async () => {
        const { judge, calls } = fakeJudge({ 'setup-gate': gateYes, 'setup-command': answers({ vibe_spacious: true }) });
        expect(await judgeSetupCommand(judge, '  Make it more spayshus.  ')).toEqual([
            { kind: 'quality', quality: 'spacious', on: true },
        ]);
        expect(calls).toEqual([
            ['setup-gate', 'Make it more spayshus.'],
            ['setup-command', 'Make it more spayshus.'],
        ]);
    });

    it('stops at a gate under its bar', async () => {
        const { judge, calls } = fakeJudge({
            'setup-gate': { [SETUP_GATE_ASK]: SETUP_GATE_BAR - 0.01 },
            'setup-command': answers({ vibe_spacious: true }),
        });
        expect(await judgeSetupCommand(judge, 'Spacious kitchen for sale.')).toBeNull();
        expect(calls.map(([id]) => id)).toEqual(['setup-gate']);
    });

    it('fails closed: a gate or set that cannot answer is nothing, and nothing throws', async () => {
        const noGate = fakeJudge({ 'setup-gate': new Error('judge returned 400') });
        expect(await judgeSetupCommand(noGate.judge, 'Make it spacious, please.')).toBeNull();
        expect(noGate.calls).toHaveLength(1);
        const noSet = fakeJudge({ 'setup-gate': gateYes, 'setup-command': new Error('judge timed out') });
        expect(await judgeSetupCommand(noSet.judge, 'Make it spacious, please.')).toBeNull();
        const garbled = fakeJudge({ 'setup-gate': {}, 'setup-command': answers({ vibe_spacious: true }) });
        expect(await judgeSetupCommand(garbled.judge, 'Make it spacious, please.')).toBeNull();
        expect(garbled.calls).toHaveLength(1);
    });

    it('never asks about a begin, or a lone word', async () => {
        const { judge, calls } = fakeJudge({ 'setup-gate': gateYes, 'setup-command': answers({ mode_noting: true }) });
        expect(await judgeSetupCommand(judge, "Let's begin a noting session.")).toBeNull();
        expect(await judgeSetupCommand(judge, 'Start noting.')).toBeNull();
        expect(await judgeSetupCommand(judge, '开始吧')).toBeNull();
        expect(await judgeSetupCommand(judge, 'Notice.')).toBeNull();
        expect(calls).toHaveLength(0);
    });
});

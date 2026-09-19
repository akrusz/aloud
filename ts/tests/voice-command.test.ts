import { describe, it, expect } from 'vitest';

import {
    detectVoiceCommand,
    classifyEndConfirm,
    mightBeCommand,
    parseTimerRequest,
    steppedRate,
    steppedPause,
    PAUSE_LADDER,
    COMMAND_LINES,
    VOICE_COMMAND_IDS,
    TTS_RATE_MAX,
    TTS_RATE_MIN,
} from '../src/facilitation/voice-command.js';
import { judgeQuestions, judgeSpec, type JudgeAnswers, type UtteranceJudge } from '../src/facilitation/utterance-judge.js';

const none = (): JudgeAnswers => Object.fromEntries(VOICE_COMMAND_IDS.map((id) => [id, 0.03]));

function judgeOf(answers: JudgeAnswers | Error): UtteranceJudge & { calls: number } {
    return {
        calls: 0,
        async judge() {
            this.calls++;
            if (answers instanceof Error) throw answers;
            return answers;
        },
    };
}

describe('detectVoiceCommand', () => {
    it('returns the ask that cleared its threshold', async () => {
        const cmd = await detectVoiceCommand(judgeOf({ ...none(), slower: 0.92 }), 'Can you slow down?');
        expect(cmd?.command).toBe('slower');
    });

    it('takes the higher of two that clear it', async () => {
        const cmd = await detectVoiceCommand(judgeOf({ ...none(), cancel_timer: 0.7, end_session: 0.9 }), 'Stop.');
        expect(cmd?.command).toBe('end_session');
    });

    it('prefers a save/discard ending over the plain one it also matches', async () => {
        const both = { ...none(), end_session: 0.97, end_discard: 0.96 };
        expect((await detectVoiceCommand(judgeOf(both), 'End without saving.'))?.command).toBe('end_discard');
        const save = { ...none(), end_session: 0.9, end_save: 0.8 };
        expect((await detectVoiceCommand(judgeOf(save), 'End and save.'))?.command).toBe('end_save');
        // Both variants at once: the judge couldn't tell, so follow the default.
        const muddled = { ...none(), end_session: 0.7, end_discard: 0.8, end_save: 0.8 };
        expect((await detectVoiceCommand(judgeOf(muddled), 'End it.'))?.command).toBe('end_session');
    });

    it('is null under the threshold, on a judge failure, and on a partial answer', async () => {
        expect(await detectVoiceCommand(judgeOf({ ...none(), slower: 0.4 }), 'Slow.')).toBeNull();
        expect(await detectVoiceCommand(judgeOf(new Error('502')), 'Slow down.')).toBeNull();
        expect(await detectVoiceCommand(judgeOf({ slower: 0.99 }), 'Slow down.')).toBeNull();
    });

    it('never asks the judge about a long utterance', async () => {
        const judge = judgeOf({ ...none(), end_session: 0.99 });
        const long = 'I keep coming back to this sense that something in me wants the whole thing to end and I do not know why';
        expect(mightBeCommand(long)).toBe(false);
        expect(await detectVoiceCommand(judge, long)).toBeNull();
        expect(judge.calls).toBe(0);
        expect(mightBeCommand('Could you set a timer for twenty five minutes please?')).toBe(true);
        expect(mightBeCommand('定一个二十分钟的计时。')).toBe(true);
    });
});

describe('classifyEndConfirm', () => {
    it('separates yes, no, and neither', async () => {
        expect(await classifyEndConfirm(judgeOf({ confirms: 0.95, declines: 0.02 }), 'Yes.')).toBe('yes');
        expect(await classifyEndConfirm(judgeOf({ confirms: 0.03, declines: 0.9 }), 'No, not yet.')).toBe('no');
        expect(await classifyEndConfirm(judgeOf({ confirms: 0.1, declines: 0.2 }), 'It moved.')).toBe('other');
    });

    it('holds ending to a higher bar than declining, and fails to neither', async () => {
        expect(await classifyEndConfirm(judgeOf({ confirms: 0.7, declines: 0.1 }), 'I guess.')).toBe('other');
        expect(await classifyEndConfirm(judgeOf(new Error('502')), 'Yes.')).toBe('other');
    });
});

describe('command specs', () => {
    it('sends one noul per command, each with both criteria sides', () => {
        const qs = judgeQuestions('command');
        expect(Object.keys(qs).sort()).toEqual([...VOICE_COMMAND_IDS].sort());
        for (const q of Object.values(qs)) {
            expect(q.type).toBe('noul');
            expect(q.criteria.true.examples.length).toBeGreaterThan(0);
            expect(q.criteria.false.examples.length).toBeGreaterThan(0);
        }
        expect(judgeSpec('end-confirm').asks['confirms']!.threshold).toBeGreaterThan(
            judgeSpec('end-confirm').asks['declines']!.threshold
        );
    });
});

describe('parseTimerRequest', () => {
    const cases: Array<[string, number | null, boolean?]> = [
        ['Set a timer for ten minutes.', 10],
        ['Set the timer for 25 minutes', 25],
        ['Can we do twenty-five minutes?', 25],
        ['forty five minutes please', 45],
        ['Timer for a minute.', 1],
        ['Make it an hour.', 60],
        ['Set it for an hour and a half.', 90],
        ['two hours', 120],
        ['Half an hour, please.', 30],
        ['Give me five more minutes.', 5, true],
        ['Add another ten minutes.', 10, true],
        ['Extend it by 15 mins', 15, true],
        ['Set a timer.', null],
        ['Wait a minute, set a timer for twelve minutes.', 12],
        ['计时二十分钟。', 20],
        ['定一个十分钟的计时', 10],
        ['计时 15 分钟', 15],
        ['半小时', 30],
        ['一个半小时', 90],
        ['两个小时', 120],
        ['再加五分钟', 5, true],
        ['设个计时', null],
    ];
    for (const [text, minutes, relative] of cases) {
        it(`${text} -> ${minutes}${relative ? ' more' : ''}`, () => {
            const got = parseTimerRequest(text);
            if (minutes === null) expect(got).toBeNull();
            else expect(got).toEqual({ minutes, relative: relative ?? false });
        });
    }
});

describe('steppedRate', () => {
    it('steps both ways and stops at the slider ends', () => {
        expect(steppedRate(150, 'slower')).toBe(130);
        expect(steppedRate(150, 'faster')).toBe(170);
        expect(steppedRate(TTS_RATE_MIN + 10, 'slower')).toBe(TTS_RATE_MIN);
        expect(steppedRate(TTS_RATE_MIN, 'slower')).toBeNull();
        expect(steppedRate(TTS_RATE_MAX, 'faster')).toBeNull();
    });
});

describe('steppedPause', () => {
    it('moves one rung, from a rung or from a custom value between rungs', () => {
        expect(steppedPause(3000, 'longer')).toEqual({ baseMs: 4000, maxMs: 6500 });
        expect(steppedPause(3000, 'sooner')).toEqual({ baseMs: 2000, maxMs: 3500 });
        expect(steppedPause(3400, 'longer')).toEqual({ baseMs: 4000, maxMs: 6500 });
        expect(steppedPause(3400, 'sooner')).toEqual({ baseMs: 3000, maxMs: 5000 });
    });

    it('stops at both ends and includes the Settings presets', () => {
        expect(steppedPause(PAUSE_LADDER[0]!.baseMs, 'sooner')).toBeNull();
        expect(steppedPause(PAUSE_LADDER[PAUSE_LADDER.length - 1]!.baseMs, 'longer')).toBeNull();
        for (const preset of [{ baseMs: 2000, maxMs: 3500 }, { baseMs: 3000, maxMs: 5000 }, { baseMs: 5000, maxMs: 8000 }]) {
            expect(PAUSE_LADDER).toContainEqual(preset);
        }
    });
});

describe('COMMAND_LINES', () => {
    it('pluralizes, handles the under-a-minute ends, and has zh for each', () => {
        expect(COMMAND_LINES.timerSet('en', 1)).toBe('Timer set for 1 minute.');
        expect(COMMAND_LINES.timerSet('en', 20)).toBe('Timer set for 20 minutes.');
        expect(COMMAND_LINES.timerSetEnds('en', 20)).toBe("Timer set for 20 minutes. The session will end when it's up.");
        expect(COMMAND_LINES.timeLeft('en', 0)).toBe('Less than a minute left.');
        expect(COMMAND_LINES.timeElapsed('en', 0)).toBe("We've just started.");
        for (const line of Object.values(COMMAND_LINES)) {
            const zh = (line as (l: 'zh-CN', n: number) => string)('zh-CN', 5);
            expect(zh).toMatch(/[一-鿿]/);
            expect(zh).not.toMatch(/[A-Za-z]/);
        }
    });
});

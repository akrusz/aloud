import { describe, it, expect, vi, afterEach } from 'vitest';

import {
    CommandPrefetch,
    detectVoiceCommand,
    resolveCommands,
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

describe('resolveCommands', () => {
    it('carries out every command the utterance held', () => {
        expect(resolveCommands({ ...none(), slower: 0.98, show_orb: 0.81 })).toEqual(['slower', 'show_orb']);
    });

    it('keeps the stronger of two opposites, and a named theme over "switch theme"', () => {
        expect(resolveCommands({ ...none(), embers_on: 0.5, embers_off: 0.7 })).toEqual(['embers_off']);
        expect(resolveCommands({ ...none(), dark_mode: 0.9, toggle_theme: 0.6 })).toEqual(['dark_mode']);
    });

    it('holds the visual toggles to a lower bar than the rest', () => {
        expect(resolveCommands({ ...none(), embers_on: 0.5 })).toEqual(['embers_on']);
        expect(resolveCommands({ ...none(), slower: 0.5 })).toEqual([]);
    });

    it('lets "say that again" and "what can I say?" stand only alone', () => {
        expect(resolveCommands({ ...none(), repeat: 0.9 })).toEqual(['repeat']);
        expect(resolveCommands({ ...none(), repeat: 0.9, slower: 0.9, help: 0.9 })).toEqual(['slower']);
    });

    it('mutes last, and asks about ending after everything else', () => {
        expect(resolveCommands({ ...none(), mute: 0.9, mute_speaker: 0.9, cancel_timer: 0.9 })).toEqual([
            'cancel_timer',
            'mute_speaker',
            'mute',
        ]);
        expect(resolveCommands({ ...none(), end_session: 0.9, end_discard: 0.9, faster: 0.9 })).toEqual([
            'faster',
            'end_discard',
        ]);
    });

    it('shows the clock rather than also reading out the time', () => {
        expect(resolveCommands({ ...none(), show_clock: 0.93, time_check: 0.61 })).toEqual(['show_clock']);
    });

    it('never mutes the mic under a question it needs an answer to', () => {
        expect(resolveCommands({ ...none(), end_session: 0.9, mute: 0.9 })).toEqual(['end_session']);
    });
});

describe('detectVoiceCommand', () => {
    it('stops at the gate on a clear no, without sending the full set', async () => {
        const asked: string[] = [];
        const judge: UtteranceJudge = {
            async judge(id) {
                asked.push(id);
                return id === 'command-gate' ? { is_command: 0.04 } : { ...none(), slower: 0.98 };
            },
        };
        expect(await detectVoiceCommand(judge, "There's a warmth in my chest.")).toBeNull();
        expect(asked).toEqual(['command-gate']);
    });

    it('goes on to the full check when the gate says maybe, or cannot be asked', async () => {
        for (const gate of [{ is_command: 0.4 }, new Error('400: unknown classifier')]) {
            const judge: UtteranceJudge = {
                async judge(id) {
                    if (id !== 'command-gate') return { ...none(), slower: 0.98 };
                    if (gate instanceof Error) throw gate;
                    return gate;
                },
            };
            expect((await detectVoiceCommand(judge, 'Can you slow down?'))?.commands).toEqual(['slower']);
        }
    });

    it('asks once more when the judge fails: a cold first call is not a no', async () => {
        let calls = 0;
        const flaky: UtteranceJudge = {
            async judge() {
                if (++calls === 1) throw new Error('timeout');
                return { ...none(), cancel_timer: 0.98 };
            },
        };
        expect((await detectVoiceCommand(flaky, 'Oh, can you cancel the timer?'))?.commands).toEqual(['cancel_timer']);
        expect(calls).toBe(2);
    });

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

describe('CommandPrefetch', () => {
    afterEach(() => vi.useRealTimers());

    it('judges a settled partial once and hands the verdict to the matching final', async () => {
        vi.useFakeTimers();
        const judge = judgeOf({ ...none(), slower: 0.95 });
        const pre = new CommandPrefetch(judge, 350);
        pre.note('can you');
        pre.note('can you slow');
        pre.note('Can you slow down');
        expect(judge.calls).toBe(0);
        vi.advanceTimersByTime(350);
        expect(judge.calls).toBe(1);
        // Same words again (a repeated partial) is not a new request.
        pre.note('can you slow down');
        vi.advanceTimersByTime(350);
        expect(judge.calls).toBe(1);

        const hit = pre.take('Can you slow down?');
        expect(hit).not.toBeNull();
        expect((await hit)?.command).toBe('slower');
        // Taken once; the next utterance starts clean.
        expect(pre.take('Can you slow down?')).toBeNull();
    });

    it('gives nothing when the final says something else, or came before the partial settled', () => {
        vi.useFakeTimers();
        const judge = judgeOf({ ...none(), slower: 0.95 });
        const pre = new CommandPrefetch(judge, 350);
        pre.note('can you slow down');
        vi.advanceTimersByTime(350);
        expect(pre.take('can you slow down the breathing exercise')).toBeNull();

        pre.note('end the session');
        expect(pre.take('end the session')).toBeNull();
        vi.advanceTimersByTime(1000);
        expect(judge.calls).toBe(1);
    });

    it('never asks about a partial too long to be a command', () => {
        vi.useFakeTimers();
        const judge = judgeOf(none());
        const pre = new CommandPrefetch(judge, 350);
        pre.note('I keep coming back to this sense that something in me wants the whole thing to end and I do not know why');
        vi.advanceTimersByTime(1000);
        expect(judge.calls).toBe(0);
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
            // Counter-examples are opt-in per ask (jev:commands decides), but
            // every ask says what it is not for.
            expect(q.criteria.false.not_for).toBeTruthy();
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

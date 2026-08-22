/**
 * Offline coverage for the soak harness orchestrator (soak/orchestrator.ts):
 * scripted providers and a scripted sim user drive the same wiring the live
 * harness uses, pinning the flows that matter - the hold round trip, the timer
 * completing inside a held silence, and the check-in pass/streak caps.
 */

import { describe, expect, it } from 'vitest';

import type { CompletionResult, LLMProvider, Message } from '../src/llm/index.js';
import { runSoakSession } from '../soak/orchestrator.js';
import { parseSimReply, type SimAction, type SimUser, type SimView } from '../soak/sim-user.js';
import { runChecks } from '../soak/checks.js';
import { parseJudgeReply } from '../soak/judge.js';
import type { Scenario } from '../soak/types.js';

function completion(text: string): CompletionResult {
    return { text, finishReason: 'stop', tokensUsed: null };
}

/**
 * Facilitator stub: event turns ([Check-in:/[Timer:) get dedicated replies,
 * everything else consumes the scripted turn queue.
 */
class ScriptedFacilitator implements LLMProvider {
    readonly model = 'scripted';
    private readonly turns: string[];
    private readonly onCheckin: () => string;
    private readonly onTimer: (event: string) => string;

    constructor(opts: {
        turns: string[];
        onCheckin?: () => string;
        onTimer?: (event: string) => string;
    }) {
        this.turns = [...opts.turns];
        this.onCheckin = opts.onCheckin ?? (() => '[PASS]');
        this.onTimer = opts.onTimer ?? (() => 'Our time is up.');
    }

    async complete(messages: Message[]): Promise<CompletionResult> {
        const last = messages[messages.length - 1]?.content ?? '';
        if (last.trimStart().startsWith('[Check-in:')) return completion(this.onCheckin());
        if (last.trimStart().startsWith('[Timer:')) return completion(this.onTimer(last));
        return completion(this.turns.shift() ?? 'Mm. Stay with that.');
    }
}

/** Yes/no classifier stub: YES when the utterance sounds like assent/resume. */
const utilityStub: LLMProvider = {
    model: 'utility-stub',
    async complete(messages: Message[]): Promise<CompletionResult> {
        const text = messages[messages.length - 1]?.content ?? '';
        return completion(/\b(yes|yeah|ready|continue|back)\b/i.test(text) ? 'YES' : 'NO');
    },
};

class ScriptedSimUser implements SimUser {
    readonly views: SimView[] = [];
    private readonly actions: SimAction[];
    constructor(actions: Array<Partial<SimAction> & { waitSec: number }>) {
        this.actions = actions.map((a) => ({
            text: null,
            end: false,
            raw: '',
            ...a,
        }));
    }
    async nextAction(view: SimView): Promise<SimAction> {
        this.views.push(view);
        return this.actions.shift() ?? { waitSec: 600, text: null, end: true, raw: '' };
    }
}

const baseScenario: Scenario = {
    id: 'test',
    title: 'test scenario',
    persona: { id: 'p', description: 'test' },
    modeId: 'exploration',
    fakeMinutes: 30,
};

describe('parseSimReply', () => {
    it('parses wait + spoken line', () => {
        const a = parseSimReply('WAIT: 90\nI notice my jaw is tight.');
        expect(a).toMatchObject({ waitSec: 90, text: 'I notice my jaw is tight.', end: false });
    });

    it('handles silence, END, clamping, and stage directions', () => {
        expect(parseSimReply('WAIT: 600').text).toBeNull();
        expect(parseSimReply('WAIT: 30\nokay, that felt complete\nEND')).toMatchObject({
            text: 'okay, that felt complete',
            end: true,
        });
        expect(parseSimReply('WAIT: 999999').waitSec).toBe(1800);
        expect(parseSimReply('no wait line at all').waitSec).toBe(60);
        expect(parseSimReply('WAIT: 60\n*breathes deeply*\n(settles)').text).toBeNull();
        expect(parseSimReply('WAIT: 60\n"quoted speech"').text).toBe('quoted speech');
    });

    it('keeps only the first move when a model scripts ahead with inline WAITs', () => {
        const a = parseSimReply('WAIT: 10\nYes, please. WAIT: 420 Hm, tingling. WAIT: 8 Okay, I am back.');
        expect(a.waitSec).toBe(10);
        expect(a.text).toBe('Yes, please.');
    });
});

describe('parseJudgeReply', () => {
    it('forgives trailing commas and code fences', () => {
        const v = parseJudgeReply(
            '```json\n{"overall": 7, "dimensions": {"tone": 8,}, "wince_moments": [], "notes": "ok",}\n```'
        );
        expect(v.overall).toBe(7);
        expect(v.dimensions.tone).toBe(8);
    });
});

describe('runSoakSession', () => {
    it('runs the hold round trip: bid, confirm, think-aloud stay, resume', async () => {
        const facilitator = new ScriptedFacilitator({
            turns: [
                'Take a breath. What do you notice?',
                '[HOLD] Would you like me to be quiet for a while?',
                'Welcome back. What did you find in the quiet?',
            ],
        });
        const sim = new ScriptedSimUser([
            { waitSec: 30, text: 'could we have some quiet for a bit' },
            { waitSec: 10, text: 'yes please' },
            { waitSec: 60, text: 'hm, lots of tingling' },
            { waitSec: 120, text: "okay, I'm ready to continue" },
            { waitSec: 30, end: true },
        ]);
        const result = await runSoakSession({
            scenario: baseScenario,
            facilitator,
            utility: utilityStub,
            simUser: sim,
        });

        expect(result.endedBy).toBe('sim-end');
        expect(result.error).toBeUndefined();
        const eventKeys = result.events.map((e) => `${e.kind}:${e.detail}`);
        expect(eventKeys).toContain('signal:hold-bid');
        expect(eventKeys).toContain('hold:enter');
        expect(eventKeys).toContain('hold:exit');
        // The think-aloud utterance stayed under the hold...
        const resumeVerdicts = result.events
            .filter((e) => e.kind === 'classifier' && e.detail === 'resume')
            .map((e) => e.data?.verdict);
        expect(resumeVerdicts).toEqual(['stay', 'resume']);
        // ...and the sim user saw the hold while it was active.
        expect(sim.views.some((v) => v.inSilence)).toBe(true);
        expect(result.finalState.silenceMode).toBe(false);
        expect(result.finalState.awaitingHoldConfirm).toBe(false);
        // All four utterances appear as user turns (buffered ones included).
        expect(result.transcript.filter((t) => t.kind === 'user')).toHaveLength(4);
        expect(runChecks(result).filter((f) => f.level === 'fail')).toEqual([]);
    });

    /**
     * meditation-pal-9era. A reply of nothing but control tokens keeps
     * rawText non-empty, so the old blank-completion guard waved it through and
     * the meditator got total silence in answer to what they said. The bare
     * [HOLD] is the worst of it: nothing is asked, so arming the confirm
     * handshake would parse their next words as a yes/no to a question they
     * never heard.
     */
    it('drops a signal-only reply instead of speaking a blank turn', async () => {
        const facilitator = new ScriptedFacilitator({
            turns: ['Settle in. What brings you here?', '[WAIT:8m]', '[HOLD]', 'Mm. Say more.'],
        });
        const sim = new ScriptedSimUser([
            { waitSec: 30, text: 'my shoulders feel tight' },
            { waitSec: 30, text: 'and my jaw too' },
            { waitSec: 30, text: 'that is about it' },
            { waitSec: 30, end: true },
        ]);
        const result = await runSoakSession({
            scenario: baseScenario,
            facilitator,
            utility: utilityStub,
            simUser: sim,
        });

        expect(result.error).toBeUndefined();
        // Nothing blank reached the transcript...
        const assistant = result.transcript.filter((t) => t.role === 'assistant');
        expect(assistant.every((t) => t.text.trim().length > 0)).toBe(true);
        // ...the opener is intact, so the two signal-only replies below are the
        // ones under test...
        expect(assistant[0]?.text).toContain('Settle in');
        // ...both were surfaced as empty instead...
        const eventKeys = result.events.map((e) => `${e.kind}:${e.detail}`);
        expect(eventKeys.filter((k) => k === 'error:empty-reply')).toHaveLength(2);
        // ...the [WAIT] still landed, because the intent is legible even when
        // there are no words with it...
        expect(eventKeys).toContain('signal:wait');
        // ...and the bare [HOLD] never armed the handshake or entered silence.
        expect(result.finalState.awaitingHoldConfirm).toBe(false);
        expect(eventKeys).not.toContain('hold:enter');
        // The soak check that exists for exactly this stays quiet.
        expect(runChecks(result).filter((f) => f.id === 'empty-spoken-turn')).toEqual([]);
    });

    it('speaks the timer completion inside a hold and restores the hold', async () => {
        const facilitator = new ScriptedFacilitator({
            turns: ['Settle in.', '[HOLD] Shall I stay quiet until your timer?'],
            onTimer: (event) => (/remain/.test(event) ? '[PASS]' : 'That is your time. No hurry coming back.'),
        });
        const sim = new ScriptedSimUser([
            { waitSec: 20, text: 'quiet please, until the bell' },
            { waitSec: 10, text: 'yes' },
            { waitSec: 1800 },
            { waitSec: 300, end: true },
        ]);
        const result = await runSoakSession({
            scenario: { ...baseScenario, timerMin: 5, fakeMinutes: 12 },
            facilitator,
            utility: utilityStub,
            simUser: sim,
        });

        const completionTurn = result.transcript.find((t) => t.kind === 'timer-completion');
        expect(completionTurn).toBeDefined();
        expect(completionTurn?.duringHold).toBe(true);
        const eventKeys = result.events.map((e) => `${e.kind}:${e.detail}`);
        expect(eventKeys).toContain('timer:approach-pass');
        expect(eventKeys).toContain('hold:restored-after-timer');
        expect(result.finalState.silenceMode).toBe(true);
        expect(result.endedBy).toBe('sim-end');
        expect(runChecks(result).filter((f) => f.level === 'fail')).toEqual([]);
    });

    it('ends the session when the timer is set to close the sit', async () => {
        const facilitator = new ScriptedFacilitator({
            turns: ['Settle in.'],
            onTimer: () => 'That is your time. Stopping here.',
        });
        const sim = new ScriptedSimUser([{ waitSec: 1800 }, { waitSec: 1800 }]);
        const result = await runSoakSession({
            scenario: {
                ...baseScenario,
                timerMin: 4, // short enough that no approach notice fires
                endSessionOnTimer: true,
                fakeMinutes: 10,
                checkinTiming: 'none',
            },
            facilitator,
            utility: utilityStub,
            simUser: sim,
        });
        expect(result.endedBy).toBe('timer');
        expect(result.transcript.filter((t) => t.kind === 'timer-completion')).toHaveLength(1);
        expect(runChecks(result).filter((f) => f.level === 'fail')).toEqual([]);
    });

    it('enforces the check-in pass budget and streak cap', async () => {
        const facilitator = new ScriptedFacilitator({
            turns: ['Whenever you are ready.', 'Mm.'],
            onCheckin: () => '[PASS]',
        });
        const sim = new ScriptedSimUser([
            { waitSec: 30, text: 'starting now' },
            { waitSec: 1800 },
            { waitSec: 1800 },
            { waitSec: 1800 },
        ]);
        const result = await runSoakSession({
            scenario: {
                ...baseScenario,
                fakeMinutes: 15,
                checkinTiming: 'fixed',
                silenceCheckinSec: 60,
            },
            facilitator,
            utility: utilityStub,
            simUser: sim,
        });

        const checkins = result.events.filter((e) => e.kind === 'checkin').map((e) => e.detail);
        // Two passes spend the budget, the third check-in speaks canned, then
        // one more pass hits the streak cap and check-ins go quiet for good.
        expect(checkins.slice(0, 4)).toEqual(['pass', 'pass', 'canned-pass-budget', 'pass']);
        expect(checkins).toContain('skipped-streak-cap');
        expect(result.transcript.filter((t) => t.kind === 'checkin-canned')).toHaveLength(1);
        expect(result.endedBy).toBe('duration');
    });
});

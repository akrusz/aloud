/**
 * Offline coverage for the soak harness (soak/orchestrator.ts and friends):
 * scripted providers and a scripted sim user drive the same wiring the live
 * harness uses, pinning the flows that matter - the hold round trip, the timer
 * completing inside a held silence, the check-in pass/streak caps, the
 * scenarios aimed at open bugs (59eg, kbec, rlgm, a zh sit), the recognizer
 * transform, the checks both firing and staying quiet, usage recording, and
 * several judges' verdicts kept apart.
 */

import { describe, expect, it } from 'vitest';

import type { CompletionOptions, CompletionResult, LLMProvider, Message } from '../src/llm/index.js';
import {
    HOLD_REQUEST_SYSTEM_PROMPT,
    RESUME_INTENT_SYSTEM_PROMPT,
    STEPPING_OUT_NOTE,
    TROUBLE_SYSTEM_PROMPT,
    ZH_LANGUAGE_FRAGMENT,
} from '../src/facilitation/index.js';
import { runSoakSession } from '../soak/orchestrator.js';
import { parseSimReply, type SimAction, type SimUser, type SimView } from '../soak/sim-user.js';
import { runChecks } from '../soak/checks.js';
import { holdsSessionRubric, judgeSessionRun, parseJudgeReply, runJudges } from '../soak/judge.js';
import { endsInQuestion, sessionStyle } from '../soak/style.js';
import { asWebSpeech, trailingFragment, transformLine } from '../soak/transform.js';
import { cachedShare, totalUsage } from '../soak/usage.js';
import { callCostUsd } from '../soak/prices.js';
import { buildReportMd, type RunMeta } from '../soak/report.js';
import { getScenarios } from '../soak/scenarios.js';
import type { Scenario, SessionReport, SessionRunResult } from '../soak/types.js';

function completion(text: string, usage: Partial<CompletionResult> = {}): CompletionResult {
    return { text, finishReason: 'stop', tokensUsed: null, ...usage };
}

/**
 * Facilitator stub: event turns ([Check-in:/[Timer:) get dedicated replies,
 * everything else consumes the scripted turn queue. Keeps every system prompt
 * and message list it was sent.
 */
class ScriptedFacilitator implements LLMProvider {
    readonly model: string;
    readonly systems: string[] = [];
    readonly sent: Message[][] = [];
    private readonly turns: string[];
    private readonly onCheckin: () => string;
    private readonly onTimer: (event: string) => string;
    private readonly usage: Partial<CompletionResult>;

    constructor(opts: {
        turns: string[];
        onCheckin?: () => string;
        onTimer?: (event: string) => string;
        model?: string;
        usage?: Partial<CompletionResult>;
    }) {
        this.turns = [...opts.turns];
        this.onCheckin = opts.onCheckin ?? (() => '[PASS]');
        this.onTimer = opts.onTimer ?? (() => 'Our time is up.');
        this.model = opts.model ?? 'scripted';
        this.usage = opts.usage ?? {};
    }

    async complete(messages: Message[], options?: CompletionOptions): Promise<CompletionResult> {
        this.systems.push(options?.system ?? '');
        this.sent.push(messages);
        const last = messages[messages.length - 1]?.content ?? '';
        if (last.trimStart().startsWith('[Check-in:')) return completion(this.onCheckin(), this.usage);
        if (last.trimStart().startsWith('[Timer:')) return completion(this.onTimer(last), this.usage);
        return completion(this.turns.shift() ?? 'Mm. Stay with that.', this.usage);
    }
}

const FRIGHTENED = /\b(scared|frightened|disappearing|not real)\b/i;

/**
 * Yes/no classifier stub, answering per classifier (told apart by system
 * prompt). Defaults: resume and hold-confirm on assent words, trouble on fear
 * words, re-hold never.
 */
function utilityBy(rules: {
    resume?: (text: string) => boolean;
    trouble?: (text: string) => boolean;
    confirm?: (text: string) => boolean;
} = {}): LLMProvider {
    const assent = (text: string): boolean => /\b(yes|yeah|ready|continue|back)\b/i.test(text);
    return {
        model: 'utility-stub',
        async complete(messages: Message[], options?: CompletionOptions): Promise<CompletionResult> {
            const text = (messages[messages.length - 1]?.content ?? '').replace(/^"|" ->$/g, '');
            const system = options?.system ?? '';
            const yes =
                system === TROUBLE_SYSTEM_PROMPT
                    ? (rules.trouble ?? ((t) => FRIGHTENED.test(t)))(text)
                    : system === RESUME_INTENT_SYSTEM_PROMPT
                      ? (rules.resume ?? assent)(text)
                      : system === HOLD_REQUEST_SYSTEM_PROMPT
                        ? false
                        : (rules.confirm ?? assent)(text);
            return completion(yes ? 'YES' : 'NO', { inputTokens: 40, outputTokens: 1 });
        },
    };
}

const utilityStub = utilityBy();

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

describe('imperative-rate check', () => {
    it('warns on command-heavy replies at low guidance, and ignores invitations', async () => {
        const facilitator = new ScriptedFacilitator({
            turns: [
                // Five imperative openings across two turns...
                'Notice the breath. Take a moment here. Let it settle. Bring attention to the chest.',
                'Focus on that warmth. Is there anything else present?',
                // ...while invitations, questions, and "Let's" don't count.
                "Let's stay here. You might notice some tingling. What's that like?",
            ],
        });
        const sim = new ScriptedSimUser([
            { waitSec: 10, text: 'okay' },
            { waitSec: 10, text: 'some warmth I think' },
            { waitSec: 10, end: true },
        ]);
        const result = await runSoakSession({
            scenario: { ...baseScenario, directiveness: 2 },
            facilitator,
            utility: utilityStub,
            simUser: sim,
        });
        const finding = runChecks(result).find((f) => f.id === 'imperative-heavy');
        expect(finding?.level).toBe('warn');
        expect(finding?.detail).toContain('5/');
        // The same transcript at high guidance is the requested style: info only.
        const high = runChecks({ ...result, scenario: { ...baseScenario, directiveness: 4 } });
        expect(high.find((f) => f.id === 'imperative-heavy')).toBeUndefined();
        expect(high.find((f) => f.id === 'imperative-rate')?.level).toBe('info');
    });
});

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

    it('takes the speech a model put on the WAIT line, with or without a number', () => {
        expect(parseSimReply('WAIT: Yes, please be quiet.')).toMatchObject({ waitSec: 60, text: 'Yes, please be quiet.' });
        expect(parseSimReply('WAIT: 30 Yes, please.')).toMatchObject({ waitSec: 30, text: 'Yes, please.' });
        expect(parseSimReply('WAIT: 90 seconds')).toMatchObject({ waitSec: 90, text: null });
        expect(parseSimReply('WAIT:\nhm').text).toBe('hm');
    });

    it('reads a placeholder for silence as silence (Haiku 5.5 wrote "EOF")', () => {
        expect(parseSimReply('WAIT: 840\nEOF_PLACEHOLDER').text).toBeNull();
        expect(parseSimReply('WAIT: 480\nEOF').text).toBeNull();
        expect(parseSimReply('WAIT: 480\nOK').text).toBe('OK');
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

    it('withdraws an unanswered hold offer once a check-in is spoken', async () => {
        const facilitator = new ScriptedFacilitator({
            turns: [
                'Take a breath. What do you notice?',
                '[HOLD] Would you like me to be quiet for a while?',
                'Good. What is here now?',
            ],
        });
        const sim = new ScriptedSimUser([
            { waitSec: 30, text: 'could we have some quiet for a bit' },
            // Says nothing to the offer; the wait ends when the check-in speaks.
            { waitSec: 900 },
            { waitSec: 10, text: 'yes, still here' },
            { waitSec: 30, end: true },
        ]);
        const result = await runSoakSession({
            scenario: { ...baseScenario, checkinTiming: 'fixed', checkinContent: 'canned' },
            facilitator,
            utility: utilityStub,
            simUser: sim,
        });

        expect(result.error).toBeUndefined();
        const eventKeys = result.events.map((e) => `${e.kind}:${e.detail}`);
        expect(eventKeys).toContain('signal:hold-bid');
        expect(eventKeys).toContain('checkin:canned');
        expect(eventKeys).not.toContain('hold:enter');
        expect(result.finalState.silenceMode).toBe(false);
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
        // ...both went back to listening, as the view does since 9a673f88, and
        // neither is an error...
        const eventKeys = result.events.map((e) => `${e.kind}:${e.detail}`);
        expect(eventKeys.filter((k) => k === 'signal:signal-only-reply')).toHaveLength(2);
        expect(eventKeys.filter((k) => k.startsWith('error:'))).toEqual([]);
        // ...the [WAIT] still landed, because the intent is legible even when
        // there are no words with it...
        expect(eventKeys).toContain('signal:wait');
        // ...and the bare [HOLD] never armed the handshake or entered silence.
        expect(result.finalState.awaitingHoldConfirm).toBe(false);
        expect(eventKeys).not.toContain('hold:enter');
        // The soak checks for blank turns stay quiet; the count is context.
        const findings = runChecks(result);
        expect(findings.filter((f) => ['empty-spoken-turn', 'turn-error', 'empty-reply'].includes(f.id))).toEqual([]);
        expect(findings.find((f) => f.id === 'signal-only-reply')?.level).toBe('info');
    });

    it('counts a blank completion as a warning, not an engine failure', async () => {
        const facilitator = new ScriptedFacilitator({ turns: ['Settle in.', '', '', 'Mm.'] });
        const sim = new ScriptedSimUser([
            { waitSec: 30, text: 'my shoulders feel tight' },
            { waitSec: 30, text: 'and my jaw' },
            { waitSec: 30, text: 'that is it' },
            { waitSec: 30, end: true },
        ]);
        const result = await runSoakSession({ scenario: baseScenario, facilitator, utility: utilityStub, simUser: sim });
        const findings = runChecks(result);
        expect(findings.find((f) => f.id === 'empty-reply')).toMatchObject({
            level: 'warn',
            detail: '2 of 3 facilitator replies came back blank',
        });
        expect(findings.filter((f) => f.id === 'turn-error')).toEqual([]);
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

// ---- Scenarios aimed at open bugs, and the checks that key on them --------

const eventKeys = (r: SessionRunResult): string[] => r.events.map((e) => `${e.kind}:${e.detail}`);
const scenario = (id: string): Scenario => getScenarios([id])[0] as Scenario;

/** A minimal finished session, for the judge and report tests. */
function fakeResult(over: Partial<SessionRunResult> = {}): SessionRunResult {
    return {
        scenario: baseScenario,
        runIndex: 0,
        startedAt: '2026-11-22T00:00:00.000Z',
        facilitatorModel: 'claude-sonnet-5-5',
        fakeDurationSec: 600,
        transcript: [{ at: 0, role: 'assistant', kind: 'opener', text: 'Settle in.', raw: 'Settle in.' }],
        events: [],
        calls: [],
        endedBy: 'duration',
        finalState: { silenceMode: false, awaitingHoldConfirm: false },
        ...over,
    };
}

describe('sim line transform', () => {
    it('hands a line over the way Chrome Web Speech does', () => {
        expect(asWebSpeech("I'm back, it was a lot of tingling and it settled now.")).toBe(
            "I'm back it was a lot of tingling and it settled now"
        );
        expect(asWebSpeech('Okay. So, I think... my jaw - it’s tight! I told Sarah.')).toBe(
            "Okay so I think my jaw it's tight I told Sarah"
        );
        expect(asWebSpeech('我感觉，有点紧。')).toBe('我感觉有点紧');
    });

    it('cuts chosen lines to a short tail, the same way every run', () => {
        const line = "I just don't know if I can keep doing all of this anymore.";
        const tail = trailingFragment(line, 7, 2);
        expect(trailingFragment(line, 7, 2)).toBe(tail);
        expect(line.endsWith(tail)).toBe(true);
        expect(tail.split(' ').length).toBeLessThanOrEqual(3);
        expect(trailingFragment('anymore.', 7, 2)).toBe('anymore.');
        const cut = { cut: { turns: [2], seed: 7 } };
        expect(transformLine(line, cut, 1)).toEqual({ text: line, cut: false });
        expect(transformLine(line, cut, 2)).toEqual({ text: tail, cut: true });
    });

    it('keeps what the sim said beside what the engine was given', async () => {
        const sim = new ScriptedSimUser([
            { waitSec: 30, text: 'Hm. My shoulders are tight, I think.' },
            { waitSec: 30, end: true },
        ]);
        const result = await runSoakSession({
            scenario: { ...baseScenario, transform: { recognizer: 'web-speech' } },
            facilitator: new ScriptedFacilitator({ turns: ['Settle in.', 'Where is it tightest?'] }),
            utility: utilityStub,
            simUser: sim,
        });
        const turn = result.transcript.find((t) => t.kind === 'user');
        expect(turn).toMatchObject({ text: 'Hm my shoulders are tight I think', said: 'Hm. My shoulders are tight, I think.' });
        expect(turn?.cut).toBeUndefined();
        // The meditator remembers their own words.
        expect(sim.views[1]?.transcript.find((t) => t.who === 'you')?.text).toBe('Hm. My shoulders are tight, I think.');
    });
});

describe('back from a hold in one breath (meditation-pal-kbec)', () => {
    const run = (back: string, resume: (text: string) => boolean = () => false) => {
        const resumeAsked: string[] = [];
        const utility = utilityBy({
            resume: (t) => {
                resumeAsked.push(t);
                return resume(t);
            },
        });
        return runSoakSession({
            scenario: scenario('back-in-hold'),
            facilitator: new ScriptedFacilitator({
                turns: ['Settle in.', '[HOLD] Would you like me to be quiet for a while?', 'Welcome back. What was it like?'],
            }),
            utility,
            simUser: new ScriptedSimUser([
                { waitSec: 60, text: 'Could I have some quiet for a while?' },
                { waitSec: 10, text: 'Yes, please.' },
                { waitSec: 300, text: 'Lots of tingling.' },
                { waitSec: 300, text: back },
                { waitSec: 30, end: true },
            ]),
        }).then((result) => ({ result, resumeAsked }));
    };

    it('ends the hold on the words, though the classifier would stay', async () => {
        const { result, resumeAsked } = await run("I'm back, it was a lot of tingling and it settled now.");
        const turn = result.transcript.find((t) => t.text.startsWith("I'm back"));
        expect(turn).toMatchObject({
            text: "I'm back it was a lot of tingling and it settled now",
            said: "I'm back, it was a lot of tingling and it settled now.",
            duringHold: true,
        });
        expect(eventKeys(result)).toContain('hold:exit');
        expect(result.events.find((e) => e.detail === 'resume' && e.data?.utterance === turn?.text)?.data).toMatchObject({
            verdict: 'resume',
            by: 'words',
        });
        // Only the murmur went to the classifier.
        expect(resumeAsked).toEqual(['Lots of tingling']);
        expect(runChecks(result).filter((f) => ['back-in-hold', 'scenario-setup-missed'].includes(f.id))).toEqual([]);
    });

    it('leaves "I\'m back in my body" to the classifier, which keeps the hold', async () => {
        const { result, resumeAsked } = await run("I'm back in my body now.");
        expect(resumeAsked).toEqual(['Lots of tingling', "I'm back in my body now"]);
        expect(eventKeys(result)).not.toContain('hold:exit');
        expect(runChecks(result).find((f) => f.id === 'back-in-hold')).toBeUndefined();
    });

    it('fails a hold that went on through the return', () => {
        // The view as the bead found it: the classifier's stay was the last word.
        const back = "I'm back it was a lot of tingling and it settled now";
        const result = fakeResult({
            scenario: scenario('back-in-hold'),
            transcript: [
                { at: 0, role: 'assistant', kind: 'opener', text: 'Settle in.', raw: 'Settle in.' },
                { at: 400, role: 'user', kind: 'user', text: back, duringHold: true },
                { at: 700, role: 'user', kind: 'user', text: 'still here', duringHold: true },
            ],
            events: [{ at: 400, kind: 'classifier', detail: 'resume', data: { verdict: 'stay', utterance: back } }],
            finalState: { silenceMode: true, awaitingHoldConfirm: false },
        });
        expect(runChecks(result).find((f) => f.id === 'back-in-hold')?.level).toBe('fail');
    });

    it('warns when the session never got there', async () => {
        const result = await runSoakSession({
            scenario: scenario('back-in-hold'),
            facilitator: new ScriptedFacilitator({ turns: ['Settle in.'] }),
            utility: utilityStub,
            simUser: new ScriptedSimUser([{ waitSec: 30, text: 'just sitting' }, { waitSec: 30, end: true }]),
        });
        expect(runChecks(result).find((f) => f.id === 'scenario-setup-missed')?.level).toBe('warn');
    });
});

describe('frightened inside a hold (meditation-pal-59eg)', () => {
    const sim = () =>
        new ScriptedSimUser([
            { waitSec: 60, text: 'Could I have some quiet for a while?' },
            { waitSec: 10, text: 'Yes.' },
            { waitSec: 200, text: 'Things feel far away and floaty.' },
            { waitSec: 30, text: "I feel like I'm disappearing and it's scaring me." },
            { waitSec: 30, end: true },
        ]);
    const turns = ['Settle in.', '[HOLD] Shall I be quiet for a while?', 'I am here. Open your eyes and look around the room.'];

    it('ends the hold and carries the stepping-out note into the reply', async () => {
        const facilitator = new ScriptedFacilitator({ turns });
        // The resume classifier says stay, as it does to a frightened line;
        // the trouble check beside it is what brings the facilitator back.
        const result = await runSoakSession({
            scenario: scenario('fright-in-hold'),
            facilitator,
            utility: utilityBy({ resume: () => false }),
            simUser: sim(),
        });
        expect(eventKeys(result)).toContain('hold:exit');
        expect(result.events.some((e) => e.detail === 'stepping-out' && e.data?.when === 'before-reply')).toBe(true);
        expect((facilitator.sent.at(-1) ?? []).some((m) => m.content.includes(STEPPING_OUT_NOTE))).toBe(true);
        expect(runChecks(result).filter((f) => ['fright-in-hold', 'scenario-setup-missed'].includes(f.id))).toEqual([]);
    });

    it('fails when the frightened line is left in silence, as before the fix', async () => {
        const result = await runSoakSession({
            scenario: scenario('fright-in-hold'),
            facilitator: new ScriptedFacilitator({ turns }),
            utility: utilityBy({ resume: () => false, trouble: () => false }),
            simUser: sim(),
        });
        const finding = runChecks(result).find((f) => f.id === 'fright-in-hold');
        expect(finding?.level).toBe('fail');
        expect(finding?.detail).toContain('disappearing');
    });

    it('drops a silence bid made in answer to someone in trouble', async () => {
        const result = await runSoakSession({
            scenario: baseScenario,
            facilitator: new ScriptedFacilitator({
                turns: ['Settle in.', '[HOLD] Are you safe right now?', 'Okay. Keep talking with me.'],
            }),
            utility: utilityStub,
            simUser: new ScriptedSimUser([
                { waitSec: 30, text: "Nothing feels real and I'm scared." },
                { waitSec: 10, text: 'Yes.' },
                { waitSec: 30, end: true },
            ]),
        });
        expect(eventKeys(result)).toContain('signal:hold-bid-ignored');
        expect(result.events.some((e) => e.detail === 'stepping-out' && e.data?.when === 'hold-bid-dropped')).toBe(true);
        expect(eventKeys(result)).not.toContain('hold:enter');
        expect(result.finalState.awaitingHoldConfirm).toBe(false);
    });
});

describe('a turn cut to its tail (meditation-pal-rlgm)', () => {
    const lines = [
        'Work has been a lot lately and I keep thinking about it at night.',
        "I just don't know if I can keep doing all of this anymore.",
        'My chest is tight right now.',
        'It has been like that for a while now I guess.',
    ];
    const run = (replyToFragment: string) =>
        runSoakSession({
            scenario: scenario('fragment'),
            facilitator: new ScriptedFacilitator({
                turns: ['Settle in.', 'What is that like?', replyToFragment, 'Mm.', 'Say more.'],
            }),
            utility: utilityStub,
            simUser: new ScriptedSimUser([...lines.map((text) => ({ waitSec: 30, text })), { waitSec: 30, end: true }]),
        });

    it('fails when the fragment draws a [HOLD] bid', async () => {
        const result = await run("[HOLD] I'll be right here.");
        const cut = result.transcript.filter((t) => t.cut);
        expect(cut.map((t) => t.said)).toEqual([lines[1], lines[3]]);
        expect(cut.every((t) => t.said?.endsWith(t.text))).toBe(true);
        expect(runChecks(result).find((f) => f.id === 'fragment-hold-bid')?.level).toBe('fail');
    });

    it('passes when the fragment gets an ordinary reply', async () => {
        const result = await run('Mm. What is here now?');
        expect(runChecks(result).filter((f) => ['fragment-hold-bid', 'scenario-setup-missed'].includes(f.id))).toEqual([]);
    });
});

describe('a 中文 session', () => {
    const sim = () =>
        new ScriptedSimUser([
            { waitSec: 60, text: '我想安静一会儿。' },
            { waitSec: 10, text: '好的。' },
            { waitSec: 300, text: '我回来了，肩膀松了一些。' },
            { waitSec: 30, end: true },
        ]);
    const utility = utilityBy({ confirm: (t) => /好/.test(t), resume: (t) => /回来/.test(t) });

    it('puts the zh fragment in the prompt and still reads the control tokens', async () => {
        const facilitator = new ScriptedFacilitator({
            turns: ['先安顿下来，此刻你注意到了什么？', '[HOLD] 要我安静一会儿吗？', '欢迎回来。刚才有什么？'],
        });
        const result = await runSoakSession({ scenario: scenario('zh'), facilitator, utility, simUser: sim() });
        expect(facilitator.systems[0]).toContain(ZH_LANGUAGE_FRAGMENT);
        expect(eventKeys(result)).toEqual(expect.arrayContaining(['signal:hold-bid', 'hold:enter', 'hold:exit']));
        const findings = runChecks(result);
        expect(findings.filter((f) => ['wrong-language', 'token-translated'].includes(f.id))).toEqual([]);
        expect(findings.find((f) => f.id === 'language')?.detail).toMatch(/^zh: 3 of 3 model replies in Chinese; [1-9]/);
    });

    it('fails replies in English and a token the model translated', async () => {
        const result = await runSoakSession({
            scenario: scenario('zh'),
            facilitator: new ScriptedFacilitator({
                turns: ['Let us begin. What do you notice?', 'What is that like?', '【保持安静】我在这里。', '嗯，慢慢来。'],
            }),
            utility,
            simUser: sim(),
        });
        const findings = runChecks(result);
        // Half the replies in English: a zh session that did not happen.
        expect(findings.find((f) => f.id === 'wrong-language')).toMatchObject({ level: 'fail' });
        expect(findings.find((f) => f.id === 'wrong-language')?.detail).toMatch(/^2 of 4/);
        expect(findings.find((f) => f.id === 'token-translated')?.level).toBe('fail');
    });

    it('leaves an English session alone', async () => {
        const result = await runSoakSession({
            scenario: baseScenario,
            facilitator: new ScriptedFacilitator({ turns: ['Settle in.'] }),
            utility: utilityStub,
            simUser: new ScriptedSimUser([{ waitSec: 30, text: 'okay' }, { waitSec: 30, end: true }]),
        });
        expect(runChecks(result).filter((f) => ['wrong-language', 'language', 'token-translated'].includes(f.id))).toEqual([]);
    });
});

describe('reasoning spoken aloud (meditation-pal-dqti)', () => {
    const run = (reply: string) =>
        runSoakSession({
            scenario: baseScenario,
            facilitator: new ScriptedFacilitator({ turns: ['Settle in.', reply] }),
            utility: utilityStub,
            simUser: new ScriptedSimUser([{ waitSec: 30, text: 'my hands feel far away' }, { waitSec: 30, end: true }]),
        });

    it('withholds a reply about the meditator in the third person, as a blank one', async () => {
        const result = await run(
            'The user is describing dissociation - feeling disconnected from their body. I should: ground them first.'
        );
        expect(result.transcript.filter((t) => t.role === 'assistant').map((t) => t.kind)).toEqual(['opener']);
        expect(eventKeys(result)).toContain('error:empty-reply');
        const findings = runChecks(result);
        expect(findings.find((f) => f.id === 'reasoning-withheld')?.level).toBe('warn');
        expect(findings.filter((f) => ['reasoning-aloud', 'empty-reply', 'signal-only-reply', 'empty-spoken-turn'].includes(f.id))).toEqual([]);
    });

    it('speaks what follows a lone closing tag, and nothing before it', async () => {
        const result = await run('The user is describing fear. I should acknowledge it.</think>What is that fear like?');
        expect(result.transcript.at(-1)).toMatchObject({ role: 'assistant', text: 'What is that fear like?' });
        expect(runChecks(result).filter((f) => f.id.startsWith('reasoning'))).toEqual([]);
    });

    it('fails a spoken line that reads as reasoning (the engine let it through)', () => {
        const result = fakeResult({
            transcript: [
                { at: 0, role: 'assistant', kind: 'reply', text: 'The user wants a brief opening.', raw: 'x' },
            ],
        });
        expect(runChecks(result).find((f) => f.id === 'reasoning-aloud')?.level).toBe('fail');
    });

    it('stays quiet on a reply spoken to them, someone else included', async () => {
        const result = await run('Is there a person you trust who could be with you? Your sister, maybe - they could come over.');
        expect(runChecks(result).filter((f) => f.id.startsWith('reasoning'))).toEqual([]);
    });
});

describe('usage per call', () => {
    it('records model and tokens on each call and leaves out what was not reported', async () => {
        const result = await runSoakSession({
            scenario: baseScenario,
            facilitator: new ScriptedFacilitator({
                turns: ['Settle in.', '[HOLD] Shall I be quiet?'],
                model: 'claude-sonnet-5-5',
                usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000, cacheCreationTokens: null },
            }),
            utility: utilityStub,
            simUser: new ScriptedSimUser([{ waitSec: 30, text: 'some quiet please' }, { waitSec: 30, end: true }]),
        });
        const turn = result.calls.find((c) => c.kind === 'turn');
        expect(turn).toMatchObject({ model: 'claude-sonnet-5-5', inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000 });
        expect(turn && 'cacheCreationTokens' in turn).toBe(false);
        // The hold bid's trouble check ran on the utility model.
        expect(result.calls.find((c) => c.kind === 'classify-trouble')).toMatchObject({ model: 'utility-stub', inputTokens: 40 });
        // The scripted sim reports nothing, so its calls say nothing.
        expect(result.calls.find((c) => c.kind === 'sim-user')).not.toHaveProperty('inputTokens');

        const facilitatorCalls = result.calls.filter((c) => c.kind === 'opener' || c.kind === 'turn');
        const t = totalUsage(facilitatorCalls);
        expect(t).toMatchObject({ calls: 2, reported: 2, inputTokens: 2000, cacheReadTokens: 10000, unpriced: 0 });
        expect(cachedShare(t)).toBeCloseTo(10000 / 12000);
        const one = callCostUsd('claude-sonnet-5-5', { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 5000 });
        expect(t.costUsd).toBeCloseTo(2 * (one ?? NaN), 12);
    });

    it('prices only what the hosted table sells, and only what was reported', () => {
        expect(callCostUsd('claude-sonnet-5-5', { inputTokens: 1000, outputTokens: 100 })).toBeGreaterThan(0);
        expect(callCostUsd('qwen3.5:4b', { inputTokens: 1000 })).toBeNull();
        expect(callCostUsd('claude-sonnet-5-5', {})).toBeNull();
        expect(totalUsage([{ model: 'qwen3.5:4b', inputTokens: 10 }]).unpriced).toBe(1);
    });
});

// ---- Several judges --------------------------------------------------------

function scriptedJudge(model: string, scores: number[], fail = false) {
    let i = 0;
    const provider: LLMProvider = {
        model,
        async complete(): Promise<CompletionResult> {
            if (fail) throw new Error('judge down');
            const overall = scores[i++ % scores.length];
            return completion(
                JSON.stringify({ overall, dimensions: { tone: overall }, wince_moments: [{ quote: 'Mm.', why: 'thin' }], notes: 'ok' }),
                { inputTokens: 3000, outputTokens: 400 }
            );
        },
    };
    return { model, provider };
}

const META: RunMeta = {
    startedAt: '2026-11-22T00:00:00.000Z',
    tier: 'headless',
    cast: {
        facilitators: [{ spec: 'anthropic', model: 'claude-sonnet-5-5' }],
        user: { spec: 'anthropic:claude-haiku-5-5', model: 'claude-haiku-5-5' },
        utility: { spec: 'anthropic:claude-haiku-5-5', model: 'claude-haiku-5-5' },
        judge: { spec: 'openai:gpt-6-sol', model: 'gpt-6-sol' },
        judges: [
            { spec: 'openai:gpt-6-sol', model: 'gpt-6-sol' },
            { spec: 'anthropic:claude-opus-5-5', model: 'claude-opus-5-5' },
        ],
    },
    collisions: [],
    wallClockMs: 1000,
    claudeVia: 'subscription',
    judgeRepeats: 3,
    gitSha: 'abcdef1234567890abcdef1234567890abcdef12',
    gitDirty: true,
};

describe('several judges', () => {
    it('keeps every verdict, first judge first, and the first verdict as `judge`', async () => {
        const out = await runJudges([scriptedJudge('gpt-6-sol', [7, 8, 6]), scriptedJudge('claude-opus-5-5', [9])], 3, fakeResult());
        expect(out.judge?.overall).toBe(7);
        expect(out.judgeRuns?.map((j) => `${j.judgeModel}:${j.verdict.overall}`)).toEqual([
            'gpt-6-sol:7',
            'gpt-6-sol:8',
            'gpt-6-sol:6',
            'claude-opus-5-5:9',
            'claude-opus-5-5:9',
            'claude-opus-5-5:9',
        ]);
        expect(out.judgeRuns?.[0]).toMatchObject({ inputTokens: 3000, outputTokens: 400 });
        expect(out.judgeRunErrors).toBeUndefined();
    });

    it('records a judge that failed without losing the others', async () => {
        const out = await runJudges([scriptedJudge('gpt-6-sol', [7], true), scriptedJudge('claude-opus-5-5', [9])], 1, fakeResult());
        expect(out.judge).toBeUndefined();
        expect(out.judgeError).toBe('judge down');
        expect(out.judgeRuns?.map((j) => j.judgeModel)).toEqual(['claude-opus-5-5']);
        expect(out.judgeRunErrors).toEqual([{ judgeModel: 'gpt-6-sol', error: 'judge down' }]);
    });

    it('reports each judge apart with its spread, never averaged together', async () => {
        const report: SessionReport = {
            result: fakeResult(),
            findings: [],
            ...(await runJudges([scriptedJudge('gpt-6-sol', [7, 8, 6]), scriptedJudge('claude-opus-5-5', [9])], 3, fakeResult())),
        };
        const md = buildReportMd(META, [report]);
        const header = md.slice(0, md.indexOf('## Scores'));
        expect(header).toContain('`gpt-6-sol` **7.0**');
        expect(header).toContain('`claude-opus-5-5` **9.0**');
        expect(header).not.toContain('8.0'); // the two judges' mean, which must never appear
        expect(header).toContain('`abcdef12` + uncommitted changes');
        const scores = md.slice(md.indexOf('## Scores'), md.indexOf('## Wince moments'));
        expect(scores).toContain('| gpt-6-sol | claude-opus-5-5 |');
        expect(scores).toContain('7.0 (6–8)');
        // Opus judging Sonnet is a same-family cell: marked, not forbidden.
        expect(scores).toContain('9.0 †');
        const spread = md.slice(md.indexOf('## Judge spread'), md.indexOf('## Tokens and cost'));
        expect(spread).toMatch(/\| gpt-6-sol \| 1 \| 3 \| 2\.0 \| 2\.0 \|/);
        expect(spread).toContain('mean gap 2.0');
        // One wince list per judge, not one per repeat.
        expect(md.match(/"Mm\."/g)).toHaveLength(2);
    });
});

describe('tokens in the report', () => {
    it('says not reported rather than zero, and marks the subscription', () => {
        const silent = fakeResult({ calls: [{ kind: 'turn', latencyMs: 5, model: 'claude-sonnet-5-5' }] });
        const md = buildReportMd(META, [{ result: silent, findings: [] }]);
        expect(md).toContain('## Tokens and cost');
        expect(md).toContain('not reported');

        const counted = fakeResult({
            calls: [{ kind: 'turn', latencyMs: 5, model: 'claude-sonnet-5-5', inputTokens: 100, outputTokens: 20, cacheReadTokens: 900 }],
        });
        const md2 = buildReportMd(META, [{ result: counted, findings: [] }]);
        expect(md2).toContain('claude-sonnet-5-5 ‡');
        expect(md2).toContain('90%');
        expect(md2).toContain('Fake clock');
    });

    it('stays out of a report whose calls carry no usage at all', () => {
        const md = buildReportMd(META, [{ result: fakeResult({ calls: [{ kind: 'turn', latencyMs: 5 }] }), findings: [] }]);
        expect(md).not.toContain('## Tokens and cost');
    });
});

// ---- An hour, and what holds it together (rubric dimension 12) ------------

describe('the hour scenario', () => {
    const lines = {
        stone: "There's a heaviness in the middle of my chest, like a smooth stone sitting in a riverbed.",
        mira: "My daughter Mira gets home at four, and I don't want to hand her this rush.",
        door: 'I spend my whole day holding the door for everyone.',
        stoneCue: 'The heavy thing in my chest is back, and something is flowing around it now.',
        doorCue: 'Part of me is already making a list of everything everyone needs from me tonight.',
        miraCue: "I think I'm nearly done. I want to take some of this quiet with me into the afternoon.",
    };
    /** `followUp`: a meditator line and the facilitator's answer to it,
     *  slipped in right after the stone's cue and its reply. */
    const run = (replyToStoneCue: string, followUp?: { says: string; reply: string }) =>
        runSoakSession({
            scenario: scenario('hour'),
            facilitator: new ScriptedFacilitator({
                turns: [
                    'Whenever you are ready.',
                    'A stone in a riverbed.',
                    'Mm.',
                    'Holding the door.',
                    '[HOLD] Shall I be quiet for a while?',
                    'Soft and slow.',
                    'Warm hands.',
                    replyToStoneCue,
                    ...(followUp ? [followUp.reply] : []),
                    'A list.',
                    'Into the afternoon, and Mira at four.',
                ],
            }),
            utility: utilityStub,
            simUser: new ScriptedSimUser([
                { waitSec: 120, text: lines.stone },
                { waitSec: 120, text: lines.mira },
                { waitSec: 120, text: lines.door },
                { waitSec: 300, text: 'Could I have some quiet for a while?' },
                { waitSec: 10, text: 'Yes, please.' },
                { waitSec: 900 },
                { waitSec: 300, text: "I'm back. It was soft and slow." },
                { waitSec: 600, text: 'My hands are warm.' },
                { waitSec: 500, text: lines.stoneCue },
                ...(followUp ? [{ waitSec: 60, text: followUp.says }] : []),
                { waitSec: 240, text: lines.doorCue },
                { waitSec: 240, text: lines.miraCue },
                { waitSec: 30, end: true },
            ]),
        });

    it('is opt-in: left out of "all", so out of every battery', () => {
        expect(getScenarios('all').map((s) => s.id)).not.toContain('hour');
        expect(scenario('hour')).toMatchObject({ fakeMinutes: 60, verbosity: 'low', directiveness: 2, optIn: true });
    });

    it('runs an hour of talk and quiet on the fake clock and finds the early material after its cue', async () => {
        const result = await run('The stone, with something flowing around it?');
        expect(result.endedBy).toBe('sim-end');
        expect(result.fakeDurationSec).toBeGreaterThan(50 * 60);
        expect(eventKeys(result)).toEqual(expect.arrayContaining(['hold:enter', 'hold:exit']));

        const style = sessionStyle(result);
        expect(style.callbacks).toEqual([
            { id: 'stone', saidEarly: true, cued: true, echoedAfter: 1, meditatorFirst: false },
            { id: 'Mira', saidEarly: true, cued: true, echoedAfter: 1, meditatorFirst: false },
            { id: 'door', saidEarly: true, cued: true, echoedAfter: null, meditatorFirst: false },
        ]);
        const callbacks = runChecks(result).filter((f) => f.id === 'callback');
        expect(callbacks.every((f) => f.level === 'info')).toBe(true);
        expect(callbacks.find((f) => f.detail.startsWith('stone:'))?.detail).toMatch(/back in facilitator line 1 after the cue/);
        expect(callbacks.find((f) => f.detail.startsWith('door:'))?.detail).toMatch(/not in any of the \d+ facilitator lines after the cue/);
        expect(runChecks(result).find((f) => f.id === 'scenario-setup-missed')).toBeUndefined();
    });

    it('reports the stone not back when the reply to its cue leaves it out', async () => {
        const result = await run('Something flowing.');
        expect(sessionStyle(result).callbacks?.[0]).toEqual({
            id: 'stone',
            saidEarly: true,
            cued: true,
            echoedAfter: null,
            meditatorFirst: false,
        });
    });

    it('does not credit an echo of the word the meditator said again first', async () => {
        const result = await run('What is the flowing like?', {
            says: 'A slow current, moving around the stone.',
            reply: 'The stone and the current.',
        });
        expect(sessionStyle(result).callbacks?.[0]).toMatchObject({ id: 'stone', echoedAfter: null, meditatorFirst: true });
        expect(runChecks(result).find((f) => f.detail.startsWith('stone:'))?.detail).toMatch(/the meditator said it again/);
    });

    it('warns when the meditator never set the material up', async () => {
        const result = await runSoakSession({
            scenario: scenario('hour'),
            facilitator: new ScriptedFacilitator({ turns: ['Whenever you are ready.'] }),
            utility: utilityStub,
            simUser: new ScriptedSimUser([{ waitSec: 120, text: lines.stone }, { waitSec: 30, end: true }]),
        });
        const missed = runChecks(result).find((f) => f.id === 'scenario-setup-missed');
        expect(missed?.level).toBe('warn');
        expect(missed?.detail).toMatch(/stone \(no late cue\).*Mira \(never said early\)/);
    });
});

describe('style counts', () => {
    const reply = (at: number, text: string) => ({ at, role: 'assistant' as const, kind: 'reply' as const, text, raw: text });

    it('counts questions, the repeated opening, and length in the first and last third', () => {
        const style = sessionStyle(
            fakeResult({
                fakeDurationSec: 900,
                transcript: [
                    { at: 0, role: 'assistant', kind: 'opener', text: 'What is here?', raw: 'What is here?' },
                    reply(100, "What's that like?"),
                    reply(200, "What's that like now?"),
                    reply(400, 'Mm.'),
                    { at: 500, role: 'assistant', kind: 'checkin', text: 'Still here?' },
                    reply(700, "What's that like for you, right now, in the chest?"),
                    reply(800, 'Stay with the warmth.'),
                ],
            })
        );
        expect(style).toEqual({
            replies: 5,
            questionShare: 3 / 5,
            topOpening: { words: "what's that like", count: 3 },
            medianWordsFirstThird: 3.5,
            medianWordsLastThird: 7,
        });
        expect(endsInQuestion('你现在注意到了什么？')).toBe(true);
    });

    it('has nothing to count in a session without replies', () => {
        expect(sessionStyle(fakeResult())).toEqual({
            replies: 0,
            questionShare: null,
            topOpening: null,
            medianWordsFirstThird: null,
            medianWordsLastThird: null,
        });
    });
});

describe('holds the session, in the judge', () => {
    const judgeSaying = (holds: number) => {
        const systems: string[] = [];
        const provider: LLMProvider = {
            model: 'gpt-5.5',
            async complete(_m: Message[], options?: CompletionOptions): Promise<CompletionResult> {
                systems.push(options?.system ?? '');
                return completion(
                    JSON.stringify({
                        overall: 7,
                        dimensions: { tone: 8, holds_session: holds },
                        wince_moments: [],
                        holds_session_moments: [{ quote: 'The stone?', why: 'minute 38: their image, back when it mattered' }],
                        notes: 'ok',
                    })
                );
            },
        };
        return { provider, systems };
    };

    it('reads dimension 12 from the eval rubric, so Alex edits one file', () => {
        expect(holdsSessionRubric()).toMatch(/minute fifty/);
        expect(holdsSessionRubric('# R\n### 12. Holds\n\nKeep it.\n\n---\n')).toBe('Keep it.');
        expect(() => holdsSessionRubric('# R\n### 11. Other\n')).toThrow(/no "### 12\." section/);
    });

    it('parses the score and its quoted moments', () => {
        const v = parseJudgeReply(
            '{"overall": 7, "dimensions": {"holds_session": 6}, "wince_moments": [], "holds_session_moments": [{"quote": "The stone?", "why": "minute 38"}], "notes": ""}'
        );
        expect(v.dimensions.holds_session).toBe(6);
        expect(v.holdsMoments).toEqual([{ quote: 'The stone?', why: 'minute 38' }]);
        expect(parseJudgeReply('{"overall": 7, "dimensions": {}, "notes": ""}').holdsMoments).toBeUndefined();
    });

    it('keeps the score on a long sit and drops one the judge gave a short sit anyway', async () => {
        const long = judgeSaying(9);
        const hour = await judgeSessionRun(long.provider, fakeResult({ fakeDurationSec: 55 * 60, scenario: scenario('hour') }));
        expect(hour.verdict.dimensions.holds_session).toBe(9);
        expect(hour.verdict.holdsMoments).toHaveLength(1);
        expect(long.systems[0]).toContain('Keeps the settings and the intention at minute fifty');

        const short = await judgeSessionRun(judgeSaying(9).provider, fakeResult({ fakeDurationSec: 10 * 60 }));
        expect(short.verdict.dimensions.holds_session).toBeNull();
        expect(short.verdict.holdsMoments).toBeUndefined();
    });

    it('puts the settings and the intention in front of the judge', async () => {
        const j = judgeSaying(8);
        const sent: string[] = [];
        const provider: LLMProvider = {
            model: j.provider.model,
            complete: (m, o) => {
                sent.push(m[0]?.content ?? '');
                return j.provider.complete(m, o);
            },
        };
        await judgeSessionRun(provider, fakeResult({ fakeDurationSec: 55 * 60, scenario: scenario('hour') }));
        expect(sent[0]).toContain('guidance level 2/5 (Somewhat following), reply length Brief, focus body sensations');
        expect(sent[0]).toContain('"to stop rushing, just for this hour"');
    });

    it('shows the score with its moments, and the style counts, in the report', () => {
        const result = fakeResult({
            fakeDurationSec: 3600,
            scenario: scenario('hour'),
            transcript: [
                { at: 0, role: 'assistant', kind: 'opener', text: 'Whenever you are ready.', raw: 'x' },
                { at: 120, role: 'user', kind: 'user', text: 'like a smooth stone sitting in a riverbed' },
                { at: 200, role: 'assistant', kind: 'reply', text: 'A stone?', raw: 'A stone?' },
            ],
        });
        const verdict = parseJudgeReply(
            '{"overall": 8, "dimensions": {"holds_session": 7}, "wince_moments": [], "holds_session_moments": [{"quote": "A stone?", "why": "minute 3"}], "notes": ""}'
        );
        const md = buildReportMd(
            { ...META, cast: { ...META.cast, judges: [{ spec: 'openai:gpt-6-sol', model: 'gpt-6-sol' }] }, judgeRepeats: 1 },
            [{ result, findings: [], judge: verdict, judgeRuns: [{ judgeModel: 'gpt-6-sol', verdict }], style: sessionStyle(result) }]
        );
        const holds = md.slice(md.indexOf('## Holds the session'), md.indexOf('## Style'));
        expect(holds).toContain('**hour-1** 7/10');
        expect(holds).toContain('"A stone?"');
        const style = md.slice(md.indexOf('## Style'), md.indexOf('## Session detail'));
        expect(style).toContain('| claude-sonnet-5-5 | 1 | 100% | "a stone" ×1 | 2 → — |');
        expect(style).toContain('Early material after its late cue, hour-1: stone never set up · Mira never set up · door never set up.');
        expect(md).toContain('| holds |');
    });
});

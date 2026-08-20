/**
 * Headless session engine for the soak harness.
 *
 * Runs the real core (PromptBuilder, SessionManager, PacingController,
 * parseTurnSignals, routeUtterance + the silence classifiers, smart check-ins,
 * StagedModeController, timer events) on a fake clock, wired the way
 * ui/src/views/session.ts wires them - same call order, same guards, same
 * counters - minus DOM, audio, and streaming. When the view's orchestration
 * changes, this file is the place that has to follow; the offline vitest
 * coverage (tests/soak.test.ts) pins the flows that matter.
 *
 * Time: the fake clock advances in POLL_STEP_SEC steps between user turns,
 * checking the timer and the check-in gate at each step exactly like the
 * view's polling intervals do, so a 25-minute sit runs in however long its
 * LLM calls take.
 */

import { createFakeClock } from '../src/clock.js';
import {
    PacingController,
    SessionManager,
    StagedModeController,
    TurnDecision,
    buildSmartCheckinEvent,
    buildTimerApproachEvent,
    buildTimerCompletionEvent,
    classifyHoldConfirm,
    classifyHoldRequest,
    classifyResumeIntent,
    defaultPacingConfig,
    defaultWaitSeconds,
    getMode,
    parseTurnSignals,
    pickTimerFallback,
    PromptBuilder,
    routeUtterance,
    runSmartCheckin,
    SESSION_TIMER_MAX_CHARS,
    timerApproachLeadSec,
    TIMER_APPROACH_FALLBACKS,
    TIMER_CLOSE_FALLBACKS,
    TIMER_COMPLETION_FALLBACKS,
    EXPLORATION_MODE,
    type LlmUsage,
} from '../src/facilitation/index.js';
import type { CompletionResult, LLMProvider } from '../src/llm/index.js';
import type {
    LlmCallStat,
    Scenario,
    SessionEnd,
    SessionRunResult,
    SoakEvent,
    TurnKind,
    TurnRecord,
} from './types.js';
import type { SimUser, SimView } from './sim-user.js';

// Mirrors of the view's private constants (views/session.ts).
const SMART_CHECKIN_MAX_STREAK = 4;
const SMART_CHECKIN_MAX_PASSES = 2;
const TURN_GAP_WINDOW = 4;

/** Fake-clock step between timer/check-in polls, seconds. */
const POLL_STEP_SEC = 5;

/** Rough speech rates, to advance the fake clock past spoken turns. */
const TTS_CHARS_PER_SEC = 14;
const SPEECH_WORDS_PER_SEC = 2.2;

export interface OrchestratorOptions {
    scenario: Scenario;
    runIndex?: number;
    facilitator: LLMProvider;
    /** Cheap model for the yes/no silence classifiers (buildUtilityProvider). */
    utility: LLMProvider;
    simUser: SimUser;
    log?: (line: string) => void;
    /** Real-time cap per session; a hung provider ends the run, not the walk. */
    wallClockCapMs?: number;
}

export async function runSoakSession(opts: OrchestratorOptions): Promise<SessionRunResult> {
    const { scenario, facilitator, utility, simUser } = opts;
    const log = opts.log ?? (() => {});
    const wallCap = opts.wallClockCapMs ?? 10 * 60_000;
    const wallStart = Date.now();

    const mode = getMode(scenario.modeId) ?? EXPLORATION_MODE;
    const directiveness = scenario.directiveness ?? 3;
    const silenceModeEnabled = scenario.silenceModeEnabled ?? true;
    // checkinPaceSlider modes own their check-ins: timing smart, content smart
    // (views/session.ts does the same off SessionSetup.feltSenseCheckins).
    const checkinTiming = mode.checkinPaceSlider ? 'smart' : (scenario.checkinTiming ?? 'smart');
    const checkinContent = mode.checkinPaceSlider ? 'smart' : (scenario.checkinContent ?? 'smart');

    const builder = new PromptBuilder({
        config: {
            focuses: scenario.focuses ?? [],
            qualities: scenario.qualities ?? [],
            directiveness,
            verbosity: scenario.verbosity ?? 'low',
            customInstructions: '',
            waitSignal: checkinTiming === 'smart',
            holdSignal: silenceModeEnabled,
        },
        mode,
    });
    const stager = mode.phases ? new StagedModeController(mode) : null;
    const session = new SessionManager({ contextStrategy: 'full' });
    session.startSession(undefined, mode.id);
    if (stager) session.setModePhase(stager.phase.id);

    const fake = createFakeClock(0);
    const now = (): number => fake.clock();
    const pacing = new PacingController({
        config: {
            ...defaultPacingConfig,
            silenceCheckinSec: scenario.silenceCheckinSec ?? defaultPacingConfig.silenceCheckinSec,
            silenceCheckinsEnabled: checkinTiming !== 'none',
            silenceModeEnabled,
        },
        clock: fake.clock,
    });
    pacing.startSession();
    if (checkinTiming === 'smart') pacing.setCheckinInterval(defaultWaitSeconds(directiveness));

    const transcript: TurnRecord[] = [];
    const events: SoakEvent[] = [];
    const calls: LlmCallStat[] = [];

    // View state mirrored 1:1 (views/session.ts).
    let silenceMode = false;
    let awaitingHoldConfirm = false;
    let leftHoldAt = -Infinity; // fake seconds; -Infinity = never held
    let silenceBuffer: string[] = [];
    let smartCheckinStreak = 0;
    let smartCheckinPasses = 0;
    const turnGaps: number[] = [];
    let lastTurnEnd = 0;

    // Timer, mirroring ui/src/session-clock.ts timerDue semantics.
    const timerTotalSec = scenario.timerMin !== undefined ? scenario.timerMin * 60 : null;
    let approachFired = false;
    let completionFired = false;

    let endedBy: SessionEnd = 'duration';
    let runError: string | undefined;

    const event = (kind: SoakEvent['kind'], detail: string, data?: Record<string, unknown>): void => {
        events.push({ at: now(), ...(data !== undefined ? { data } : {}), kind, detail });
    };
    const mmss = (): string => {
        const t = Math.round(now());
        return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
    };

    function record(role: TurnRecord['role'], kind: TurnKind, text: string, extra: Partial<TurnRecord> = {}): void {
        transcript.push({ at: now(), role, kind, text, ...(silenceMode ? { duringHold: true } : {}), ...extra });
        const who = role === 'assistant' ? 'facilitator' : kind === 'event' ? 'event' : 'meditator';
        log(`${mmss()} ${who}> ${text.length > 100 ? `${text.slice(0, 100)}…` : text}`);
    }

    async function timedComplete(
        kind: string,
        fn: () => Promise<CompletionResult>
    ): Promise<{ result: CompletionResult; latencyMs: number }> {
        const t0 = Date.now();
        const result = await fn();
        const latencyMs = Date.now() - t0;
        calls.push({ kind, latencyMs });
        return { result, latencyMs };
    }

    const usageOf = (r: CompletionResult): LlmUsage => ({
        tokensIn: r.inputTokens ?? null,
        tokensOut: r.outputTokens ?? null,
        cacheRead: r.cacheReadTokens ?? null,
        cacheCreation: r.cacheCreationTokens ?? null,
        cacheCreation1h: r.cacheCreation1hTokens ?? null,
    });

    const speakAdvance = (text: string): void => {
        fake.tick(Math.max(2, text.length / TTS_CHARS_PER_SEC));
    };
    const utteranceAdvance = (text: string): void => {
        fake.tick(Math.max(1, text.split(/\s+/).length / SPEECH_WORDS_PER_SEC));
    };

    function recordTurnGap(): void {
        turnGaps.push(now() - lastTurnEnd);
        if (turnGaps.length > TURN_GAP_WINDOW) turnGaps.shift();
        lastTurnEnd = now();
    }
    function avgTurnSec(): number | null {
        if (turnGaps.length === 0) return null;
        return turnGaps.reduce((a, b) => a + b, 0) / turnGaps.length;
    }

    function enterHold(): void {
        silenceMode = true;
        silenceBuffer = [];
        pacing.enterSilenceMode();
        event('hold', 'enter');
        log(`${mmss()} [hold entered]`);
    }

    /** A facilitator line with no LLM call behind it (respondWithFacilitatorLine). */
    function speakCannedLine(kind: TurnKind, text: string): void {
        session.addAssistantMessage(text);
        record('assistant', kind, text);
        speakAdvance(text);
        pacing.onResponseEnd();
    }

    /** A full facilitation turn (respondTo in the view). */
    async function respondTo(userText: string, opts2: { skipTranscript?: boolean } = {}): Promise<void> {
        pacing.onSpeechEnd();
        pacing.onTranscription(userText);
        smartCheckinStreak = 0;
        smartCheckinPasses = 0;
        const wasSilent = silenceMode;
        if (silenceMode) {
            silenceMode = false;
            leftHoldAt = now();
            event('hold', 'exit');
        }
        if (!opts2.skipTranscript) record('user', 'user', userText);
        utteranceAdvance(userText);
        session.addUserMessage(userText);

        const systemPrompt = builder.buildSystemPrompt(stager?.promptSection());
        let raw: string;
        let latencyMs: number;
        let usage: LlmUsage;
        try {
            const { result, latencyMs: lm } = await timedComplete('turn', () =>
                facilitator.complete(session.getContextMessages(), { system: systemPrompt })
            );
            raw = result.text;
            latencyMs = lm;
            usage = usageOf(result);
        } catch (err) {
            event('error', 'turn-failed', { message: (err as Error).message });
            pacing.onResponseEnd();
            recordTurnGap();
            return;
        }
        const { hold, stage, waitSec, cleanText } = parseTurnSignals(raw);
        if (!raw.trim()) {
            // The view surfaces this as an error toast and records nothing.
            event('error', 'empty-reply');
            pacing.onResponseEnd();
            recordTurnGap();
            return;
        }
        session.addAssistantMessage(cleanText, undefined, usage);
        if (stager && stage !== 'none') {
            const applied = stager.apply(stage);
            if (applied) {
                session.setModePhase(stager.phase.id);
                event('stage', stage, { phase: stager.phase.id });
            } else {
                event('stage', 'clamped', { signal: stage, phase: stager.phase.id });
            }
        }
        if (waitSec !== null) {
            if (checkinTiming === 'smart') {
                pacing.setCheckinInterval(waitSec);
                event('signal', 'wait', { requestedSec: waitSec, effectiveSec: pacing.getCheckinInterval() });
            } else {
                event('signal', 'wait-ignored', { requestedSec: waitSec });
            }
        }
        record('assistant', 'reply', cleanText, { raw, latencyMs });
        speakAdvance(cleanText);
        awaitingHoldConfirm = !wasSilent && hold && silenceModeEnabled;
        if (hold) event('signal', awaitingHoldConfirm ? 'hold-bid' : 'hold-bid-ignored');
        pacing.onResponseEnd();
        recordTurnGap();
    }

    /** respondWithSmartCheckIn, including the canned-content path. */
    async function runCheckin(): Promise<boolean> {
        if (smartCheckinStreak >= SMART_CHECKIN_MAX_STREAK) {
            event('checkin', 'skipped-streak-cap');
            pacing.onResponseEnd();
            return false;
        }
        if (checkinContent === 'canned') {
            smartCheckinStreak++;
            event('checkin', 'canned');
            speakCannedLine('checkin-canned', builder.getCheckInPrompt());
            return true;
        }
        if (smartCheckinPasses >= SMART_CHECKIN_MAX_PASSES) {
            smartCheckinStreak++;
            smartCheckinPasses = 0;
            event('checkin', 'canned-pass-budget');
            speakCannedLine('checkin-canned', builder.getCheckInPrompt());
            return true;
        }
        smartCheckinStreak++;
        const smartTiming = checkinTiming === 'smart';
        const eventText = buildSmartCheckinEvent(pacing.getSilenceDuration(), smartCheckinStreak, {
            withWaitHint: smartTiming,
            directive: directiveness >= 7,
        });
        try {
            const t0 = Date.now();
            const { reply, usage } = await runSmartCheckin(
                facilitator,
                [...session.getContextMessages(), { role: 'user', content: eventText }],
                { system: builder.buildSystemPrompt(stager?.promptSection()) }
            );
            calls.push({ kind: 'checkin', latencyMs: Date.now() - t0 });
            session.recordLlmUsage(usage);
            if (smartTiming && reply.kind !== 'fallback' && reply.waitSec !== null) {
                pacing.setCheckinInterval(reply.waitSec);
                event('signal', 'wait', { requestedSec: reply.waitSec, effectiveSec: pacing.getCheckinInterval() });
            }
            if (reply.kind === 'pass') {
                smartCheckinPasses++;
                event('checkin', 'pass', { streak: smartCheckinStreak });
                log(`${mmss()} [check-in: pass]`);
                pacing.onResponseEnd();
                return false;
            }
            smartCheckinPasses = 0;
            if (reply.kind === 'speak') {
                event('checkin', 'speak', { streak: smartCheckinStreak });
                session.addUserMessage(eventText);
                record('user', 'event', eventText);
                speakCannedLine('checkin', reply.text);
            } else {
                event('checkin', 'fallback', { streak: smartCheckinStreak });
                speakCannedLine('checkin-canned', builder.getCheckInPrompt());
            }
            return true;
        } catch (err) {
            event('checkin', 'error-fallback', { message: (err as Error).message });
            speakCannedLine('checkin-canned', builder.getCheckInPrompt());
            return true;
        }
    }

    /** respondWithTimerNotice: approach may pass, completion may not. */
    async function runTimerNotice(
        kind: 'approach' | 'completion'
    ): Promise<{ spoke: boolean; ended: boolean }> {
        const total = scenario.timerMin as number;
        const staged = stager !== null;
        const endsSession = kind === 'completion' && (scenario.endSessionOnTimer ?? false);
        const fallbackPool =
            kind === 'approach'
                ? TIMER_APPROACH_FALLBACKS
                : endsSession
                  ? TIMER_CLOSE_FALLBACKS
                  : TIMER_COMPLETION_FALLBACKS;
        const canned = pickTimerFallback(fallbackPool, total);
        const remaining = timerTotalSec === null ? 0 : Math.max(0, timerTotalSec - now());
        const eventText =
            kind === 'approach'
                ? buildTimerApproachEvent(remaining, total, { staged })
                : buildTimerCompletionEvent(total, { staged, endsSession });
        let spokenKind: TurnKind = kind === 'approach' ? 'timer-approach' : 'timer-completion';
        try {
            const t0 = Date.now();
            const { reply, usage } = await runSmartCheckin(
                facilitator,
                [...session.getContextMessages(), { role: 'user', content: eventText }],
                {
                    system: builder.buildSystemPrompt(stager?.promptSection()),
                    maxChars: SESSION_TIMER_MAX_CHARS,
                }
            );
            calls.push({ kind: `timer-${kind}`, latencyMs: Date.now() - t0 });
            session.recordLlmUsage(usage);
            if (reply.kind === 'pass' && kind === 'approach') {
                event('timer', 'approach-pass');
                pacing.onResponseEnd();
                return { spoke: false, ended: false };
            }
            if (reply.kind === 'pass') event('timer', 'pass-on-completion');
            const line = reply.kind === 'speak' ? reply.text : canned;
            event('timer', `${kind}-${reply.kind === 'speak' ? 'speak' : 'canned'}`);
            session.addUserMessage(eventText);
            record('user', 'event', eventText);
            speakCannedLine(spokenKind, line);
        } catch (err) {
            event('timer', `${kind}-error-canned`, { message: (err as Error).message });
            session.addUserMessage(eventText);
            record('user', 'event', eventText);
            speakCannedLine(spokenKind, canned);
        }
        if (endsSession) {
            endedBy = 'timer';
            return { spoke: true, ended: true };
        }
        // restoreHoldAfterNotice: the notice must not end a held silence.
        if (silenceMode) {
            pacing.enterSilenceMode();
            event('hold', 'restored-after-timer');
        }
        return { spoke: true, ended: false };
    }

    /** ui/src/session-clock.ts timerDue, on the fake clock. */
    function timerDue(): 'approach' | 'completion' | null {
        if (timerTotalSec === null) return null;
        const remaining = timerTotalSec - now();
        if (!completionFired && remaining <= 0) {
            completionFired = true;
            approachFired = true;
            return 'completion';
        }
        const lead = timerApproachLeadSec(timerTotalSec, avgTurnSec());
        if (!approachFired && lead > 0 && remaining <= lead) {
            approachFired = true;
            return 'approach';
        }
        return null;
    }

    const onClassifierUsage = { onUsage: (u: LlmUsage) => session.recordLlmUsage(u) };

    async function dispatch(userText: string): Promise<void> {
        const route = routeUtterance({
            silenceMode,
            awaitingHoldConfirm,
            silenceModeEnabled,
            msSinceHoldEnded: (now() - leftHoldAt) * 1000,
        });
        event('note', `route:${route}`);
        if (route === 'silence') {
            record('user', 'user', userText);
            utteranceAdvance(userText);
            silenceBuffer.push(userText);
            const t0 = Date.now();
            const verdict = await classifyResumeIntent(utility, userText, onClassifierUsage);
            calls.push({ kind: 'classify-resume', latencyMs: Date.now() - t0 });
            event('classifier', 'resume', { verdict, utterance: userText });
            if (verdict === 'stay') return;
            // 'resume' or 'error': fail open, as the view does (ff1y).
            const joined = silenceBuffer.join(' ');
            silenceBuffer = [];
            await respondTo(joined, { skipTranscript: true });
            return;
        }
        if (route === 'hold-confirm') {
            awaitingHoldConfirm = false;
            const t0 = Date.now();
            const confirmed = await classifyHoldConfirm(utility, userText, onClassifierUsage);
            calls.push({ kind: 'classify-confirm', latencyMs: Date.now() - t0 });
            event('classifier', 'hold-confirm', { confirmed, utterance: userText });
            if (confirmed) {
                record('user', 'user', userText);
                utteranceAdvance(userText);
                enterHold();
            } else {
                await respondTo(userText);
            }
            return;
        }
        if (route === 'rehold') {
            const t0 = Date.now();
            const asking = await classifyHoldRequest(utility, userText, onClassifierUsage);
            calls.push({ kind: 'classify-rehold', latencyMs: Date.now() - t0 });
            event('classifier', 'rehold', { asking, utterance: userText });
            if (!asking) {
                await respondTo(userText);
                return;
            }
            record('user', 'user', userText);
            utteranceAdvance(userText);
            session.addUserMessage(userText);
            speakCannedLine('reentry', builder.getHoldReentryLine());
            enterHold();
            return;
        }
        await respondTo(userText);
    }

    // ---- Opener (generateOpener in the view: one-shot prompt, not kept). ----
    try {
        const openerPrompt = builder.buildOpenerPrompt(scenario.intention ?? '');
        try {
            const { result, latencyMs } = await timedComplete('opener', () =>
                facilitator.complete(
                    [...session.getContextMessages(), { role: 'user', content: openerPrompt }],
                    { system: builder.buildSystemPrompt(stager?.promptSection()) }
                )
            );
            const { cleanText } = parseTurnSignals(result.text);
            if (!result.text.trim()) throw new Error('empty opener completion');
            session.addAssistantMessage(cleanText, undefined, usageOf(result));
            record('assistant', 'opener', cleanText, { raw: result.text, latencyMs });
            speakAdvance(cleanText);
            pacing.onResponseEnd();
        } catch (err) {
            event('note', 'opener-fallback', { message: (err as Error).message });
            const fallback = builder.getSessionOpener();
            session.addAssistantMessage(fallback);
            record('assistant', 'opener', fallback);
            speakAdvance(fallback);
            pacing.onResponseEnd();
        }

        // ---- Main loop. ----
        const fakeCapSec = scenario.fakeMinutes * 60;
        const maxUserTurns = scenario.maxUserTurns ?? 30;
        let userTurns = 0;
        let situation: string | undefined;

        outer: while (true) {
            if (now() >= fakeCapSec) { endedBy = 'duration'; break; }
            if (userTurns >= maxUserTurns) { endedBy = 'turns'; break; }
            if (Date.now() - wallStart > wallCap) { endedBy = 'wall-clock'; break; }

            const view: SimView = {
                transcript: transcript
                    .filter((t) => t.kind !== 'event' && t.text.trim() !== '')
                    .map((t) => ({
                        who: t.role === 'assistant' ? ('facilitator' as const) : ('you' as const),
                        text: t.text,
                    })),
                elapsedMin: now() / 60,
                plannedMin: scenario.fakeMinutes,
                inSilence: silenceMode,
                ...(situation !== undefined ? { situation } : {}),
            };
            situation = undefined;
            const t0 = Date.now();
            const action = await simUser.nextAction(view);
            calls.push({ kind: 'sim-user', latencyMs: Date.now() - t0 });
            event('sim', 'action', { waitSec: action.waitSec, spoke: action.text !== null, end: action.end });

            // Wait phase: advance the fake clock, polling timer + check-in gate.
            const target = now() + action.waitSec;
            let facilitatorSpoke = false;
            while (now() < target) {
                fake.tick(Math.min(POLL_STEP_SEC, target - now()));
                const due = timerDue();
                if (due) {
                    const notice = await runTimerNotice(due);
                    if (notice.ended) break outer;
                    facilitatorSpoke = facilitatorSpoke || notice.spoke;
                    if (notice.spoke) break;
                    continue;
                }
                if (!silenceMode && pacing.shouldRespond() === TurnDecision.CheckIn) {
                    const spoke = await runCheckin();
                    facilitatorSpoke = facilitatorSpoke || spoke;
                    if (spoke) break;
                }
                if (Date.now() - wallStart > wallCap) { endedBy = 'wall-clock'; break outer; }
            }
            if (facilitatorSpoke) continue; // sim user heard something new; reconsider
            if (action.text !== null) {
                userTurns++;
                await dispatch(action.text);
                if (action.end) { endedBy = 'sim-end'; break; }
            } else if (action.end) {
                endedBy = 'sim-end';
                break;
            } else {
                situation = silenceMode
                    ? '(You stayed quiet; the facilitator is still keeping the silence.)'
                    : '(You stayed quiet for that long and the facilitator said nothing new.)';
            }
        }
    } catch (err) {
        endedBy = 'error';
        runError = err instanceof Error ? err.message : String(err);
        event('error', 'session-aborted', { message: runError });
    }

    session.endSession();
    return {
        scenario,
        runIndex: opts.runIndex ?? 0,
        startedAt: new Date(wallStart).toISOString(),
        facilitatorModel: facilitator.model,
        fakeDurationSec: Math.round(now()),
        transcript,
        events,
        calls,
        endedBy,
        ...(runError !== undefined ? { error: runError } : {}),
        finalState: {
            silenceMode,
            awaitingHoldConfirm,
            ...(stager ? { phase: stager.phase.id } : {}),
        },
    };
}

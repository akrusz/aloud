/**
 * Shared shapes for the soak harness (dev-docs/soak-harness.md): an LLM plays
 * the meditator against the real core engine on a fake clock, and every run
 * leaves a transcript + event log a judge and deterministic checks can score.
 */

import type { Focus, Quality, Verbosity } from '../src/facilitation/index.js';

export interface Persona {
    id: string;
    /** Second-person character brief for the sim-user system prompt. */
    description: string;
    /** Things this meditator should get around to during the sit, spread out. */
    arc?: readonly string[];
}

/**
 * How the sim meditator's lines reach the engine. Real turns arrive the way a
 * recognizer hands them over, and some bugs only show that way (kbec only
 * reproduced unpunctuated).
 */
export interface SimLineTransform {
    /** Chrome's Web Speech: no punctuation but apostrophes and in-word
     *  hyphens, sentence capitals dropped, the first letter and "I" kept up. */
    recognizer?: 'web-speech';
    /** Cut these lines (1-based, counting the sim's spoken lines) to their
     *  last one to three words, as an endpointing cut delivers a sentence's
     *  tail as a turn of its own (meditation-pal-kkiz). The seed picks how many
     *  words each keeps, so a scenario cuts the same way every run. */
    cut?: { turns: readonly number[]; seed: number };
}

/** The situation a scenario exists to produce. checks.ts warns
 *  `scenario-setup-missed` when a session never got there, since such a
 *  session passing says nothing about the bug it was aimed at. */
export type ScenarioAim = 'fright-in-hold' | 'back-in-hold' | 'fragment';

export interface Scenario {
    id: string;
    title: string;
    persona: Persona;
    modeId: 'exploration' | 'felt_sense';
    focuses?: Focus[];
    qualities?: Quality[];
    /** Guidance level 1-5; in felt sense this is the check-in pace. */
    directiveness?: number;
    verbosity?: Verbosity;
    intention?: string;
    checkinTiming?: 'fixed' | 'smart' | 'none';
    checkinContent?: 'canned' | 'smart';
    silenceModeEnabled?: boolean;
    /** Fixed-timing check-in interval, seconds. */
    silenceCheckinSec?: number;
    timerMin?: number;
    endSessionOnTimer?: boolean;
    /** Simulated sit length cap (fake clock), minutes. */
    fakeMinutes: number;
    maxUserTurns?: number;
    /** The app's language setting (English unless set). */
    language?: 'en' | 'zh';
    transform?: SimLineTransform;
    aim?: ScenarioAim;
}

export type TurnKind =
    | 'opener'
    | 'reply'
    | 'checkin'
    | 'checkin-canned'
    | 'timer-approach'
    | 'timer-completion'
    | 'reentry'
    | 'command'
    | 'user'
    | 'event';

export interface TurnRecord {
    /** Fake-clock seconds since session start. */
    at: number;
    role: 'user' | 'assistant';
    kind: TurnKind;
    /** What was spoken/heard (cleanText for assistant turns). */
    text: string;
    /** Raw model output before token parsing, assistant turns only. */
    raw?: string;
    /** Real wall-clock latency of the LLM call behind this turn. */
    latencyMs?: number;
    /** Spoken while a silence hold was active. */
    duringHold?: boolean;
    /** What the sim meditator said, when the engine was given something else
     *  (Scenario.transform); `text` is what the engine was given. */
    said?: string;
    /** Delivered as a cut-off tail (SimLineTransform.cut). */
    cut?: boolean;
}

export interface SoakEvent {
    at: number;
    kind:
        | 'signal'
        | 'classifier'
        | 'checkin'
        | 'timer'
        | 'hold'
        | 'stage'
        | 'error'
        | 'sim'
        | 'note'
        // Tier 2 only (ui/src/soak-tap.ts): the audio path the headless
        // harness has no equivalent of.
        | 'tts'
        | 'stt'
        | 'audio';
    detail: string;
    data?: Record<string, unknown>;
}

/**
 * Token counts as the provider reported them (core CompletionResult, where
 * `inputTokens` is the fresh, full-price part of the prompt). A field the
 * provider left out stays absent: absent means not reported, never zero.
 */
export interface CallUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
}

export interface LlmCallStat extends CallUsage {
    kind: string;
    latencyMs: number;
    model?: string;
}

export type SessionEnd =
    | 'duration'
    | 'turns'
    | 'timer'
    | 'sim-end'
    | 'wall-clock'
    | 'error'
    /** Tier 2: the app tore the view down on its own (timer close, auto-quit). */
    | 'app-ended';

export interface SessionRunResult {
    scenario: Scenario;
    runIndex: number;
    startedAt: string;
    facilitatorModel: string;
    fakeDurationSec: number;
    transcript: TurnRecord[];
    events: SoakEvent[];
    calls: LlmCallStat[];
    endedBy: SessionEnd;
    error?: string;
    finalState: {
        silenceMode: boolean;
        awaitingHoldConfirm: boolean;
        phase?: string;
    };
}

export interface CheckFinding {
    id: string;
    level: 'fail' | 'warn' | 'info';
    detail: string;
}

export interface JudgeVerdict {
    overall: number;
    dimensions: Record<string, number | null>;
    winceMoments: Array<{ quote: string; why: string }>;
    notes: string;
}

/** One judge model's verdict on one session; with --judge-repeats a judge
 *  scores the same session several times, one entry each. */
export interface JudgeRun extends CallUsage {
    judgeModel: string;
    verdict: JudgeVerdict;
    latencyMs?: number;
}

export interface SessionReport {
    result: SessionRunResult;
    findings: CheckFinding[];
    /** The first judge's first verdict, kept for single-judge readers
     *  (baseline.ts, tier 2). Every verdict is in `judgeRuns`. */
    judge?: JudgeVerdict;
    judgeError?: string;
    judgeRuns?: JudgeRun[];
    /** Judge calls that produced no verdict. */
    judgeRunErrors?: Array<{ judgeModel: string; error: string }>;
}

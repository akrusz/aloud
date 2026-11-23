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

/**
 * Something the meditator says early that matters again much later, for a
 * long session (rubric dimension 12, "Holds the session"). The persona's arc
 * fixes the words, so a check can find them: `early` marks the early line and
 * `cue` the late one in what the engine was given (case-insensitive, as
 * written), and any `echo` word (whole words) in a facilitator line after the
 * cue counts as the early material coming back.
 */
export interface SessionCallback {
    id: string;
    early: string;
    cue: string;
    echo: readonly string[];
}

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
    callbacks?: readonly SessionCallback[];
    /** Words from each line the persona must say (case-insensitive, as
     *  written); checks.ts warns `scenario-setup-missed` for any never said. */
    fixedLines?: readonly string[];
    /** Run only when named (`--scenarios=<id>`): left out of "all", so out of
     *  every battery. For the long, dearer ones. */
    optIn?: boolean;
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
    /** Includes `holds_session` (rubric dimension 12), null on a session too
     *  short to show it. */
    dimensions: Record<string, number | null>;
    winceMoments: Array<{ quote: string; why: string }>;
    notes: string;
    /** The moments that decided `holds_session`, quoted; absent when it was
     *  not scored. */
    holdsMoments?: Array<{ quote: string; why: string }>;
    /** Rubric 13 and 14 (Conduct), binary over the whole session, with the
     *  failing replies quoted; a dimension is absent when the meditator never
     *  gave a turn that calls for it. */
    conduct?: Partial<Record<ConductDim, { pass: boolean; fails: Array<{ quote: string; why: string }> }>>;
    /** How it held the role over the session, 1 to 5, by the rubric's "Held the
     *  role" anchors; absent with `conduct`. */
    heldRole?: number;
}

export type ConductDim = '13' | '14';

/**
 * Counts over the facilitator's replies (turns of kind `reply`: answers to
 * something the meditator said; the opener, check-ins and canned lines are
 * left out), free beside the judge's "holds the session". Computed by
 * soak/style.ts.
 */
export interface SessionStyle {
    replies: number;
    /** Share of replies ending in a question mark; null with no replies. */
    questionShare: number | null;
    /** The most frequent first three words (lowercased) and how many replies
     *  open with them; null with no replies. */
    topOpening: { words: string; count: number } | null;
    /** Median words per reply in the first and the last third of the
     *  session's simulated time; null when that third has no reply. */
    medianWordsFirstThird: number | null;
    medianWordsLastThird: number | null;
    /** Scenario.callbacks: whether each early line and its cue were said,
     *  and how many facilitator lines after the cue it took for the early
     *  words to come back (null: never, or no cue). `meditatorFirst`: the
     *  meditator said the words again after the cue before the facilitator
     *  did, so no later echo is counted. */
    callbacks?: Array<{
        id: string;
        saidEarly: boolean;
        cued: boolean;
        echoedAfter: number | null;
        meditatorFirst: boolean;
    }>;
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
    style?: SessionStyle;
}

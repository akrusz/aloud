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

export interface Scenario {
    id: string;
    title: string;
    persona: Persona;
    modeId: 'exploration' | 'felt_sense';
    focuses?: Focus[];
    qualities?: Quality[];
    /** Guidance level 0-10; in felt sense this is the check-in pace. */
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
}

export type TurnKind =
    | 'opener'
    | 'reply'
    | 'checkin'
    | 'checkin-canned'
    | 'timer-approach'
    | 'timer-completion'
    | 'reentry'
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

export interface LlmCallStat {
    kind: string;
    latencyMs: number;
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

export interface SessionReport {
    result: SessionRunResult;
    findings: CheckFinding[];
    judge?: JudgeVerdict;
    judgeError?: string;
}

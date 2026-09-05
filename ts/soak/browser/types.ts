/**
 * Tier-2 shapes. The session result is deliberately tier 1's `SessionRunResult`
 * so `runChecks`, `judgeSession`, and the report writer take a browser session
 * unchanged; everything the audio path adds rides alongside it.
 */

import type { Scenario, SessionRunResult } from '../types.js';

export interface WebScenario extends Scenario {
    /** Real wall-clock cap for the sit, minutes. Tier 2 has no fake clock. */
    realMinutes: number;
    /**
     * Ceiling on a sim user's WAIT, seconds. Personas ask for meditation-scale
     * silences; at wall-clock speed a 900-second wait is a quarter-hour of
     * nothing. Clamping keeps the persona's *relative* pacing while fitting the
     * sit into a coffee break - so tier 2 tests the audio path, and tier 1
     * remains the place long-silence pacing is exercised honestly.
     */
    maxWaitSec: number;
    /**
     * Speak over the facilitator instead of waiting for a turn boundary, to
     * exercise barge-in. Off by default: every other scenario wants clean
     * turn-taking so an STT miss means an STT miss.
     */
    interrupt?: boolean;
    /** Say the mute command at this point in the sit (elapsed seconds). */
    muteAfterSec?: number;
    /**
     * Fixed lines instead of the LLM sim user, spoken in order with a short
     * wait between them. For endpointing experiments, where what matters is
     * WHERE the pauses fall (`say` honours [[slnc <ms>]] inline) and the
     * persona would only add noise. Markup is stripped before WER scoring.
     */
    script?: string[];
    /** Seconds between scripted lines (default 3). */
    scriptWaitSec?: number;
    /**
     * After the first recognizer final for a line, keep listening this long
     * for further finals and attribute them to the same line. A scripted line
     * with a long mid-clause pause is meant to come back as ONE turn; two
     * finals means the endpointer cut it. Default 0 (first final wins).
     */
    finalsSettleMs?: number;
    /** Override AppSettings.sttSpeculation for the run (default: leave the
     *  app's default). */
    sttSpeculation?: boolean;
    /**
     * Play the facilitator's browser voice at volume 0. The loopback device
     * feeds the app's own TTS back into its mic at digital full scale, which
     * no acoustic echo path does, and the mic-capturing engine's echo gate
     * (tuned for speakers) reads that as barge-in - the facilitator ends up
     * answering itself. For an endpointing experiment that's noise, so the
     * facilitator keeps its timing and loses its sound.
     */
    silentFacilitator?: boolean;
}

/** One sim utterance and what the app made of it. */
export interface SpokenLine {
    /** Seconds since session start. */
    at: number;
    /** What the voice was asked to say. */
    said: string;
    /** The recognizer's final for it, or null when nothing arrived in time. */
    heard: string | null;
    /** The app dropped it as TTS echo of its own voice. */
    echoDropped: boolean;
    /** Word error rate of `heard` against `said`, 0-1; null when unheard. */
    wer: number | null;
    /** Recognizer finals attributed to this line (0 = unheard). Above 1 the
     *  endpointer split the line; `heard` is the finals joined in order. */
    finals: number;
    /** Wall-clock from end of playback to the recognizer's final, ms. */
    latencyMs: number | null;
}

export interface WebSessionRunResult extends SessionRunResult {
    /** The audio round trip, one entry per sim utterance. */
    spoken: SpokenLine[];
    /** How the meditator's voice was synthesized (`say`, `openai:sage`, …). */
    voiceId: string;
    /** Which recognizer the app was configured to use. */
    sttEngine: string;
    /** Audio seconds the client reported billing for STT ([stt-cost] console
     *  lines), split by pass kind. Only the mic-capturing engines log these;
     *  Web Speech bills nothing. */
    sttBilled: { specSec: number; finalSec: number; specCalls: number; finalCalls: number; reusedFinals: number };
}

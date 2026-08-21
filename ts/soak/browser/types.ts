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
}

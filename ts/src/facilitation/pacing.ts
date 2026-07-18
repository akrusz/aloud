/**
 * Pacing and turn-taking logic for meditation facilitation.
 *
 * Meditation conversation has silences with very different meanings, and
 * the controller must not treat them alike:
 *
 * - A thinking pause: short mid-share silence while the meditator finds
 *   words. Responding here cuts them off — wait (responseDelayMs, plus the
 *   VAD-side ramp that grants longer shares more trailing-silence patience).
 * - A natural end of sharing: silence past the response delay after speech —
 *   the facilitator's turn to respond.
 * - A contemplative drop: the meditator has gone inward and stopped talking
 *   entirely. Interrupting defeats the practice, so nothing fires until a
 *   long interval (silenceCheckinSec) passes, then a gentle check-in
 *   confirms presence and the timer resets. What the check-in says is the
 *   caller's choice: a canned phrase (no LLM round-trip) or a smart one
 *   (smart-checkin.ts — the LLM offers a line in context, or declines).
 * - Requested silence: the LLM prefixed its reply with [HOLD], entering an
 *   explicit hold where even check-ins stay quiet; any new speech exits it
 *   (subject to the resume-intent classifier upstream).
 */

import { realClock, type Clock } from '../clock.js';

export const ConversationState = {
    Idle: 'idle',
    Listening: 'listening',
    Processing: 'processing',
    Responding: 'responding',
    SilentHold: 'silent_hold',
} as const;
export type ConversationState =
    (typeof ConversationState)[keyof typeof ConversationState];

export const TurnDecision = {
    Wait: 'wait',
    Respond: 'respond',
    CheckIn: 'check_in',
    Hold: 'hold',
} as const;
export type TurnDecision =
    (typeof TurnDecision)[keyof typeof TurnDecision];

export interface PacingConfig {
    // -----------------------------------------------------------------
    // Facilitation-side pacing — used by PacingController itself.
    // -----------------------------------------------------------------

    /** Milliseconds of silence after speech before responding. */
    responseDelayMs: number;
    /** Seconds of total silence before a gentle check-in. */
    silenceCheckinSec: number;
    /** If false, check-ins never fire. */
    silenceCheckinsEnabled: boolean;
    /**
     * If false, the [HOLD] signal from the LLM is ignored — the session
     * never enters extended silence mode. Useful for users who find
     * silence mode unsettling. The PacingController doesn't enforce
     * this on its own; callers should treat a hold-signaled response
     * as a normal one when this is false.
     */
    silenceModeEnabled: boolean;

    // -----------------------------------------------------------------
    // Client-side VAD tuning — used by STT adapters, not PacingController.
    // Grouped here so the user has one knob bag to tune. Adapters read
    // only the fields they need.
    // -----------------------------------------------------------------

    /** Base trailing silence before submitting a transcribed utterance. */
    silenceBaseMs: number;
    /** Maximum tolerated silence after a long share. */
    silenceMaxMs: number;
    /** Extra ms of silence allowed per ms of speech (ramp from base to max). */
    silenceRampRate: number;
    /** Minimum total speech duration before an utterance can be submitted. */
    minSpeechDurationMs: number;
}

/** Clamp bounds for a model-set check-in interval ([WAIT:Nm] smart timing).
 *  A floor keeps a confused model from turning check-ins into chatter; the
 *  ceiling keeps one from silencing check-ins entirely. */
export const CHECKIN_INTERVAL_MIN_SEC = 60;
export const CHECKIN_INTERVAL_MAX_SEC = 3600;

export const defaultPacingConfig: PacingConfig = {
    responseDelayMs: 2000,
    silenceCheckinSec: 300,
    silenceCheckinsEnabled: true,
    silenceModeEnabled: true,
    silenceBaseMs: 3000,
    // The long-end cap: how much trailing silence a long, reflective share gets
    // before we submit. Meditation speech has real mid-thought pauses, so the
    // ceiling is generous (a too-short cap cuts people off mid-sentence).
    silenceMaxMs: 6000,
    // Extra ms of trailing-silence tolerance per ms of speech (ramps from base
    // toward the cap). At 0.16 a short reply stays snappy while a longer share
    // earns more patience without over-waiting on quick answers.
    silenceRampRate: 0.16,
    minSpeechDurationMs: 500,
};

export interface PacingControllerOptions {
    config?: Partial<PacingConfig>;
    clock?: Clock;
}

export class PacingController {
    readonly config: PacingConfig;
    private readonly clock: Clock;

    private _state: ConversationState = ConversationState.Idle;
    private _lastSpeechEnd = 0;
    private _lastResponseTime = 0;
    private _silenceModeStart: number | null = null;
    private _hasSpoken = false;
    private _checkinIntervalOverride: number | null = null;

    constructor(options: PacingControllerOptions = {}) {
        this.config = { ...defaultPacingConfig, ...options.config };
        this.clock = options.clock ?? realClock;
    }

    get state(): ConversationState {
        return this._state;
    }

    startSession(): void {
        this._state = ConversationState.Listening;
        this._lastSpeechEnd = 0;
        this._lastResponseTime = this.clock();
        this._silenceModeStart = null;
        this._hasSpoken = false;
        this._checkinIntervalOverride = null;
    }

    /**
     * Smart timing: override the check-in interval (seconds), clamped to
     * [CHECKIN_INTERVAL_MIN_SEC, CHECKIN_INTERVAL_MAX_SEC]. Sticky — the
     * model's latest estimate stands across turns until it sets a new one;
     * null restores the configured silenceCheckinSec.
     */
    setCheckinInterval(sec: number | null): void {
        this._checkinIntervalOverride =
            sec === null
                ? null
                : Math.min(CHECKIN_INTERVAL_MAX_SEC, Math.max(CHECKIN_INTERVAL_MIN_SEC, sec));
    }

    /** The interval currently gating check-ins (override or configured). */
    getCheckinInterval(): number {
        return this._checkinIntervalOverride ?? this.config.silenceCheckinSec;
    }

    endSession(): void {
        this._state = ConversationState.Idle;
    }

    onSpeechStart(): void {
        this._state = ConversationState.Listening;
    }

    onSpeechEnd(): void {
        this._lastSpeechEnd = this.clock();
        this._state = ConversationState.Processing;
        this._hasSpoken = true;
    }

    /**
     * Process a transcribed utterance and decide on turn-taking.
     *
     * Any speech auto-exits silence mode. Entering silence mode is the
     * LLM's call, handled externally via the [HOLD] signal in its reply.
     */
    onTranscription(_text: string): TurnDecision {
        if (this._silenceModeStart !== null) {
            this.exitSilenceMode();
        }
        return TurnDecision.Respond;
    }

    /**
     * Timing-based decision, called periodically during silence.
     */
    shouldRespond(): TurnDecision {
        const now = this.clock();

        if (this._silenceModeStart !== null) {
            return TurnDecision.Hold;
        }

        if (this._lastSpeechEnd > 0) {
            const silenceDuration = now - this._lastSpeechEnd;
            const responseDelay = this.config.responseDelayMs / 1000;
            if (silenceDuration >= responseDelay) {
                return TurnDecision.Respond;
            }
        }

        if (
            this._hasSpoken &&
            this.config.silenceCheckinsEnabled &&
            now - this._lastResponseTime >= this.getCheckinInterval()
        ) {
            return TurnDecision.CheckIn;
        }

        return TurnDecision.Wait;
    }

    onResponseStart(): void {
        this._state = ConversationState.Responding;
    }

    onResponseEnd(): void {
        this._state = ConversationState.Listening;
        this._lastResponseTime = this.clock();
        this._lastSpeechEnd = 0;
    }

    /** Called after the LLM signals [HOLD]. */
    enterSilenceMode(): void {
        this._state = ConversationState.SilentHold;
        this._silenceModeStart = this.clock();
    }

    /** Called when the meditator speaks again. */
    exitSilenceMode(): void {
        this._state = ConversationState.Listening;
        this._silenceModeStart = null;
    }

    getSilenceDuration(): number {
        const now = this.clock();
        if (this._silenceModeStart !== null) {
            return now - this._silenceModeStart;
        }
        if (this._lastSpeechEnd > 0) {
            return now - this._lastSpeechEnd;
        }
        return now - this._lastResponseTime;
    }

    isInSilenceMode(): boolean {
        return this._silenceModeStart !== null;
    }

    // Internal hooks used by tests that need to set up timing scenarios
    // without driving the controller through a full transcript.
    /** @internal */
    _setLastSpeechEnd(t: number): void { this._lastSpeechEnd = t; }
    /** @internal */
    _setLastResponseTime(t: number): void { this._lastResponseTime = t; }
    /** @internal */
    _setHasSpoken(v: boolean): void { this._hasSpoken = v; }
}

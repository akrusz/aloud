/**
 * Pacing and turn-taking logic for meditation facilitation.
 *
 * Meditation silences mean very different things, and must not be treated alike:
 *
 * - Thinking pause: short mid-share silence while the meditator finds words.
 *   Responding cuts them off, so wait (responseDelayMs, plus the VAD-side ramp
 *   granting longer shares more trailing-silence patience).
 * - End of sharing: silence past the response delay. The facilitator's turn.
 * - Contemplative drop: they've gone inward and stopped talking. Interrupting
 *   defeats the practice, so nothing fires until silenceCheckinSec passes, then
 *   a gentle check-in confirms presence and the timer resets. Its content is the
 *   caller's choice: a canned phrase, or a smart one (smart-checkin.ts).
 * - Requested silence: the LLM prefixed [HOLD], so even check-ins stay quiet.
 *   Any new speech exits, subject to the upstream resume-intent classifier.
 */

import { realClock, type Clock } from '../clock.js';

export const TurnDecision = {
    Wait: 'wait',
    Respond: 'respond',
    CheckIn: 'check_in',
    Hold: 'hold',
} as const;
export type TurnDecision =
    (typeof TurnDecision)[keyof typeof TurnDecision];

export interface PacingConfig {
    // Facilitation-side pacing, used by PacingController itself.

    /** Milliseconds of silence after speech before responding. */
    responseDelayMs: number;
    /** Seconds of total silence before a gentle check-in. */
    silenceCheckinSec: number;
    silenceCheckinsEnabled: boolean;
    /**
     * If false, [HOLD] is ignored and the session never enters extended silence
     * mode (for users who find it unsettling). PacingController does not enforce
     * this; callers must treat a hold-signaled response as a normal one.
     */
    silenceModeEnabled: boolean;

    // Client-side VAD tuning, read by STT adapters rather than PacingController.
    // Grouped here so the user has one knob bag.

    /** Base trailing silence before submitting a transcribed utterance. */
    silenceBaseMs: number;
    /** Maximum tolerated silence after a long share. */
    silenceMaxMs: number;
    /** Extra ms of silence allowed per ms of speech (ramp from base to max). */
    silenceRampRate: number;
    /** Minimum total speech duration before an utterance can be submitted. */
    minSpeechDurationMs: number;
}

/** Clamp bounds for a model-set check-in interval ([WAIT:Nm] smart timing). The
 *  floor stops a confused model turning check-ins into chatter (and admits the
 *  30s high-guidance default, defaultWaitSeconds); the ceiling stops one
 *  silencing check-ins entirely. */
export const CHECKIN_INTERVAL_MIN_SEC = 30;
export const CHECKIN_INTERVAL_MAX_SEC = 3600;

export const defaultPacingConfig: PacingConfig = {
    responseDelayMs: 2000,
    silenceCheckinSec: 300,
    silenceCheckinsEnabled: true,
    silenceModeEnabled: true,
    silenceBaseMs: 3000,
    // Trailing silence a long reflective share gets before submitting.
    // Meditation speech has real mid-thought pauses, so the cap is generous; a
    // shorter one cuts people off mid-sentence.
    silenceMaxMs: 6000,
    // Extra ms of tolerance per ms of speech, ramping base toward the cap. At
    // 0.16 short replies stay snappy while longer shares earn more patience.
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

    private _lastSpeechEnd = 0;
    private _lastResponseTime = 0;
    private _silenceModeStart: number | null = null;
    private _hasSpoken = false;
    private _checkinIntervalOverride: number | null = null;

    constructor(options: PacingControllerOptions = {}) {
        this.config = { ...defaultPacingConfig, ...options.config };
        this.clock = options.clock ?? realClock;
    }

    startSession(): void {
        this._lastSpeechEnd = 0;
        this._lastResponseTime = this.clock();
        this._silenceModeStart = null;
        this._hasSpoken = false;
        this._checkinIntervalOverride = null;
    }

    /**
     * Smart timing: override the check-in interval (seconds), clamped to
     * [CHECKIN_INTERVAL_MIN_SEC, CHECKIN_INTERVAL_MAX_SEC]. Sticky across turns
     * until the model sets a new one; null restores the configured
     * silenceCheckinSec.
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

    /** True when a [WAIT:Nm] override is currently in effect. */
    hasCheckinOverride(): boolean {
        return this._checkinIntervalOverride !== null;
    }

    /** Seconds until a check-in could fire (0 = due now). Timing math only:
     *  ignores enablement, holds, and the has-spoken gate. */
    getCheckinEtaSec(): number {
        const elapsed = this.clock() - this._lastResponseTime;
        return Math.max(0, this.getCheckinInterval() - elapsed);
    }

    onSpeechEnd(): void {
        this._lastSpeechEnd = this.clock();
        this._hasSpoken = true;
    }

    /**
     * A transcribed utterance arrived. Any speech auto-exits silence mode;
     * entering it is the LLM's call, handled externally via the [HOLD] signal.
     */
    onTranscription(): void {
        if (this._silenceModeStart !== null) {
            this.exitSilenceMode();
        }
    }

    /** Timing-based decision, called periodically during silence. */
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

    onResponseEnd(): void {
        this._lastResponseTime = this.clock();
        this._lastSpeechEnd = 0;
    }

    /** Called after the LLM signals [HOLD]. */
    enterSilenceMode(): void {
        this._silenceModeStart = this.clock();
    }

    /** Called when the meditator speaks again. */
    exitSilenceMode(): void {
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

    /** Test hook: set up a check-in scenario without driving a transcript.
     *  @internal */
    _setHasSpoken(v: boolean): void { this._hasSpoken = v; }
}

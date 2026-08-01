/**
 * The session clock: the small readout in the input row, its three modes, and
 * the picker modal behind a tap.
 *
 * Modes are a display choice EXCEPT 'timer', which also arms the spoken notices
 * in the session views (facilitation/session-timer.ts). This module owns the
 * arming deadline and reports when each notice is due; it never speaks.
 *
 * Duration is always measured from the moment the timer is set, not from when
 * the session started. Setting "20 minutes" ten minutes into a sit means twenty
 * more, which is what a person means by it. The modal shows the resulting end
 * time so there's nothing to guess.
 */

import {
    SESSION_TIMER_MAX_MINUTES,
    SESSION_TIMER_MIN_MINUTES,
    SESSION_TIMER_PRESETS,
} from '../../src/facilitation/index.js';
import type { AppSettings, SessionClockMode } from './app-settings.js';
import { manageModalFocus } from './modal-focus.js';

const OVERLAY_ID = 'session-clock-modal-overlay';

/** How long an armed-but-hidden clock stays on screen: 2s at full strength,
 *  then a 6s fade (the split lives in the session-timer-flash keyframes). */
export const SESSION_CLOCK_FLASH_MS = 8000;

const MODE_LABELS: ReadonlyArray<[SessionClockMode, string, string]> = [
    ['elapsed', 'Time in session', 'Counts up from when you started.'],
    ['wall', 'Time of day', 'The clock on the wall, no seconds ticking.'],
    ['timer', 'Timer', 'Counts down. The facilitator will tell you when the time is up.'],
];

export interface SessionClockChoice {
    mode: SessionClockMode;
    timerMin: number;
    showClock: boolean;
}

function pad(n: number): string {
    return n < 10 ? `0${n}` : String(n);
}

/** m:ss, or h:mm:ss past an hour. */
export function formatDuration(totalSec: number): string {
    const sec = Math.max(0, Math.floor(totalSec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Local time, no seconds: a ticking seconds digit is what people are escaping
 *  when they switch off the elapsed count. */
export function formatWallClock(now: Date): string {
    return now.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/** Clamp a hand-entered duration to something a session can actually hold. */
export function clampTimerMinutes(min: number): number {
    if (!Number.isFinite(min)) return 20;
    return Math.min(SESSION_TIMER_MAX_MINUTES, Math.max(SESSION_TIMER_MIN_MINUTES, Math.round(min)));
}

/** "20 min timer" / "Time of day" - the setup button's face and the clock's
 *  accessible name. With the readout off there's nothing to name but the timer,
 *  if one is armed: "20 min timer (hidden)", else just "Hidden". */
export function clockModeLabel(
    mode: SessionClockMode,
    timerMin: number,
    showClock = true
): string {
    if (mode === 'timer') return `${timerMin} min timer${showClock ? '' : ' (hidden)'}`;
    if (!showClock) return 'Hidden';
    return mode === 'wall' ? 'Time of day' : 'Time in session';
}

/**
 * Live clock for one session. Owns the readout element and the timer deadline;
 * the view polls `timerDue()` and does the speaking.
 */
export class SessionClock {
    private mode: SessionClockMode;
    private timerMin: number;
    private visible: boolean;
    /** Epoch ms the countdown ends, or null when no timer is armed. */
    private endsAt: number | null = null;
    /** Notices already handed to the view, so each fires once per arming. */
    private approachFired = false;
    private completionFired = false;
    private readonly tick: ReturnType<typeof setInterval>;
    /** Mid-flash: the readout shows even though `visible` is false. */
    private flashing = false;
    private flashTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly el: HTMLElement,
        private readonly startMs: number,
        settings: Pick<AppSettings, 'sessionClockMode' | 'sessionTimerMin' | 'showSessionClock'>,
        /** Called when the user picks a new mode/duration, to persist it. */
        private readonly onChange: (choice: SessionClockChoice) => void
    ) {
        this.mode = settings.sessionClockMode;
        this.timerMin = clampTimerMinutes(settings.sessionTimerMin);
        this.visible = settings.showSessionClock;
        if (this.mode === 'timer') this.arm(this.timerMin);

        this.el.addEventListener('click', () => void this.openPicker());
        this.render();
        this.tick = setInterval(() => this.render(), 1000);
    }

    /** Start (or restart) the countdown, measured from now. */
    private arm(min: number): void {
        this.timerMin = clampTimerMinutes(min);
        this.endsAt = Date.now() + this.timerMin * 60_000;
        this.approachFired = false;
        this.completionFired = false;
    }

    private disarm(): void {
        this.endsAt = null;
    }

    /** Total length of the armed timer, in seconds. */
    timerTotalSec(): number {
        return this.timerMin * 60;
    }

    timerMinutes(): number {
        return this.timerMin;
    }

    /** "20 min timer" / "Time of day" - for the session info panel's row. */
    faceLabel(): string {
        return clockModeLabel(this.mode, this.timerMin, this.visible);
    }

    /** Seconds until the countdown ends, or null when no timer is armed. */
    remainingSec(): number | null {
        if (this.endsAt === null) return null;
        return (this.endsAt - Date.now()) / 1000;
    }

    /**
     * What the view owes the meditator right now, if anything. Each notice is
     * returned once per arming; the view marks it consumed by acting on it.
     * `leadSec` comes from the view because it depends on how long turns have
     * been running (timerApproachLeadSec).
     */
    timerDue(leadSec: number): 'approach' | 'completion' | null {
        const remaining = this.remainingSec();
        if (remaining === null) return null;
        if (!this.completionFired && remaining <= 0) {
            this.completionFired = true;
            // A completion supersedes an unfired approach: never say "a few
            // minutes left" and "that's your time" back to back.
            this.approachFired = true;
            return 'completion';
        }
        if (!this.approachFired && leadSec > 0 && remaining <= leadSec) {
            this.approachFired = true;
            return 'approach';
        }
        return null;
    }

    /** Open the picker (also reachable by tapping the clock). */
    async openPicker(): Promise<void> {
        const choice = await showSessionClockModal({
            mode: this.mode,
            timerMin: this.timerMin,
            showClock: this.visible,
        });
        if (!choice) return;
        this.applyChoice(choice);
        this.onChange(choice);
    }

    /** Adopt a picked mode/duration. Public so a choice made somewhere other
     *  than this clock's own picker can be pushed in. */
    applyChoice(choice: SessionClockChoice): void {
        this.mode = choice.mode;
        this.visible = choice.showClock;
        if (choice.mode === 'timer') this.arm(choice.timerMin);
        else {
            this.timerMin = clampTimerMinutes(choice.timerMin);
            this.disarm();
        }
        // Setting a timer with the readout off would otherwise give no sign it
        // took, and the first confirmation would be the facilitator speaking
        // minutes later. Show the countdown briefly, then let it fade away.
        if (choice.mode === 'timer' && !choice.showClock) this.flash();
        else this.render();
    }

    private flash(): void {
        this.flashing = true;
        this.el.classList.add('session-timer-flash');
        if (this.flashTimer) clearTimeout(this.flashTimer);
        this.flashTimer = setTimeout(() => {
            this.flashTimer = null;
            this.flashing = false;
            this.el.classList.remove('session-timer-flash');
            this.render();
        }, SESSION_CLOCK_FLASH_MS);
        this.render();
    }

    private render(): void {
        // Hidden by preference, but a running timer keeps counting: the notices
        // are the point, the readout is optional.
        const showing = this.visible || this.flashing;
        this.el.classList.toggle('hidden', !showing);
        this.el.setAttribute('aria-label', `Session Clock: ${clockModeLabel(this.mode, this.timerMin)}`);
        if (!showing) return;
        if (this.mode === 'wall') {
            this.el.textContent = formatWallClock(new Date());
            this.el.classList.remove('session-timer-final');
            return;
        }
        if (this.mode === 'timer' && this.endsAt !== null) {
            const remaining = this.remainingSec() ?? 0;
            // Past zero the session keeps going, so the clock keeps honest time
            // and counts up again rather than sitting frozen at 0:00.
            this.el.textContent =
                remaining <= 0 ? `+${formatDuration(-remaining)}` : formatDuration(remaining);
            // Colour, not opacity, for the last minute.
            this.el.classList.toggle('session-timer-final', remaining > 0 && remaining <= 60);
            return;
        }
        this.el.classList.remove('session-timer-final');
        this.el.textContent = formatDuration((Date.now() - this.startMs) / 1000);
    }

    destroy(): void {
        clearInterval(this.tick);
        if (this.flashTimer) clearTimeout(this.flashTimer);
    }
}

export interface SessionClockModalConfig {
    mode: SessionClockMode;
    timerMin: number;
    showClock: boolean;
}

/**
 * The picker. Resolves with the chosen settings, or null if dismissed.
 */
export function showSessionClockModal(
    config: SessionClockModalConfig
): Promise<SessionClockChoice | null> {
    return new Promise((resolve) => {
        if (typeof document === 'undefined' || document.getElementById(OVERLAY_ID)) {
            resolve(null);
            return;
        }
        let mode = config.mode;
        let timerMin = clampTimerMinutes(config.timerMin);
        let showClock = config.showClock;

        const overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'voice-modal-overlay';
        overlay.innerHTML = `
        <div class="voice-modal clock-modal" role="dialog" aria-modal="true" aria-label="Session Clock">
            <div class="voice-modal-header">
                <span class="voice-modal-title">Session Clock</span>
                <button type="button" class="voice-modal-close" id="clock-modal-close" aria-label="Cancel">&times;</button>
            </div>
            <div class="clock-modal-body">
                <div class="clock-mode-list" role="radiogroup" aria-label="Clock mode">
                    ${MODE_LABELS.map(
                        ([value, label, hint]) => `
                    <button type="button" class="clock-mode" role="radio" data-mode="${value}" aria-checked="false">
                        <span class="clock-mode-label">${label}</span>
                        <span class="clock-mode-hint">${hint}</span>
                    </button>`
                    ).join('')}
                </div>
                <div class="clock-timer-panel hidden" id="clock-timer-panel">
                    <div class="clock-presets">
                        ${SESSION_TIMER_PRESETS.map(
                            (m) =>
                                `<button type="button" class="clock-preset" data-min="${m}">${m}</button>`
                        ).join('')}
                    </div>
                    <div class="clock-custom">
                        <label for="clock-minutes">Minutes</label>
                        <div class="stepper">
                            <button type="button" class="stepper-btn stepper-dec" aria-label="Decrease">&minus;</button>
                            <input type="number" id="clock-minutes" class="stepper-value" inputmode="numeric"
                                min="${SESSION_TIMER_MIN_MINUTES}" max="${SESSION_TIMER_MAX_MINUTES}" step="1">
                            <button type="button" class="stepper-btn stepper-inc" aria-label="Increase">+</button>
                        </div>
                        <!-- Set mid-session, a duration counts from now, not from
                             when the sit began. This line is what says so. -->
                        <span class="clock-ends-at" id="clock-ends-at"></span>
                    </div>
                </div>
            </div>
            <!-- Outside the scrolling body: on a short window the mode list
                 scrolls, but this stays put rather than clipping away. -->
            <label class="checkbox-label clock-hide-row">
                <input type="checkbox" id="clock-show">
                <span>Show the clock during sessions</span>
            </label>
            <div class="clock-modal-actions">
                <button type="button" class="btn btn-primary" id="clock-modal-save">Done</button>
            </div>
        </div>`;
        document.body.appendChild(overlay);
        const releaseFocus = manageModalFocus(overlay);

        const minutesInput = overlay.querySelector<HTMLInputElement>('#clock-minutes')!;
        const showToggle = overlay.querySelector<HTMLInputElement>('#clock-show')!;
        const panel = overlay.querySelector<HTMLElement>('#clock-timer-panel')!;
        const endsAt = overlay.querySelector<HTMLElement>('#clock-ends-at')!;

        function sync(): void {
            for (const btn of overlay.querySelectorAll<HTMLElement>('.clock-mode')) {
                const on = btn.dataset['mode'] === mode;
                btn.classList.toggle('selected', on);
                btn.setAttribute('aria-checked', String(on));
            }
            panel.classList.toggle('hidden', mode !== 'timer');
            for (const btn of overlay.querySelectorAll<HTMLElement>('.clock-preset')) {
                btn.classList.toggle('selected', Number(btn.dataset['min']) === timerMin);
            }
            if (minutesInput.value !== String(timerMin)) minutesInput.value = String(timerMin);
            showToggle.checked = showClock;
            const end = new Date(Date.now() + timerMin * 60_000);
            endsAt.textContent = mode === 'timer' ? `ends ${formatWallClock(end)}` : '';
        }

        const close = (result: SessionClockChoice | null): void => {
            document.removeEventListener('keydown', onKey);
            releaseFocus();
            overlay.remove();
            resolve(result);
        };
        const onKey = (e: KeyboardEvent): void => {
            if (e.key === 'Escape') close(null);
        };
        document.addEventListener('keydown', onKey);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) close(null);
        });
        overlay.querySelector('#clock-modal-close')?.addEventListener('click', () => close(null));

        for (const btn of overlay.querySelectorAll<HTMLElement>('.clock-mode')) {
            btn.addEventListener('click', () => {
                mode = (btn.dataset['mode'] ?? 'elapsed') as SessionClockMode;
                sync();
            });
        }
        for (const btn of overlay.querySelectorAll<HTMLElement>('.clock-preset')) {
            btn.addEventListener('click', () => {
                timerMin = clampTimerMinutes(Number(btn.dataset['min']));
                // Picking a length is also how you pick the mode: nobody taps
                // "30" meaning anything but "give me a 30 minute timer".
                mode = 'timer';
                sync();
            });
        }
        minutesInput.addEventListener('input', () => {
            const n = Number(minutesInput.value);
            if (!Number.isFinite(n) || n <= 0) return;
            timerMin = clampTimerMinutes(n);
            endsAt.textContent = `ends ${formatWallClock(new Date(Date.now() + timerMin * 60_000))}`;
            for (const btn of overlay.querySelectorAll<HTMLElement>('.clock-preset')) {
                btn.classList.toggle('selected', Number(btn.dataset['min']) === timerMin);
            }
        });
        // Normalize an out-of-range or empty entry once the user leaves the field.
        minutesInput.addEventListener('change', () => {
            timerMin = clampTimerMinutes(Number(minutesInput.value));
            sync();
        });
        overlay.querySelector('.stepper-dec')?.addEventListener('click', () => {
            timerMin = clampTimerMinutes(timerMin - 1);
            sync();
        });
        overlay.querySelector('.stepper-inc')?.addEventListener('click', () => {
            timerMin = clampTimerMinutes(timerMin + 1);
            sync();
        });
        showToggle.addEventListener('change', () => {
            showClock = showToggle.checked;
        });
        overlay.querySelector('#clock-modal-save')?.addEventListener('click', () => {
            close({ mode, timerMin: clampTimerMinutes(timerMin), showClock });
        });

        sync();
    });
}

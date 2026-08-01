import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
    SessionClock,
    SESSION_CLOCK_REVEAL_MS,
    clampTimerMinutes,
    clockModeLabel,
    formatDuration,
} from '../ui/src/session-clock.js';

/** Minimal stand-in for the readout element: this suite runs without a DOM. */
function fakeEl(): HTMLElement & { text: string; classes: Set<string> } {
    const classes = new Set<string>();
    const el = {
        text: '',
        classes,
        set textContent(v: string) {
            el.text = v;
        },
        get textContent(): string {
            return el.text;
        },
        classList: {
            toggle: (name: string, on?: boolean) => {
                if (on === undefined ? classes.has(name) : !on) classes.delete(name);
                else classes.add(name);
            },
            remove: (name: string) => classes.delete(name),
            add: (name: string) => classes.add(name),
        },
        setAttribute: () => undefined,
        addEventListener: () => undefined,
    };
    return el as unknown as HTMLElement & { text: string; classes: Set<string> };
}

const TIMER_SETTINGS = {
    sessionClockMode: 'timer' as const,
    sessionTimerMin: 20,
    showSessionClock: true,
    endSessionOnTimer: false,
};

describe('formatDuration', () => {
    it('reads m:ss, and grows an hours field only when needed', () => {
        expect(formatDuration(0)).toBe('0:00');
        expect(formatDuration(65)).toBe('1:05');
        expect(formatDuration(600)).toBe('10:00');
        expect(formatDuration(3661)).toBe('1:01:01');
    });

    it('floors at zero rather than showing negative time', () => {
        expect(formatDuration(-30)).toBe('0:00');
    });
});

describe('clampTimerMinutes', () => {
    it('keeps a duration inside what a session can hold', () => {
        expect(clampTimerMinutes(20)).toBe(20);
        expect(clampTimerMinutes(0)).toBe(1);
        expect(clampTimerMinutes(-5)).toBe(1);
        expect(clampTimerMinutes(10_000)).toBe(480);
        expect(clampTimerMinutes(20.6)).toBe(21);
        expect(clampTimerMinutes(Number.NaN)).toBe(20);
    });
});

describe('clockModeLabel', () => {
    it('names the mode, and a timer by its length', () => {
        expect(clockModeLabel('elapsed', 20)).toBe('Time in session');
        expect(clockModeLabel('wall', 20)).toBe('Time of day');
        expect(clockModeLabel('timer', 20)).toBe('20 min timer');
    });

    it('says Hidden when the readout is off, but still names an armed timer', () => {
        expect(clockModeLabel('elapsed', 20, false)).toBe('Hidden');
        expect(clockModeLabel('wall', 20, false)).toBe('Hidden');
        expect(clockModeLabel('timer', 20, false)).toBe('20 min timer (hidden)');
    });
});

describe('SessionClock', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('counts a timer down, then keeps honest time past zero', () => {
        const el = fakeEl();
        const clock = new SessionClock(el, Date.now(), TIMER_SETTINGS, () => undefined);
        expect(el.text).toBe('20:00');
        vi.advanceTimersByTime(19 * 60_000);
        expect(el.text).toBe('1:00');
        // Past the end the session stays open, so the clock counts back up
        // rather than freezing at 0:00.
        vi.advanceTimersByTime(90_000);
        expect(el.text).toBe('+0:30');
        clock.destroy();
    });

    it('marks the last minute for colour, not for hiding', () => {
        const el = fakeEl();
        const clock = new SessionClock(el, Date.now(), TIMER_SETTINGS, () => undefined);
        expect(el.classes.has('session-timer-final')).toBe(false);
        vi.advanceTimersByTime(19 * 60_000 + 30_000);
        expect(el.classes.has('session-timer-final')).toBe(true);
        clock.destroy();
    });

    it('hands each notice to the view exactly once', () => {
        const clock = new SessionClock(fakeEl(), Date.now(), TIMER_SETTINGS, () => undefined);
        const lead = 180;
        expect(clock.timerDue(lead)).toBe(null);
        vi.advanceTimersByTime(17 * 60_000 + 1000);
        expect(clock.timerDue(lead)).toBe('approach');
        // The view polls every couple of seconds; it must not re-fire.
        vi.advanceTimersByTime(4000);
        expect(clock.timerDue(lead)).toBe(null);
        vi.advanceTimersByTime(3 * 60_000);
        expect(clock.timerDue(lead)).toBe('completion');
        vi.advanceTimersByTime(60_000);
        expect(clock.timerDue(lead)).toBe(null);
        clock.destroy();
    });

    it('drops an unfired approach when the end has already arrived', () => {
        // A backgrounded tab (or a very long turn) can leave both notices due at
        // the same poll. Saying "a few minutes left" and then "that's your time"
        // back to back is worse than saying only the second.
        const clock = new SessionClock(fakeEl(), Date.now(), TIMER_SETTINGS, () => undefined);
        vi.advanceTimersByTime(21 * 60_000);
        expect(clock.timerDue(180)).toBe('completion');
        expect(clock.timerDue(180)).toBe(null);
        clock.destroy();
    });

    it('reveals a hidden clock when a timer is armed, then fades it away', () => {
        const el = fakeEl();
        const clock = new SessionClock(
            el,
            Date.now(),
            { ...TIMER_SETTINGS, sessionClockMode: 'elapsed', showSessionClock: false },
            () => undefined
        );
        expect(el.classes.has('hidden')).toBe(true);

        clock.applyChoice({ mode: 'timer', timerMin: 20, showClock: false, endOnComplete: false });
        expect(el.classes.has('hidden')).toBe(false);
        expect(el.classes.has('session-clock-reveal')).toBe(true);

        vi.advanceTimersByTime(SESSION_CLOCK_REVEAL_MS + 100);
        expect(el.classes.has('hidden')).toBe(true);
        expect(el.classes.has('session-clock-reveal')).toBe(false);
        // The timer itself is unaffected by the readout coming and going.
        vi.advanceTimersByTime(20 * 60_000);
        expect(clock.timerDue(0)).toBe('completion');
        clock.destroy();
    });

    it('does not reveal when the clock is already showing, or with no timer', () => {
        const shown = fakeEl();
        const a = new SessionClock(shown, Date.now(), TIMER_SETTINGS, () => undefined);
        a.applyChoice({ mode: 'timer', timerMin: 20, showClock: true, endOnComplete: false });
        expect(shown.classes.has('session-clock-reveal')).toBe(false);
        a.destroy();

        const hidden = fakeEl();
        const b = new SessionClock(
            hidden,
            Date.now(),
            { ...TIMER_SETTINGS, showSessionClock: false },
            () => undefined
        );
        b.applyChoice({ mode: 'wall', timerMin: 20, showClock: false, endOnComplete: false });
        expect(hidden.classes.has('session-clock-reveal')).toBe(false);
        expect(hidden.classes.has('hidden')).toBe(true);
        b.destroy();
    });

    it('runs the timer even with the readout hidden', () => {
        const clock = new SessionClock(
            fakeEl(),
            Date.now(),
            { ...TIMER_SETTINGS, showSessionClock: false },
            () => undefined
        );
        vi.advanceTimersByTime(20 * 60_000);
        expect(clock.timerDue(0)).toBe('completion');
        clock.destroy();
    });

    it('only ends the session when a timer is what is running', () => {
        const opts = { ...TIMER_SETTINGS, endSessionOnTimer: true };
        const timer = new SessionClock(fakeEl(), Date.now(), opts, () => undefined);
        expect(timer.endsSessionOnComplete()).toBe(true);
        timer.destroy();
        // The setting persists across modes, but a clock that is only telling
        // the time has nothing to end.
        const wall = new SessionClock(
            fakeEl(),
            Date.now(),
            { ...opts, sessionClockMode: 'wall' },
            () => undefined
        );
        expect(wall.endsSessionOnComplete()).toBe(false);
        wall.destroy();
    });

    it('arms nothing in the display-only modes', () => {
        for (const mode of ['elapsed', 'wall'] as const) {
            const clock = new SessionClock(
                fakeEl(),
                Date.now(),
                { ...TIMER_SETTINGS, sessionClockMode: mode },
                () => undefined
            );
            vi.advanceTimersByTime(60 * 60_000);
            expect(clock.remainingSec()).toBe(null);
            expect(clock.timerDue(180)).toBe(null);
            clock.destroy();
        }
    });

    it('counts elapsed time from the session start, not from mount', () => {
        const el = fakeEl();
        const clock = new SessionClock(
            el,
            Date.now() - 5 * 60_000,
            { ...TIMER_SETTINGS, sessionClockMode: 'elapsed' },
            () => undefined
        );
        expect(el.text).toBe('5:00');
        clock.destroy();
    });
});

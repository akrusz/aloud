/**
 * The setup form's changes as named actions, so a request made by voice
 * (core setup-command.ts) goes through the same door as a click and comes back
 * with what the form now says (SetupOutcome), which is what gets spoken.
 *
 * The view owns the form (views/setup.ts implements SetupForm over its state
 * and its DOM); this decides what an action means against it: which mode a
 * setting belongs to, where a stepper stops, what "change the vibe to" clears.
 * A voice or a model picked by name is not here (core setup-pick.ts, applied
 * in the view, which owns those lists); provider and speech recognition stay
 * button-only.
 */

import {
    GUIDANCE_STOPS,
    setupActionModes,
    type BeginMode,
    type Quality,
    type SetupAction,
    type SetupFocus,
    type SetupOutcome,
    type Verbosity,
} from '../../src/facilitation/index.js';

/** What the actions need of the setup view. Every setter also repaints. */
export interface SetupForm {
    mode(): BeginMode;
    /** A mode tab tap. False when a continuation holds the tabs. */
    selectMode(mode: BeginMode): boolean;
    /** Set the session timer; returns the minutes it was clamped to. */
    setTimer(minutes: number): number;
    /** Back to the plain clock, no countdown. */
    clearTimer(): void;
    /** Show or hide the clock readout during a session. A timer keeps running
     *  behind a hidden one. */
    setClockVisible(show: boolean): void;
    /** What the readout counts with no timer; also shows it. */
    setClockMode(mode: 'elapsed' | 'wall'): void;
    focuses(): readonly SetupFocus[];
    setFocuses(list: SetupFocus[]): void;
    qualities(): readonly Quality[];
    setQualities(list: Quality[]): void;
    /** The guidance level, 1 to GUIDANCE_STOPS. */
    guidance(): number;
    setGuidance(level: number): void;
    verbosity(): Verbosity;
    setVerbosity(value: Verbosity): void;
    /** The intention field of the mode on screen. */
    setIntention(text: string): void;
    /** Exploration's special requests field, as it stands (typed or said). */
    specialRequests(): string;
    setSpecialRequests(text: string): void;
    setCheckins(on: boolean): void;
}

const VERBOSITY_ORDER: readonly Verbosity[] = ['low', 'medium', 'high'];

function withValue<T>(list: readonly T[], value: T, on: boolean): T[] {
    const without = list.filter((v) => v !== value);
    return on ? [...without, value] : without;
}

/** One more request on its own line, after whatever the field holds; one
 *  already there, said again, is not doubled. */
function withRequest(field: string, request: string): string {
    const said = request.trim().toLowerCase();
    if (field.split('\n').some((line) => line.trim().toLowerCase() === said)) return field;
    const kept = field.trimEnd();
    return kept ? `${kept}\n${request.trim()}` : request.trim();
}

/**
 * Make one change. Never begins a session and never touches the microphone:
 * `stop-listening` and `help` come back as themselves for the listener to act
 * on.
 */
export function applySetupAction(form: SetupForm, action: SetupAction): SetupOutcome {
    const here = form.mode();
    const modes = setupActionModes(action);
    if (modes && !modes.includes(here)) {
        return { kind: 'elsewhere', mode: modes.length === 1 ? modes[0]! : null };
    }

    switch (action.kind) {
        case 'mode':
            if (!form.selectMode(action.mode)) return { kind: 'unavailable' };
            return { kind: 'mode', mode: form.mode() };
        case 'length':
            return { kind: 'length', minutes: form.setTimer(action.minutes) };
        case 'no-timer':
            form.clearTimer();
            return { kind: 'no-timer' };
        case 'focus': {
            const on = action.on === 'toggle' ? !form.focuses().includes(action.focus) : action.on;
            form.setFocuses(withValue(form.focuses(), action.focus, on));
            return { kind: 'focus', focus: action.focus, on };
        }
        case 'quality': {
            const on = action.on === 'toggle' ? !form.qualities().includes(action.quality) : action.on;
            form.setQualities(withValue(form.qualities(), action.quality, on));
            return { kind: 'quality', quality: action.quality, on };
        }
        case 'clear':
            if (action.group === 'focus') form.setFocuses([]);
            else form.setQualities([]);
            return { kind: 'cleared', group: action.group };
        case 'guidance': {
            const from = form.guidance();
            const to = action.to === 'up' ? from + 1 : action.to === 'down' ? from - 1 : action.to;
            form.setGuidance(Math.max(1, Math.min(GUIDANCE_STOPS, Math.round(to))));
            return { kind: 'guidance', level: form.guidance() };
        }
        case 'verbosity': {
            const at = VERBOSITY_ORDER.indexOf(form.verbosity());
            const to =
                action.to === 'up'
                    ? VERBOSITY_ORDER[Math.min(VERBOSITY_ORDER.length - 1, at + 1)]!
                    : action.to === 'down'
                      ? VERBOSITY_ORDER[Math.max(0, at - 1)]!
                      : action.to;
            form.setVerbosity(to);
            return { kind: 'verbosity', value: form.verbosity() };
        }
        case 'intention':
            form.setIntention(action.text);
            return { kind: 'intention', set: action.text !== '' };
        case 'intention-ask':
            return { kind: 'intention-ask' };
        case 'special-request':
            form.setSpecialRequests(action.text === '' ? '' : withRequest(form.specialRequests(), action.text));
            return { kind: 'special-request', added: action.text !== '' };
        case 'special-request-ask':
            return { kind: 'special-request-ask' };
        case 'clock':
            if (action.timerOff) form.clearTimer();
            form.setClockVisible(action.show);
            return action.timerOff ? { kind: 'clock', show: action.show, off: true } : { kind: 'clock', show: action.show };
        case 'clock-mode':
            form.setClockMode(action.mode);
            return { kind: 'clock-mode', mode: action.mode };
        case 'voice-picker':
            return { kind: 'voice-picker' };
        case 'checkins':
            form.setCheckins(action.on);
            return { kind: 'checkins', on: action.on };
        case 'stop-listening':
            return { kind: 'stop-listening' };
        case 'help':
            return { kind: 'help' };
    }
}

/**
 * A whole request. The mode goes first, wherever it was said: "playful
 * exploration" said under Noting means the vibe for the mode being switched
 * to, not for the one being left. The rest keeps the order it was said in.
 */
export function applySetupActions(form: SetupForm, actions: readonly SetupAction[]): SetupOutcome[] {
    const modesFirst = [...actions.filter((a) => a.kind === 'mode'), ...actions.filter((a) => a.kind !== 'mode')];
    return modesFirst.map((action) => applySetupAction(form, action));
}

/**
 * The setup form's changes as named actions, so a request made by voice
 * (core setup-command.ts) goes through the same door as a click and comes back
 * with what the form now says (SetupOutcome), which is what gets spoken.
 *
 * The view owns the form (views/setup.ts implements SetupForm over its state
 * and its DOM); this decides what an action means against it: which mode a
 * setting belongs to, where a stepper stops, what "change the vibe to" clears.
 * Voice, model, provider and speech recognition are not here: those stay
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
    focuses(): readonly SetupFocus[];
    setFocuses(list: SetupFocus[]): void;
    qualities(): readonly Quality[];
    setQualities(list: Quality[]): void;
    /** The guidance slider's stop, 0 to GUIDANCE_STOPS - 1. */
    guidance(): number;
    setGuidance(step: number): void;
    verbosity(): Verbosity;
    setVerbosity(value: Verbosity): void;
    /** The intention field of the mode on screen. */
    setIntention(text: string): void;
    setCheckins(on: boolean): void;
}

const VERBOSITY_ORDER: readonly Verbosity[] = ['low', 'medium', 'high'];

function withValue<T>(list: readonly T[], value: T, on: boolean): T[] {
    const without = list.filter((v) => v !== value);
    return on ? [...without, value] : without;
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
        case 'focus':
            form.setFocuses(withValue(form.focuses(), action.focus, action.on));
            return { kind: 'focus', focus: action.focus, on: action.on };
        case 'quality':
            form.setQualities(withValue(form.qualities(), action.quality, action.on));
            return { kind: 'quality', quality: action.quality, on: action.on };
        case 'clear':
            if (action.group === 'focus') form.setFocuses([]);
            else form.setQualities([]);
            return { kind: 'cleared', group: action.group };
        case 'guidance': {
            const from = form.guidance();
            const to = action.to === 'up' ? from + 1 : action.to === 'down' ? from - 1 : action.to;
            form.setGuidance(Math.max(0, Math.min(GUIDANCE_STOPS - 1, Math.round(to))));
            return { kind: 'guidance', step: form.guidance() };
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
        case 'checkins':
            form.setCheckins(action.on);
            return { kind: 'checkins', on: action.on };
        case 'stop-listening':
            return { kind: 'stop-listening' };
        case 'help':
            return { kind: 'help' };
    }
}

/** A whole request, in the order it was said. */
export function applySetupActions(form: SetupForm, actions: readonly SetupAction[]): SetupOutcome[] {
    return actions.map((action) => applySetupAction(form, action));
}

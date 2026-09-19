/**
 * Telling people the voice commands exist (core voice-command.ts), without a
 * manual and without toasts. Everything rides the session's status line, which
 * is where eyes already go:
 *
 * - For the first few hosted sessions on a device, "Listening…" carries an
 *   invitation to ask for the list.
 * - Doing by hand something that has a command (the speed slider, the timer
 *   picker, the mute button) puts what to say in the status line, once per
 *   control. It teaches the one command that person just showed they want.
 *
 * Storage unavailable reads as "already seen": a hint that can't remember it
 * was shown would show forever.
 */

const KEY_PREFIX = 'aloud:voiceHint:';

/** 'enable' is the one shown where commands are off (a BYOK/local sit that
 *  hasn't opted in): whichever control they reached for, once. */
export type VoiceHintId = 'speed' | 'timer' | 'mute' | 'enable';

/** True the first time only. */
export function claimVoiceHint(id: VoiceHintId): boolean {
    try {
        if (localStorage.getItem(KEY_PREFIX + id)) return false;
        localStorage.setItem(KEY_PREFIX + id, '1');
        return true;
    } catch {
        return false;
    }
}

/** Sessions that open with the invitation in the status line. */
export const INTRO_SESSIONS = 3;

/** Call once per hosted session: true while this is one of the first few. */
export function claimIntroSession(): boolean {
    try {
        const seen = Number(localStorage.getItem(KEY_PREFIX + 'introSessions')) || 0;
        if (seen >= INTRO_SESSIONS) return false;
        localStorage.setItem(KEY_PREFIX + 'introSessions', String(seen + 1));
        return true;
    } catch {
        return false;
    }
}

// English source strings; callers pass them through t().

// The phrase has to survive mediocre speech-to-text: "list voice commands" came
// back as "this device commands". Plain words, nothing that rhymes with noise.

export const LISTENING_WITH_INVITE = 'Listening… or ask "what can I say?"';

export const VOICE_HINT_TEXT: Record<VoiceHintId, string> = {
    speed: 'You can just say "talk slower" or "faster"',
    timer: 'You can just say "set a timer for ten minutes"',
    mute: 'Muted. You can just say "mute"',
    enable: 'Voice commands can do this. Turn them on under ⓘ',
};

/** The list behind the info panel's row: things to say, one per line. */
export const VOICE_COMMAND_EXAMPLES: readonly string[] = [
    '"Talk slower" / "talk faster"',
    '"Respond sooner" / "wait longer"',
    '"Say that again"',
    '"Set a timer for ten minutes"',
    '"Five more minutes" / "cancel the timer"',
    '"How much time is left?"',
    '"Mute"',
];

/** The list's last line offers whichever override isn't already the default. */
export const END_EXAMPLE_WHEN_SAVING = '"End the session" / "end without saving"';
export const END_EXAMPLE_WHEN_NOT_SAVING = '"End the session" / "end and save"';

export function endExampleFor(savesByDefault: boolean): string {
    return savesByDefault ? END_EXAMPLE_WHEN_SAVING : END_EXAMPLE_WHEN_NOT_SAVING;
}

/** Under the list: the examples are not a syntax. */
export const VOICE_COMMANDS_NOTE =
  'These understand natural language, so phrasing is flexible.';

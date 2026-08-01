/**
 * Session timer: "I have twenty minutes" without a harsh alarm.
 *
 * The countdown itself is UI. What makes it a meditation timer rather than an
 * egg timer is that the facilitator lands it in voice: a gentle notice as the
 * time approaches, and a closing line when it completes. Both ride the smart
 * check-in machinery (a synthetic bracketed event turn, one short reply, canned
 * fallback when the reply is unusable), so a weak model degrades to a stock
 * line instead of saying nothing.
 *
 * Two rules the callers must honor, because they are what make a timer a timer:
 *   - the completion event fires even in [HOLD] silence mode. Silence mode
 *     suppresses everything else; a timer that can be suppressed is not one.
 *   - the model may [PASS] on the approach notice (it can read the room), but
 *     never on completion - a pass there falls back to a canned line.
 */

import { PASS_PREFIX, SMART_CHECKIN_EVENT_PREFIX } from './smart-checkin.js';

/** Stable opener of every synthetic timer event turn (see isSessionTimerEvent). */
export const SESSION_TIMER_EVENT_PREFIX = '[Timer:';

/** Longest reply still spoken as a timer line. Roomier than a check-in: a
 *  closing word is allowed a couple of sentences. */
export const SESSION_TIMER_MAX_CHARS = 400;

/** Selectable timer lengths, in minutes. The modal offers these as one tap and
 *  takes any other whole number by hand. */
export const SESSION_TIMER_PRESETS: readonly number[] = [5, 10, 15, 20, 30, 45, 60];

/** Bounds for a hand-entered duration. */
export const SESSION_TIMER_MIN_MINUTES = 1;
export const SESSION_TIMER_MAX_MINUTES = 480;

/** True for synthetic timer event turns, so transcript renderers skip them. */
export function isSessionTimerEvent(text: string): boolean {
    return text.trimStart().startsWith(SESSION_TIMER_EVENT_PREFIX);
}

/** True for any synthetic (non-spoken) user turn: check-in or timer event. */
export function isSyntheticEventTurn(text: string): boolean {
    const t = text.trimStart();
    return t.startsWith(SMART_CHECKIN_EVENT_PREFIX) || t.startsWith(SESSION_TIMER_EVENT_PREFIX);
}

/**
 * How long before the end the approach notice fires.
 *
 * A fixed lead misses: if the meditator is taking 90 seconds a turn, a one
 * minute notice can fall entirely inside a silence and never be spoken before
 * the completion line lands on top of it. So the duration-based base is raised
 * to at least one full turn plus a margin, and capped at a third of the sit so
 * a short timer's notice can't arrive before the session has settled.
 *
 * Returns 0 for sits too short to be worth warning about, meaning "no notice".
 */
export function timerApproachLeadSec(totalSec: number, avgTurnSec: number | null): number {
    const base =
        totalSec >= 20 * 60 ? 180 : totalSec >= 10 * 60 ? 120 : totalSec >= 5 * 60 ? 60 : 0;
    if (base === 0) return 0;
    const turnFloor = avgTurnSec !== null && avgTurnSec > 0 ? avgTurnSec * 1.3 : 0;
    return Math.round(Math.min(Math.max(base, turnFloor), totalSec / 3));
}

/** Minutes, spoken the way a person would say them. */
function minutesPhrase(sec: number): string {
    const mins = Math.round(sec / 60);
    if (mins <= 1) return 'about a minute';
    return `about ${mins} minutes`;
}

export interface TimerEventOptions {
    /** A staged mode (felt sense): the model can move the arc with [NEXT]
     *  rather than only changing what it says. */
    staged?: boolean;
    /** The meditator asked for the session to end when the time is up, so this
     *  closing word is the last thing they hear - it should sound like one. */
    endsSession?: boolean;
}

/**
 * The synthetic user-role turn for the approach notice. Deliberately does not
 * ask the model to announce a number: "you have three minutes left" is the
 * alarm-clock version. It asks for a turn toward closing, which the meditator
 * feels rather than gets told.
 */
export function buildTimerApproachEvent(
    remainingSec: number,
    totalMin: number,
    opts: TimerEventOptions = {}
): string {
    const staged = opts.staged
        ? ' If the practice has a further stage that fits the time left, you may move to it with [NEXT].'
        : '';
    return (
        `${SESSION_TIMER_EVENT_PREFIX} ${minutesPhrase(remainingSec)} remain of a ` +
        `${totalMin} minute sit. The meditator set this length in advance; this ` +
        `message is automatic and they have not spoken. If it fits, begin drawing ` +
        `gently toward a close. Do not announce the time or count it down. ` +
        `If it would interrupt something live, reply with exactly ${PASS_PREFIX}.${staged}]`
    );
}

/**
 * The synthetic user-role turn for completion. No [PASS] offered: the one thing
 * the meditator asked for is to be told when the time is up.
 */
export function buildTimerCompletionEvent(
    totalMin: number,
    opts: TimerEventOptions = {}
): string {
    const staged = opts.staged
        ? ' You may close out the current stage rather than opening a new one.'
        : '';
    // Whether the sit stops here changes what a good closing word is, so the
    // model is told which it is. The one thing both share: say the time is up.
    const ending = opts.endsSession
        ? `The session ends after you speak - this is the last thing they will ` +
          `hear from you, so close it properly and do not ask a question.`
        : `The session doesn't automatically close so don't say goodbye, but ` +
          `also don't ask a question that needs an answer.`;
    return (
        `${SESSION_TIMER_EVENT_PREFIX} the ${totalMin} minutes the meditator set ` +
        `are complete. This message is automatic; they have not spoken. Offer a ` +
        `short closing word and let them come back in their own time. ` +
        `${ending}${staged}]`
    );
}

/** Spoken when the model's approach reply is unusable. */
export const TIMER_APPROACH_FALLBACKS: readonly string[] = [
    'We have a little time left. Let it settle where it is.',
    "There's a few minutes left. No need to do anything with them.",
    'Coming toward the end now. Stay with whatever is here.',
];

/** Spoken when the model's completion reply is unusable, or it tries to pass. */
export const TIMER_COMPLETION_FALLBACKS: readonly string[] = [
    "That's your time. Come back whenever you're ready.",
    'The time you set is complete. Take as long as you like coming back.',
    "That's the end of your sit. No hurry.",
];

/** Spoken instead of TIMER_COMPLETION_FALLBACKS when the sit ends here: the
 *  session is about to close, so the line has to sound like the end of it. */
export const TIMER_CLOSE_FALLBACKS: readonly string[] = [
    "That's your time. I'll leave you here.",
    'The time you set is up. Stopping there.',
    "That's the end of your sit. Take your time.",
];

/** Pick a fallback line, varying by index so a repeat sit isn't identical. */
export function pickTimerFallback(pool: readonly string[], index: number): string {
    return pool[Math.abs(index) % pool.length] as string;
}

/**
 * Smart check-ins: LLM-generated, context-sensitive lines for long silences.
 *
 * Where a simple check-in speaks a stock phrase unconditionally, this sends the
 * session so far plus a synthetic bracketed "event" turn describing the silence,
 * and the model either offers one short line or replies [PASS]. The [PASS] option
 * is why this exists: a model with context can respect "I'm going to sit with my
 * breath for ten minutes now" where a canned phrase would barge in.
 *
 * A reply that is empty, unparseable, or too long falls back to the canned pool,
 * so weak models degrade to the simple behavior.
 *
 * On a spoken check-in the caller records BOTH the event turn and the reply: the
 * event keeps user/assistant alternation valid for strict providers and tells
 * later turns why the facilitator spoke unprompted. A pass or fallback records
 * nothing. isSmartCheckinEvent lets transcript views skip event turns.
 */

import type { LLMProvider, Message } from '../llm/index.js';
import { llmUsageOf, type LlmUsage } from './session.js';
import { matchWaitToken, scrubControlTokens } from './modes.js';
import { HOLD_PREFIX } from './prompts.js';
import { stripThinkTags } from './strip-think-tags.js';

/** Literal token: the model declines to check in and keeps the silence. */
export const PASS_PREFIX = '[PASS]';

/** Stable opener of every synthetic event turn (see isSmartCheckinEvent). */
export const SMART_CHECKIN_EVENT_PREFIX = '[Check-in:';

/** Longest reply (after token stripping) still spoken as a check-in. Beyond
 *  this: try the first sentence, then the canned pool. A paragraph mid-silence
 *  is a weak model rambling, not a check-in. */
export const SMART_CHECKIN_MAX_CHARS = 240;

/** Generation cap. Roomy enough for open-weights models that spend tokens in
 *  <think> blocks before the one-liner. */
export const SMART_CHECKIN_MAX_TOKENS = 350;

/** True for synthetic check-in event turns, so transcript renderers (resume
 *  replay, history view) can skip them. */
export function isSmartCheckinEvent(text: string): boolean {
    return text.trimStart().startsWith(SMART_CHECKIN_EVENT_PREFIX);
}

export interface SmartCheckinEventOptions {
    /** Smart timing on: remind the model it can reschedule with [WAIT:Nm]. */
    withWaitHint?: boolean;
    /** How much the line may steer, from the guidance slider: presence only
     *  ('none'); presence or a suggestion, the model's call ('offered'); a
     *  suggestion or observation expected ('expected'). Check-ins are minutes
     *  apart, so a suggestion in the first one is not overbearing, and it is
     *  the way in for someone who doesn't know what to do. */
    suggestion?: CheckinSuggestion;
    /** The model answered the previous check-in with [PASS], this many seconds
     *  ago. Null or omitted when it spoke, and on the first of a stretch. */
    passedSecAgo?: number | null;
}

export type CheckinSuggestion = 'none' | 'offered' | 'expected';

const SUGGESTION_ASKS: Record<CheckinSuggestion, string> = {
    none: 'If a brief word would support their practice right now, reply with one short sentence.',
    offered:
        'If a brief word would support their practice right now, reply with one short sentence: presence, or if it would help more (they may not know what to do), a suggestion or one thing to notice.',
    expected:
        'If a word would support their practice right now, offer it: an observation, a suggestion, or a possible next step, in a sentence or two.',
};

/** The tier for a guidance level (DIRECTIVENESS_VALUES 0/3/5/7/10, or a pace
 *  slider mapped onto it): Directing expects a suggestion, Following never
 *  steers, and everything between leaves it to the model from the first
 *  check-in. */
export function checkinSuggestionFor(directiveness: number): CheckinSuggestion {
    return directiveness >= 9 ? 'expected' : directiveness >= 3 ? 'offered' : 'none';
}

function aboutMinutes(sec: number): string {
    const mins = Math.round(sec / 60);
    return mins < 2 ? 'about a minute' : `about ${mins} minutes`;
}

/**
 * The synthetic user-role turn for one check-in. `checkinIndex` is 1-based
 * among the check-ins SPOKEN in the current silence stretch; it tells the
 * model how many went unanswered so its tone can shift, or it can pass.
 *
 * A pass leaves no trace in the conversation, so this turn is the only place
 * the model can learn it already passed. Told nothing, it reads the same
 * transcript and passes again every time; told (as it once was) that a pass
 * was a check-in "with no reply", it passes and stretches the wait. Hence the
 * plain account in `passedSecAgo`, and the bar for a second pass: silence the
 * meditator asked for, not silence the model merely preferred a while ago.
 * Measured on the default model, 2026-10-11 (meditation-pal-v85a).
 */
export function buildSmartCheckinEvent(
    silenceSec: number,
    checkinIndex: number,
    opts: SmartCheckinEventOptions = {}
): string {
    const dur = aboutMinutes(silenceSec);
    const prior =
        checkinIndex > 1
            ? ` You have checked in ${checkinIndex - 1} time${checkinIndex > 2 ? 's' : ''} already with no reply.`
            : '';
    let passed = '';
    if (opts.passedSecAgo !== null && opts.passedSecAgo !== undefined) {
        passed = ` You stayed quiet at the last check-in, ${aboutMinutes(opts.passedSecAgo)} ago`;
        // After an unanswered spoken check-in, quiet is a fair reading again.
        passed +=
            checkinIndex > 1
                ? '.'
                : ', so nothing has been said since your last reply. Stay quiet again only if they asked for silence or for space.';
    }
    const ask = SUGGESTION_ASKS[opts.suggestion ?? 'none'];
    const waitHint = opts.withWaitHint
        ? ' Either way you may prefix [WAIT:Nm] to set when the next check-in may happen.'
        : '';
    return (
        `${SMART_CHECKIN_EVENT_PREFIX} the meditator has been quiet for ${dur}. ` +
        `They have not spoken; this message is automatic.${prior}${passed} ` +
        `${ask} ` +
        `If staying quiet serves them better, reply with exactly ${PASS_PREFIX}.${waitHint}]`
    );
}

export type SmartCheckinReply =
    /** Speak this line, record event + line in history. */
    | { kind: 'speak'; text: string; waitSec: number | null }
    /** The model chose silence: say nothing, record nothing. */
    | { kind: 'pass'; waitSec: number | null }
    /** Unusable reply: speak a canned line instead, record nothing. */
    | { kind: 'fallback' };

/**
 * Parse the model's check-in reply, stripping leading control tokens: [PASS]
 * and [HOLD] both mean "stay quiet" (real silence mode needs user confirmation,
 * which a check-in can't get), [WAIT:Nm] reschedules the next check-in, and
 * stray [NEXT]/[BACK] are dropped rather than spoken. Misplaced known tokens
 * are scrubbed mid-text, and a bare unbracketed "pass" (a small model flubbing
 * the format) counts as a pass rather than being said into the silence.
 */
export function parseSmartCheckinReply(
    raw: string,
    maxChars: number = SMART_CHECKIN_MAX_CHARS
): SmartCheckinReply {
    let text = stripThinkTags(raw).trim();
    let pass = false;
    let waitSec: number | null = null;
    for (;;) {
        const wait = matchWaitToken(text);
        if (wait) {
            if (waitSec === null) waitSec = wait.seconds;
            text = text.slice(wait.length).trimStart();
            continue;
        }
        const m = /^\[[A-Z]+\]/.exec(text.toUpperCase());
        if (!m) break;
        const token = m[0];
        if (token === PASS_PREFIX || token === HOLD_PREFIX) pass = true;
        text = text.slice(token.length).trimStart();
    }
    text = scrubControlTokens(text);
    if (pass || /^["']?pass[."'!]*$/i.test(text)) return { kind: 'pass', waitSec };
    if (!text) return { kind: 'fallback' };
    if (text.length <= maxChars) return { kind: 'speak', text, waitSec };
    // Too long: salvage the first sentence if it stands alone as a line.
    const sentence = /^[\s\S]*?[.!?…]+(?=\s|$)/.exec(text)?.[0]?.trim();
    if (sentence && sentence.length <= maxChars) {
        return { kind: 'speak', text: sentence, waitSec };
    }
    return { kind: 'fallback' };
}

export interface SmartCheckinResult {
    reply: SmartCheckinReply;
    usage: LlmUsage;
}

/**
 * One check-in round-trip: history + event turn → model → parsed reply. The
 * caller passes `messages` WITH the event turn already appended (it decides
 * whether to persist it) and the session's normal system prompt, so mode,
 * phase, and qualities shape the line and the cached prefix is reused. Throws
 * what the provider throws; callers treat any error as 'fallback'.
 */
export async function runSmartCheckin(
    provider: LLMProvider,
    messages: Message[],
    options: { system?: string; signal?: AbortSignal; maxChars?: number } = {}
): Promise<SmartCheckinResult> {
    const result = await provider.complete(messages, {
        maxTokens: SMART_CHECKIN_MAX_TOKENS,
        ...(options.system !== undefined && { system: options.system }),
        ...(options.signal !== undefined && { signal: options.signal }),
    });
    return {
        reply: parseSmartCheckinReply(result.text, options.maxChars),
        usage: llmUsageOf(result),
    };
}

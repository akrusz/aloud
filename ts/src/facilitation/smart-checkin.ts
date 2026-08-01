/**
 * Smart check-ins: LLM-generated, context-sensitive lines for long silences.
 *
 * Where a simple check-in speaks a stock phrase unconditionally, this sends the
 * session so far plus a synthetic bracketed "event" turn describing the silence,
 * and the model either offers one short line or replies [PASS]. The pass is the
 * point: a model with context can honor "I'm going to sit with my breath for ten
 * minutes now" where a canned phrase would barge in.
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
import type { LlmUsage } from './session.js';
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
    /** High guidance-level session: invite substance (an observation or
     *  suggestion), not just a word of presence. */
    directive?: boolean;
}

/**
 * The synthetic user-role turn for one check-in. `checkinIndex` is 1-based
 * within the current silence stretch; it tells the model how many went
 * unanswered so its tone can shift, or it can pass.
 */
export function buildSmartCheckinEvent(
    silenceSec: number,
    checkinIndex: number,
    opts: SmartCheckinEventOptions = {}
): string {
    const mins = Math.round(silenceSec / 60);
    const dur = mins < 2 ? 'about a minute' : `about ${mins} minutes`;
    const prior =
        checkinIndex > 1
            ? ` You have checked in ${checkinIndex - 1} time${checkinIndex > 2 ? 's' : ''} already with no reply.`
            : '';
    const ask = opts.directive
        ? 'If a word would support their practice right now, offer it: an observation, a suggestion, or a possible next step, in a sentence or two.'
        : 'If a brief word would support their practice right now, reply with one short sentence.';
    const waitHint = opts.withWaitHint
        ? ' Either way you may prefix [WAIT:Nm] to set when the next check-in may happen.'
        : '';
    return (
        `${SMART_CHECKIN_EVENT_PREFIX} the meditator has been quiet for ${dur}. ` +
        `They have not spoken; this message is automatic.${prior} ` +
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
        usage: {
            tokensIn: result.inputTokens ?? null,
            tokensOut: result.outputTokens ?? null,
            cacheRead: result.cacheReadTokens ?? null,
            cacheCreation: result.cacheCreationTokens ?? null,
            cacheCreation1h: result.cacheCreation1hTokens ?? null,
        },
    };
}

/**
 * Smart check-ins: LLM-generated, context-sensitive lines for long silences.
 *
 * The simple check-in speaks a stock phrase from a pool, unconditionally.
 * A smart check-in instead sends the session so far plus a synthetic,
 * bracketed "event" turn describing the silence, and lets the model either
 * offer one short line that fits where the session left off or reply [PASS]
 * to keep the silence. The pass option is the point: a model with context
 * can honor "I'm going to sit with my breath for ten minutes now" where a
 * canned phrase would barge in.
 *
 * Degrades gracefully on weak models: a reply that is empty, unparseable, or
 * too long to be a check-in falls back to the canned pool ('fallback'), so
 * the worst case is exactly the simple behavior.
 *
 * On a spoken check-in the caller records BOTH the event turn and the reply
 * in session history — the event keeps user/assistant alternation valid for
 * strict providers and tells later turns why the facilitator spoke
 * unprompted. On a pass (or fallback) nothing is recorded. Event turns are
 * recognizable via isSmartCheckinEvent so transcript views can skip them.
 */

import type { LLMProvider, Message } from '../llm/index.js';
import type { LlmUsage } from './session.js';
import { HOLD_PREFIX } from './prompts.js';
import { stripThinkTags } from './strip-think-tags.js';

/** Literal token: the model declines to check in and keeps the silence. */
export const PASS_PREFIX = '[PASS]';

/** Stable opener of every synthetic event turn (see isSmartCheckinEvent). */
export const SMART_CHECKIN_EVENT_PREFIX = '[Check-in:';

/** Longest reply (after token stripping) still spoken as a check-in. Beyond
 *  this we try the first sentence, then fall back to the canned pool — a
 *  paragraph mid-silence is a weak model rambling, not a check-in. */
export const SMART_CHECKIN_MAX_CHARS = 240;

/** Generation cap for the check-in call. Roomy enough for open-weights
 *  models that spend tokens in <think> blocks before the one-liner. */
export const SMART_CHECKIN_MAX_TOKENS = 350;

/** True for history user-turns that are synthetic check-in events, so
 *  transcript renderers (resume replay, history view) can skip them. */
export function isSmartCheckinEvent(text: string): boolean {
    return text.trimStart().startsWith(SMART_CHECKIN_EVENT_PREFIX);
}

/**
 * The synthetic user-role turn sent (and, when the model speaks, recorded)
 * for one check-in. `checkinIndex` is 1-based within the current silence
 * stretch; later check-ins tell the model how many went unanswered so its
 * tone can shift (or it can pass).
 */
export function buildSmartCheckinEvent(silenceSec: number, checkinIndex: number): string {
    const mins = Math.round(silenceSec / 60);
    const dur = mins < 2 ? 'about a minute' : `about ${mins} minutes`;
    const prior =
        checkinIndex > 1
            ? ` You have checked in ${checkinIndex - 1} time${checkinIndex > 2 ? 's' : ''} already with no reply.`
            : '';
    return (
        `${SMART_CHECKIN_EVENT_PREFIX} the meditator has been quiet for ${dur}. ` +
        `They have not spoken; this message is automatic.${prior} ` +
        `If a brief word would support their practice right now, reply with one short sentence. ` +
        `If staying quiet serves them better, reply with exactly ${PASS_PREFIX}.]`
    );
}

export type SmartCheckinReply =
    /** Speak this line, record event + line in history. */
    | { kind: 'speak'; text: string }
    /** The model chose silence — say nothing, record nothing. */
    | { kind: 'pass' }
    /** Unusable reply — speak a canned line instead, record nothing. */
    | { kind: 'fallback' };

/**
 * Parse the model's check-in reply. Leading bracketed control tokens are
 * stripped ([PASS] and [HOLD] both mean "stay quiet" — entering real silence
 * mode needs the user's confirmation, which a check-in can't get; stray
 * [NEXT]/[BACK] and the like are ignored rather than spoken).
 */
export function parseSmartCheckinReply(raw: string): SmartCheckinReply {
    let text = stripThinkTags(raw).trim();
    let pass = false;
    for (;;) {
        const m = /^\[[A-Z]+\]/.exec(text.toUpperCase());
        if (!m) break;
        const token = m[0];
        if (token === PASS_PREFIX || token === HOLD_PREFIX) pass = true;
        text = text.slice(token.length).trimStart();
    }
    if (pass) return { kind: 'pass' };
    if (!text) return { kind: 'fallback' };
    if (text.length <= SMART_CHECKIN_MAX_CHARS) return { kind: 'speak', text };
    // Too long — salvage the first sentence if it stands alone as a line.
    const sentence = /^[\s\S]*?[.!?…]+(?=\s|$)/.exec(text)?.[0]?.trim();
    if (sentence && sentence.length <= SMART_CHECKIN_MAX_CHARS) {
        return { kind: 'speak', text: sentence };
    }
    return { kind: 'fallback' };
}

export interface SmartCheckinResult {
    reply: SmartCheckinReply;
    usage: LlmUsage;
}

/**
 * One check-in round-trip: history + event turn → model → parsed reply.
 * The caller supplies `messages` WITH the event turn appended (it decides
 * whether/when to persist that turn) and the session's normal system prompt,
 * so mode, phase, and qualities shape the line and the cached prefix is
 * reused. Throws what the provider throws — callers treat any error as
 * 'fallback'.
 */
export async function runSmartCheckin(
    provider: LLMProvider,
    messages: Message[],
    options: { system?: string; signal?: AbortSignal } = {}
): Promise<SmartCheckinResult> {
    const result = await provider.complete(messages, {
        maxTokens: SMART_CHECKIN_MAX_TOKENS,
        ...(options.system !== undefined && { system: options.system }),
        ...(options.signal !== undefined && { signal: options.signal }),
    });
    return {
        reply: parseSmartCheckinReply(result.text),
        usage: {
            tokensIn: result.inputTokens ?? null,
            tokensOut: result.outputTokens ?? null,
            cacheRead: result.cacheReadTokens ?? null,
            cacheCreation: result.cacheCreationTokens ?? null,
            cacheCreation1h: result.cacheCreation1hTokens ?? null,
        },
    };
}

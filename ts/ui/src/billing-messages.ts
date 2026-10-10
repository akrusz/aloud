/**
 * Client-side mirror of the server's canned billing copy + signals
 * (ts/server/src/admin/runtime-config.ts), kept in sync by hand. The bubble uses
 * the text here; the matching audio is synthesized server-side from the same
 * constants (/tts/canned), so keep these IDENTICAL to the server's
 * CANNED_MESSAGES or the spoken and shown words drift.
 */

import { purchaseChannel } from './purchase-channel.js';

export type CannedReason = 'paused' | 'insufficient_credits' | 'insufficient_credits_plain';

export const FREE_LIMIT_MESSAGE =
    "Apologies, but we've reached the limit of free credit usage. Please try back later.";

export const OUT_OF_CREDITS_MESSAGE =
    "We've used up the clouds for this session. Add more to keep going, or switch to a local or bring-your-own-key provider in settings.";

export const OUT_OF_CREDITS_PLAIN_MESSAGE = "We've used up the clouds for this session.";

/** The out-of-credits notice this build shows and speaks: the plain one where
 *  nothing is sold. `reason` picks the matching server-voiced clip. */
export function outOfCreditsNotice(): { reason: CannedReason; text: string } {
    return purchaseChannel() === 'none'
        ? { reason: 'insufficient_credits_plain', text: OUT_OF_CREDITS_PLAIN_MESSAGE }
        : { reason: 'insufficient_credits', text: OUT_OF_CREDITS_MESSAGE };
}

/** finishReason the cloud LLM proxy stamps on a soft-launch-pause canned turn.
 *  The session view keys off it to drop the turn from history and skip the buy
 *  prompt, since a top-up can't lift the pause. Mirrors the server constant. */
export const BILLING_PAUSED_FINISH = 'billing_paused';

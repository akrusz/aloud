/**
 * Client-side mirror of the server's canned billing copy + signals
 * (ts/server/src/admin/runtime-config.ts), kept in sync by hand. The bubble uses
 * the text here; the matching audio is synthesized server-side from the same
 * constants (/tts/canned), so keep these IDENTICAL to the server's
 * CANNED_MESSAGES or the spoken and shown words drift.
 */

export type CannedReason = 'paused' | 'insufficient_credits';

export const FREE_LIMIT_MESSAGE =
    "Apologies, but we've reached the limit of free credit usage. Please try back later, or buy credits to continue.";

export const OUT_OF_CREDITS_MESSAGE =
    "We've used up the clouds for this session. Add more to keep going, or switch to a local or bring-your-own-key provider in settings.";

/** finishReason the cloud LLM proxy stamps on a soft-launch-pause canned turn.
 *  The session view keys off it to drop the turn from history and skip the buy
 *  prompt, since a top-up can't lift the pause. Mirrors the server constant. */
export const BILLING_PAUSED_FINISH = 'billing_paused';

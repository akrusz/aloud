/**
 * Where a finished utterance goes during and around silence mode.
 *
 * Four handlers share one dispatch, and the order between them is load-bearing:
 * held silence outranks a pending hold-confirm, which outranks the re-entry
 * window. Kept pure and out of the listen loop so that precedence is testable
 * without a mic, a provider, or a DOM.
 */

/**
 * - `silence`      - buffer it; the resume classifier decides (rlgm, tv9u).
 * - `hold-confirm` - the reply to "shall I be quiet?".
 * - `rehold`       - just left a hold; check for "no, stay quiet" first (tv9u).
 * - `normal`       - an ordinary facilitation turn.
 */
export type UtteranceRoute = 'silence' | 'hold-confirm' | 'rehold' | 'normal';

export interface SilenceDispatchState {
    /** A silence is being held right now. */
    silenceMode: boolean;
    /** The facilitator asked "shall I be quiet?" and is awaiting the answer. */
    awaitingHoldConfirm: boolean;
    /** AppSettings.silenceModeEnabled: off means [HOLD] is ignored entirely. */
    silenceModeEnabled: boolean;
    /** Since the last hold ended. Infinity (or any large value) if never. */
    msSinceHoldEnded: number;
}

/**
 * How long after a hold ends an utterance is checked for "no, stay quiet"
 * before it can take a facilitation turn. Someone talked over by a wrong resume
 * says so immediately, so this only has to cover the unwanted reply plus their
 * reaction; past that, a request for silence is new and gets asked about
 * normally.
 */
export const HOLD_REENTRY_GRACE_MS = 60_000;

/** Pick the handler for one finished utterance. */
export function routeUtterance(
    state: SilenceDispatchState,
    graceMs: number = HOLD_REENTRY_GRACE_MS
): UtteranceRoute {
    if (state.silenceMode) return 'silence';
    if (state.awaitingHoldConfirm) return 'hold-confirm';
    if (state.silenceModeEnabled && state.msSinceHoldEnded < graceMs) return 'rehold';
    return 'normal';
}

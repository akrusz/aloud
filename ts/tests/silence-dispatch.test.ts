import { describe, it, expect } from 'vitest';

import {
    routeUtterance,
    HOLD_REENTRY_GRACE_MS,
    type SilenceDispatchState,
} from '../src/facilitation/silence-dispatch.js';

/** Nothing held, nothing pending, no hold this session. */
const idle: SilenceDispatchState = {
    silenceMode: false,
    awaitingHoldConfirm: false,
    silenceModeEnabled: true,
    msSinceHoldEnded: Number.POSITIVE_INFINITY,
};

describe('routeUtterance', () => {
    it('sends an ordinary utterance to a normal turn', () => {
        expect(routeUtterance(idle)).toBe('normal');
    });

    it('buffers everything while a silence is held', () => {
        expect(routeUtterance({ ...idle, silenceMode: true })).toBe('silence');
    });

    it('routes the answer to "shall I be quiet?" to the confirm classifier', () => {
        expect(routeUtterance({ ...idle, awaitingHoldConfirm: true })).toBe('hold-confirm');
    });

    it('checks for "no, stay quiet" inside the re-entry window', () => {
        expect(routeUtterance({ ...idle, msSinceHoldEnded: 1_000 })).toBe('rehold');
    });

    it('treats a request after the window as an ordinary turn', () => {
        expect(routeUtterance({ ...idle, msSinceHoldEnded: HOLD_REENTRY_GRACE_MS + 1 })).toBe(
            'normal'
        );
    });

    // The boundary is exclusive, so the window can't fire on a stale timestamp
    // that happens to land exactly on it.
    it('excludes the boundary itself', () => {
        expect(routeUtterance({ ...idle, msSinceHoldEnded: HOLD_REENTRY_GRACE_MS })).toBe('normal');
    });

    // Precedence: a held silence outranks both of the states that can be live
    // at the same moment, or an utterance meant for the buffer would take a
    // turn instead.
    it('prefers the held silence over a pending confirm', () => {
        const state = { ...idle, silenceMode: true, awaitingHoldConfirm: true };
        expect(routeUtterance(state)).toBe('silence');
    });

    it('prefers the held silence over the re-entry window', () => {
        const state = { ...idle, silenceMode: true, msSinceHoldEnded: 1_000 };
        expect(routeUtterance(state)).toBe('silence');
    });

    // enterHold() clears awaitingHoldConfirm, but a re-bid can land while the
    // window is still open; the confirm is the more specific question.
    it('prefers a pending confirm over the re-entry window', () => {
        const state = { ...idle, awaitingHoldConfirm: true, msSinceHoldEnded: 1_000 };
        expect(routeUtterance(state)).toBe('hold-confirm');
    });

    // With the setting off there is nothing to go back to, so the extra
    // classifier call would be pure latency.
    it('skips the re-entry check when silence mode is disabled', () => {
        const state = { ...idle, silenceModeEnabled: false, msSinceHoldEnded: 1_000 };
        expect(routeUtterance(state)).toBe('normal');
    });

    it('honours a caller-supplied window', () => {
        expect(routeUtterance({ ...idle, msSinceHoldEnded: 5_000 }, 1_000)).toBe('normal');
        expect(routeUtterance({ ...idle, msSinceHoldEnded: 500 }, 1_000)).toBe('rehold');
    });
});

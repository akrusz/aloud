/**
 * Whether the signed-in account is currently covered by a retreat pass
 * (meditation-pal-414), shared across the UI.
 *
 * A retreat attendee's usage is free for the pass window, so the surfaces that
 * normally nudge a user to spend — the setup cloud-rate pill, the account-page
 * Buy button, the optional in-session balance readout — read this and quietly
 * step aside. Fed by `/me` (cloud-auth.fetchMe); mirrors cloud-balance.ts.
 */

let covered = false;
const listeners = new Set<(covered: boolean) => void>();

/** Whether an active retreat pass currently covers this account. */
export function getRetreatCovered(): boolean {
    return covered;
}

/** Record coverage (from a `/me` reading) and notify if it changed. */
export function setRetreatCovered(value: boolean): void {
    if (value === covered) return;
    covered = value;
    for (const cb of [...listeners]) cb(covered);
}

/** Forget coverage on sign-out / account deletion. */
export function clearRetreatCovered(): void {
    setRetreatCovered(false);
}

/** Subscribe to coverage changes. Returns an unsubscribe fn. Does NOT fire
 *  immediately — read getRetreatCovered() for the current value. */
export function subscribeCoverage(cb: (covered: boolean) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

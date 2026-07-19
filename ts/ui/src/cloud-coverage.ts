/**
 * Whether a retreat pass currently covers the signed-in account
 * (meditation-pal-414), shared across the UI.
 *
 * An attendee's usage is free for the pass window, so the surfaces that nudge a
 * user to spend (setup rate pill, account Buy button, in-session balance) read
 * this and step aside. Fed by `/me`; mirrors cloud-balance.ts.
 */

let covered = false;
const listeners = new Set<(covered: boolean) => void>();

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

/** Returns an unsubscribe fn. Does NOT fire immediately; read
 *  getRetreatCovered() for the current value. */
export function subscribeCoverage(cb: (covered: boolean) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

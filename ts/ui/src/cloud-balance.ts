/**
 * Last-known cloud credit balance, shared across the UI (meditation-pal-14s).
 *
 * The metered LLM proxy returns the authoritative post-turn `creditsRemaining`
 * on every completion (see adapters/cloud-llm.ts), and `/me` returns it on
 * demand (cloud-auth.fetchMe). Rather than re-fetch to learn what we were just
 * told, both feed it here, and the surfaces that show a balance — the setup
 * pill, the settings account panel, the optional in-session readout — read from
 * here and can subscribe to live updates (e.g. the number ticking down mid-
 * session). null means "unknown" (signed out, or nothing observed yet).
 */

let known: number | null = null;
const listeners = new Set<(balance: number | null) => void>();

/** The most recent balance we've been told, or null if unknown. */
export function getKnownBalance(): number | null {
    return known;
}

/** Record an authoritative balance (from a completion or /me) and notify. */
export function setKnownBalance(balance: number): void {
    known = balance;
    for (const cb of [...listeners]) cb(known);
}

/** Forget the balance (on sign-out / account deletion) and notify. */
export function clearKnownBalance(): void {
    known = null;
    for (const cb of [...listeners]) cb(known);
}

/** Subscribe to balance changes. Returns an unsubscribe fn. Does NOT fire
 *  immediately — read getKnownBalance() for the current value. */
export function subscribeBalance(cb: (balance: number | null) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

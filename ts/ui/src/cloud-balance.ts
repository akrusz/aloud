/**
 * Last-known cloud credit balance, shared across the UI (meditation-pal-14s).
 *
 * The metered LLM proxy returns authoritative post-turn `creditsRemaining` on
 * every completion (adapters/cloud-llm.ts) and `/me` returns it on demand, so
 * both feed it here instead of surfaces re-fetching what we were just told.
 * Balance readouts (setup pill, account panel, in-session) read and subscribe
 * for live ticks. null means unknown: signed out, or nothing observed yet.
 */

let known: number | null = null;
const listeners = new Set<(balance: number | null) => void>();

export function getKnownBalance(): number | null {
    return known;
}

/** Record an authoritative balance (from a completion or /me) and notify. */
export function setKnownBalance(balance: number): void {
    known = balance;
    for (const cb of [...listeners]) cb(known);
}

/** Forget the balance on sign-out / account deletion. */
export function clearKnownBalance(): void {
    known = null;
    for (const cb of [...listeners]) cb(known);
}

/** Returns an unsubscribe fn. Does NOT fire immediately; read
 *  getKnownBalance() for the current value. */
export function subscribeBalance(cb: (balance: number | null) => void): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
}

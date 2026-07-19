/**
 * The current session's cloud grouping id (analytics).
 *
 * Every metered cloud call (LLM turn, STT pass, TTS synth) tags itself with this
 * so the admin cost report attributes them to one session exactly, instead of
 * inferring boundaries from time gaps. A fresh random token per session,
 * decoupled from the stored transcript id, carrying no content and no PII: the
 * server only groups calls for aggregate, anonymized stats.
 *
 * Null means no session is active (e.g. a Settings voice preview), in which case
 * calls send no id and fall back to server-side time-gap clustering.
 */

let current: string | null = null;

/** Mint and store a fresh group id, returning it. */
export function startCloudSession(): string {
    current = newId();
    return current;
}

export function getCloudSessionId(): string | null {
    return current;
}

/** Clear at session end (back to time-gap clustering). */
export function clearCloudSession(): void {
    current = null;
}

/** A random opaque token. Prefers crypto.randomUUID; falls back for old hosts. */
function newId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'cs-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

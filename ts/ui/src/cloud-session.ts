/**
 * The current meditation session's cloud grouping id (meditation-pal analytics).
 *
 * When a session is running, every metered cloud call (LLM turn, STT pass, TTS
 * synth) tags itself with this id so the server's admin cost report attributes
 * them all to one session exactly — instead of inferring session boundaries by
 * time gaps. It is a fresh random token per session, decoupled from the locally
 * stored transcript id, and carries NO content and NO PII: the server only ever
 * uses it to group calls for aggregate, anonymized stats.
 *
 * Mirrors the module-singleton shape of cloud-balance.ts. Null means "no session
 * is active" — e.g. a voice preview in Settings — in which case calls send no
 * id and fall back to the server's time-gap clustering.
 */

let current: string | null = null;

/** Start a new session group: mint and store a fresh random id, returning it. */
export function startCloudSession(): string {
    current = newId();
    return current;
}

/** The active session's grouping id, or null when no session is running. */
export function getCloudSessionId(): string | null {
    return current;
}

/** Clear the grouping id at session end (back to time-gap clustering). */
export function clearCloudSession(): void {
    current = null;
}

/** A random opaque token. Prefers crypto.randomUUID; falls back for old hosts. */
function newId(): string {
    const c = globalThis.crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    return 'cs-' + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

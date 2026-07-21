/**
 * Durable pointer to a session that is live but not cleanly ended, so a mobile
 * cold-boot (Android killing a backgrounded activity - meditation-pal-v73p) can
 * offer to resume it on relaunch.
 *
 * The pointer rides on the shared KV (Capacitor Preferences on native mobile,
 * localStorage elsewhere); the transcript itself is already autosaved by the
 * session view (autosaveSession). We only need the pointer because autosave
 * stamps a provisional endTime, so an interrupted session is indistinguishable
 * on disk from a cleanly-ended one. Set on each autosave, cleared on a clean
 * end (endSession) or an explicit "start new" dismiss.
 *
 * All writes are best-effort: a failed pointer write must never break a
 * session, and a missing pointer at boot simply means "nothing to resume".
 */

import { sharedKv } from './state.js';

const ACTIVE_SESSION_KEY = 'session:active';

export async function markSessionActive(sessionId: string): Promise<void> {
    try {
        await sharedKv.set(ACTIVE_SESSION_KEY, sessionId);
    } catch {
        /* best-effort; resume-on-crash is a convenience, not a guarantee */
    }
}

export async function clearActiveSession(): Promise<void> {
    try {
        await sharedKv.delete(ACTIVE_SESSION_KEY);
    } catch {
        /* best-effort */
    }
}

export async function getActiveSessionId(): Promise<string | null> {
    try {
        return (await sharedKv.get(ACTIVE_SESSION_KEY)) ?? null;
    } catch {
        return null;
    }
}

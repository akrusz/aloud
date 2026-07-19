/**
 * Retreat-pass coverage decision (meditation-pal-414): the one place the metered
 * routes (llm/stt/tts) ask "is this account covered right now?". A pass means
 * forward to the provider with NO hold or debit, but still record usage tagged
 * with the pass so the admin can attribute per-retreat spend. Null means meter
 * normally against the user's own balance.
 */

import type { CreditsStore, RetreatPass } from './store.js';

/** Trailing window for the per-attendee daily-cap backstop. Rolling 24h keeps it
 *  timezone-free; it's a cost guardrail, not a precise quota. */
export const RETREAT_CAP_WINDOW_SEC = 24 * 60 * 60;

/**
 * The pass covering this account's call right now, or null to meter normally.
 * A pass whose per-attendee daily cap is already spent over the trailing 24h
 * returns null (the backstop against a single runaway client), so the call
 * meters against the user's own balance instead.
 */
export async function activeRetreatCoverage(
    store: Pick<CreditsStore, 'activeRetreatPassForAccount' | 'usageCreditsSince'>,
    accountId: string,
    now: number
): Promise<RetreatPass | null> {
    const pass = await store.activeRetreatPassForAccount(accountId, now);
    if (!pass) return null;
    if (pass.perAttendeeDailyCap != null) {
        const spent = await store.usageCreditsSince(accountId, now - RETREAT_CAP_WINDOW_SEC);
        if (spent >= pass.perAttendeeDailyCap) return null;
    }
    return pass;
}

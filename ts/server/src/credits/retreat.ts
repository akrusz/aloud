/**
 * Retreat-pass coverage decision (meditation-pal-414). The single place the
 * metered routes (llm/stt/tts) ask "is this account covered by a retreat pass
 * right now?". When it returns a pass, the route forwards to the provider WITHOUT
 * holding or debiting credits — but still records usage (tagged with the pass) so
 * the admin can attribute per-retreat spend. When it returns null, the call
 * meters normally against the user's own balance.
 */

import type { CreditsStore, RetreatPass } from './store.js';

/** Trailing window for the per-attendee daily-cap backstop. A rolling 24h keeps
 *  it timezone-free and is plenty for a cost guardrail (not a precise quota). */
export const RETREAT_CAP_WINDOW_SEC = 24 * 60 * 60;

/**
 * The retreat pass covering this account's call right now, or null to meter
 * normally. A pass whose optional per-attendee daily cap is already spent over
 * the trailing 24h falls back to null — the backstop against a single runaway
 * client; the call then meters against the user's own balance instead.
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

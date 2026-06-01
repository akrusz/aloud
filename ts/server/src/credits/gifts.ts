/**
 * Gift-clouds logic (meditation-pal-bd5). A gift is funded by a CLEARED Stripe
 * payment, so the money is never "cancelled" — the purchased clouds are granted
 * exactly ONCE: to the recipient on accept, or back to the BUYER on decline /
 * 60-day expiry. Declining is therefore safe and refund-free.
 *
 * Exactly-once is enforced by `store.resolveGift`, an atomic compare-and-set that
 * only transitions a gift out of 'pending'. Whoever wins that transition is the
 * one (and only one) that grants the clouds — so a recipient accept racing the
 * expiry sweep can't double-grant.
 */

import type { Deps } from '../deps.js';
import type { Account, Gift } from './store.js';

/** Unaccepted gifts return to the buyer after this long. */
export const GIFT_EXPIRY_SECONDS = 60 * 24 * 3600; // 60 days

function norm(email: string): string {
    return email.trim().toLowerCase();
}

/** Pending, non-expired gifts addressed to this account's email. Expired ones
 *  are reconciled back to the buyer in passing, so they never show to a recipient. */
export async function pendingGiftsForAccount(deps: Deps, account: Account, now: number): Promise<Gift[]> {
    const gifts = await deps.store.getPendingGiftsForEmail(norm(account.email));
    const cutoff = now - GIFT_EXPIRY_SECONDS;
    const live: Gift[] = [];
    for (const g of gifts) {
        if (g.createdAt <= cutoff) {
            await returnToBuyer(deps, g, now, 'expired');
        } else {
            live.push(g);
        }
    }
    return live;
}

export type GiftResolution =
    | { ok: true; credits: number }
    | { ok: false; reason: 'not_found' | 'not_pending' | 'wrong_recipient' };

/** Accept a gift: grant its clouds to `account`. Guards that the gift is pending
 *  and addressed to this account's email; the atomic resolve makes the grant
 *  happen at most once. */
export async function acceptGift(
    deps: Deps,
    account: Account,
    giftId: string,
    now: number
): Promise<GiftResolution> {
    const gift = await deps.store.getGiftById(giftId);
    if (!gift) return { ok: false, reason: 'not_found' };
    if (gift.status !== 'pending') return { ok: false, reason: 'not_pending' };
    if (gift.recipientEmail !== norm(account.email)) return { ok: false, reason: 'wrong_recipient' };

    const won = await deps.store.resolveGift(gift.id, 'accepted', now);
    if (!won) return { ok: false, reason: 'not_pending' }; // lost the race
    await deps.ledger.purchase(account.id, gift.credits, `gift_accepted:${gift.id}`);
    return { ok: true, credits: gift.credits };
}

/** Decline a gift: the clouds go back to the BUYER (no refund). Same recipient +
 *  pending guards as accept. */
export async function declineGift(
    deps: Deps,
    account: Account,
    giftId: string,
    now: number
): Promise<GiftResolution> {
    const gift = await deps.store.getGiftById(giftId);
    if (!gift) return { ok: false, reason: 'not_found' };
    if (gift.status !== 'pending') return { ok: false, reason: 'not_pending' };
    if (gift.recipientEmail !== norm(account.email)) return { ok: false, reason: 'wrong_recipient' };

    const returned = await returnToBuyer(deps, gift, now, 'declined');
    return returned ? { ok: true, credits: gift.credits } : { ok: false, reason: 'not_pending' };
}

/** Return a pending gift's clouds to the buyer (decline or expiry). Atomic: only
 *  the winner of the resolve grants, so it can't double-credit the buyer. */
async function returnToBuyer(
    deps: Deps,
    gift: Gift,
    now: number,
    status: 'declined' | 'expired'
): Promise<boolean> {
    const won = await deps.store.resolveGift(gift.id, status, now);
    if (!won) return false;
    await deps.ledger.purchase(gift.buyerAccountId, gift.credits, `gift_${status}:${gift.id}`);
    return true;
}

/** Sweep: return every gift left pending past expiry to its buyer. Runs on a
 *  timer in the server process (index.ts); idempotent and safe to call anytime. */
export async function reconcileExpiredGifts(deps: Deps, now: number): Promise<number> {
    const cutoff = now - GIFT_EXPIRY_SECONDS;
    const stale = await deps.store.pendingGiftsCreatedBefore(cutoff);
    let returned = 0;
    for (const g of stale) {
        if (await returnToBuyer(deps, g, now, 'expired')) returned++;
    }
    return returned;
}

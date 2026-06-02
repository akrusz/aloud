/**
 * Gift-clouds logic (meditation-pal-bd5). A gift is funded by a CLEARED Stripe
 * payment, so the money is never "cancelled" — the purchased clouds are granted
 * exactly ONCE and never refunded. Lifecycle:
 *
 *   pending ──accept──▶ accepted        (clouds → recipient)
 *      │
 *      ├─decline──────▶ returned        (held for the buyer)
 *      └─30d unclaimed▶ returned
 *                         │
 *                         ├─re-gift────▶ regifted  (+ a fresh pending gift to a new email)
 *                         └─claim──────▶ claimed   (clouds → buyer's own balance)
 *
 * A bounced gift does NOT auto-credit the buyer; it's held as 'returned' so they
 * can re-send it (no new charge) or claim it to their balance — value stays in
 * the credit system, never refunded. Returned gifts don't re-expire.
 *
 * Exactly-once is enforced by atomic compare-and-set on status (store.resolveGift
 * for pending→X, store.transitionGift for returned→X): whoever wins the
 * transition is the one (and only one) that grants / re-gifts, so a recipient
 * accept racing the expiry sweep — or two clicks on Claim — can't double-spend.
 */

import { randomUUID } from 'node:crypto';
import type { Deps } from '../deps.js';
import type { Account, Gift } from './store.js';

/** Unaccepted gifts bounce back to the buyer (as 'returned') after this long. */
export const GIFT_EXPIRY_SECONDS = 30 * 24 * 3600; // 30 days

/** Loose email shape check for a re-gift target — enough to reject garbage. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function norm(email: string): string {
    return email.trim().toLowerCase();
}

/** Pending, non-expired gifts addressed to this account's email. Expired ones
 *  are bounced to 'returned' in passing, so they never show to a recipient. */
export async function pendingGiftsForAccount(deps: Deps, account: Account, now: number): Promise<Gift[]> {
    const gifts = await deps.store.getPendingGiftsForEmail(norm(account.email));
    const cutoff = now - GIFT_EXPIRY_SECONDS;
    const live: Gift[] = [];
    for (const g of gifts) {
        if (g.createdAt <= cutoff) {
            await markReturned(deps, g, now);
        } else {
            live.push(g);
        }
    }
    return live;
}

export type GiftResolution =
    | { ok: true; credits: number }
    | { ok: false; reason: 'not_found' | 'not_pending' | 'wrong_recipient' };

export type ReturnedGiftResolution =
    | { ok: true; credits: number }
    | { ok: false; reason: 'not_found' | 'not_returned' | 'not_owner' | 'bad_email' };

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

/** Decline a gift: it bounces to 'returned', held for the BUYER to re-gift or
 *  claim (no credit yet, no refund). Same recipient + pending guards as accept. */
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

    const returned = await markReturned(deps, gift, now);
    return returned ? { ok: true, credits: gift.credits } : { ok: false, reason: 'not_pending' };
}

/** Move a pending gift to 'returned' (decline or expiry). Atomic — only the
 *  winner of the resolve flips it — and deliberately credits NOBODY: the clouds
 *  wait for the buyer to re-gift or claim them. */
async function markReturned(deps: Deps, gift: Gift, now: number): Promise<boolean> {
    return deps.store.resolveGift(gift.id, 'returned', now);
}

/** Re-gift a returned gift to a new recipient (meditation-pal-bd5). Only the
 *  buyer can; the original payment already cleared, so no new charge — we spawn a
 *  fresh pending gift (same clouds, new email, expiry clock reset) and mark the
 *  old one 'regifted'. Atomic so two clicks can't fork it into two live gifts. */
export async function regiftReturned(
    deps: Deps,
    account: Account,
    giftId: string,
    newEmail: string,
    now: number
): Promise<ReturnedGiftResolution> {
    const recipient = norm(newEmail);
    if (!EMAIL_RE.test(recipient)) return { ok: false, reason: 'bad_email' };
    const gift = await deps.store.getGiftById(giftId);
    if (!gift) return { ok: false, reason: 'not_found' };
    if (gift.buyerAccountId !== account.id) return { ok: false, reason: 'not_owner' };
    if (gift.status !== 'returned') return { ok: false, reason: 'not_returned' };

    const won = await deps.store.transitionGift(gift.id, 'returned', 'regifted', now);
    if (!won) return { ok: false, reason: 'not_returned' }; // lost the race
    const fresh: Gift = {
        id: randomUUID(),
        buyerAccountId: gift.buyerAccountId,
        recipientEmail: recipient,
        credits: gift.credits,
        // Not a new payment; synthesize a unique ref so the idempotency key holds.
        stripeSessionId: `regift:${gift.id}`,
        status: 'pending',
        createdAt: now, // reset the 30-day clock for the new recipient
    };
    await deps.store.createGift(fresh);
    return { ok: true, credits: gift.credits };
}

/** Claim a returned gift to the buyer's own balance (meditation-pal-bd5). Only
 *  the buyer can; atomic, so a click race can't double-credit. */
export async function claimReturned(
    deps: Deps,
    account: Account,
    giftId: string,
    now: number
): Promise<ReturnedGiftResolution> {
    const gift = await deps.store.getGiftById(giftId);
    if (!gift) return { ok: false, reason: 'not_found' };
    if (gift.buyerAccountId !== account.id) return { ok: false, reason: 'not_owner' };
    if (gift.status !== 'returned') return { ok: false, reason: 'not_returned' };

    const won = await deps.store.transitionGift(gift.id, 'returned', 'claimed', now);
    if (!won) return { ok: false, reason: 'not_returned' }; // lost the race
    await deps.ledger.purchase(account.id, gift.credits, `gift_claimed:${gift.id}`);
    return { ok: true, credits: gift.credits };
}

/** Sweep: bounce every gift left pending past expiry to 'returned'. Runs on a
 *  timer in the server process (index.ts); idempotent and safe to call anytime. */
export async function reconcileExpiredGifts(deps: Deps, now: number): Promise<number> {
    const cutoff = now - GIFT_EXPIRY_SECONDS;
    const stale = await deps.store.pendingGiftsCreatedBefore(cutoff);
    let returned = 0;
    for (const g of stale) {
        if (await markReturned(deps, g, now)) returned++;
    }
    return returned;
}

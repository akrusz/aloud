/**
 * Gift-clouds (meditation-pal-gift). The money invariant under test: a cleared
 * payment grants the clouds EXACTLY ONCE — to the recipient on accept, or back
 * to the buyer on decline/expiry — with no refund, no double-grant, no loss.
 */

import { describe, it, expect } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import type { Deps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import {
    acceptGift,
    declineGift,
    regiftReturned,
    claimReturned,
    reconcileExpiredGifts,
    pendingGiftsForAccount,
    GIFT_EXPIRY_SECONDS,
} from '../src/credits/gifts.js';
import type { Account } from '../src/credits/store.js';

function deps(env: Record<string, string> = {}): Deps {
    return buildDeps(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ...env }));
}

async function account(d: Deps, email: string): Promise<Account> {
    const a: Account = { id: randomUUID(), email, emailVerified: true, createdAt: 1000 };
    await d.store.createAccount(a);
    return a;
}

async function gift(d: Deps, buyer: Account, toEmail: string, credits = 50, createdAt = 2000) {
    const g = {
        id: randomUUID(),
        buyerAccountId: buyer.id,
        recipientEmail: toEmail.toLowerCase(),
        credits,
        stripeSessionId: `cs_${randomUUID()}`,
        status: 'pending' as const,
        createdAt,
    };
    await d.store.createGift(g);
    return g;
}

const NOW = 1_000_000;

describe('accept', () => {
    it('grants the clouds to the recipient, not the buyer', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const recip = await account(d, 'recip@e.com');
        const g = await gift(d, buyer, 'recip@e.com', 50);

        const r = await acceptGift(d, recip, g.id, NOW);
        expect(r).toEqual({ ok: true, credits: 50 });
        expect(await d.ledger.balance(recip.id)).toBe(50);
        expect(await d.ledger.balance(buyer.id)).toBe(0);
    });

    it('matches case-insensitively on email', async () => {
        const d = deps();
        const buyer = await account(d, 'b@e.com');
        const recip = await account(d, 'Mixed@E.com');
        const g = await gift(d, buyer, 'mixed@e.com');
        expect((await acceptGift(d, recip, g.id, NOW)).ok).toBe(true);
    });

    it('cannot be accepted by a different recipient', async () => {
        const d = deps();
        const buyer = await account(d, 'b@e.com');
        const other = await account(d, 'other@e.com');
        const g = await gift(d, buyer, 'intended@e.com');
        const r = await acceptGift(d, other, g.id, NOW);
        expect(r).toEqual({ ok: false, reason: 'wrong_recipient' });
        expect(await d.ledger.balance(other.id)).toBe(0);
    });

    it('cannot be accepted twice (no double-grant)', async () => {
        const d = deps();
        const buyer = await account(d, 'b@e.com');
        const recip = await account(d, 'r@e.com');
        const g = await gift(d, buyer, 'r@e.com', 50);
        await acceptGift(d, recip, g.id, NOW);
        const second = await acceptGift(d, recip, g.id, NOW);
        expect(second.ok).toBe(false);
        expect(await d.ledger.balance(recip.id)).toBe(50); // not 100
    });
});

describe('decline → returned (held for the buyer, no auto-credit)', () => {
    it('credits nobody and holds the gift as returned for the buyer', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const recip = await account(d, 'recip@e.com');
        const g = await gift(d, buyer, 'recip@e.com', 50);

        const r = await declineGift(d, recip, g.id, NOW);
        expect(r).toEqual({ ok: true, credits: 50 });
        expect(await d.ledger.balance(buyer.id)).toBe(0); // not auto-credited anymore
        expect(await d.ledger.balance(recip.id)).toBe(0);
        const returned = await d.store.getReturnedGiftsForBuyer(buyer.id);
        expect(returned.map((x) => x.id)).toContain(g.id);
    });

    it('accept after decline fails (no longer pending)', async () => {
        const d = deps();
        const buyer = await account(d, 'b@e.com');
        const recip = await account(d, 'r@e.com');
        const g = await gift(d, buyer, 'r@e.com', 50);
        await declineGift(d, recip, g.id, NOW);
        expect((await acceptGift(d, recip, g.id, NOW)).ok).toBe(false);
        expect(await d.ledger.balance(recip.id)).toBe(0);
    });
});

describe('expiry → returned', () => {
    it('bounces to returned past expiry, hidden from the recipient, buyer not yet credited', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const recip = await account(d, 'recip@e.com');
        const old = NOW - GIFT_EXPIRY_SECONDS - 1;
        const g = await gift(d, buyer, 'recip@e.com', 50, old);

        const live = await pendingGiftsForAccount(d, recip, NOW);
        expect(live).toHaveLength(0);
        expect(await d.ledger.balance(buyer.id)).toBe(0); // held, not credited
        const returned = await d.store.getReturnedGiftsForBuyer(buyer.id);
        expect(returned.map((x) => x.id)).toContain(g.id);
    });

    it('the sweep returns each expired gift exactly once', async () => {
        const d = deps();
        const buyer = await account(d, 'b@e.com');
        const old = NOW - GIFT_EXPIRY_SECONDS - 1;
        await gift(d, buyer, 'x@e.com', 30, old);
        expect(await reconcileExpiredGifts(d, NOW)).toBe(1);
        expect(await reconcileExpiredGifts(d, NOW)).toBe(0); // already returned
        expect(await d.ledger.balance(buyer.id)).toBe(0);
        expect(await d.store.getReturnedGiftsForBuyer(buyer.id)).toHaveLength(1);
    });

    it('uses a 30-day window', () => {
        expect(GIFT_EXPIRY_SECONDS).toBe(30 * 24 * 3600);
    });

    it('does not expire a gift that is still within the window', async () => {
        const d = deps();
        const buyer = await account(d, 'b@e.com');
        const recip = await account(d, 'r@e.com');
        await gift(d, buyer, 'r@e.com', 50, NOW - 1000);
        expect(await pendingGiftsForAccount(d, recip, NOW)).toHaveLength(1);
        expect(await d.ledger.balance(buyer.id)).toBe(0);
    });
});

describe('returned gifts: claim and re-gift (meditation-pal-bd5)', () => {
    /** Decline a fresh gift so it lands in 'returned' for the buyer. */
    async function returnedGift(d: Deps, buyer: Account, credits = 50) {
        const recip = await account(d, 'recip@e.com');
        const g = await gift(d, buyer, 'recip@e.com', credits);
        await declineGift(d, recip, g.id, NOW);
        return g;
    }

    it('claim credits the buyer once, no double-credit', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const g = await returnedGift(d, buyer, 50);

        expect(await claimReturned(d, buyer, g.id, NOW)).toEqual({ ok: true, credits: 50 });
        expect(await d.ledger.balance(buyer.id)).toBe(50);
        // Second claim loses the race / wrong state — no extra credit.
        expect((await claimReturned(d, buyer, g.id, NOW)).ok).toBe(false);
        expect(await d.ledger.balance(buyer.id)).toBe(50);
    });

    it('re-gift spawns a fresh pending gift to a new email, no new charge', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const g = await returnedGift(d, buyer, 50);

        expect(await regiftReturned(d, buyer, g.id, 'New@E.com', NOW)).toEqual({ ok: true, credits: 50 });
        expect(await d.ledger.balance(buyer.id)).toBe(0); // re-gift doesn't credit the buyer
        expect(await d.store.getReturnedGiftsForBuyer(buyer.id)).toHaveLength(0); // moved on

        // The new recipient now has a live pending gift and can accept it.
        const newRecip = await account(d, 'new@e.com');
        const pending = await pendingGiftsForAccount(d, newRecip, NOW);
        expect(pending).toHaveLength(1);
        expect(pending[0]?.credits).toBe(50);
        expect((await acceptGift(d, newRecip, pending[0]!.id, NOW)).ok).toBe(true);
        expect(await d.ledger.balance(newRecip.id)).toBe(50);
    });

    it('only the buyer can claim or re-gift', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const stranger = await account(d, 'stranger@e.com');
        const g = await returnedGift(d, buyer, 50);

        expect((await claimReturned(d, stranger, g.id, NOW)).reason).toBe('not_owner');
        expect((await regiftReturned(d, stranger, g.id, 'x@e.com', NOW)).reason).toBe('not_owner');
        expect(await d.ledger.balance(stranger.id)).toBe(0);
    });

    it('rejects a bad re-gift email', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const g = await returnedGift(d, buyer, 50);
        expect((await regiftReturned(d, buyer, g.id, 'not-an-email', NOW)).reason).toBe('bad_email');
    });

    it('cannot claim after re-gift (state moved on)', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const g = await returnedGift(d, buyer, 50);
        await regiftReturned(d, buyer, g.id, 'new@e.com', NOW);
        expect((await claimReturned(d, buyer, g.id, NOW)).reason).toBe('not_returned');
        expect(await d.ledger.balance(buyer.id)).toBe(0);
    });
});

describe('webhook records a gift instead of crediting the buyer', () => {
    function sign(payload: string, secret: string, t: number): string {
        const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
        return `t=${t},v1=${v1}`;
    }

    it('creates one pending gift (idempotent) and leaves the buyer uncredited', async () => {
        const d = deps({ STRIPE_SECRET_KEY: 'sk_test', STRIPE_WEBHOOK_SECRET: 'whsec_test' });
        const buyer = await account(d, 'buyer@e.com');
        const app = createApp(d);
        const event = JSON.stringify({
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_gift_1',
                    client_reference_id: buyer.id,
                    payment_status: 'paid',
                    metadata: { pack_id: 'starter', credits: '50', gift_to_email: 'Friend@E.com' },
                },
            },
        });
        const post = () =>
            app.request('/cloud/v1/billing/webhook', {
                method: 'POST',
                headers: { 'stripe-signature': sign(event, 'whsec_test', Math.floor(Date.now() / 1000)) },
                body: event,
            });

        expect((await post()).status).toBe(200);
        expect((await post()).status).toBe(200); // retry — must not duplicate

        const pending = await d.store.getPendingGiftsForEmail('friend@e.com');
        expect(pending).toHaveLength(1);
        expect(pending[0]?.credits).toBe(50);
        expect(await d.ledger.balance(buyer.id)).toBe(0); // buyer not credited; clouds await acceptance
    });
});

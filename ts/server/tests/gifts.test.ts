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

describe('decline', () => {
    it('returns the clouds to the buyer (no refund), recipient gets nothing', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const recip = await account(d, 'recip@e.com');
        const g = await gift(d, buyer, 'recip@e.com', 50);

        const r = await declineGift(d, recip, g.id, NOW);
        expect(r).toEqual({ ok: true, credits: 50 });
        expect(await d.ledger.balance(buyer.id)).toBe(50);
        expect(await d.ledger.balance(recip.id)).toBe(0);
    });

    it('accept after decline fails (terminal state)', async () => {
        const d = deps();
        const buyer = await account(d, 'b@e.com');
        const recip = await account(d, 'r@e.com');
        const g = await gift(d, buyer, 'r@e.com', 50);
        await declineGift(d, recip, g.id, NOW);
        expect((await acceptGift(d, recip, g.id, NOW)).ok).toBe(false);
        expect(await d.ledger.balance(buyer.id)).toBe(50);
        expect(await d.ledger.balance(recip.id)).toBe(0);
    });
});

describe('expiry', () => {
    it('returns clouds to the buyer once past expiry, and hides them from the recipient', async () => {
        const d = deps();
        const buyer = await account(d, 'buyer@e.com');
        const recip = await account(d, 'recip@e.com');
        const old = NOW - GIFT_EXPIRY_SECONDS - 1;
        await gift(d, buyer, 'recip@e.com', 50, old);

        // Listing for the recipient reconciles the expired gift back to the buyer.
        const live = await pendingGiftsForAccount(d, recip, NOW);
        expect(live).toHaveLength(0);
        expect(await d.ledger.balance(buyer.id)).toBe(50);
        expect(await d.ledger.balance(recip.id)).toBe(0);
    });

    it('the sweep returns each expired gift exactly once', async () => {
        const d = deps();
        const buyer = await account(d, 'b@e.com');
        const old = NOW - GIFT_EXPIRY_SECONDS - 1;
        await gift(d, buyer, 'x@e.com', 30, old);
        expect(await reconcileExpiredGifts(d, NOW)).toBe(1);
        expect(await reconcileExpiredGifts(d, NOW)).toBe(0); // already returned
        expect(await d.ledger.balance(buyer.id)).toBe(30);
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

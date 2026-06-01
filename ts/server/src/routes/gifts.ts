/**
 * Gift-clouds routes (meditation-pal-bd5). A recipient lists the gifts waiting
 * for their email and accepts (clouds → them) or declines (clouds → back to the
 * buyer). All authed: the account's own email is the address we match on, so one
 * user can't accept another's gift.
 */

import { Hono } from 'hono';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { GiftView } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { acceptGift, declineGift, pendingGiftsForAccount } from '../credits/gifts.js';
import { log } from '../logger.js';

export function giftRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    // Pending gifts addressed to the signed-in account's email.
    app.get('/', requireAuth(deps), async (c) => {
        const account = c.get('account');
        const gifts = await pendingGiftsForAccount(deps, account, Date.now() / 1000);
        const views: GiftView[] = await Promise.all(
            gifts.map(async (g) => {
                const buyer = await deps.store.getAccountById(g.buyerAccountId);
                return {
                    id: g.id,
                    credits: g.credits,
                    createdAt: g.createdAt,
                    ...(buyer ? { fromEmail: buyer.email } : {}),
                };
            })
        );
        return c.json({ gifts: views });
    });

    app.post('/:id/accept', requireAuth(deps), async (c) => {
        const account = c.get('account');
        const result = await acceptGift(deps, account, c.req.param('id'), Date.now() / 1000);
        if (!result.ok) {
            // Already-resolved or not-yours → 404 (don't leak which); the client
            // just refreshes its gift list.
            return c.json(apiError('bad_request', 'gift is no longer available'), ERROR_STATUS.bad_request);
        }
        log.info('gift accepted', { accountId: account.id, credits: result.credits });
        return c.json({ creditsRemaining: await deps.ledger.balance(account.id) });
    });

    app.post('/:id/decline', requireAuth(deps), async (c) => {
        const account = c.get('account');
        const result = await declineGift(deps, account, c.req.param('id'), Date.now() / 1000);
        if (!result.ok) {
            return c.json(apiError('bad_request', 'gift is no longer available'), ERROR_STATUS.bad_request);
        }
        log.info('gift declined', { accountId: account.id });
        return c.json({ ok: true });
    });

    return app;
}

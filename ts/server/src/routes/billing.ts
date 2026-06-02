/**
 * Billing routes (meditation-pal-8sj). Credit packs sold via Stripe Checkout,
 * fulfilled on a signature-verified webhook. Degrades gracefully when Stripe
 * isn't configured (dev runs on the free-tier grant alone).
 *
 * The webhook is the trust boundary: credits are added to the ledger ONLY here,
 * after Stripe confirms payment and the signature verifies. The checkout route
 * just starts the flow.
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
    ERROR_STATUS,
    apiError,
    type CheckoutRequest,
    type CheckoutResponse,
} from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import {
    createCheckoutSession,
    customPack,
    isValidCustomCredits,
    packById,
    parseCheckoutCompleted,
    verifyStripeSignature,
    MIN_CUSTOM_CREDITS,
    MAX_CUSTOM_CREDITS,
} from '../billing/stripe.js';
import { x402Configured, x402Routes } from '../billing/x402.js';
import { log } from '../logger.js';

/** Loose email shape check for gift recipients (mirrors routes/auth.ts). */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A client-supplied post-checkout return path, sanitised to a single clean
 *  relative path ending in '/'. Anything not starting with a single '/' (absolute
 *  URLs, scheme-relative '//host', missing) falls back to '/'. The trailing '?'
 *  for the purchase param is added by the caller. */
export function safeReturnPath(raw: string | undefined): string {
    if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//')) return '/';
    // Strip any query/hash the client tacked on; we own the ?purchase param.
    const path = raw.split(/[?#]/)[0] ?? '/';
    return path.endsWith('/') ? path : `${path}/`;
}

export function billingRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.post('/checkout', requireAuth(deps), async (c) => {
        const secret = deps.config.stripeSecretKey;
        if (!secret) {
            return c.json(apiError('internal', 'billing not configured on this server'), ERROR_STATUS.internal);
        }
        const account = c.get('account');
        const body = (await c.req.json().catch(() => ({}))) as Partial<CheckoutRequest>;
        // A custom amount (server-priced) takes precedence over a preset pack id.
        let pack;
        if (body.credits !== undefined) {
            if (!isValidCustomCredits(body.credits)) {
                return c.json(
                    apiError('bad_request', `credits must be a whole number from ${MIN_CUSTOM_CREDITS} to ${MAX_CUSTOM_CREDITS}`),
                    ERROR_STATUS.bad_request
                );
            }
            pack = customPack(body.credits);
        } else {
            pack = body.packId ? packById(body.packId) : undefined;
            if (!pack) {
                return c.json(apiError('bad_request', 'unknown packId'), ERROR_STATUS.bad_request);
            }
        }
        // Optional gift recipient. Validate the shape now so a typo fails fast at
        // checkout rather than minting an undeliverable gift after payment.
        const giftToEmail = body.giftToEmail ? body.giftToEmail.trim().toLowerCase() : '';
        if (giftToEmail && !EMAIL_RE.test(giftToEmail)) {
            return c.json(apiError('bad_request', 'gift recipient email is not valid'), ERROR_STATUS.bad_request);
        }
        const origin = deps.config.corsOrigins[0] ?? '';
        // Where Stripe returns the user. The client passes its own app path (e.g.
        // '/app/' on the Pages subpath build) so the redirect lands back IN the
        // app, not the marketing root; we only honour a clean relative path
        // (leading '/', no '//' scheme-relative) and always prefix our own
        // origin, so this can't be turned into an open redirect.
        const returnBase = `${origin}${safeReturnPath(body.returnPath)}`;
        try {
            const url = await createCheckoutSession(
                {
                    pack,
                    accountId: account.id,
                    successUrl: `${returnBase}?purchase=success`,
                    cancelUrl: `${returnBase}?purchase=cancel`,
                    ...(giftToEmail ? { giftToEmail } : {}),
                },
                secret
            );
            return c.json({ checkoutUrl: url } satisfies CheckoutResponse);
        } catch (err) {
            log.error('checkout failed', { err: String(err) });
            return c.json(apiError('internal', 'could not start checkout'), ERROR_STATUS.internal);
        }
    });

    // Stripe calls this — no user auth; trust comes from signature verification.
    app.post('/webhook', async (c) => {
        const secret = deps.config.stripeWebhookSecret;
        if (!secret) return c.json(apiError('internal', 'webhook not configured'), ERROR_STATUS.internal);

        const sig = c.req.header('stripe-signature');
        const payload = await c.req.text();
        if (!sig || !verifyStripeSignature(payload, sig, secret)) {
            return c.json(apiError('unauthenticated', 'bad signature'), ERROR_STATUS.unauthenticated);
        }

        const event = JSON.parse(payload) as unknown;
        const purchase = parseCheckoutCompleted(event);
        if (purchase && purchase.giftToEmail) {
            // A GIFT: the payment cleared, but the clouds become a pending gift the
            // recipient accepts on next sign-in (declined/expired → back to buyer).
            // createGift is idempotent on the session id, so a webhook retry is safe.
            await deps.store.createGift({
                id: randomUUID(),
                buyerAccountId: purchase.accountId,
                // Normalize here too — matching (accept/list) is all lower-cased,
                // so the stored address must be, regardless of how it arrived.
                recipientEmail: purchase.giftToEmail.trim().toLowerCase(),
                credits: purchase.credits,
                stripeSessionId: purchase.stripeSessionId,
                status: 'pending',
                createdAt: Date.now() / 1000,
            });
            log.info('gift purchased', {
                buyerAccountId: purchase.accountId,
                credits: purchase.credits,
                recipientEmail: purchase.giftToEmail,
            });
        } else if (purchase) {
            await deps.ledger.purchase(
                purchase.accountId,
                purchase.credits,
                `purchase:${purchase.packId}:${purchase.stripeSessionId}`
            );
            log.info('purchase fulfilled', {
                accountId: purchase.accountId,
                credits: purchase.credits,
                packId: purchase.packId,
            });
        }
        return c.json({ received: true });
    });

    // x402 channel (meditation-pal-du9): USDC-on-Base credit purchases. Mounted
    // only when configured; otherwise the buy path reports not-configured so the
    // surface is discoverable (mirrors /checkout's behavior without a Stripe key).
    const x402 = x402Configured(deps);
    if (x402) {
        app.route('/x402', x402Routes(deps, x402));
    } else {
        app.post('/x402/buy/:packId', (c) =>
            c.json(apiError('internal', 'x402 billing not configured on this server'), ERROR_STATUS.internal)
        );
    }

    return app;
}

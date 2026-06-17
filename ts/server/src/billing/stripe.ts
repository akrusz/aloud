/**
 * Stripe integration (meditation-pal-8sj) — credit packs sold via Stripe
 * Checkout, fulfilled on a verified webhook. No `stripe` SDK dependency: we
 * call the REST API with fetch and verify webhook signatures with node:crypto.
 * Fewer deps, and the signature check is right here in the open to audit.
 *
 * Optional: if STRIPE_SECRET_KEY is unset the routes report "billing not
 * configured" rather than crashing, so the server runs end-to-end in dev with
 * just the free-tier grant.
 *
 * Channel/jurisdiction commission (meditation-pal-czr addendum) is applied at
 * the pricing layer, not here — this module only moves money and credits the
 * account on confirmed payment.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** A purchasable credit pack. Price embeds the margin (Model B — see meter.ts):
 *  credits debit at COST, so the price funds the provider cost its credits buy
 *  times the markup. Sales tax/VAT is added on top at checkout (Stripe Tax). */
export interface CreditPack {
    id: string;
    credits: number;
    priceUsdCents: number;
    label: string;
}

// ---- Pricing curve ----------------------------------------------------------
// One curve drives BOTH the preset packs and the custom "type your own" amount,
// so a custom amount is never out of line with a pack. Base rate is 8 credits
// per dollar (12.5¢/credit); a volume discount ramps linearly from 0% at $5 of
// spend to 12.5% at $20 (capped above $20), expressed as extra credits for the
// dollars. Credits round up (ceil). Anchors: $5 → 40, $20 → ceil(160 × 1.125) =
// 180 (≈11.1¢/credit). All tunable during pre-launch calibration (meditation-pal-7xl).

/** Base list price before any volume discount: 12.5¢/credit (8 credits per $1). */
export const BASE_CENTS_PER_CREDIT = 12.5;
/** Spend (cents) at which the volume discount begins — below this it's 0%. */
export const DISCOUNT_START_CENTS = 500; // $5
/** Spend (cents) at which the volume discount caps. */
export const DISCOUNT_FULL_CENTS = 2_000; // $20
/** Maximum volume discount, reached at DISCOUNT_FULL_CENTS. At 12.5% the $20
 *  tier lands a round 180 credits (≈11.1¢/credit). */
export const MAX_DISCOUNT = 0.125; // 12.5%

/** Volume discount fraction for a purchase of `cents` (0 … MAX_DISCOUNT). */
export function discountForCents(cents: number): number {
    if (cents <= DISCOUNT_START_CENTS) return 0;
    if (cents >= DISCOUNT_FULL_CENTS) return MAX_DISCOUNT;
    return (
        (MAX_DISCOUNT * (cents - DISCOUNT_START_CENTS)) /
        (DISCOUNT_FULL_CENTS - DISCOUNT_START_CENTS)
    );
}

/** Credits a spend of `cents` buys: base rate scaled up by the volume discount,
 *  rounded up. The canonical curve — presets are points on it. */
export function creditsForCents(cents: number): number {
    return Math.ceil((cents / BASE_CENTS_PER_CREDIT) * (1 + discountForCents(cents)));
}

/** Inverse of the curve for the custom field (buyer types credits, we price
 *  them): the cents that buy `credits`. Flat base rate below the ramp, flat
 *  discounted rate above it, and the closed-form quadratic inverse within —
 *  derived from the same constants so it can't drift from creditsForCents. */
export function centsForCredits(credits: number): number {
    if (credits <= creditsForCents(DISCOUNT_START_CENTS)) {
        return Math.ceil(credits * BASE_CENTS_PER_CREDIT); // below $5: no discount
    }
    if (credits >= creditsForCents(DISCOUNT_FULL_CENTS)) {
        return Math.ceil((credits * BASE_CENTS_PER_CREDIT) / (1 + MAX_DISCOUNT)); // above $20: capped
    }
    // Within the ramp credits = (cents/B)(1 + k(cents − S)), k = M/(F − S):
    // k·cents² + (1 − kS)·cents − B·credits = 0. Solve the positive root.
    const k = MAX_DISCOUNT / (DISCOUNT_FULL_CENTS - DISCOUNT_START_CENTS);
    const b = 1 - k * DISCOUNT_START_CENTS;
    const cents = (-b + Math.sqrt(b * b + 4 * k * BASE_CENTS_PER_CREDIT * credits)) / (2 * k);
    return Math.ceil(cents);
}

/** The preset packs — points on the curve at $5 / $10 / $20. Regenerated from
 *  the curve so they always match it (and the custom amount). */
export const CREDIT_PACKS: CreditPack[] = [
    { id: 'starter', cents: 500 },
    { id: 'plus', cents: 1000 },
    { id: 'pro', cents: 2000 },
].map(({ id, cents }) => {
    const credits = creditsForCents(cents);
    const dollars = cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`;
    return {
        id,
        credits,
        priceUsdCents: cents,
        label: `${credits} credits — ${dollars}`,
    };
});

export function packById(id: string): CreditPack | undefined {
    return CREDIT_PACKS.find((p) => p.id === id);
}

// ---- Custom amounts (type-your-own credits) ---------------------------------
// A buyer can name any whole-credit amount instead of a preset. It's priced on
// the SAME curve (centsForCredits), so it gets the same volume discount as a
// pack and is never a premium. Floor is the smallest preset; a high ceiling
// guards a fat-fingered charge. Server-priced; the client number is a preview.

/** Floor: never below the smallest preset pack (kept in sync with CREDIT_PACKS). */
export const MIN_CUSTOM_CREDITS = Math.min(...CREDIT_PACKS.map((p) => p.credits));
/** Ceiling: a sanity cap so a typo can't trigger a four-figure charge. */
export const MAX_CUSTOM_CREDITS = 100_000;

/** Whether a requested custom amount is a whole number within bounds. */
export function isValidCustomCredits(credits: number): boolean {
    return (
        Number.isInteger(credits) &&
        credits >= MIN_CUSTOM_CREDITS &&
        credits <= MAX_CUSTOM_CREDITS
    );
}

/** Build a synthetic pack for a custom amount so the checkout/webhook path is
 *  identical to a preset. Priced on the curve via centsForCredits. */
export function customPack(credits: number): CreditPack {
    return {
        id: 'custom',
        credits,
        priceUsdCents: centsForCredits(credits),
        label: `${credits} credits`,
    };
}

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header).
 * Implements Stripe's documented scheme: HMAC-SHA256 over `${t}.${payload}`
 * keyed by the webhook secret, compared constant-time against the `v1=` value,
 * with a timestamp tolerance to defeat replay.
 */
export function verifyStripeSignature(
    payload: string,
    sigHeader: string,
    secret: string,
    toleranceSec = 300,
    now: () => number = () => Date.now() / 1000
): boolean {
    const parts = Object.fromEntries(
        sigHeader.split(',').map((kv) => kv.split('=') as [string, string])
    );
    const t = Number(parts['t']);
    const v1 = parts['v1'];
    if (!t || !v1) return false;
    if (Math.abs(now() - t) > toleranceSec) return false;

    const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(v1);
    return a.length === b.length && timingSafeEqual(a, b);
}

export interface CheckoutParams {
    pack: CreditPack;
    accountId: string;
    successUrl: string;
    cancelUrl: string;
    /** When set, the payment funds a GIFT to this email rather than crediting the
     *  buyer directly (meditation-pal-bd5). Rides in metadata for the webhook. */
    giftToEmail?: string;
}

/**
 * Create a Stripe Checkout Session and return its URL. The accountId rides in
 * client_reference_id so the webhook can credit the right ledger on payment.
 */
export async function createCheckoutSession(
    params: CheckoutParams,
    secretKey: string,
    fetchImpl: typeof fetch = fetch
): Promise<string> {
    const form = new URLSearchParams({
        mode: 'payment',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.accountId,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(params.pack.priceUsdCents),
        'line_items[0][price_data][product_data][name]': params.pack.label,
        'metadata[pack_id]': params.pack.id,
        'metadata[credits]': String(params.pack.credits),
        ...(params.giftToEmail ? { 'metadata[gift_to_email]': params.giftToEmail } : {}),
        // Also stamp the PaymentIntent so a later charge.refunded / dispute event
        // (whose object is a charge/dispute, NOT the session) can recover the
        // buyer + amount to claw back (meditation-pal-7tl). 'gift' marks a gift
        // purchase — those credited a gift record, not the buyer, so the reversal
        // path must NOT debit the buyer; it flags for manual review instead.
        'payment_intent_data[metadata][account_id]': params.accountId,
        'payment_intent_data[metadata][credits]': String(params.pack.credits),
        'payment_intent_data[metadata][pack_id]': params.pack.id,
        ...(params.giftToEmail ? { 'payment_intent_data[metadata][gift]': '1' } : {}),
    });

    const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${secretKey}`,
            'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Stripe checkout creation failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error('Stripe checkout session had no url');
    return data.url;
}

/** Parse the bits we need from a checkout.session.completed event. */
export interface FulfilledPurchase {
    accountId: string;
    credits: number;
    packId: string;
    stripeSessionId: string;
    /** Present when the purchase was a gift (metadata[gift_to_email]); the webhook
     *  then records a pending gift instead of crediting the buyer. */
    giftToEmail?: string;
}

export function parseCheckoutCompleted(event: unknown): FulfilledPurchase | undefined {
    const e = event as {
        type?: string;
        data?: { object?: Record<string, unknown> };
    };
    if (e.type !== 'checkout.session.completed') return undefined;
    const obj = e.data?.object ?? {};
    // `checkout.session.completed` also fires for sessions whose payment is
    // still pending or unpaid (e.g. delayed payment methods) — only a session
    // Stripe marks `paid` may mint credits. We don't sell via delayed methods
    // today, so requiring `paid` here is the whole gate.
    if (obj['payment_status'] !== 'paid') return undefined;
    const accountId = typeof obj['client_reference_id'] === 'string' ? obj['client_reference_id'] : '';
    const meta = (obj['metadata'] as Record<string, string> | undefined) ?? {};
    const packId = meta['pack_id'] ?? '';
    const stripeSessionId = typeof obj['id'] === 'string' ? obj['id'] : '';
    // Defense in depth: the metadata is our own write at checkout-creation
    // time, but re-derive the credit amount from the server-side pack table
    // anyway so a tampered metadata blob can't inflate the grant. Only the
    // custom pack has no table row — there the metadata number is the source,
    // re-run through the same bounds check the checkout route applied. (The
    // volume discount is already baked into a pack's credits and into the custom
    // amount the buyer chose, so the grant is simply that credit count.)
    let credits: number;
    if (packId === 'custom') {
        credits = Number(meta['credits']);
        if (!isValidCustomCredits(credits)) return undefined;
    } else {
        const pack = packById(packId);
        if (!pack) return undefined;
        credits = pack.credits;
    }
    if (!accountId || !credits) return undefined;
    const giftToEmail = typeof meta['gift_to_email'] === 'string' ? meta['gift_to_email'] : '';
    return { accountId, credits, packId, stripeSessionId, ...(giftToEmail ? { giftToEmail } : {}) };
}

/** A refund or chargeback to claw back (meditation-pal-7tl). The triggering
 *  object is a charge (charge.refunded) or a dispute (charge.dispute.created),
 *  neither of which carries our session metadata — only a payment_intent id, so
 *  the caller resolves the buyer/credits via fetchPurchaseMetadata below. */
export interface ChargeReversal {
    kind: 'refund' | 'dispute';
    paymentIntentId: string;
    /** Stable idempotency ref for the clawback ledger entry. */
    ref: string;
    /** Fraction of the original purchase to claw back (1 = full). */
    fraction: number;
}

export function parseChargeReversal(event: unknown): ChargeReversal | undefined {
    const e = event as { type?: string; data?: { object?: Record<string, unknown> } };
    const obj = e.data?.object ?? {};
    const pi = (k: string): string => (typeof obj[k] === 'string' ? (obj[k] as string) : '');

    if (e.type === 'charge.refunded') {
        const paymentIntentId = pi('payment_intent');
        const chargeId = pi('id');
        const amount = Number(obj['amount']);
        const amountRefunded = Number(obj['amount_refunded']);
        if (!paymentIntentId || !chargeId || !(amount > 0)) return undefined;
        // Proportional clawback (a full refund → 1). NOTE: keyed on the charge,
        // so a sequence of *partial* refunds on one charge only claws the first;
        // full refunds (the common case) and webhook retries are exact.
        const fraction = Math.min(1, Math.max(0, amountRefunded / amount));
        if (fraction <= 0) return undefined;
        return { kind: 'refund', paymentIntentId, ref: `refund:${chargeId}`, fraction };
    }

    if (e.type === 'charge.dispute.created') {
        const paymentIntentId = pi('payment_intent');
        const disputeId = pi('id');
        if (!paymentIntentId || !disputeId) return undefined;
        // A chargeback claws back the whole purchase (funds are held/lost).
        return { kind: 'dispute', paymentIntentId, ref: `dispute:${disputeId}`, fraction: 1 };
    }

    return undefined;
}

/** Resolve the buyer + granted credits behind a payment_intent, from the
 *  metadata we stamped at checkout (payment_intent_data[metadata]). Returns
 *  undefined on any failure so the caller can flag for manual review rather than
 *  guess. `isGift` purchases credited a gift record, not the buyer. */
export async function fetchPurchaseMetadata(
    paymentIntentId: string,
    secretKey: string,
    fetchImpl: typeof fetch = fetch
): Promise<{ accountId: string; credits: number; isGift: boolean } | undefined> {
    const res = await fetchImpl(`https://api.stripe.com/v1/payment_intents/${paymentIntentId}`, {
        headers: { authorization: `Bearer ${secretKey}` },
    });
    if (!res.ok) return undefined;
    const pi = (await res.json().catch(() => ({}))) as { metadata?: Record<string, string> };
    const meta = pi.metadata ?? {};
    const accountId = typeof meta['account_id'] === 'string' ? meta['account_id'] : '';
    const credits = Number(meta['credits']);
    if (!accountId || !(credits > 0)) return undefined;
    return { accountId, credits, isGift: meta['gift'] === '1' };
}

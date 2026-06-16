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
import { USD_PER_CREDIT, PACK_MARKUP } from '../pricing/meter.js';

/** A purchasable credit pack. Price embeds the margin (Model B — see meter.ts):
 *  credits debit at COST, so a pack is priced at the provider cost its credits
 *  fund times the markup. Sales tax/VAT is added on top at checkout (Stripe Tax).
 *
 *  At USD_PER_CREDIT $0.05, each credit funds $0.05 of compute; prices below
 *  give effective markups of ~2.0–2.4x (bigger packs = a small volume discount,
 *  still clearing the worst-channel commission — verified by assertSolvent at
 *  boot). All tunable during pre-launch calibration (meditation-pal-7xl). */
export interface CreditPack {
    id: string;
    credits: number;
    priceUsdCents: number;
    label: string;
}

export const CREDIT_PACKS: CreditPack[] = [
    // ~$0.120/credit · funds $2.50 of compute · ~2.4x markup
    { id: 'starter', credits: 50, priceUsdCents: 600, label: '50 credits — $6' },
    // ~$0.109/credit · funds $5.50 of compute · ~2.2x markup
    { id: 'plus', credits: 110, priceUsdCents: 1200, label: '110 credits — $12 (best value)' },
    // ~$0.100/credit · funds $12 of compute · ~2.0x markup
    { id: 'pro', credits: 240, priceUsdCents: 2400, label: '240 credits — $24' },
];

export function packById(id: string): CreditPack | undefined {
    return CREDIT_PACKS.find((p) => p.id === id);
}

// ---- Custom amounts (meditation-pal: type-your-own credits) -----------------
// A buyer can name any whole-credit amount instead of a preset. It's priced at
// the flat list rate (no volume discount): provider cost x the standard markup.
// The floor is the smallest preset — we don't undercut a pack — and a high
// ceiling guards against a fat-fingered charge. Server-priced; the client's
// number is only a preview.

/** Cents per credit for a custom amount = $0.05 cost x 2.5 markup = 12.5¢. */
export const CUSTOM_CENTS_PER_CREDIT = USD_PER_CREDIT * PACK_MARKUP * 100;
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
 *  identical to a preset. Price is rounded to the cent. */
export function customPack(credits: number): CreditPack {
    return {
        id: 'custom',
        credits,
        priceUsdCents: Math.round(credits * CUSTOM_CENTS_PER_CREDIT),
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
    // re-run through the same bounds check the checkout route applied.
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

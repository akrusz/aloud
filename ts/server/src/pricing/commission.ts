/**
 * Commission lookup by (channel, jurisdiction).
 *
 * The meditation-pal-8sj ADDENDUM: commission is NOT a constant, it's a knob
 * keyed by how the money arrived and where the buyer is. The metered margin
 * multiplier (meter.ts) is validated AGAINST this so net margin stays positive
 * on every channel, including the 15% IAP floor.
 *
 * These rates live in the open-source tree on purpose. aloud publishes its
 * margin (see README), and anyone motivated to audit it has two cheaper escape
 * hatches (local Ollama, bring-your-own-key). Transparency is a trust feature.
 *
 * ⚠️ The US web ~0% path is LEGALLY UNSETTLED (Epic v. Apple remand; Apple
 * seeking SCOTUS review, rehearing denied Mar-2026). 0% is today's best case,
 * not a permanent assumption. The knob is what protects us if it changes;
 * re-verify before relying on it (meditation-pal-czr).
 */

import type { PurchaseChannel } from '../contract.js';

/** Fraction (0..1) the platform loses to processing + store commission on a
 *  purchase through this channel/jurisdiction. */
export interface CommissionRate {
    /** Total take-rate as a fraction of the gross purchase. */
    rate: number;
    /** Human-readable basis, surfaced in pricing transparency copy. */
    note: string;
}

const DEFAULT_JURISDICTION = 'US';

const TABLE: Record<PurchaseChannel, Record<string, CommissionRate>> = {
    // Web checkout via Stripe. US post-Epic: ~Stripe only. EU: Stripe PLUS
    // Apple Core Technology Commission (~12-20%) when reached via an
    // external-purchase-link entitlement, modeled separately + conservatively.
    web_stripe: {
        US: { rate: 0.03, note: 'Stripe ~3%, ~0% store commission (post-Epic external link, UNSETTLED)' },
        EU: { rate: 0.18, note: 'Stripe ~3% + Apple Core Technology Commission ~15% (EU external-purchase entitlement)' },
    },
    // In-app purchase fallback. Small-business floor 15%, standard 30%. We model
    // the FLOOR so margin validation must clear the best IAP case; standard-rate
    // jurisdictions are then even safer.
    iap_apple: {
        US: { rate: 0.15, note: 'Apple IAP small-business rate (15%); 30% above $1M/yr' },
    },
    iap_google: {
        US: { rate: 0.15, note: 'Google Play small-business rate (15%); 30% above $1M/yr' },
    },
    // On-chain USDC via x402 on Base (meditation-pal-du9). The CDP facilitator
    // settles free and Base gas is sub-cent, so the take-rate is dust. No
    // on-chain chargebacks.
    //
    // EU CAVEAT: if x402 is ever exposed *inside the iOS app* in the EU, Apple's
    // Core Technology Commission could apply just like web_stripe.EU. The MVP
    // offers x402 on web/agent only (no Apple surface), so no store cut. Add an
    // EU row mirroring web_stripe.EU before enabling it there.
    x402: {
        US: { rate: 0.001, note: 'Base gas + CDP facilitator (~0); USDC settled on-chain, no chargebacks' },
    },
};

/** Highest commission across all configured channels. Margin validation
 *  (meter.ts) clears against THIS, so the model is solvent on the worst path we
 *  offer, not just the cheapest. */
export const WORST_CASE_COMMISSION = 0.18;

export function commissionFor(channel: PurchaseChannel, jurisdiction?: string): CommissionRate {
    const byJ = TABLE[channel];
    const j = (jurisdiction ?? DEFAULT_JURISDICTION).toUpperCase();
    return byJ[j] ?? byJ[DEFAULT_JURISDICTION] ?? { rate: WORST_CASE_COMMISSION, note: 'fallback worst-case' };
}

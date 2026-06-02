/**
 * The metered-billing core (meditation-pal-8sj): price each unit of usage by
 * its ACTUAL underlying provider cost, debited from a credit balance. Metered
 * debit is the direct fix for the cost-math trap meditation-pal-a2j flags — a
 * daily power user's heavy use can never run at a loss, because every token
 * they burn is debited at real cost, not amortized against a flat subscription.
 *
 * Money model (Model B — margin lives at PURCHASE, not in the debit):
 *   - 1 credit = USD_PER_CREDIT of PROVIDER COST (what we pay). The debit is at
 *     cost: credits_spent = providerCostUsd / USD_PER_CREDIT. No markup here.
 *   - Margin is applied when CREDITS ARE SOLD: a pack of N credits funds
 *     N * USD_PER_CREDIT of provider cost, and sells for that * PACK_MARKUP
 *     (see billing/stripe.ts). Markup is visible at checkout — the most
 *     transparent place to put it — and sales tax/VAT is collected on top via
 *     Stripe Tax (not absorbed from margin).
 *   - Net of the ~$0.05 cost basis and a ~2.5x pack markup, the user pays
 *     ~$0.125/credit at purchase. Keeping margin out of the debit means the
 *     per-session credit counts the user watches tick down map 1:1 to real
 *     compute cost — easy to verify, on-brand for the published-margin stance.
 *
 * Solvency (the addendum's "must clear positive margin at the 15% IAP floor"):
 * net pack revenue after commission must exceed the provider cost the sold
 * credits fund, i.e. effective pack markup >= 1 / (1 - commission). 15% IAP
 * needs >=1.176x; 18% EU >=1.22x; 30% >=1.43x. assertSolvent() enforces this at
 * boot against every pack and channel.
 */

import type { LlmUsage, SessionUsage } from '@aloud/core/facilitation';
import { WORST_CASE_COMMISSION, commissionFor } from './commission.js';
import type { PurchaseChannel } from '../contract.js';
import {
    STT_USD_PER_SECOND,
    TTS_USD_PER_CHAR,
    googleTtsRateFor,
    pricingFor,
} from './providers.js';
import type { ProviderId } from '../contract.js';

/** Provider COST that one credit represents, in USD. Margin is NOT here — it's
 *  added at purchase (PACK_MARKUP). Tentative $0.05; with a ~2.5x pack markup
 *  the user pays ~$0.125/credit, and a ~50-min Opus session lands at a friendly
 *  single-digit credit count. Calibrate against real testing (meditation-pal-7xl). */
export const USD_PER_CREDIT = 0.05;

/** Markup applied when SELLING credits (in pack pricing), over the provider
 *  cost the credits fund. Covers margin + payment commission; sales tax is
 *  added on top by Stripe Tax. Comfortably above every channel's commission
 *  floor (see assertSolvent). Published — it's the one "sensitive" number, and
 *  trivially derivable anyway. */
export const PACK_MARKUP = 2.5;

/** USD provider cost of one LLM turn from its usage split. */
export function llmCostUsd(provider: ProviderId, model: string, usage: LlmUsage): number {
    const p = pricingFor(provider, model);
    if (!p) return 0;
    // Cache CREATION is billed (Anthropic ~1.25x input) — not free. With
    // history caching on it's a real leg, so it must be charged here or the
    // proxy under-bills. cache READ is the cheap ~0.1x leg.
    return (
        (usage.tokensIn ?? 0) * p.input +
        (usage.tokensOut ?? 0) * p.output +
        (usage.cacheRead ?? 0) * p.cacheRead +
        (usage.cacheCreation ?? 0) * p.cacheCreation
    );
}

export interface CostBreakdown {
    providerCostUsd: number;
    /** Credits to debit, at cost (no markup). FRACTIONAL — the balance is a real
     *  number, so we debit the exact proportional cost and never round a turn up.
     *  Rounding each turn up to a whole credit massively over-charges cheap
     *  (e.g. cached) turns — a $0.0001 Gemini turn would bill a full $0.05 credit.
     *  The UI rounds for display; the debit stays exact. */
    credits: number;
}

/** Credits for a raw provider-cost USD amount, at cost (no markup). Fractional —
 *  see CostBreakdown.credits. (Display layers that want a whole-number "credits
 *  /hr" headline ceil the aggregate themselves; this stays exact.) */
export function usdToCredits(providerCostUsd: number): number {
    return providerCostUsd / USD_PER_CREDIT;
}

function toCredits(providerCostUsd: number): CostBreakdown {
    return { providerCostUsd, credits: usdToCredits(providerCostUsd) };
}

/** Price a single LLM turn (the proxy's hot path). */
export function priceLlmTurn(provider: ProviderId, model: string, usage: LlmUsage): CostBreakdown {
    return toCredits(llmCostUsd(provider, model, usage));
}

/** Price `seconds` of cloud STT — fractional credits, like every other leg.
 *  A turn fires several short STT passes (speculative + final), each a real
 *  Groq call; debiting the exact proportional cost keeps a fraction-of-a-cent
 *  leg from being rounded up by orders of magnitude. The balance is a real
 *  number; the UI rounds for display. */
export function priceSttSeconds(seconds: number): CostBreakdown {
    const providerCostUsd = Math.max(0, seconds) * STT_USD_PER_SECOND;
    return { providerCostUsd, credits: providerCostUsd / USD_PER_CREDIT };
}

/** Price `chars` of cloud TTS — fractional credits, same rationale as STT. The
 *  rate depends on the Google voice tier actually synthesized (Chirp3-HD vs the
 *  cheaper Neural2/Standard tiers differ 2-8x), so pass the resolved voice id;
 *  omitting it falls back to the Chirp3-HD default (providers.googleTtsRateFor). */
export function priceTtsChars(chars: number, voiceId?: string): CostBreakdown {
    const providerCostUsd = Math.max(0, chars) * googleTtsRateFor(voiceId);
    return { providerCostUsd, credits: providerCostUsd / USD_PER_CREDIT };
}

/** Price a whole session's accumulated usage (LLM + STT secs + TTS chars),
 *  e.g. for a final reconciliation or the live cost meter (meditation-pal-14s).
 *  LLM provider/model are passed since SessionUsage tallies tokens provider-
 *  agnostically; pass the dominant model used. */
export function priceSession(
    provider: ProviderId,
    model: string,
    usage: SessionUsage
): CostBreakdown {
    const p = pricingFor(provider, model);
    const llm = p
        ? usage.llmTokensIn * p.input +
          usage.llmTokensOut * p.output +
          usage.llmCacheRead * p.cacheRead +
          usage.llmCacheCreation * p.cacheCreation
        : 0;
    const stt = usage.sttSeconds * STT_USD_PER_SECOND;
    const tts = usage.ttsChars * TTS_USD_PER_CHAR;
    return toCredits(llm + stt + tts);
}

/** USD a pack of `credits` sells for: the provider cost it funds, marked up.
 *  Sales tax is added on top at checkout (Stripe Tax), not included here. */
export function packPriceUsd(credits: number): number {
    return credits * USD_PER_CREDIT * PACK_MARKUP;
}

/** A conservative pre-auth hold placed at session start, before any usage is
 *  known (meditation-pal-8sj: "a small pre-auth hold at session start").
 *  Sized to a few minutes of premium use; the unused remainder is released on
 *  settle. At cost-denominated credits this is a few cents of headroom. */
export const SESSION_HOLD_CREDITS = 10;

/** Hard ceiling on output tokens per turn, enforced server-side regardless of
 *  what the client asks for (meditation-pal-aa8). Bounds the priciest leg of a
 *  turn so a single response can't blow past the pre-auth hold. ~512 tokens is
 *  roughly a minute of spoken guidance — plenty for light-ish facilitation (the
 *  cloud default is 400) — and at Opus output rates only ~0.15 credits, leaving
 *  nearly all of SESSION_HOLD_CREDITS for input/context. Only clips pathological
 *  requests. */
export const MAX_OUTPUT_TOKENS = 512;

export interface PackLike {
    id: string;
    credits: number;
    priceUsdCents: number;
}

export interface SolvencyReport {
    packId: string;
    /** price / (credits * USD_PER_CREDIT) — net revenue per cost-dollar funded. */
    effectiveMarkup: number;
    /** Worst commission across channels we sell through. */
    worstCommission: number;
    requiredMarkup: number;
    clears: boolean;
}

/** Does every pack clear positive net margin on the worst channel we sell
 *  through? Called at boot with the live packs; throws if any would run at a
 *  loss after commission. The addendum's hard requirement, made executable. */
export function assertSolvent(packs: readonly PackLike[]): SolvencyReport[] {
    // The worst commission we'd ever pay on a sale bounds the required markup.
    const channels: Array<[PurchaseChannel, string]> = [
        ['web_stripe', 'US'],
        ['web_stripe', 'EU'],
        ['iap_apple', 'US'],
        ['iap_google', 'US'],
        ['x402', 'US'],
    ];
    const worstCommission = Math.max(
        ...channels.map(([c, j]) => commissionFor(c, j).rate),
        WORST_CASE_COMMISSION
    );
    const requiredMarkup = 1 / (1 - worstCommission);

    const reports = packs.map((pack): SolvencyReport => {
        const costFunded = pack.credits * USD_PER_CREDIT;
        const effectiveMarkup = costFunded > 0 ? pack.priceUsdCents / 100 / costFunded : 0;
        return {
            packId: pack.id,
            effectiveMarkup,
            worstCommission,
            requiredMarkup,
            clears: effectiveMarkup >= requiredMarkup,
        };
    });

    const failing = reports.filter((r) => !r.clears);
    if (failing.length > 0) {
        const detail = failing
            .map((r) => `${r.packId} markup ${r.effectiveMarkup.toFixed(2)}x < required ${r.requiredMarkup.toFixed(3)}x`)
            .join('; ');
        throw new Error(
            `Pricing is insolvent on the worst channel (commission ${worstCommission}): ${detail}. ` +
                `Raise pack prices or PACK_MARKUP.`
        );
    }
    return reports;
}

/**
 * The metered-billing core (meditation-pal-8sj): price each unit of usage by
 * its ACTUAL underlying provider cost, debited from a credit balance. That is
 * the direct fix for the cost-math trap meditation-pal-a2j flags: a daily power
 * user can never run at a loss, because every token is debited at real cost
 * rather than amortized against a flat subscription.
 *
 * Money model (Model B: margin lives at PURCHASE, not in the debit):
 *   - 1 credit = USD_PER_CREDIT of PROVIDER COST (what we pay). Debit is at
 *     cost: credits_spent = providerCostUsd / USD_PER_CREDIT. No markup here.
 *   - Margin is applied when CREDITS ARE SOLD, on a VOLUME CURVE whose single
 *     source of truth is billing/stripe.ts (creditsForCents / centsForCredits):
 *     credits-per-dollar steps up with spend, so markup is highest at the entry
 *     tier and eases for larger buys - ~2.5x / 12.5¢ per credit at the $5 tier,
 *     ~2.1x / 10.5¢ at $20+. PACK_MARKUP below is only that ENTRY-tier rate (the
 *     curve's max, and the solvency reference), NOT a flat per-pack multiplier.
 *     Markup is visible at checkout; sales tax/VAT rides on top via Stripe Tax.
 *   - Margin out of the debit means the per-session credit counts a user watches
 *     tick down map 1:1 to real compute cost: easy to verify, on-brand for the
 *     published-margin stance.
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
    DEFAULT_STT_MODEL,
    sttUsdPerSecond,
    TTS_USD_PER_CHAR,
    ttsRateFor,
    pricingFor,
} from './providers.js';
import type { ProviderId } from '../contract.js';
import type { TtsProvider } from '../providers/voice-catalog.js';

/** Provider COST one credit represents, in USD. Margin is NOT here; it's added
 *  at purchase via the sell curve (billing/stripe.ts). Tentative $0.05: at the
 *  entry rate the user pays ~$0.125/credit (less on larger buys), and a ~50-min
 *  Opus session lands at a single-digit credit count. Calibrate against real
 *  testing (meditation-pal-7xl). */
export const USD_PER_CREDIT = 0.05;

/** ENTRY-tier sell markup over the provider cost the credits fund: the steepest
 *  point of the volume curve (billing/stripe.ts), at the $5 tier. NOT a flat
 *  per-pack multiplier - larger buys sell below this (down to ~2.1x at $20+).
 *  Covers margin + payment commission; sales tax added on top by Stripe Tax.
 *  Comfortably above every channel's commission floor (see assertSolvent).
 *  Published: the one "sensitive" number, and trivially derivable anyway. */
export const PACK_MARKUP = 2.5;

/** USD provider cost of one LLM turn from its usage split. */
export function llmCostUsd(provider: ProviderId, model: string, usage: LlmUsage): number {
    const p = pricingFor(provider, model);
    if (!p) return 0;
    // Cache CREATION is billed and split by TTL: the 5m default costs ~1.25x
    // input, the 1h "anchor" write ~2x. Bill the 1h portion (Anthropic's
    // reported ephemeral_1h_input_tokens) at the higher rate and the rest at the
    // 5m rate, or the proxy under-bills the anchor. Cache READ is the ~0.1x leg.
    const cacheCreation = usage.cacheCreation ?? 0;
    const cacheCreation1h = Math.min(cacheCreation, Math.max(0, usage.cacheCreation1h ?? 0));
    const cacheCreation5m = cacheCreation - cacheCreation1h;
    return (
        (usage.tokensIn ?? 0) * p.input +
        (usage.tokensOut ?? 0) * p.output +
        (usage.cacheRead ?? 0) * p.cacheRead +
        cacheCreation5m * p.cacheCreation +
        cacheCreation1h * p.cacheCreation1h
    );
}

export interface CostBreakdown {
    providerCostUsd: number;
    /** Credits to debit, at cost (no markup). FRACTIONAL: the balance is a real
     *  number, so we debit the exact proportional cost and never round a turn up.
     *  Rounding each turn up to a whole credit massively over-charges cheap
     *  (e.g. cached) turns - a $0.0001 Gemini turn would bill a full $0.05
     *  credit. The UI rounds for display; the debit stays exact. */
    credits: number;
}

/** Credits for a raw provider-cost USD amount, at cost (no markup). Fractional,
 *  see CostBreakdown.credits. Display layers wanting a whole-number "credits/hr"
 *  headline ceil the aggregate themselves; this stays exact. */
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

/** Price `seconds` of cloud STT for `model` (default: the server-default
 *  gpt-4o-transcribe), at provider cost like every other leg, fractional
 *  credits. A turn fires several short STT passes (speculative + final), each a
 *  real Whisper-backend call, so debiting the exact proportional cost keeps a
 *  fraction-of-a-cent leg from being rounded up by orders of magnitude. */
export function priceSttSeconds(seconds: number, model: string = DEFAULT_STT_MODEL): CostBreakdown {
    const providerCostUsd = Math.max(0, seconds) * sttUsdPerSecond(model);
    return { providerCostUsd, credits: providerCostUsd / USD_PER_CREDIT };
}

/** Price `chars` of cloud TTS, fractional credits, same rationale as STT. The
 *  rate depends on the provider and (for Google) the voice tier synthesized:
 *  Chirp3-HD vs cheaper Neural2/Standard differ 2-8x and OpenAI is its own flat
 *  rate, so pass the resolved (provider, voiceId). Omitting the options falls
 *  back to Google Chirp3-HD (providers.ttsRateFor), our most conservative rate. */
export function priceTtsChars(
    chars: number,
    opts: { provider?: TtsProvider; voiceId?: string } = {}
): CostBreakdown {
    const providerCostUsd = Math.max(0, chars) * ttsRateFor(opts.provider ?? 'google', opts.voiceId);
    return { providerCostUsd, credits: providerCostUsd / USD_PER_CREDIT };
}

/** Price a whole session's usage (LLM + STT secs + TTS chars), e.g. for final
 *  reconciliation or the live cost meter (meditation-pal-14s). SessionUsage
 *  tallies tokens provider-agnostically, so pass the dominant model used. */
export function priceSession(
    provider: ProviderId,
    model: string,
    usage: SessionUsage
): CostBreakdown {
    // One pricing function for LLM tokens (llmCostUsd) so per-turn and
    // per-session paths can't drift. SessionUsage carries no 1h cache-creation
    // split, so the whole creation bucket prices at the 5m rate here, the same
    // treatment as a turn that reports no 1h portion.
    const llm = llmCostUsd(provider, model, {
        tokensIn: usage.llmTokensIn,
        tokensOut: usage.llmTokensOut,
        cacheRead: usage.llmCacheRead,
        cacheCreation: usage.llmCacheCreation,
        cacheCreation1h: 0,
    });
    // SessionUsage doesn't carry the STT model, so the default's rate applies —
    // exact on the default hosted engine, slightly over-stating the cheaper one.
    const stt = usage.sttSeconds * sttUsdPerSecond(DEFAULT_STT_MODEL);
    const tts = usage.ttsChars * TTS_USD_PER_CHAR;
    return toCredits(llm + stt + tts);
}

/** Conservative pre-auth hold at session start, before usage is known
 *  (meditation-pal-8sj: "a small pre-auth hold at session start"). Sized to a
 *  few minutes of premium use; the unused remainder is released on settle. At
 *  cost-denominated credits that's a few cents of headroom. */
export const SESSION_HOLD_CREDITS = 10;

/** Hard ceiling on output tokens per turn, enforced server-side regardless of
 *  what the client asks for (meditation-pal-aa8). Bounds the priciest leg of a
 *  turn so one response can't blow past the pre-auth hold. 512 tokens is ~a
 *  minute of spoken guidance (the cloud default is 400) and at Opus output rates
 *  only ~0.15 credits, leaving nearly all of SESSION_HOLD_CREDITS for
 *  input/context. Only clips pathological requests. */
export const MAX_OUTPUT_TOKENS = 512;

export interface PackLike {
    id: string;
    credits: number;
    priceUsdCents: number;
}

export interface SolvencyReport {
    packId: string;
    /** price / (credits * USD_PER_CREDIT): net revenue per cost-dollar funded. */
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
    // The worst commission we'd ever pay bounds the required markup.
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
                `Steepen the sell curve (fewer credits per dollar) in billing/stripe.ts.`
        );
    }
    return reports;
}

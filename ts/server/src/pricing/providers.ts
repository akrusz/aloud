/**
 * Underlying provider cost tables: what aloud PAYS, in USD. Retail is this times
 * the margin multiplier (meter.ts).
 *
 * Token rates are USD per token (list price / 1e6). Input, output, and cache
 * read are priced separately and never summed - output runs ~4-5x input and a
 * cache read ~10x cheaper than fresh input, so collapsing them would misprice
 * long sessions badly. Mirrors the split the core usage tracker already carries
 * (ts/src/llm/base.ts CompletionResult).
 *
 * LIST prices as of early 2026, and they WILL drift; they live here in the open
 * so a price change is a one-line diff. This table's model allowlist also gates
 * which models a client may bill against (meditation-pal-8sj: a client must not
 * be able to invoke an arbitrary expensive model on a user's credits).
 */

import type { ProviderId } from '../contract.js';
import type { TtsProvider } from '../providers/voice-catalog.js';

export interface TokenRates {
    /** USD per input token. */
    input: number;
    /** USD per output token. */
    output: number;
    /** USD per cached-read input token. */
    cacheRead: number;
    /** USD per cache-write (creation) input token at the DEFAULT 5-minute TTL
     *  (Anthropic ~1.25x input). */
    cacheCreation: number;
    /** USD per cache-write at the 1-hour TTL (Anthropic 2x input). Used by the
     *  "anchor" breakpoint that survives long [HOLD] silences. Providers with
     *  automatic caching (OpenAI/Google) have no 1h write and report none, so
     *  this sits at the input rate and never accrues. */
    cacheCreation1h: number;
}

export interface ModelPricing extends TokenRates {
    provider: ProviderId;
    model: string;
    /** The model the picker pre-selects when the user hasn't chosen one. Exactly
     *  one entry should carry it; the client falls back to the first model if
     *  none does. Independent of list order, so the dropdown can order models
     *  however it likes. */
    default?: boolean;
    /** Expanded-tier: hidden from the model picker until the user opts into
     *  "Show all available models" (ui model-picker.ts). For older and niche
     *  models kept for their distinct voices (Opus 3, Kimi K2) or as price
     *  variants of a listed sibling, so new users see a short curated list.
     *  Billing and forwarding ignore it - an expanded model is fully served. */
    expanded?: boolean;
}

const M = 1_000_000;

/**
 * ADDING A MODEL - checklist (each item has bitten us at least once):
 *
 * 1. CACHING POLICY, before list price. The session shape is ~45:1 input-heavy
 *    and most input is re-sent prefix (estimate.ts TYPICAL_SESSION), so the
 *    cacheRead rate, not input/output, drives $/hr. Check: (a) does the endpoint
 *    cache at all; (b) the cached-read multiplier (~0.1x on
 *    OpenAI/Google/Anthropic, only 0.5x on Groq, none on Novita); (c) whether
 *    cached tokens are actually REPORTED on the wire
 *    (prompt_tokens_details.cached_tokens / Anthropic's cache fields) - a proxy
 *    hop like OpenRouter can drop the field. If caching is absent or unreported,
 *    pin all cache fields at the input rate: estimates then match real billing,
 *    and if tokens ever do appear we over-charge, never under-bill.
 * 2. Run the math through estimate.ts before calling a model "cheap": a no-cache
 *    $0.57 model and a 50%-cached $1 model land within a cent/hr.
 * 3. OpenRouter slugs: list the real endpoints
 *    (GET /api/v1/models/<slug>/endpoints) for host, jurisdiction, quantization.
 *    Pin routing (extraBody provider.only) if the host matters, and update the
 *    privacy policy's provider list (docs/privacy/index.html) to name where
 *    session content actually goes. For single-host slugs, consider a fallback
 *    chain (forward.ts OPENROUTER_FALLBACKS) so the turn survives the host
 *    dropping the model.
 * 4. Reasoning: voice needs ~1s to first token, so mandatory reasoning is
 *    disqualifying (Kimi K3, 7-12s). Update OPENROUTER_MANDATORY_REASONING /
 *    OPENROUTER_REASONING_UNSUPPORTED in ts/src/llm/openai.ts and the "slower"
 *    note list in ui/src/model-picker.ts.
 * 5. Ear-test the control tokens ([HOLD]/[WAIT:Nm]/[PASS]/[NEXT]) in a real
 *    session; small/open models mishandle them and a bare completion won't show
 *    it.
 * 6. Housekeeping: pretty name in ui/src/model-picker.ts CLOUD_MODEL_NAMES;
 *    allowlist + rate assertions in server/tests/model-additions.test.ts; decide
 *    curated vs expanded-tier (`expanded: true` hides it behind the picker's
 *    "Show all available models" toggle).
 */

/** Keyed by `${provider}:${model}`. */
const MODELS: Record<string, ModelPricing> = {
    // Fable 5: Anthropic's most capable model, a premium tier ABOVE Opus 5
    // ($10/$50 per 1M, ~2x Opus). Same 5m/1h prompt caching as the Opus family
    // (verified live on the metered request shape), so the 1h "anchor" bills
    // through cacheCreation1h like the others. Offered but NOT the default: it's
    // slow (always reasons) and the priciest tier, so Opus 5 is pre-selected
    // (see `default` below) and Fable is opt-in. Uses the newer tokenizer (~30%
    // more tokens for the same text), which inflates token COUNTS, not the
    // per-token rates below, so no adjustment here.
    'anthropic:claude-fable-5': {
        provider: 'anthropic',
        model: 'claude-fable-5',
        input: 10 / M,
        output: 50 / M,
        cacheRead: 1 / M,
        cacheCreation: 12.5 / M, // 5m write, 1.25x input
        cacheCreation1h: 20 / M, // 1h write, 2x input
    },
    // Opus 5 (replaced Opus 4.8 here, July 2026): a drop-in successor at
    // IDENTICAL rates ($5/$25 per 1M, same cache multipliers), so the debit math
    // and the shown credits/hr don't move. Swapped rather than listed alongside
    // 4.8, as Sonnet 5 replaced Sonnet 4.6 below - two same-price Opus entries
    // would only clutter the picker. Thinking is ON by default here, so the core
    // AnthropicProvider sends an explicit disable (THINKING_OFF_MODELS) to keep
    // the voice loop prompt. Its 512-token cache minimum (half of 4.8's) makes
    // short early turns cacheable - cheaper, never costlier.
    'anthropic:claude-opus-5': {
        provider: 'anthropic',
        model: 'claude-opus-5',
        default: true, // pre-selected default: capable, faster + cheaper than Fable
        input: 5 / M,
        output: 25 / M,
        cacheRead: 0.5 / M,
        cacheCreation: 6.25 / M, // 5m write, 1.25x input
        cacheCreation1h: 10 / M, // 1h write, 2x input
    },
    // Opus 4.8, RE-ADDED as expanded-tier (July 2026): it was the hosted default
    // until Opus 5 replaced it, so it's already ear-tested and cache-verified in
    // production here - restored verbatim from the pre-2bd2120 entry because the
    // older personalities speak differently, not worse. Same $5/$25 sticker and
    // cache multipliers as Opus 5; thinking is off by default (no
    // THINKING_OFF_MODELS entry needed). Legacy-model caveat: Anthropic will
    // retire it eventually - drop the entry when the API does.
    'anthropic:claude-opus-4-8': {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        expanded: true,
        input: 5 / M,
        output: 25 / M,
        cacheRead: 0.5 / M,
        cacheCreation: 6.25 / M, // 5m write, 1.25x input
        cacheCreation1h: 10 / M, // 1h write, 2x input
    },
    // Opus 4.5, expanded-tier: the OLDEST Opus under the 5☁️/hr line (a direct
    // ask). Nov 2025 is where Opus pricing dropped to $5/$25; every Opus before
    // it (4.1, 4, 3) sits at the $15/$75 legacy tier - Opus 3's 14☁️/hr - so
    // this is as far back as the family goes at this rate. Same cache
    // multipliers as its successors; thinking off by default (pre-Opus-5, like
    // 4.8/4.6). UNLIKE 4.8/4.6 it never served here, so it still needs the
    // checklist's ear-test before release; the liveness sweep only proves the
    // id exists.
    'anthropic:claude-opus-4-5': {
        provider: 'anthropic',
        model: 'claude-opus-4-5',
        expanded: true,
        input: 5 / M,
        output: 25 / M,
        cacheRead: 0.5 / M,
        cacheCreation: 6.25 / M, // 5m write, 1.25x input
        cacheCreation1h: 10 / M, // 1h write, 2x input
    },
    // Sonnet 5 (replaced Sonnet 4.6 here, July 2026): near-Opus quality at
    // $2/$10. That WAS a promotional rate through 2026-08-31, above a $3/$15
    // list, and this table carried the list price on the reasoning that we'd
    // simply pay less until then. Anthropic made the intro rate permanent
    // (announced 2026-08-10), so the list price is gone and $2/$10 IS the
    // price. Rates below are the real ones: since credits debit at cost
    // (meter.ts priceLlmTurn), billing the old sticker would have quietly taken
    // an extra ~1.5x on every Sonnet turn, forever rather than for three weeks.
    // The docs pricing table still showed the Sept 1 step-up when this landed -
    // it lags the announcement; verify there before assuming a regression.
    // Sonnet 4.6 below stays at $3/$15: the change is Sonnet 5 only, so the
    // legacy entry is now DEARER than its successor.
    //
    // Newer tokenizer (~30% more tokens for the same text than 4.6) inflates
    // token COUNTS, not these per-token rates, so no adjustment here (same
    // stance as Fable above). The core AnthropicProvider sends an explicit
    // thinking-disabled for this model (adaptive thinking is otherwise ON by
    // default), so no thinking tokens accrue on the metered path.
    'anthropic:claude-sonnet-5': {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        input: 2 / M,
        output: 10 / M,
        cacheRead: 0.2 / M,
        cacheCreation: 2.5 / M, // 5m write, 1.25x input
        cacheCreation1h: 4 / M, // 1h write, 2x input
    },
    // Sonnet 4.6, RE-ADDED as expanded-tier (July 2026): same re-add logic as
    // Opus 4.8 above (served here until Sonnet 5 replaced it in e851420, so
    // production-proven; distinct voice, not a downgrade). Still $3/$15, which
    // since Sonnet 5's permanent price cut makes this the pricier of the pair -
    // it's the one legacy entry that costs MORE than its successor, so the
    // picker shows it at a higher rate. Older tokenizer (fewer tokens for the
    // same text, so if anything it estimates slightly cheap). Thinking off by
    // default. Same retirement caveat as 4.8.
    'anthropic:claude-sonnet-4-6': {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        expanded: true,
        input: 3 / M,
        output: 15 / M,
        cacheRead: 0.3 / M,
        cacheCreation: 3.75 / M, // 5m write, 1.25x input
        cacheCreation1h: 6 / M, // 1h write, 2x input
    },
    // The curated list's budget slot. Flash Lite is ~11x cheaper per token, but
    // in absolute terms that's $0.046/hr vs $0.004/hr (estimate.ts) - both round
    // up to the same 1☁️ badge and both are noise next to the session's TTS
    // spend - so the slot goes to the model with the warmer prose (a Claude),
    // and Flash Lite sits in the expanded tier for whoever wants the floor.
    'anthropic:claude-haiku-4-5-20251001': {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        input: 1 / M,
        output: 5 / M,
        cacheRead: 0.1 / M,
        cacheCreation: 1.25 / M, // 5m write, 1.25x input
        cacheCreation1h: 2 / M, // 1h write, 2x input
    },
    // Opus 3 (claude-3-opus-20240229): the original Claude 3 flagship, still
    // served on the API though dropped from Anthropic's current price sheet. A
    // niche draw - some people prefer its warmer, more distinctive prose, which
    // is exactly what the meditation voice wants. Legacy Opus rate, $15/$75 per
    // 1M (the tier Opus 4/4.1 legacy also sit at). 200K context, 4096 max output,
    // well above our 512-token cap. 5m + 1h caching both verified on the metered
    // path, so the anchor breakpoint is fine. Pinned to the dated id, the only
    // form the API exposes.
    'anthropic:claude-3-opus-20240229': {
        provider: 'anthropic',
        model: 'claude-3-opus-20240229',
        expanded: true, // niche draw, not a first-session pick
        input: 15 / M,
        output: 75 / M,
        cacheRead: 1.5 / M,
        cacheCreation: 18.75 / M, // 5m write, 1.25x input
        cacheCreation1h: 30 / M, // 1h write, 2x input
    },
    // (Groq llama-3.3-70b was removed as a hosted option: NO prompt caching, so
    // on this ~98%-re-sent-history workload the whole transcript bills at full
    // input every turn, pricier than cached Haiku/Gemini despite a lower sticker
    // price. 'groq' stays a valid provider for STT/Whisper.)
    //
    // The genuine VALUE tier: cheap per-token AND cache-capable, which on this
    // ~98%-re-sent-history workload crushes Haiku. Accessed DIRECT via Google's
    // OpenAI-compatible endpoint (no OpenRouter middleman fee, these are Google's
    // own list prices). Gemini implicit caching is ~75% off input and the OpenAI
    // provider parses prompt_tokens_details.cached_tokens, so cache reads bill at
    // the discounted rate. (cacheCreation isn't surfaced by the OpenAI usage
    // shape, so it never accrues here; left at input rate harmlessly.)
    'google:gemini-2.5-flash-lite': {
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
        expanded: true, // absolute-cheapest option; Haiku holds the curated budget slot (see above)
        input: 0.1 / M,
        output: 0.4 / M,
        cacheRead: 0.01 / M, // Google list price for cached-input read (text), ~90% off input
        cacheCreation: 0.1 / M,
        cacheCreation1h: 0.1 / M, // no 1h write on automatic caching; never accrues
    },
    // OpenAI's current flagship (GA July 2026), the GPT counterpart to Opus: the
    // top "Sol" tier of the 5.6 family (Terra/Luna are the mid/value tiers we
    // don't list; after OpenAI's Jul 30 2026 cuts Terra is $2/$12 - undercutting
    // gpt-5.4 below - and Luna $0.20/$1.20/$0.02-cached, near Flash Lite range,
    // so both are worth a revisit - see the bead filed with this note).
    // PINNED to the exact tier id, NOT the moving chatgpt-latest alias: the debit
    // math bills against THIS table, so the model must be a known quantity (a new
    // flagship at a different price can't bill at a stale rate). Cache-capable,
    // essential on this ~98%-re-sent-history workload, via OpenAI automatic
    // prompt caching: cached input ~90% off, surfaced as
    // prompt_tokens_details.cached_tokens (OpenAIProvider parses it into
    // cacheRead). ONE pricing difference from every earlier OpenAI model: the 5.6
    // family bills cache WRITES at 1.25x input and reports them
    // (prompt_tokens_details.cache_write_tokens, parsed into cacheCreation), so
    // cacheCreation here is a real accruing rate, not the never-accrues
    // placeholder older entries carry. Automatic caching has no 1h write tier, so
    // cacheCreation1h mirrors the 5m rate and never accrues. $5/$30 per 1M, $0.50
    // cached, $6.25 write (Jul 2026).
    'openai:gpt-5.6-sol': {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        input: 5 / M,
        output: 30 / M,
        cacheRead: 0.5 / M,
        cacheCreation: 6.25 / M, // real 1.25x write fee, new in the 5.6 family
        cacheCreation1h: 6.25 / M, // no 1h tier on automatic caching; never accrues
    },
    // Expanded-tier: same sticker as its 5.6 Sol successor, kept only for its
    // different voice.
    'openai:gpt-5.5': {
        provider: 'openai',
        model: 'gpt-5.5',
        expanded: true,
        input: 5 / M,
        output: 30 / M,
        cacheRead: 0.5 / M,
        cacheCreation: 5 / M,
        cacheCreation1h: 5 / M, // no 1h write on automatic caching; never accrues
    },
    // OpenAI midrange: a prior flagship, ~half the price of 5.5 and roughly the
    // Sonnet cost tier. Same family caching (cached input ~90% off) and the same
    // pinned-version / cacheCreation-at-input-rate treatment as 5.5 above.
    // $2.50/$15 per 1M, $0.25 cached (Mar 2026).
    'openai:gpt-5.4': {
        provider: 'openai',
        model: 'gpt-5.4',
        expanded: true, // midrange price variant; Sonnet 5 holds that slot in the curated list
        input: 2.5 / M,
        output: 15 / M,
        cacheRead: 0.25 / M,
        cacheCreation: 2.5 / M,
        cacheCreation1h: 2.5 / M, // no 1h write on automatic caching; never accrues
    },
    // Kimi K2 0711: the ORIGINAL K2 (July 2025), Moonshot's open model but hosted
    // on Novita (Groq as fallback host), reached via OpenRouter - the one
    // openrouter entry in this table, and the server's OPENROUTER_API_KEY must be
    // set for it to forward. Replaced Kimi K3 here (July 2026): K3's reasoning is
    // mandatory, which measured 7-12s to first spoken token and could blank a
    // turn when the thinking preamble hit max_tokens, unusable pacing for voice.
    // K2 0711 has no reasoning (~1s to first token) and is the release the Kimi
    // personality lore is about ("genuine literary intelligence"; later K2.5 was
    // widely called a personality regression from it) - the same niche-draw logic
    // as Opus 3 above, at 1/5 the K3 price: $0.57/$2.30 per 1M. Single-host slug,
    // so it degrades to kimi-k2-0905 (forward.ts OPENROUTER_FALLBACKS), which
    // bills at these rates while OpenRouter charges 0905's, a ~4% under-recovery.
    // OpenRouter lists NO cache pricing for this endpoint, so all cache fields
    // sit at the input rate: cached_tokens never appear and everything bills as
    // fresh input (and if a host ever does report them, input-rate is an
    // over-charge, never an under-bill). Full fresh-input billing is what
    // disqualified Groq llama above, but at $0.57 it stays cheaper per turn than
    // cached mid-tier models.
    'openrouter:moonshotai/kimi-k2': {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2',
        expanded: true, // niche draw, same logic as Opus 3
        input: 0.57 / M,
        output: 2.3 / M,
        cacheRead: 0.57 / M,
        cacheCreation: 0.57 / M,
        cacheCreation1h: 0.57 / M, // no caching on this endpoint; never accrues
    },
};

/** Per-second provider cost of cloud STT, by model — debited AT COST like every
 *  other leg (meter.ts Model B). The free/browser engines bill zero; only
 *  /cloud/v1/stt feeds this. Rates verified July 2026: gpt-4o-transcribe
 *  $0.006/min, gpt-transcribe $0.0045/min (its 25%-cheaper successor, same
 *  /audio/transcriptions API); Groq ≈ $0.04/hr, gpt-4o-mini-transcribe ≈
 *  $0.18/hr if ever env-pinned. Even at the top of the range STT is a small
 *  fraction of a session's TTS + LLM spend. */
export const STT_USD_PER_SECOND_BY_MODEL: Record<string, number> = {
    'gpt-4o-transcribe': 0.36 / 3600,
    'gpt-transcribe': 0.27 / 3600,
};

/** The server-default model (config.ts STT_DEFAULTS), used when a request names
 *  no model — and the cost fallback for env-pinned backends (Groq, custom)
 *  whose models aren't in the table: they bill the default's rate, which can
 *  only over-charge fractions of a cent, never under-bill. */
export const DEFAULT_STT_MODEL = 'gpt-4o-transcribe';

/** Provider cost $/s for a model, falling back to the default's rate. */
export function sttUsdPerSecond(model: string): number {
    return STT_USD_PER_SECOND_BY_MODEL[model] ?? STT_USD_PER_SECOND_BY_MODEL[DEFAULT_STT_MODEL]!;
}

/** Google Cloud TTS list price per CHARACTER, by voice tier. The hosted TTS
 *  backend is Google (providers/tts.ts synthesizes en-US-Chirp3-HD-* voices), so
 *  THIS, not a generic "cloud"/ElevenLabs rate, is what actually bills. Verified
 *  vs cloud.google.com/text-to-speech/pricing (June 2026), per 1M chars:
 *  Standard $4 · WaveNet/Neural2/Polyglot $16 · Chirp3-HD $30 · Studio $160.
 *  (Google also gives 1M chars/month free per tier; we don't model that, so we
 *  slightly over-state real cost - conservative, never an under-bill.) */
const GOOGLE_TTS_TIER_USD_PER_CHAR = {
    standard: 4 / M,
    premium: 16 / M, // WaveNet / Neural2 / Polyglot
    chirpHd: 30 / M, // Chirp3-HD / Chirp-HD, the tier every curated voice ships on
    studio: 160 / M,
} as const;

/** Default per-char TTS rate when a voice id's tier can't be parsed: Chirp3-HD,
 *  the tier every curated voice uses (voice-catalog.ts). Also the rate the
 *  whole-session estimate assumes (meter.priceSession, which has no voice). */
export const TTS_USD_PER_CHAR = GOOGLE_TTS_TIER_USD_PER_CHAR.chirpHd; // $30/1M (Google Chirp3-HD)

/** OpenAI gpt-4o-mini-tts list price, expressed per CHARACTER to fit our meter.
 *  OpenAI bills by AUDIO OUTPUT tokens ($12/1M) plus a small text-input leg
 *  ($0.60/1M tokens), about $0.015 per minute of speech, so per-char is an
 *  approximation of a duration price. Calibrated against the first spend
 *  reconciliation (meditation-pal-t5ye, 2026-07-18): the initial $22/1M
 *  slow-pace guess billed a uniform +18.3% over OpenAI's actual charges,
 *  implying an effective ~$18.6/1M at real delivery pace. $19/1M rounds up
 *  from measured (a slow delivery still can't under-bill) while staying under
 *  the Chirp3-HD ceiling. Re-check against the reconciliation as rates drift. */
export const OPENAI_TTS_USD_PER_CHAR = 19 / M; // ~$19/1M (gpt-4o-mini-tts, reconciled 2026-07)

/** Per-character cost for a specific Google voice, read from its id. Google
 *  voice ids encode the tier (en-US-Chirp3-HD-Leda, en-US-Neural2-C,
 *  en-US-Standard-B, en-US-Studio-O), so the tier comes straight from the name.
 *  Unknown tier → the Chirp3-HD default (what our catalog ships): conservative
 *  for anything cheaper, and only under-bills the Studio tier we don't offer. */
export function googleTtsRateFor(voiceId: string | undefined): number {
    if (!voiceId) return TTS_USD_PER_CHAR;
    const v = voiceId.toLowerCase();
    if (v.includes('studio')) return GOOGLE_TTS_TIER_USD_PER_CHAR.studio;
    if (v.includes('chirp')) return GOOGLE_TTS_TIER_USD_PER_CHAR.chirpHd;
    if (v.includes('neural2') || v.includes('wavenet') || v.includes('polyglot'))
        return GOOGLE_TTS_TIER_USD_PER_CHAR.premium;
    if (v.includes('standard')) return GOOGLE_TTS_TIER_USD_PER_CHAR.standard;
    return TTS_USD_PER_CHAR;
}

/** Per-character TTS cost for a resolved (provider, voiceId). OpenAI is a flat
 *  per-char rate (voice doesn't change the price); Google's is read from the
 *  voice id's tier. The single rate authority both the meter and the picker's
 *  credits/hr estimate bill through, so a shown rate can't drift from the real
 *  charge. */
export function ttsRateFor(provider: TtsProvider, voiceId: string | undefined): number {
    return provider === 'openai' ? OPENAI_TTS_USD_PER_CHAR : googleTtsRateFor(voiceId);
}

export function pricingFor(provider: ProviderId, model: string): ModelPricing | undefined {
    return MODELS[`${provider}:${model}`];
}

export function isModelAllowed(provider: ProviderId, model: string): boolean {
    return pricingFor(provider, model) !== undefined;
}

export function allowedModels(): ModelPricing[] {
    return Object.values(MODELS);
}

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
    /** zh picker overrides (2026-09-01, native-listener pass: the GPT family
     *  reads better in Chinese than the Claudes). When the app language is
     *  Chinese the client rebuilds the shortlist from these three flags;
     *  billing and forwarding ignore them, and nothing changes for English.
     *  zhDefault: pre-selected instead of `default` (at most one entry).
     *  zhCurated: shortlisted in zh even though `expanded` here.
     *  zhExpanded: dropped to the expanded tier in zh even though curated. */
    zhDefault?: boolean;
    zhCurated?: boolean;
    zhExpanded?: boolean;
    /** The model background utility work runs on - currently the in-session
     *  recap refresh (ui/views/session.ts buildRecapProvider), which reads it
     *  off /me/models rather than pinning an id in the view. Exactly one entry
     *  should carry it; callers fall back to the utility provider (Haiku) when
     *  none does. Deliberately a FLAG, not "whichever model is cheapest":
     *  recaps seed summary-based resume, so letting a future budget entry
     *  silently inherit the job would quietly change what the facilitator
     *  believes about a past sit. */
    utility?: boolean;
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
    // Fable 5.1: the premium tier above Opus. Same 5m/1h caching as the Opus
    // family (verified on the metered request shape), but cache READS are only
    // 0.025x input, the rate that drives $/hr here. Opt-in, not the default:
    // slow (always reasons) and the priciest. Its tokenizer (~30% more tokens
    // than 4.6) inflates token COUNTS, not these rates.
    'anthropic:claude-fable-5-1': {
        provider: 'anthropic',
        model: 'claude-fable-5-1',
        input: 10 / M,
        output: 50 / M,
        cacheRead: 0.25 / M,
        cacheCreation: 12.5 / M, // 5m write, 1.25x input
        cacheCreation1h: 20 / M, // 1h write, 2x input
    },
    // Opus 5.5, the default. Thinking CAN'T be disabled (the disable 400s at
    // every effort), so the core AnthropicProvider pins effort `low` like Fable
    // (thinkingPolicy 'always-on'); the API default is `medium`.
    'anthropic:claude-opus-5-5': {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
        default: true, // pre-selected default: capable, and cheaper than Fable
        input: 4 / M,
        output: 20 / M,
        cacheRead: 0.2 / M,
        cacheCreation: 5 / M, // 5m write, 1.25x input
        cacheCreation1h: 8 / M, // 1h write, 2x input
    },
    // Opus 5, expanded-tier: ear-tested in production, and a sitter who picked
    // it keeps it. Thinking is ON by default, so the core AnthropicProvider
    // sends an explicit disable (thinkingPolicy 'opt-out') to keep the voice
    // loop prompt.
    'anthropic:claude-opus-5': {
        provider: 'anthropic',
        model: 'claude-opus-5',
        expanded: true,
        input: 5 / M,
        output: 25 / M,
        cacheRead: 0.5 / M,
        cacheCreation: 6.25 / M, // 5m write, 1.25x input
        cacheCreation1h: 10 / M, // 1h write, 2x input
    },
    // Opus 4.8, expanded-tier: a former hosted default (ear-tested and
    // cache-verified here), kept because older personalities speak
    // differently, not worse. Thinking off by default. Drop the entry when the
    // API retires it.
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
    // Opus 4.5, expanded-tier: the oldest Opus at the $5/$25 rate (every
    // earlier one is $15/$75 legacy). Thinking off by default. Unlike 4.8 it
    // never served here, so it still needs the checklist's ear-test; the
    // liveness sweep only proves the id exists.
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
    // Sonnet 5: $2/$10 is the permanent price (the intro rate Anthropic kept,
    // announced 2026-08-10), even though the docs pricing table lagged with a
    // $3/$15 step-up; verify there before "fixing" it. Credits debit at cost,
    // so the stale sticker would over-bill every Sonnet turn ~1.5x. Newer
    // tokenizer (~30% more tokens than 4.6) inflates COUNTS, not these rates.
    // The core AnthropicProvider sends an explicit thinking-disabled (adaptive
    // thinking is otherwise on), so no thinking tokens accrue.
    'anthropic:claude-sonnet-5': {
        provider: 'anthropic',
        model: 'claude-sonnet-5',
        zhExpanded: true, // zh shortlist carries the GPTs instead (see zh flags above)
        input: 2 / M,
        output: 10 / M,
        cacheRead: 0.2 / M,
        cacheCreation: 2.5 / M, // 5m write, 1.25x input
        cacheCreation1h: 4 / M, // 1h write, 2x input
    },
    // Sonnet 4.6, expanded-tier on the same logic as Opus 4.8. Still $3/$15,
    // so DEARER than its successor: the picker shows it at a higher rate.
    // Thinking off by default. Same retirement caveat as 4.8.
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
        zhExpanded: true, // zh's budget slot goes to Kimi K2 (zhCurated below)
        input: 1 / M,
        output: 5 / M,
        cacheRead: 0.1 / M,
        cacheCreation: 1.25 / M, // 5m write, 1.25x input
        cacheCreation1h: 2 / M, // 1h write, 2x input
    },
    // Opus 3: still served though off Anthropic's current price sheet; a niche
    // draw for its warmer prose. Legacy $15/$75 rate. 5m + 1h caching both
    // verified on the metered path. The dated id is the only form the API
    // exposes.
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
    // (No Groq LLM: without prompt caching the whole re-sent transcript bills
    // at full input every turn. 'groq' stays a provider for STT.)
    //
    // Direct via Google's OpenAI-compatible endpoint, at Google's list prices.
    // The OpenAI provider parses prompt_tokens_details.cached_tokens, so
    // implicit-cache reads bill discounted; cache writes aren't surfaced, so
    // cacheCreation sits at the input rate and never accrues.
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
    // The floor, and the recap engine (`utility` above), picked over Flash Lite
    // for CACHE CERTAINTY: OpenAI reports and discounts cached_tokens, while
    // meditation-pal-1etx is open on whether Gemini's implicit-cache discount
    // reaches the bill, and recaps re-send the whole transcript. Pre-5.6 GPT-5:
    // no cache-write reporting, so cacheCreation is a never-accrues
    // placeholder. ts/src/llm/openai.ts pins its reasoning to 'minimal'. Not
    // ear-tested as a facilitator (checklist item 5); recaps emit no control
    // tokens.
    'openai:gpt-5-nano': {
        provider: 'openai',
        model: 'gpt-5-nano',
        expanded: true,
        utility: true,
        input: 0.05 / M,
        output: 0.4 / M,
        cacheRead: 0.005 / M,
        cacheCreation: 0.05 / M,
        cacheCreation1h: 0.05 / M, // no 1h write on automatic caching; never accrues
    },
    // OpenAI's flagship, the top "Sol" tier of the 5.6 family. PINNED to the
    // tier id, not the moving chatgpt-latest alias: the debit bills against
    // THIS table, so a new flagship must not bill at a stale rate. Unlike
    // earlier OpenAI models, the 5.6 family bills cache WRITES at 1.25x input
    // and reports them (prompt_tokens_details.cache_write_tokens), so
    // cacheCreation is a real accruing rate here. No 1h tier on automatic
    // caching, so cacheCreation1h mirrors the 5m rate and never accrues.
    'openai:gpt-5.6-sol': {
        provider: 'openai',
        model: 'gpt-5.6-sol',
        zhDefault: true, // zh pre-select: GPT reads native, the Claudes accented
        input: 5 / M,
        output: 30 / M,
        cacheRead: 0.5 / M,
        cacheCreation: 6.25 / M, // real 1.25x write fee, new in the 5.6 family
        cacheCreation1h: 6.25 / M, // no 1h tier on automatic caching; never accrues
    },
    // Terra, the 5.6 family's mid tier, same caching contract as Sol.
    // Expanded for English (Sonnet 5 holds the midrange slot) but curated on
    // the zh shortlist. NOT yet ear-tested as a facilitator (checklist item 5).
    'openai:gpt-5.6-terra': {
        provider: 'openai',
        model: 'gpt-5.6-terra',
        expanded: true,
        zhCurated: true,
        input: 2 / M,
        output: 12 / M,
        cacheRead: 0.2 / M,
        cacheCreation: 2.5 / M, // real 1.25x write fee, like Sol
        cacheCreation1h: 2.5 / M, // no 1h tier on automatic caching; never accrues
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
    // A prior flagship at the Sonnet cost tier; same cacheCreation-at-input
    // placeholder as 5.5.
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
    // Kimi K2 0711, the original K2 (no reasoning, ~1s to first token; K3's
    // mandatory reasoning ran 7-12s), via OpenRouter on Novita: the one
    // openrouter entry, so OPENROUTER_API_KEY must be set. A niche draw like
    // Opus 3. Single-host slug, so it degrades to kimi-k2-0905 (forward.ts
    // OPENROUTER_FALLBACKS), a ~4% under-recovery while degraded. No cache
    // pricing on this endpoint, so every cache field sits at the input rate (a
    // reported cached token would over-charge, never under-bill); at $0.57
    // full fresh input still undercuts cached mid-tier models.
    'openrouter:moonshotai/kimi-k2': {
        provider: 'openrouter',
        model: 'moonshotai/kimi-k2',
        expanded: true, // niche draw, same logic as Opus 3
        zhCurated: true, // zh shortlist: Moonshot's own model, the budget slot there
        input: 0.57 / M,
        output: 2.3 / M,
        cacheRead: 0.57 / M,
        cacheCreation: 0.57 / M,
        cacheCreation1h: 0.57 / M, // no caching on this endpoint; never accrues
    },
};

/** Per-second provider cost of cloud STT, by model, debited AT COST like every
 *  other leg (meter.ts Model B); only /cloud/v1/stt feeds this. Rates verified
 *  July 2026: gpt-4o-transcribe $0.006/min, gpt-transcribe $0.0045/min. */
export const STT_USD_PER_SECOND_BY_MODEL: Record<string, number> = {
    'gpt-4o-transcribe': 0.36 / 3600,
    'gpt-transcribe': 0.27 / 3600,
};

/** The server-default model (config.ts STT_DEFAULTS), used when a request names
 *  no model — and the cost fallback for env-pinned backends (Groq, custom)
 *  whose models aren't in the table. Those bill the default's rate, so keep the
 *  default at or above the cheapest entry: a Groq clip billed at gpt-transcribe
 *  still over-charges fractions of a cent, never under-bills. */
export const DEFAULT_STT_MODEL = 'gpt-transcribe';

/** Provider cost $/s for a model, falling back to the default's rate. */
export function sttUsdPerSecond(model: string): number {
    return STT_USD_PER_SECOND_BY_MODEL[model] ?? STT_USD_PER_SECOND_BY_MODEL[DEFAULT_STT_MODEL]!;
}

/** Google Cloud TTS list price per CHARACTER, by voice tier (verified June
 *  2026). Google's 1M free chars/month per tier isn't modelled, so this
 *  slightly over-states real cost: conservative, never an under-bill. */
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

/** Azure AI Speech list price per BILLED character (see providers/tts.ts
 *  azureSsmlBody: SSML markup and doubled CJK characters are the caller's
 *  problem — this is the rate applied to that count). Neural voices ~$16/1M,
 *  DragonHD ~$22/1M (azure.microsoft.com Speech pricing, region-dependent;
 *  matches scripts/audition/sources.ts). The tier is read from the ShortName:
 *  DragonHD voices carry it (en-US-Andrew_DragonHDLatestNeural). */
const AZURE_TTS_USD_PER_CHAR = { neural: 16 / M, dragonHd: 22 / M } as const;

export function azureTtsRateFor(voiceId: string | undefined): number {
    return voiceId?.includes('DragonHD') ? AZURE_TTS_USD_PER_CHAR.dragonHd : AZURE_TTS_USD_PER_CHAR.neural;
}

/** Per-character TTS cost for a resolved (provider, voiceId). OpenAI is a flat
 *  per-char rate (voice doesn't change the price); Google's and Azure's are
 *  read from the voice id's tier. The single rate authority both the meter and
 *  the picker's credits/hr estimate bill through, so a shown rate can't drift
 *  from the real charge. NOTE for Azure the "characters" this multiplies must
 *  be the BILLED count (providers/tts.azureBilledChars), not text.length. */
export function ttsRateFor(provider: TtsProvider, voiceId: string | undefined): number {
    if (provider === 'openai') return OPENAI_TTS_USD_PER_CHAR;
    if (provider === 'azure') return azureTtsRateFor(voiceId);
    return googleTtsRateFor(voiceId);
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

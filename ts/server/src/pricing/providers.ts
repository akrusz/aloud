/**
 * Underlying provider cost tables — what aloud PAYS, in USD. The retail price
 * a user sees is this times the margin multiplier (meter.ts).
 *
 * Token rates are USD per token (list price / 1e6). Input, output, and
 * cache-read are priced separately and never summed — output runs ~4-5x input
 * and a cache read ~10x cheaper than fresh input, so collapsing them would
 * misprice long facilitation sessions badly. This mirrors the split the core
 * usage tracker already carries (ts/src/llm/base.ts CompletionResult).
 *
 * These are LIST prices as of early 2026 and WILL drift — they live here, in
 * the open, precisely so a price change is a one-line diff, not a mystery.
 * The model allowlist here also gates which models a client may bill against
 * (meditation-pal-8sj: a client must not be able to invoke an arbitrary
 * expensive model on a user's credits).
 */

import type { ProviderId } from '../contract.js';

export interface TokenRates {
    /** USD per input token. */
    input: number;
    /** USD per output token. */
    output: number;
    /** USD per cached-read input token. */
    cacheRead: number;
    /** USD per cache-write (creation) input token. */
    cacheCreation: number;
}

export interface ModelPricing extends TokenRates {
    provider: ProviderId;
    model: string;
}

const M = 1_000_000;

/** Keyed by `${provider}:${model}`. */
const MODELS: Record<string, ModelPricing> = {
    'anthropic:claude-opus-4-8': {
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        input: 5 / M,
        output: 25 / M,
        cacheRead: 0.5 / M,
        cacheCreation: 6.25 / M,
    },
    'anthropic:claude-sonnet-4-6': {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        input: 3 / M,
        output: 15 / M,
        cacheRead: 0.3 / M,
        cacheCreation: 3.75 / M,
    },
    'anthropic:claude-haiku-4-5-20251001': {
        provider: 'anthropic',
        model: 'claude-haiku-4-5-20251001',
        input: 1 / M,
        output: 5 / M,
        cacheRead: 0.1 / M,
        cacheCreation: 1.25 / M,
    },
    // (Groq llama-3.3-70b was removed as a hosted option: it has NO prompt
    // caching, so on this ~98%-re-sent-history workload the whole transcript
    // bills at full input every turn — pricier than cached Haiku/Gemini despite
    // a lower sticker price. 'groq' stays a valid provider for STT/Whisper.)
    //
    // The genuine VALUE tier: cheap per-token AND cache-capable. On this
    // ~98%-re-sent-history workload, the combination crushes Haiku. Accessed
    // DIRECT via Google's OpenAI-compatible endpoint (no
    // OpenRouter middleman fee — these are Google's own list prices). Gemini
    // implicit caching is ~75% off input; the OpenAI provider parses
    // prompt_tokens_details.cached_tokens, so cache reads bill at the
    // discounted rate. (cacheCreation isn't surfaced by the OpenAI usage shape,
    // so it never accrues for this provider — left at input rate harmlessly.)
    'google:gemini-2.5-flash-lite': {
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
        input: 0.1 / M,
        output: 0.4 / M,
        cacheRead: 0.01 / M, // Google list price for cached-input read (text), ~90% off input
        cacheCreation: 0.1 / M,
    },
};

/** Per-second cost of cloud STT (Fireworks Whisper, the default backend). The
 *  free/browser engine bills zero — only the server-side engine feeds this. If
 *  you switch the STT backend via env (config.ts resolveSttConfig), revisit:
 *  Fireworks whisper-v3-turbo ≈ $0.054/hr, Groq ≈ $0.04/hr, OpenAI
 *  gpt-4o-mini-transcribe ≈ $0.18/hr. */
export const STT_USD_PER_SECOND = 0.054 / 3600; // $0.054/hr (Fireworks whisper-v3-turbo, standard serverless)

/** Google Cloud TTS list price per CHARACTER, by voice tier. The hosted TTS
 *  backend is Google (providers/tts.ts synthesizes en-US-Chirp3-HD-* voices),
 *  so THIS — not a generic "cloud"/ElevenLabs rate — is what actually bills.
 *  Verified vs cloud.google.com/text-to-speech/pricing (June 2026), per 1M
 *  chars: Standard $4 · WaveNet/Neural2/Polyglot $16 · Chirp3-HD $30 · Studio
 *  $160. (Google also gives 1M chars/month free per tier; we don't model that,
 *  so we slightly over-state real cost — conservative, never an under-bill.) */
const GOOGLE_TTS_TIER_USD_PER_CHAR = {
    standard: 4 / M,
    premium: 16 / M, // WaveNet / Neural2 / Polyglot
    chirpHd: 30 / M, // Chirp3-HD / Chirp-HD — the tier every curated voice ships on
    studio: 160 / M,
} as const;

/** Default per-char TTS rate when a voice id's tier can't be parsed: Chirp3-HD,
 *  the tier every curated voice uses (voice-catalog.ts). Also the rate the
 *  whole-session estimate assumes (meter.priceSession, which has no voice). */
export const TTS_USD_PER_CHAR = GOOGLE_TTS_TIER_USD_PER_CHAR.chirpHd; // $30/1M (Google Chirp3-HD)

/** Per-character cost for a specific Google voice, read from its id. Google
 *  voice ids encode the tier — en-US-Chirp3-HD-Leda, en-US-Neural2-C,
 *  en-US-Standard-B, en-US-Studio-O — so the tier comes straight from the name.
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

export function pricingFor(provider: ProviderId, model: string): ModelPricing | undefined {
    return MODELS[`${provider}:${model}`];
}

export function isModelAllowed(provider: ProviderId, model: string): boolean {
    return pricingFor(provider, model) !== undefined;
}

export function allowedModels(): ModelPricing[] {
    return Object.values(MODELS);
}

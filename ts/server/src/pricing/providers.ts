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
    'groq:llama-3.3-70b-versatile': {
        provider: 'groq',
        model: 'llama-3.3-70b-versatile',
        input: 0.59 / M,
        output: 0.79 / M,
        cacheRead: 0.59 / M, // Groq has NO prompt caching — re-sent history bills at full input.
        cacheCreation: 0.59 / M,
    },
    // The genuine VALUE tier: cheap per-token AND cache-capable. On this
    // ~98%-re-sent-history workload, the combination crushes both Haiku and
    // Groq. Accessed DIRECT via Google's OpenAI-compatible endpoint (no
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

/** Per-second cost of cloud STT (Fireworks Whisper, the default backend) and
 *  per-character cost of cloud TTS (ElevenLabs-class). The free/browser engines
 *  bill zero — only the server-side engines feed these. If you switch the STT
 *  backend via env (config.ts resolveSttConfig), revisit this rate:
 *  Fireworks whisper-v3-turbo ≈ $0.054/hr, Groq ≈ $0.04/hr, OpenAI
 *  gpt-4o-mini-transcribe ≈ $0.18/hr. */
export const STT_USD_PER_SECOND = 0.054 / 3600; // $0.054/hr (Fireworks whisper-v3-turbo, batch)
export const TTS_USD_PER_CHAR = 0.00003; // ~ElevenLabs flagship per-char

export function pricingFor(provider: ProviderId, model: string): ModelPricing | undefined {
    return MODELS[`${provider}:${model}`];
}

export function isModelAllowed(provider: ProviderId, model: string): boolean {
    return pricingFor(provider, model) !== undefined;
}

export function allowedModels(): ModelPricing[] {
    return Object.values(MODELS);
}

/**
 * Forward a completion to the chosen provider with aloud's server-held API key
 * injected. The ONE place meditation content transits the server, and it is
 * stateless: request in, stream out, nothing persisted (privacy invariant;
 * logger.ts, meditation-pal-dn2).
 *
 * Runtime reuse of @aloud/core: we construct the SAME provider classes the
 * client uses rather than re-implementing request building and, critically,
 * usage parsing. Token accounting is what billing rides on
 * (meditation-pal-8sj), so client and server must share one implementation.
 * (Runs via tsx, which resolves the @aloud/core path alias; see tsconfig.json.)
 */

import {
    AnthropicProvider,
    GroqProvider,
    OpenRouterProvider,
    GoogleProvider,
    OpenAIProvider,
    type CompletionResult,
    type LLMProvider,
    type Message,
    type StreamChunk,
} from '@aloud/core/llm';
import type { LlmUsage } from '@aloud/core/facilitation';
import type { ProviderId } from '../contract.js';
import type { ProviderKeys } from '../config.js';

export class ProviderNotConfiguredError extends Error {
    constructor(provider: ProviderId) {
        super(`provider not configured on this server: ${provider}`);
        this.name = 'ProviderNotConfiguredError';
    }
}

export interface ForwardOptions {
    provider: ProviderId;
    model: string;
    maxTokens?: number;
}

/**
 * Server-side OpenRouter fallback chains, sent as the request's `models` array
 * (priority order, primary first; OpenRouter caps the list at 3). OpenRouter
 * walks the array when a slug can't serve (endpoint gone, host downtime, rate
 * limit) so the turn completes instead of erroring.
 *
 * Kimi K2 0711 sits on a single Novita endpoint for a year-old checkpoint, so
 * it degrades to 0905: same K2 generation (the personality break came later,
 * with the Claude-distilled K2 Thinking/K2.5), and its hosts (Novita, Groq) are
 * both US, so the privacy story is unchanged.
 *
 * Billing during a degraded window: the meter keys on the REQUESTED model, so a
 * fallback turn debits at the primary's table rates while OpenRouter charges
 * the fallback's (0905 $0.60/$2.50 vs 0711 $0.57/$2.30, ~4% under-recovery on
 * this model only). Accepted cost of not dropping sessions; if the primary is
 * permanently gone, swap the pricing-table entry (ADDING A MODEL checklist in
 * pricing/providers.ts).
 */
export const OPENROUTER_FALLBACKS: Record<string, readonly string[]> = {
    'moonshotai/kimi-k2': ['moonshotai/kimi-k2', 'moonshotai/kimi-k2-0905'],
};

function buildProvider(keys: ProviderKeys, opts: ForwardOptions): LLMProvider {
    const common = { model: opts.model, ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}) };
    switch (opts.provider) {
        case 'anthropic':
            if (!keys.anthropic) throw new ProviderNotConfiguredError('anthropic');
            return new AnthropicProvider({ apiKey: keys.anthropic, ...common });
        case 'groq':
            if (!keys.groq) throw new ProviderNotConfiguredError('groq');
            return new GroqProvider({ apiKey: keys.groq, ...common });
        case 'openrouter': {
            if (!keys.openrouter) throw new ProviderNotConfiguredError('openrouter');
            const fallbacks = OPENROUTER_FALLBACKS[opts.model];
            return new OpenRouterProvider({
                apiKey: keys.openrouter,
                ...common,
                ...(fallbacks && { extraBody: { models: [...fallbacks] } }),
            });
        }
        case 'google':
            if (!keys.google) throw new ProviderNotConfiguredError('google');
            return new GoogleProvider({ apiKey: keys.google, ...common });
        case 'openai':
            if (!keys.openai) throw new ProviderNotConfiguredError('openai');
            return new OpenAIProvider({ apiKey: keys.openai, ...common });
    }
}

/** Pull the billing-relevant usage split out of a result/final chunk. */
export function usageOf(r: CompletionResult | StreamChunk): LlmUsage {
    return {
        tokensIn: r.inputTokens ?? null,
        tokensOut: r.outputTokens ?? null,
        cacheRead: r.cacheReadTokens ?? null,
        cacheCreation: r.cacheCreationTokens ?? null,
        cacheCreation1h: r.cacheCreation1hTokens ?? null,
    };
}

export class Forwarder {
    constructor(private readonly keys: ProviderKeys) {}

    async complete(
        messages: Message[],
        opts: ForwardOptions & { system?: string }
    ): Promise<CompletionResult> {
        const provider = buildProvider(this.keys, opts);
        return provider.complete(messages, opts.system ? { system: opts.system } : {});
    }

    /** Yields deltas; the final chunk (done: true) carries usage. Falls back to
     *  a single synthetic chunk if the provider lacks streaming. */
    async *stream(
        messages: Message[],
        opts: ForwardOptions & { system?: string }
    ): AsyncIterable<StreamChunk> {
        const provider = buildProvider(this.keys, opts);
        const options = opts.system ? { system: opts.system } : {};
        if (provider.completeStream) {
            yield* provider.completeStream(messages, options);
            return;
        }
        const result = await provider.complete(messages, options);
        yield {
            text: result.text,
            done: true,
            finishReason: result.finishReason,
            inputTokens: result.inputTokens ?? null,
            outputTokens: result.outputTokens ?? null,
            cacheReadTokens: result.cacheReadTokens ?? null,
            cacheCreationTokens: result.cacheCreationTokens ?? null,
            cacheCreation1hTokens: result.cacheCreation1hTokens ?? null,
        };
    }
}

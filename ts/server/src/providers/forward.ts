/**
 * Forward a completion to the chosen provider, with aloud's server-held API
 * key injected. This is the ONE place meditation content transits the server,
 * and it is stateless: request in, stream out, nothing persisted (the privacy
 * invariant — see logger.ts and meditation-pal-dn2).
 *
 * Runtime reuse of @aloud/core: we construct the SAME provider classes the
 * client uses (AnthropicProvider, GroqProvider, OpenRouterProvider) rather than
 * re-implementing request building and — critically — usage parsing. Token
 * accounting is what billing rides on (meditation-pal-8sj); having one
 * implementation shared between client and server is the whole reason this
 * lives in the monorepo. (Runs via tsx, which resolves the @aloud/core path
 * alias; see ts/server/tsconfig.json.)
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

function buildProvider(keys: ProviderKeys, opts: ForwardOptions): LLMProvider {
    const common = { model: opts.model, ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}) };
    switch (opts.provider) {
        case 'anthropic':
            if (!keys.anthropic) throw new ProviderNotConfiguredError('anthropic');
            return new AnthropicProvider({ apiKey: keys.anthropic, ...common });
        case 'groq':
            if (!keys.groq) throw new ProviderNotConfiguredError('groq');
            return new GroqProvider({ apiKey: keys.groq, ...common });
        case 'openrouter':
            if (!keys.openrouter) throw new ProviderNotConfiguredError('openrouter');
            return new OpenRouterProvider({ apiKey: keys.openrouter, ...common });
        case 'google':
            if (!keys.google) throw new ProviderNotConfiguredError('google');
            return new GoogleProvider({ apiKey: keys.google, ...common });
        case 'openai':
            if (!keys.openai) throw new ProviderNotConfiguredError('openai');
            // Direct to api.openai.com (OpenAIProvider's default base URL).
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

    /** Yields incremental deltas; the final chunk (done: true) carries usage.
     *  Falls back to a single synthetic stream if the provider lacks streaming. */
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

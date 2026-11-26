/**
 * Forward a completion to the chosen provider with aloud's server-held API key
 * injected. Meditation content transits here (as it does the STT, TTS and
 * judge routes), statelessly: request in, stream out, nothing persisted
 * (privacy invariant; logger.ts, meditation-pal-dn2).
 *
 * Runtime reuse of @aloud/core: we construct the SAME provider classes the
 * client uses rather than re-implementing request building and, critically,
 * usage parsing. Token accounting is what billing depends on
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
import { openRouterRouting, openRouterSlug } from '../pricing/openrouter-hosts.js';
import { THINKS_ALOUD, withholdThinking, withoutThinking } from './withheld-thinking.js';

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
        case 'openrouter': {
            if (!keys.openrouter) throw new ProviderNotConfiguredError('openrouter');
            const slug = openRouterSlug(opts.model);
            const routing = openRouterRouting(slug);
            return new OpenRouterProvider({
                apiKey: keys.openrouter,
                ...common,
                model: slug,
                ...(routing && { extraBody: routing }),
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

function thinksAloud(opts: ForwardOptions): boolean {
    return opts.provider === 'openrouter' && THINKS_ALOUD.has(openRouterSlug(opts.model));
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
        const result = await provider.complete(messages, opts.system ? { system: opts.system } : {});
        return thinksAloud(opts) ? withoutThinking(result) : result;
    }

    /** A max_tokens 0 read of the cache entry `complete`/`stream` left for the
     *  same messages and options: built by the same provider construction, so
     *  the prefix is byte-identical (the turn's maxTokens never reaches it).
     *  Throws for a provider without one. */
    async keepAlive(
        messages: Message[],
        opts: ForwardOptions & { system?: string }
    ): Promise<CompletionResult> {
        const provider = buildProvider(this.keys, opts);
        if (!provider.keepAlive) throw new Error(`no keep-alive for provider ${opts.provider}`);
        return provider.keepAlive(messages, opts.system ? { system: opts.system } : {});
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
            const stream = provider.completeStream(messages, options);
            yield* thinksAloud(opts) ? withholdThinking(stream) : stream;
            return;
        }
        const raw = await provider.complete(messages, options);
        const result = thinksAloud(opts) ? withoutThinking(raw) : raw;
        yield {
            text: result.text,
            done: true,
            finishReason: result.finishReason,
            inputTokens: result.inputTokens ?? null,
            outputTokens: result.outputTokens ?? null,
            cacheReadTokens: result.cacheReadTokens ?? null,
            cacheCreationTokens: result.cacheCreationTokens ?? null,
            cacheCreation1hTokens: result.cacheCreation1hTokens ?? null,
            ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
            ...(result.attempts ? { attempts: result.attempts } : {}),
        };
    }
}

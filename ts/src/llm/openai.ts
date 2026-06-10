/**
 * OpenAI-compatible chat completions provider.
 *
 * Direct fetch implementation (no SDK) so this runs unchanged in Node,
 * the browser, and Capacitor's WebView. One adapter covers OpenAI,
 * OpenRouter, Venice, and Groq — they all speak the same wire format,
 * they just differ in base URL and default model. The named exports
 * at the bottom of this file bake those defaults in.
 */

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
    StreamChunk,
} from './base.js';
import { iterateSseEvents } from './sse.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_MAX_TOKENS = 300;

/** OpenAI reasoning-model families (gpt-5*, o1/o3/o4-mini, …). These reject
 *  `max_tokens` (require `max_completion_tokens`) and accept
 *  `reasoning_effort`. Bare model names only — vendor-prefixed IDs like
 *  "openai/gpt-5" on OpenRouter intentionally don't match (OpenRouter has its
 *  own reasoning controls and still expects `max_tokens`). */
const REASONING_MODEL_RE = /^(gpt-5|o\d)/;

export interface OpenAIProviderOptions {
    /**
     * API key. Required for direct calls. Omit when pointing `baseUrl`
     * at a proxy that injects the key server-side.
     */
    apiKey?: string;
    model?: string;
    maxTokens?: number;
    /**
     * Base URL ending at `/v1` (no trailing slash). Defaults to
     * api.openai.com. Override for OpenRouter, Venice, Groq, or a proxy.
     */
    baseUrl?: string;
    /**
     * Extra body fields merged into the request — used by Venice for
     * `venice_parameters.include_venice_system_prompt: false`.
     */
    extraBody?: Record<string, unknown>;
    /** Override fetch for testing. */
    fetchImpl?: typeof fetch;
}

interface OpenAIUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Cached-prompt breakdown. OpenAI and OpenRouter surface this for models
     *  with implicit/automatic prompt caching (e.g. Gemini, DeepSeek). When
     *  present, `cached_tokens` is the portion of prompt_tokens served from
     *  cache — billed far cheaper, so it's split out for the cost model. */
    prompt_tokens_details?: { cached_tokens?: number };
}

interface OpenAIChatResponse {
    choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string | null;
    }>;
    usage?: OpenAIUsage;
}

export class OpenAIProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly extraBody: Record<string, unknown> | undefined;
    private readonly fetchImpl: typeof fetch;

    constructor(options: OpenAIProviderOptions = {}) {
        const baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '');
        const usingProxy = baseUrl !== OPENAI_BASE_URL;
        if (!options.apiKey && !usingProxy) {
            throw new Error(
                'OpenAI API key required when calling api.openai.com directly. ' +
                    'Pass apiKey, or set baseUrl to a proxy that injects the key server-side.'
            );
        }
        this.apiKey = options.apiKey;
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.baseUrl = baseUrl;
        this.extraBody = options.extraBody;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    private buildRequest(
        messages: Message[],
        options: CompletionOptions,
        stream: boolean
    ): RequestInit {
        const openaiMessages: Array<{ role: string; content: string }> = [];
        if (options.system) {
            openaiMessages.push({ role: 'system', content: options.system });
        }
        for (const msg of messages) {
            openaiMessages.push({ role: msg.role, content: msg.content });
        }

        // OpenAI's reasoning models (gpt-5 family, o-series) reject the
        // legacy `max_tokens` and require `max_completion_tokens`; OpenAI
        // accepts the new name for all current chat models, so use it for
        // anything that looks like one of those models OR any direct
        // api.openai.com call. Other OpenAI-compatible providers (OpenRouter,
        // Groq, Venice, Gemini-compat) still expect `max_tokens`.
        const openaiDirect = this.baseUrl === OPENAI_BASE_URL;
        const reasoningModel = REASONING_MODEL_RE.test(this.model);
        const maxTokens = options.maxTokens ?? this.maxTokens;

        const body: Record<string, unknown> = {
            model: this.model,
            messages: openaiMessages,
            ...(openaiDirect || reasoningModel
                ? { max_completion_tokens: maxTokens }
                : { max_tokens: maxTokens }),
            // Reasoning tokens add latency and cost and a spoken meditation
            // turn gains nothing from them — same intent as OpenRouter's
            // `reasoning.enabled: false` and Gemini's `reasoning_effort:
            // "none"` defaults below. OpenAI's reasoning models don't accept
            // "none", so "minimal" is the floor; non-reasoning models reject
            // the param, hence the model gate. extraBody merges after this,
            // so callers can still override.
            ...(reasoningModel && { reasoning_effort: 'minimal' }),
            ...(stream && {
                stream: true,
                // Some providers (Groq, Together) need this to send usage on
                // the final chunk; OpenAI also recognizes it. Harmless when
                // unsupported.
                stream_options: { include_usage: true },
            }),
        };
        if (this.extraBody) Object.assign(body, this.extraBody);

        const headers: Record<string, string> = {
            'content-type': 'application/json',
        };
        if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
        if (stream) headers['accept'] = 'text/event-stream';

        return {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            ...(options.signal && { signal: options.signal }),
        };
    }

    async complete(
        messages: Message[],
        options: CompletionOptions = {}
    ): Promise<CompletionResult> {
        const init = this.buildRequest(messages, options, false);
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, init);

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`OpenAI-compatible API error ${response.status}: ${detail}`);
        }

        const data = (await response.json()) as OpenAIChatResponse;
        const choice = data.choices?.[0];
        const text = choice?.message?.content ?? '';

        return {
            text,
            finishReason: choice?.finish_reason ?? null,
            ...usageToResult(data.usage),
        };
    }

    async *completeStream(
        messages: Message[],
        options: CompletionOptions = {}
    ): AsyncIterable<StreamChunk> {
        const init = this.buildRequest(messages, options, true);
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, init);

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`OpenAI-compatible API error ${response.status}: ${detail}`);
        }

        // OpenAI SSE format:
        //   data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
        //   ...
        //   data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}
        //   data: [DONE]
        let finishReason: string | null = null;
        let usage: OpenAIUsage | undefined;

        for await (const evt of iterateSseEvents(response)) {
            const raw = evt.data.trim();
            if (raw === '[DONE]') break;
            const parsed = safeJson<OpenAIStreamChunk>(raw);
            if (!parsed) continue;
            const choice = parsed.choices?.[0];
            const text = choice?.delta?.content;
            if (typeof text === 'string' && text.length > 0) {
                yield { text, done: false };
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (parsed.usage) usage = parsed.usage;
        }

        yield { text: '', done: true, finishReason, ...usageToResult(usage) };
    }
}

/**
 * Map an OpenAI-compatible usage object to the CompletionResult split.
 * `tokensUsed` keeps the provider-reported total. When the provider reports
 * cached prompt tokens (prompt_tokens_details.cached_tokens — Gemini/DeepSeek
 * via OpenRouter, OpenAI prompt caching), they're split out as cacheRead and
 * subtracted from inputTokens, so `inputTokens` is the FRESH (full-price)
 * portion. Cache reads price ~75-98% cheaper, so collapsing them would
 * mis-bill cache-friendly value models. cacheCreation isn't reported by this
 * API shape, so it's left null.
 */
function usageToResult(usage: OpenAIUsage | undefined): {
    tokensUsed: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
} {
    if (!usage) {
        return { tokensUsed: null, inputTokens: null, outputTokens: null, cacheReadTokens: null };
    }
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const prompt = usage.prompt_tokens ?? null;
    return {
        tokensUsed: usage.total_tokens ?? null,
        // Fresh (uncached) input = prompt_tokens - cached_tokens.
        inputTokens: prompt === null ? null : prompt - cached,
        outputTokens: usage.completion_tokens ?? null,
        cacheReadTokens: cached > 0 ? cached : null,
    };
}

interface OpenAIStreamChunk {
    choices?: Array<{
        delta?: { content?: string };
        finish_reason?: string | null;
    }>;
    usage?: OpenAIUsage;
}

function safeJson<T>(s: string): T | null {
    try {
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Pre-configured providers for the OpenAI-compatible services we support.
// Each one is just OpenAIProvider with a different default base URL and
// model. Callers can still override either at construction time.
// ---------------------------------------------------------------------------

/**
 * Subclass-style factory: returns a class with provider-specific defaults
 * baked in. Easier to typecheck than three separate class declarations
 * that vary only in two constants.
 */
function preconfigured(defaults: {
    baseUrl: string;
    defaultModel: string;
    extraBody?: Record<string, unknown>;
}): new (options?: OpenAIProviderOptions) => OpenAIProvider {
    return class extends OpenAIProvider {
        constructor(options: OpenAIProviderOptions = {}) {
            super({
                ...options,
                baseUrl: options.baseUrl ?? defaults.baseUrl,
                model: options.model ?? defaults.defaultModel,
                ...(defaults.extraBody && {
                    extraBody: { ...defaults.extraBody, ...(options.extraBody ?? {}) },
                }),
            });
        }
    };
}

/** OpenRouter — multi-vendor LLM proxy. */
export const OpenRouterProvider = preconfigured({
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v3.2',
    // aloud never wants chain-of-thought: a spoken meditation turn gains nothing
    // from reasoning tokens, which only add latency and cost. Several routable
    // models (deepseek-v3.2 included) reason by default; OpenRouter normalizes
    // `reasoning.enabled` across vendors and ignores it for models that can't.
    extraBody: { reasoning: { enabled: false } },
});

/** Venice — privacy-focused open-weights inference. */
export const VeniceProvider = preconfigured({
    baseUrl: 'https://api.venice.ai/api/v1',
    defaultModel: 'llama-3.3-70b',
    // Suppress Venice's stock system prompt so our facilitator prompt wins.
    extraBody: { venice_parameters: { include_venice_system_prompt: false } },
});

/** Groq — fast inference on open-weights models. */
export const GroqProvider = preconfigured({
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
});

/** Google Gemini via its OpenAI-compatible endpoint. Direct (no OpenRouter
 *  middleman fee). Gemini does implicit prompt caching and reports it as
 *  prompt_tokens_details.cached_tokens — already parsed by usageToResult. */
export const GoogleProvider = preconfigured({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash-lite',
    // Disable Gemini "thinking". 2.5 Flash reasons by default (Flash-Lite does
    // not, but be explicit so a model swap can't silently turn it on) — we want
    // fast, direct facilitation, not a thinking budget. Gemini's OpenAI-compat
    // endpoint maps reasoning_effort:"none" to thinking off.
    extraBody: { reasoning_effort: 'none' },
});

/**
 * OpenAI-compatible chat completions provider. Direct fetch, no SDK, so it runs
 * unchanged in Node, the browser, and Capacitor. One adapter covers OpenAI,
 * OpenRouter, Venice, and Groq, which share the wire format and differ only in
 * base URL and default model; the named exports at the bottom bake those in.
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

/** OpenAI reasoning-model families (gpt-5*, o1/o3/o4-mini). They reject
 *  `max_tokens` (requiring `max_completion_tokens`) and accept
 *  `reasoning_effort`. Bare names only: vendor-prefixed IDs like "openai/gpt-5"
 *  on OpenRouter must not match, since OpenRouter has its own reasoning
 *  controls and still expects `max_tokens`. */
const REASONING_MODEL_RE = /^(gpt-5|o\d)/;

/** Lowest `reasoning_effort` each OpenAI reasoning family accepts (probed July
 *  2026; each family 400s on the others' floor): gpt-5.x takes 'none' and
 *  rejects 'minimal', the bare gpt-5 family is the reverse, and o-series reject
 *  both, leaving 'low'. */
function lowestReasoningEffort(model: string): 'none' | 'minimal' | 'low' {
    if (/^o\d/.test(model)) return 'low';
    if (/^gpt-5\.\d/.test(model)) return 'none';
    return 'minimal';
}

export interface OpenAIProviderOptions {
    /**
     * Required for direct calls. Omit when `baseUrl` points at a proxy that
     * injects the key server-side.
     */
    apiKey?: string;
    model?: string;
    maxTokens?: number;
    /**
     * Base URL ending at `/v1`, no trailing slash. Default api.openai.com;
     * override for OpenRouter, Venice, Groq, or a proxy.
     */
    baseUrl?: string;
    /**
     * Extra body fields merged into the request, e.g. Venice's
     * `venice_parameters.include_venice_system_prompt: false`.
     */
    extraBody?: Record<string, unknown>;
    /**
     * Completion tokens added to max_tokens on top of the caller's content
     * budget, for models whose always-on reasoning bills against max_tokens
     * (OPENROUTER_MANDATORY_REASONING). Without headroom the thinking preamble
     * can eat the whole budget and the turn returns EMPTY with finish_reason
     * "length"; kimi-k3 spends ~100-300 reasoning tokens even at effort:'low'
     * and ignores reasoning.max_tokens caps.
     */
    reasoningHeadroom?: number;
    /** Override fetch for testing. */
    fetchImpl?: typeof fetch;
}

interface OpenAIUsage {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    /** Cached-prompt breakdown, surfaced by OpenAI and OpenRouter for models
     *  with implicit prompt caching (Gemini, DeepSeek). `cached_tokens` is the
     *  portion of prompt_tokens served from cache, billed far cheaper, so it's
     *  split out for the cost model. `cache_write_tokens` (GPT-5.6+) is the
     *  portion written TO cache at 1.25x input; absent on older models, where
     *  writes are free. */
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
}

interface OpenAIChatResponse {
    choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string | null;
    }>;
    usage?: OpenAIUsage;
    error?: OpenAIInlineError;
}

export class OpenAIProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly extraBody: Record<string, unknown> | undefined;
    private readonly reasoningHeadroom: number;
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
        this.reasoningHeadroom = options.reasoningHeadroom ?? 0;
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

        // OpenAI reasoning models reject legacy `max_tokens` and require
        // `max_completion_tokens`, which OpenAI accepts for all current chat
        // models, so use it for those models or any direct api.openai.com call.
        // Other compatible providers still expect `max_tokens`.
        const openaiDirect = this.baseUrl === OPENAI_BASE_URL;
        const reasoningModel = REASONING_MODEL_RE.test(this.model);
        const maxTokens = (options.maxTokens ?? this.maxTokens) + this.reasoningHeadroom;

        const body: Record<string, unknown> = {
            model: this.model,
            messages: openaiMessages,
            ...(openaiDirect || reasoningModel
                ? { max_completion_tokens: maxTokens }
                : { max_tokens: maxTokens }),
            // A spoken meditation turn gains nothing from reasoning tokens,
            // which only add latency and cost (as with OpenRouter's
            // `reasoning.enabled: false` and Gemini's `reasoning_effort:"none"`
            // below). Each family has its own floor (lowestReasoningEffort), and
            // non-reasoning models reject the param, hence the gate. extraBody
            // merges after, so callers can override.
            ...(reasoningModel && { reasoning_effort: lowestReasoningEffort(this.model) }),
            ...(stream && {
                stream: true,
                // Groq and Together need this to report usage on the final
                // chunk; OpenAI recognizes it, others ignore it.
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
        if (data.error) throw new Error(inlineErrorMessage(data.error, 'in body'));
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

        // SSE format: `data:` chunks carrying choices[].delta.content, the last
        // with finish_reason + usage, then `data: [DONE]`.
        let finishReason: string | null = null;
        let usage: OpenAIUsage | undefined;

        for await (const evt of iterateSseEvents(response)) {
            const raw = evt.data.trim();
            if (raw === '[DONE]') break;
            const parsed = safeJson<OpenAIStreamChunk>(raw);
            if (!parsed) continue;
            if (parsed.error) throw new Error(inlineErrorMessage(parsed.error, 'mid-stream'));
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
 * `tokensUsed` is the provider-reported total. Cached prompt tokens
 * (prompt_tokens_details.cached_tokens) are split out as cacheRead and
 * subtracted from inputTokens, leaving it the FRESH full-price portion: cache
 * reads are ~75-98% cheaper, so collapsing them would mis-bill cache-friendly
 * value models. Cache writes (cache_write_tokens, GPT-5.6+, 1.25x input) are
 * split out the same way; older models don't report it, so cacheCreation stays
 * null.
 */
function usageToResult(usage: OpenAIUsage | undefined): {
    tokensUsed: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
} {
    if (!usage) {
        return {
            tokensUsed: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
        };
    }
    const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
    const written = usage.prompt_tokens_details?.cache_write_tokens ?? 0;
    const prompt = usage.prompt_tokens ?? null;
    return {
        tokensUsed: usage.total_tokens ?? null,
        inputTokens: prompt === null ? null : prompt - cached - written,
        outputTokens: usage.completion_tokens ?? null,
        cacheReadTokens: cached > 0 ? cached : null,
        cacheCreationTokens: written > 0 ? written : null,
    };
}

interface OpenAIStreamChunk {
    choices?: Array<{
        delta?: { content?: string };
        finish_reason?: string | null;
    }>;
    usage?: OpenAIUsage;
    error?: OpenAIInlineError;
}

/**
 * An upstream failure reported INSIDE a 200 response. OpenRouter does this once
 * the stream has started (a host dropping mid-generation arrives as a chunk with
 * `error` and finish_reason "error"), and for some routing failures on the
 * non-streaming path too. Ignoring the field turns the failure into a silent
 * empty completion - "The model returned an empty response" with nothing in
 * any log (meditation-pal-yi02) - so both paths throw on it instead.
 */
interface OpenAIInlineError {
    message?: string;
    code?: number | string;
}

function inlineErrorMessage(err: OpenAIInlineError, phase: string): string {
    const detail = err.message ?? JSON.stringify(err);
    return `OpenAI-compatible API error ${phase}${err.code !== undefined ? ` (${err.code})` : ''}: ${detail}`;
}

function safeJson<T>(s: string): T | null {
    try {
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}

// Pre-configured providers: OpenAIProvider with a different default base URL
// and model. Callers can still override either at construction.

/**
 * Returns a class with provider-specific defaults baked in. Easier to typecheck
 * than several class declarations varying only in two constants.
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

/** OpenRouter models with always-on reasoning: `reasoning: {enabled: false}`
 *  400s ("Reasoning is mandatory for this endpoint and cannot be disabled",
 *  kimi-k3). Pin the lowest effort instead (both list `reasoning`/
 *  `reasoning_effort` in supported_parameters), as anthropic.ts does with
 *  thinkingPolicy 'always-on': shortest think-before-speak, fewest billed tokens. */
const OPENROUTER_MANDATORY_REASONING = new Set(['moonshotai/kimi-k3']);

/** OpenRouter models whose only endpoints don't support the `reasoning`
 *  parameter at all: send nothing, not `{enabled: false}`. Kimi K2 0711
 *  (Novita, fp8) has no reasoning, but sending the param intermittently flipped
 *  the endpoint into a thinking-style template (~10% of measured openers): the
 *  model narrates its planning, which either blanks the turn (all tokens billed
 *  as reasoning_tokens, finish "length") or gets SPOKEN when a "[WAIT:Nm]"
 *  prefix lands before the think block. 0/40 anomalies omitted vs 4/42 with. */
const OPENROUTER_REASONING_UNSUPPORTED = new Set(['moonshotai/kimi-k2']);

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v3.2';

/** Completion-token headroom for mandatory-reasoning models. Observed kimi-k3
 *  preambles run 100-300 tokens at effort:'low', so 1024 leaves >3x margin
 *  against a blanked turn while bounding worst-case output spend. The headroom
 *  raises the ceiling only, not typical usage. */
const MANDATORY_REASONING_HEADROOM = 1024;

/** OpenRouter: multi-vendor LLM proxy. */
export class OpenRouterProvider extends OpenAIProvider {
    constructor(options: OpenAIProviderOptions = {}) {
        const model = options.model ?? OPENROUTER_DEFAULT_MODEL;
        const mandatoryReasoning = OPENROUTER_MANDATORY_REASONING.has(model);
        super({
            ...options,
            baseUrl: options.baseUrl ?? OPENROUTER_BASE_URL,
            model,
            ...(mandatoryReasoning && {
                reasoningHeadroom: options.reasoningHeadroom ?? MANDATORY_REASONING_HEADROOM,
            }),
            // aloud never wants chain-of-thought: it only adds latency and cost.
            // Several routable models (deepseek-v3.2) reason by default, and
            // OpenRouter normalizes `reasoning.enabled` across vendors. Models
            // that refuse to disable get effort:'low'
            // (OPENROUTER_MANDATORY_REASONING); models whose endpoints don't
            // take the param get nothing (OPENROUTER_REASONING_UNSUPPORTED).
            extraBody: {
                ...(OPENROUTER_REASONING_UNSUPPORTED.has(model)
                    ? {}
                    : { reasoning: mandatoryReasoning ? { effort: 'low' } : { enabled: false } }),
                ...(options.extraBody ?? {}),
            },
        });
    }
}

/** Venice: privacy-focused open-weights inference. */
export const VeniceProvider = preconfigured({
    baseUrl: 'https://api.venice.ai/api/v1',
    defaultModel: 'llama-3.3-70b',
    // Suppress Venice's stock system prompt so our facilitator prompt wins.
    extraBody: { venice_parameters: { include_venice_system_prompt: false } },
});

/** Groq: fast inference on open-weights models. */
export const GroqProvider = preconfigured({
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
});

/** Google Gemini via its OpenAI-compatible endpoint, direct (no OpenRouter
 *  fee). Gemini caches prompts implicitly and reports it as
 *  prompt_tokens_details.cached_tokens, parsed by usageToResult. */
export const GoogleProvider = preconfigured({
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash-lite',
    // Disable Gemini "thinking": 2.5 Flash reasons by default, and being
    // explicit stops a model swap silently turning it on for Flash-Lite too.
    // The OpenAI-compat endpoint maps reasoning_effort:"none" to thinking off.
    extraBody: { reasoning_effort: 'none' },
});

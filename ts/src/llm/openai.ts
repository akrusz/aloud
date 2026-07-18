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

/** Lowest `reasoning_effort` each OpenAI reasoning family accepts (probed
 *  July 2026, each family 400s on the others' floor): versioned gpt-5.x
 *  models take 'none' and reject 'minimal'; the original bare gpt-5 family
 *  (gpt-5, gpt-5-mini, …) is the reverse; o-series reject both, so 'low' is
 *  the floor there. */
function lowestReasoningEffort(model: string): 'none' | 'minimal' | 'low' {
    if (/^o\d/.test(model)) return 'low';
    if (/^gpt-5\.\d/.test(model)) return 'none';
    return 'minimal';
}

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
    /**
     * Extra completion tokens added to every request's max_tokens, on top of
     * the caller's content budget. For models whose always-on reasoning bills
     * against max_tokens (OPENROUTER_MANDATORY_REASONING): without headroom
     * the thinking preamble can consume the whole budget and the turn comes
     * back EMPTY with finish_reason "length" (kimi-k3 spends ~100-300
     * reasoning tokens even at effort:'low', and ignores reasoning.max_tokens
     * caps).
     */
    reasoningHeadroom?: number;
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
     *  cache — billed far cheaper, so it's split out for the cost model.
     *  `cache_write_tokens` (GPT-5.6+ family) is the portion written TO cache,
     *  billed at 1.25x the input rate; absent on older models, where writes
     *  carry no fee. */
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
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

        // OpenAI's reasoning models (gpt-5 family, o-series) reject the
        // legacy `max_tokens` and require `max_completion_tokens`; OpenAI
        // accepts the new name for all current chat models, so use it for
        // anything that looks like one of those models OR any direct
        // api.openai.com call. Other OpenAI-compatible providers (OpenRouter,
        // Groq, Venice, Gemini-compat) still expect `max_tokens`.
        const openaiDirect = this.baseUrl === OPENAI_BASE_URL;
        const reasoningModel = REASONING_MODEL_RE.test(this.model);
        const maxTokens = (options.maxTokens ?? this.maxTokens) + this.reasoningHeadroom;

        const body: Record<string, unknown> = {
            model: this.model,
            messages: openaiMessages,
            ...(openaiDirect || reasoningModel
                ? { max_completion_tokens: maxTokens }
                : { max_tokens: maxTokens }),
            // Reasoning tokens add latency and cost and a spoken meditation
            // turn gains nothing from them — same intent as OpenRouter's
            // `reasoning.enabled: false` and Gemini's `reasoning_effort:
            // "none"` defaults below. Each OpenAI reasoning family has a
            // different lowest accepted value (lowestReasoningEffort);
            // non-reasoning models reject the param entirely, hence the model
            // gate. extraBody merges after this, so callers can still
            // override.
            ...(reasoningModel && { reasoning_effort: lowestReasoningEffort(this.model) }),
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
 * mis-bill cache-friendly value models. Cache WRITES (cache_write_tokens,
 * GPT-5.6+ — billed at 1.25x input) are likewise split out as cacheCreation
 * and subtracted from the fresh portion; older models never report the field
 * and keep cacheCreation null.
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
        // Fresh (full-price) input = prompt_tokens - cached - written.
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

/** OpenRouter models whose endpoints run reasoning always-on: sending
 *  `reasoning: {enabled: false}` 400s ("Reasoning is mandatory for this
 *  endpoint and cannot be disabled" — kimi-k3). For these, pin the lowest
 *  effort instead (both list `reasoning`/`reasoning_effort` in the model's
 *  supported_parameters) — same intent as anthropic.ts EFFORT_LOW_MODELS:
 *  the shortest think-before-speak and the fewest billed reasoning tokens. */
const OPENROUTER_MANDATORY_REASONING = new Set(['moonshotai/kimi-k3']);

/** OpenRouter models whose (only) endpoints do NOT support the `reasoning`
 *  parameter at all — send nothing rather than `{enabled: false}`. Kimi K2
 *  0711 (Novita, fp8) has no reasoning, but sending the param anyway flipped
 *  the endpoint into a thinking-style template intermittently (~10% of
 *  measured openers): the model narrates its planning, which either blanks
 *  the turn (all tokens billed as reasoning_tokens, finish "length") or gets
 *  SPOKEN as content when a "[WAIT:Nm]" prefix lands before the think block.
 *  0/40 anomalies with the param omitted vs 4/42 with it. */
const OPENROUTER_REASONING_UNSUPPORTED = new Set(['moonshotai/kimi-k2']);

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const OPENROUTER_DEFAULT_MODEL = 'deepseek/deepseek-v3.2';

/** Completion-token headroom for mandatory-reasoning models. Observed kimi-k3
 *  preambles run 100-300 tokens at effort:'low'; 1024 leaves >3x margin so a
 *  long think can't blank a turn, while still bounding worst-case output
 *  spend. (Reasoning tokens bill as output either way — the headroom only
 *  raises the ceiling, not typical usage.) */
const MANDATORY_REASONING_HEADROOM = 1024;

/** OpenRouter — multi-vendor LLM proxy. */
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
            // aloud never wants chain-of-thought: a spoken meditation turn
            // gains nothing from reasoning tokens, which only add latency and
            // cost. Several routable models (deepseek-v3.2 included) reason by
            // default; OpenRouter normalizes `reasoning.enabled` across
            // vendors. Models that refuse to disable it get effort:'low'
            // instead (OPENROUTER_MANDATORY_REASONING); models whose endpoints
            // don't take the param at all get nothing (OPENROUTER_REASONING_
            // UNSUPPORTED — sending it anyway destabilized kimi-k2).
            extraBody: {
                ...(OPENROUTER_REASONING_UNSUPPORTED.has(model)
                    ? {}
                    : { reasoning: mandatoryReasoning ? { effort: 'low' } : { enabled: false } }),
                ...(options.extraBody ?? {}),
            },
        });
    }
}

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

/**
 * Anthropic API provider: direct fetch, no SDK.
 *
 * Prompt caching: the breakpoint on the LAST message caches the whole
 * system+conversation prefix, so each later turn reads the transcript at ~0.1x
 * instead of re-billing it as fresh input - the dominant cost on this
 * input-heavy (~45:1) workload. Long sessions add a second, 1h-TTL "anchor"
 * breakpoint (ANCHOR_STEP) so a >5min [HOLD] silence doesn't drop the prefix.
 *
 * The system prompt gets NO breakpoint of its own: it already rides the
 * message-prefix caches, and a 5m system block is processed before the messages
 * (order: tools, system, messages), so it would precede the 1h anchor, which
 * Anthropic 400s ("a 1h cache_control block must not come after a 5m block").
 * That error appeared once sessions grew long enough for the anchor (~msg 16).
 */

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
    StreamChunk,
} from './base.js';
import { iterateSseEvents } from './sse.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_TOKENS = 300;

/**
 * Models with always-on thinking (`thinking: {type:"disabled"}` 400s). Pinned to
 * lowest effort for the shortest think-before-speak, capping both the preamble
 * latency and thinking tokens (billed as output). Gated to this exact set:
 * `output_config`/`effort` 400s on older models (claude-3-opus-20240229), and
 * the opt-in thinking models (opus-4-8, sonnet-4-6) already run without thinking
 * when no `thinking` param is sent.
 */
const EFFORT_LOW_MODELS = new Set(['claude-fable-5', 'claude-fable-5-1']);

/**
 * Models where thinking is opt-OUT: omitting `thinking` runs adaptive thinking
 * (Sonnet 5, Opus 5), costing a silent delay plus output-billed thinking tokens
 * every turn, so send an explicit disable. Gated to this exact set: the disable
 * 400s on always-on models (Fable), and opt-in models are already off.
 *
 * Opus 5 accepts the disable only at effort `high` or lower, so keep it OUT of
 * EFFORT_LOW_MODELS: sending no `output_config` leaves it at the `high` default,
 * while `xhigh`/`max` alongside a disable is a 400.
 */
const THINKING_OFF_MODELS = new Set(['claude-sonnet-5', 'claude-opus-5']);

/** Retryable upstream statuses: 429, and the transient 5xx family including
 *  Anthropic's 529 "overloaded". A non-429 4xx is the caller's fault (bad
 *  request, auth) and never retried. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 529]);

/** Capped exponential backoff (ms) with jitter, honoring a numeric Retry-After.
 *  The cap keeps a long rate-limit window from hanging a turn for more than a
 *  few seconds before the error surfaces. */
function backoffMs(attempt: number, retryAfter: string | null): number {
    const ra = retryAfter ? Number(retryAfter) : NaN;
    const base = Number.isFinite(ra) ? ra * 1000 : 400 * 2 ** attempt + Math.random() * 200;
    return Math.min(base, 8000);
}

/**
 * Two ephemeral cache TTLs, both used: 5m (write 1.25x input) on the rolling
 * tail, refreshed by each turn's read so the prefix stays warm cheaply; 1h
 * (write 2x) on a slowly-advancing anchor (ANCHOR_STEP), which survives a >5min
 * [HOLD] silence so the resume still reads the transcript at ~0.1x.
 *
 * The 1h write is priced at 2x in the server table (providers.ts
 * cacheCreation1h) off Anthropic's ephemeral_1h_input_tokens; keep them in
 * lockstep.
 */
const CACHE_5M = { type: 'ephemeral' } as const;
const CACHE_1H = { type: 'ephemeral', ttl: '1h' } as const;

/**
 * The 1h anchor advances every ANCHOR_STEP messages, holding a fixed re-readable
 * position in between. Bounded by Anthropic's 20-content-block cache-lookback
 * window: one block per message, so the anchor-to-tail gap (= ANCHOR_STEP) must
 * be < 20 to stay reachable and survive a hold. 16 (8 exchanges) leaves margin;
 * beyond ~10 exchanges the anchor falls out of the window and a mid-stretch hold
 * loses the prefix anyway.
 */
const ANCHOR_STEP = 16;

export interface AnthropicProviderOptions {
    /**
     * Required for direct calls to api.anthropic.com. Omit when `baseUrl` points
     * at a proxy that supplies the key server-side; sending no `x-api-key` is
     * cleaner than a fake one the proxy would reject anyway.
     */
    apiKey?: string;
    model?: string;
    maxTokens?: number;
    /** Endpoint URL, default Anthropic's hosted API. */
    baseUrl?: string;
    /**
     * Send `anthropic-dangerous-direct-browser-access`, which opts a
     * browser-origin request into Anthropic's CORS allowance. Required to call
     * api.anthropic.com from a webview (hosted web, Tauri, Capacitor); without
     * it the preflight fails and every turn dies on a network error.
     *
     * "Dangerous" is Anthropic's name for the general case - a key shipped to
     * untrusted browsers. Here the key is the user's own BYOK key, typed into
     * their own browser and never leaving it, which is the case the flag exists
     * for. Harmless from Node, but off by default so it's an explicit choice.
     */
    directBrowserAccess?: boolean;
    /** Override fetch for testing. */
    fetchImpl?: typeof fetch;
    /**
     * Retries on transient upstream failures (429 / 5xx / network), default 3.
     * Anthropic, Haiku especially, returns 429 and 529 under load; without retry
     * a single hiccup killed the turn, which made mid-session turns fail ~5/6 of
     * the time. A non-429 4xx won't get better and is never retried.
     */
    maxRetries?: number;
    /** Override the inter-retry sleep (tests inject a no-op to stay fast). */
    sleepImpl?: (ms: number) => Promise<void>;
}

interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    /** Per-TTL breakdown, present when a 1h breakpoint is used. The flat field
     *  above stays the total (5m + 1h). */
    cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
    };
}

interface AnthropicMessagesResponse {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string | null;
    usage?: AnthropicUsage;
}

export class AnthropicProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly directBrowserAccess: boolean;
    private readonly fetchImpl: typeof fetch;
    private readonly maxRetries: number;
    private readonly sleep: (ms: number) => Promise<void>;

    constructor(options: AnthropicProviderOptions = {}) {
        const usingProxy = options.baseUrl !== undefined && options.baseUrl !== ANTHROPIC_API_URL;
        if (!options.apiKey && !usingProxy) {
            throw new Error(
                'Anthropic API key required when calling api.anthropic.com directly. ' +
                    'Pass apiKey, or set baseUrl to a proxy that injects the key server-side.'
            );
        }
        this.apiKey = options.apiKey;
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.baseUrl = options.baseUrl ?? ANTHROPIC_API_URL;
        this.directBrowserAccess = options.directBrowserAccess ?? false;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.maxRetries = options.maxRetries ?? 3;
        this.sleep = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    /**
     * fetch with bounded retry on RETRYABLE_STATUS and network throws, using
     * capped backoff with jitter. Never retries a caller-aborted request or a
     * non-429 4xx. The returned Response may still be an error (retries
     * exhausted); the caller does the ok-check, preserving its error message.
     */
    private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
        for (let attempt = 0; ; attempt++) {
            try {
                const response = await this.fetchImpl(url, init);
                if (
                    response.ok ||
                    !RETRYABLE_STATUS.has(response.status) ||
                    attempt >= this.maxRetries
                ) {
                    return response;
                }
                const retryAfter = response.headers.get('retry-after');
                // Drain the errored body so the socket can be reused.
                await response.text().catch(() => {});
                await this.sleep(backoffMs(attempt, retryAfter));
            } catch (err) {
                const aborted = (init.signal as AbortSignal | undefined)?.aborted;
                if (aborted || attempt >= this.maxRetries) throw err;
                await this.sleep(backoffMs(attempt, null));
            }
        }
    }

    private buildRequest(
        messages: Message[],
        options: CompletionOptions,
        stream: boolean
    ): { url: string; init: RequestInit } {
        const convo = normalizeConversation(messages);
        const lastIndex = convo.length - 1;
        // The 1h anchor: largest ANCHOR_STEP boundary strictly behind the tail.
        // Stable for a stretch of ANCHOR_STEP messages (re-read each turn,
        // refreshing its TTL), then jumps forward, so a long session pays one
        // cheap 1h write per stretch and never leaves the 20-block lookback
        // window. -1 skips it until the convo needs hold-protection and clears
        // the cacheable minimum.
        const anchorBoundary = Math.floor((lastIndex - 1) / ANCHOR_STEP) * ANCHOR_STEP;
        const anchorIndex = anchorBoundary >= ANCHOR_STEP ? anchorBoundary : -1;

        // Tail → 5m rolling breakpoint, anchor → 1h, rest plain. The tail writes
        // a cache entry for the full system+conversation prefix so the NEXT turn
        // reads it at ~0.1x instead of re-billing the transcript.
        const anthropicMessages = convo.map((m, i) => {
            const ttl = i === lastIndex ? CACHE_5M : i === anchorIndex ? CACHE_1H : null;
            return ttl
                ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: ttl }] }
                : { role: m.role, content: m.content };
        });

        // No cache_control here on purpose (see the file header): the system is
        // cached via the message-prefix breakpoints, and a 5m block here would
        // precede the 1h anchor and 400.
        const systemParam = options.system
            ? [{ type: 'text', text: options.system }]
            : undefined;

        const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: options.maxTokens ?? this.maxTokens,
            messages: anthropicMessages,
            ...(stream && { stream: true }),
        };
        if (systemParam) body['system'] = systemParam;
        // Minimal reasoning preamble, so the facilitator speaks sooner.
        if (EFFORT_LOW_MODELS.has(this.model)) body['output_config'] = { effort: 'low' };
        // Turn off default adaptive thinking, so the facilitator speaks sooner.
        if (THINKING_OFF_MODELS.has(this.model)) body['thinking'] = { type: 'disabled' };

        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_API_VERSION,
        };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        if (this.directBrowserAccess) headers['anthropic-dangerous-direct-browser-access'] = 'true';
        if (stream) headers['accept'] = 'text/event-stream';

        return {
            url: this.baseUrl,
            init: {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                ...(options.signal && { signal: options.signal }),
            },
        };
    }

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const { url, init } = this.buildRequest(messages, options, false);
        const response = await this.fetchWithRetry(url, init);

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Anthropic API error ${response.status}: ${detail}`);
        }

        const data = (await response.json()) as AnthropicMessagesResponse;
        // Take the TEXT blocks, not content[0]: an always-thinking model (Fable
        // 5) leads with a `thinking` block, so content[0].text is undefined and
        // the response would be dropped. Joining survives any block ordering.
        const text = (data.content ?? [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text ?? '')
            .join('');

        return {
            text,
            finishReason: data.stop_reason ?? null,
            ...usageToResult(data.usage),
        };
    }

    async *completeStream(
        messages: Message[],
        options: CompletionOptions = {}
    ): AsyncIterable<StreamChunk> {
        const { url, init } = this.buildRequest(messages, options, true);
        const response = await this.fetchWithRetry(url, init);

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Anthropic API error ${response.status}: ${detail}`);
        }

        // Events of interest: content_block_delta (text deltas), message_delta
        // (final stop_reason + usage), message_stop (terminator).
        let stopReason: string | null = null;
        let usage: AnthropicUsage | undefined;

        for await (const evt of iterateSseEvents(response)) {
            if (evt.event === 'content_block_delta') {
                const parsed = safeJson<{ delta?: { type?: string; text?: string } }>(evt.data);
                const delta = parsed?.delta;
                if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                    yield { text: delta.text, done: false };
                }
            } else if (evt.event === 'message_start') {
                // Input + cache tokens arrive here, output tokens in
                // message_delta, so merge both.
                const parsed = safeJson<{ message?: { usage?: AnthropicUsage } }>(evt.data);
                if (parsed?.message?.usage) usage = { ...usage, ...parsed.message.usage };
            } else if (evt.event === 'message_delta') {
                const parsed = safeJson<{
                    delta?: { stop_reason?: string | null };
                    usage?: AnthropicUsage;
                }>(evt.data);
                if (parsed?.delta?.stop_reason !== undefined) {
                    stopReason = parsed.delta.stop_reason;
                }
                if (parsed?.usage) usage = { ...usage, ...parsed.usage };
            } else if (evt.event === 'message_stop') {
                break;
            }
        }

        yield { text: '', done: true, finishReason: stopReason, ...usageToResult(usage) };
    }
}

/**
 * Reshape a conversation for the Messages API: strip system messages (the
 * system prompt travels in the `system` param), merge consecutive same-role
 * messages (Anthropic requires strict alternation), and prepend a user stub
 * when the conversation opens with an assistant message, as the summary-based
 * resume flow does. Doing it here keeps every caller safe.
 */
function normalizeConversation(messages: Message[]): Message[] {
    const out: Message[] = [];
    for (const m of messages) {
        if (m.role === 'system') continue;
        const prev = out[out.length - 1];
        if (prev && prev.role === m.role) {
            out[out.length - 1] = { role: prev.role, content: `${prev.content}\n\n${m.content}` };
        } else {
            out.push({ role: m.role, content: m.content });
        }
    }
    if (out[0]?.role === 'assistant') {
        out.unshift({ role: 'user', content: '[Resuming a previous session.]' });
    }
    return out;
}

/**
 * Map Anthropic's usage object to the CompletionResult split fields. Cache
 * fields appear only when prompt caching is active. `tokensUsed` is the
 * input+output sum for back-compat, excluding cache reads/creation.
 */
function usageToResult(usage: AnthropicUsage | undefined): {
    tokensUsed: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    cacheCreation1hTokens: number | null;
} {
    if (!usage) {
        return {
            tokensUsed: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
            cacheCreation1hTokens: null,
        };
    }
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    return {
        tokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? null,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
        cacheCreation1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? null,
    };
}

function safeJson<T>(s: string): T | null {
    try {
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}

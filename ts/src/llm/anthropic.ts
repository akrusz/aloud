/**
 * Anthropic API provider — direct fetch, no SDK.
 *
 * Prompt caching: the breakpoint on the LAST message caches the whole
 * system+conversation prefix, so each subsequent turn reads the entire
 * transcript at ~0.1x instead of re-billing it as fresh input every turn — the
 * dominant cost on this input-heavy (~45:1) workload. A long session adds a
 * second, 1h-TTL "anchor" breakpoint (see ANCHOR_STEP) so a >5min [HOLD] silence
 * doesn't drop the prefix.
 *
 * The system prompt gets NO breakpoint of its own. It already rides the
 * message-prefix caches above, so a separate block is redundant — and a 5m
 * system block is processed *before* the messages (order: tools, system,
 * messages), so it would sit before the 1h anchor, which Anthropic rejects with
 * a 400 ("a 1h cache_control block must not come after a 5m block"). That error
 * surfaced once a session grew long enough for the anchor to appear (~msg 16).
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
 * Models whose reasoning can't be turned off (thinking is always-on; a
 * `thinking: {type:"disabled"}` request 400s). For real-time voice facilitation
 * we want the SHORTEST possible think-before-speak, so we pin these to the
 * lowest effort — it caps the thinking preamble (latency) and the thinking
 * tokens (billed as output). Gated to this exact set because `output_config` /
 * `effort` 400s on models that predate it (e.g. claude-3-opus-20240229), and
 * the current opt-in thinking models (opus-4-8, sonnet-4-6) run WITHOUT thinking
 * when we send no `thinking` param, so they neither need nor want it.
 */
const EFFORT_LOW_MODELS = new Set(['claude-fable-5']);

/**
 * Models where thinking is opt-OUT: omitting the `thinking` param runs adaptive
 * thinking by default (Sonnet 5 is the first). For real-time voice that means a
 * silent think-before-speak delay plus thinking tokens billed as output on
 * every turn, so we send an explicit disable. Gated to this exact set: the
 * disable is a 400 on always-on models (Fable), and the opt-in models above
 * are already off without it.
 */
const THINKING_OFF_MODELS = new Set(['claude-sonnet-5']);

/** Upstream statuses worth retrying: rate-limit (429), and the transient 5xx
 *  family including Anthropic's 529 "overloaded". A non-429 4xx is the caller's
 *  fault (bad request / auth) and never retried. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 529]);

/** Capped exponential backoff (ms) with jitter, honoring a numeric Retry-After
 *  header when Anthropic sends one; capped so a long rate-limit window can't
 *  hang a turn for more than a few seconds before it surfaces an error. */
function backoffMs(attempt: number, retryAfter: string | null): number {
    const ra = retryAfter ? Number(retryAfter) : NaN;
    const base = Number.isFinite(ra) ? ra * 1000 : 400 * 2 ** attempt + Math.random() * 200;
    return Math.min(base, 8000);
}

/**
 * Ephemeral cache breakpoints come in two TTLs: 5m (default; write costs 1.25x
 * input) and 1h (write costs 2x). We use BOTH:
 *   - 5m on the rolling tail (last message): refreshed by each active turn's
 *     read, so the prefix stays warm cheaply during normal facilitation.
 *   - 1h on a slowly-advancing "anchor" (see ANCHOR_STEP): survives a long
 *     [HOLD] silence (>5min) so a resume reads the bulk of the transcript at
 *     ~0.1x instead of re-billing the whole thing as fresh input.
 *
 * The 1h write is priced at 2x in the server table (providers.ts cacheCreation1h)
 * and billed from Anthropic's reported ephemeral_1h_input_tokens — keep the two
 * in lockstep.
 */
const CACHE_5M = { type: 'ephemeral' } as const;
const CACHE_1H = { type: 'ephemeral', ttl: '1h' } as const;

/**
 * The 1h anchor advances every ANCHOR_STEP messages and sits at a fixed,
 * re-readable position in between. It's bounded by Anthropic's 20-content-block
 * cache-lookback window: the anchor must stay within 20 blocks of the tail to
 * remain reachable (and survive a hold), and each message is one block — so the
 * max anchor-to-tail gap (= ANCHOR_STEP) must be < 20. 16 (= 8 facilitator
 * exchanges) leaves margin. Beyond ~10 exchanges the anchor would fall out of
 * the window and a mid-stretch hold would lose the whole prefix anyway.
 */
const ANCHOR_STEP = 16;

export interface AnthropicProviderOptions {
    /**
     * Anthropic API key. Required for direct calls to api.anthropic.com.
     * Omit when pointing `baseUrl` at a proxy that supplies the key
     * server-side — the proxy will reject browser requests carrying a
     * fake key anyway, so it's cleaner to send no `x-api-key` header.
     */
    apiKey?: string;
    model?: string;
    maxTokens?: number;
    /**
     * Endpoint URL. Defaults to Anthropic's hosted API. Override with a
     * proxy URL (e.g. "/api/llm/anthropic/messages") when running in
     * the browser, since Anthropic blocks browser-origin CORS.
     */
    baseUrl?: string;
    /** Override fetch for testing. */
    fetchImpl?: typeof fetch;
    /**
     * Retries on transient upstream failures (HTTP 429 / 5xx / network error)
     * before giving up. Default 3. Anthropic — Haiku especially — returns 429
     * (rate-limited) and 529 (overloaded) under load; without retry a single
     * hiccup kills the whole turn, which is what made mid-session turns fail
     * ~5/6 of the time. A 4xx other than 429 (bad request, auth) is never
     * retried — it won't get better.
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
    /** Per-TTL breakdown of cache_creation_input_tokens, present when a 1h
     *  breakpoint is used. The flat field above stays the total (5m + 1h). */
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
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.maxRetries = options.maxRetries ?? 3;
        this.sleep = options.sleepImpl ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    /**
     * fetch with bounded retry on transient upstream failures. Retries 429 and
     * 5xx (incl. 529 overloaded) and network throws, with capped exponential
     * backoff + jitter (honoring a numeric Retry-After). Never retries a
     * caller-aborted request or a non-429 4xx — those won't improve. The
     * returned Response may still be an error (retries exhausted); the caller
     * does the final ok-check so the existing error message is preserved.
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
        // The 1h anchor: the largest ANCHOR_STEP boundary strictly behind the
        // tail. It's stable for a stretch of ANCHOR_STEP messages (re-read every
        // turn, refreshing its 1h TTL), then jumps forward — so a long session
        // accrues one cheap 1h write per stretch while never dropping out of the
        // 20-block lookback window. -1 (skip) until the convo is long enough to
        // need hold-protection and to clear the cacheable minimum.
        const anchorBoundary = Math.floor((lastIndex - 1) / ANCHOR_STEP) * ANCHOR_STEP;
        const anchorIndex = anchorBoundary >= ANCHOR_STEP ? anchorBoundary : -1;

        // Tail (last message) → 5m rolling breakpoint; anchor → 1h; rest plain.
        // The tail writes a cache entry for the full system+conversation prefix
        // so the NEXT turn reads it at ~0.1x instead of re-billing the transcript.
        const anthropicMessages = convo.map((m, i) => {
            const ttl = i === lastIndex ? CACHE_5M : i === anchorIndex ? CACHE_1H : null;
            return ttl
                ? { role: m.role, content: [{ type: 'text', text: m.content, cache_control: ttl }] }
                : { role: m.role, content: m.content };
        });

        // No cache_control here on purpose — see the file header. The system is
        // cached via the message-prefix breakpoints; a 5m block here would
        // precede the 1h anchor and trigger a 400.
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
        // Always-on-thinking models: keep the reasoning preamble minimal so the
        // facilitator speaks with the least delay (see EFFORT_LOW_MODELS).
        if (EFFORT_LOW_MODELS.has(this.model)) body['output_config'] = { effort: 'low' };
        // Opt-out-thinking models: disable the default adaptive thinking so the
        // facilitator speaks immediately (see THINKING_OFF_MODELS).
        if (THINKING_OFF_MODELS.has(this.model)) body['thinking'] = { type: 'disabled' };

        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_API_VERSION,
        };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
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
        // Take the TEXT block(s), not content[0]: an always-thinking model
        // (Fable 5) leads with a `thinking` block, so content[0].text is
        // undefined and grabbing it would drop the whole response. Joining all
        // text blocks is robust to any block ordering/count.
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

        // Anthropic SSE events of interest:
        //   content_block_delta — { delta: { type: 'text_delta', text } }
        //   message_delta       — final stop_reason + usage
        //   message_stop        — terminator (no payload we need)
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
                // Initial usage (input + cache tokens) arrives here; output
                // tokens are finalized in message_delta. Merge both.
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
 * Normalize a conversation into a shape the Messages API accepts: system
 * messages stripped (the system prompt travels in the `system` param),
 * consecutive same-role messages merged (Anthropic requires strict
 * user/assistant alternation), and a minimal user stub prepended when the
 * conversation would otherwise open with an assistant message (the
 * summary-based resume flow leads with an assistant recap). Normalizing
 * here keeps every caller safe without each one re-implementing the rules.
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
 * fields are only present when prompt caching is active. `tokensUsed` keeps
 * the input+output sum for back-compat (cache reads/creation excluded).
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

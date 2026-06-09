/**
 * Anthropic API provider — direct fetch, no SDK.
 *
 * Prompt caching: we set TWO ephemeral breakpoints — one on the system prompt
 * and one on the LAST message. The system breakpoint alone is nearly useless
 * here: the assembled facilitation system prompt is ~1.1-2k tokens, below the
 * per-model minimum cacheable prefix (2048 on Sonnet 4.6, 4096 on Opus), so a
 * system-only breakpoint usually writes nothing. The breakpoint on the last
 * message caches the whole system+conversation prefix, so each subsequent turn
 * reads the entire transcript at ~0.1x instead of re-billing it as fresh input
 * every turn — the dominant cost on this input-heavy (~45:1) workload.
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
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 300;

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
    }

    private buildRequest(
        messages: Message[],
        options: CompletionOptions,
        stream: boolean
    ): { url: string; init: RequestInit } {
        const convo = messages.filter((m) => m.role !== 'system');
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

        const systemParam = options.system
            ? [
                  {
                      type: 'text',
                      text: options.system,
                      cache_control: CACHE_5M,
                  },
              ]
            : undefined;

        const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: options.maxTokens ?? this.maxTokens,
            messages: anthropicMessages,
            ...(stream && { stream: true }),
        };
        if (systemParam) body['system'] = systemParam;

        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_API_VERSION,
        };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        if (stream) headers['accept'] = 'text/event-stream';

        return {
            url: this.baseUrl,
            init: { method: 'POST', headers, body: JSON.stringify(body) },
        };
    }

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const { url, init } = this.buildRequest(messages, options, false);
        const response = await this.fetchImpl(url, init);

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Anthropic API error ${response.status}: ${detail}`);
        }

        const data = (await response.json()) as AnthropicMessagesResponse;
        const text = data.content?.[0]?.text ?? '';

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
        const response = await this.fetchImpl(url, init);

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
 * Map Anthropic's usage object to the CompletionResult split fields. Cache
 * fields are only present when prompt caching is active. `tokensUsed` keeps
 * the input+output sum for back-compat (cache reads/creation excluded, to
 * match how the Python provider sums input+output).
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

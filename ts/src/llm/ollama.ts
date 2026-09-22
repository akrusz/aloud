/** Ollama provider: local inference via the Ollama HTTP API, direct fetch. */

import {
    withSystemMessage,
    type CompletionOptions,
    type CompletionResult,
    type LLMProvider,
    type Message,
    type StreamChunk,
} from './base.js';
import { fetchWithRetry, retryOptions, type RetryOptions, type SleepFn } from './retry.js';
import { iterateNdjson } from './sse.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen3.5:4b';
const DEFAULT_MAX_TOKENS = 300;
const COLD_LOAD_PROBE_TIMEOUT_MS = 2000;
/**
 * Narrower than the cloud set (retry.ts): a proxy's 502/504 while the daemon
 * starts, and 503 when its queue is full. Ollama's 500 means a model that
 * failed to load (out of memory, unsupported), and each retry would sit
 * through that load again only to fail the same way. A cold load itself is
 * no error, just a slow response, so needs no retry.
 */
const OLLAMA_RETRYABLE_STATUS: ReadonlySet<number> = new Set([502, 503, 504]);
/**
 * Context window (num_ctx) requested per call. Ollama defaults to 4096 unless
 * OLLAMA_CONTEXT_LENGTH is set, and overflow truncates the prompt SILENTLY, so
 * a long session loses its system prompt and the facilitator forgets its role
 * (meditation-pal-76qx). 16k covers a multi-hour session (worst-case ~3k system
 * prompt plus short voice turns) while keeping KV-cache memory reasonable. The
 * cap is ours, not the model's: qwen3.5/gemma4 train to 262k.
 */
const DEFAULT_NUM_CTX = 16384;

/**
 * Pick a context length from total system RAM. Down-only: 16k is already hours
 * of voice-paced conversation, so more RAM never raises it, but at <=8GB the KV
 * cache competes with model weights, so step down to 8k (still multi-hour).
 * Unknown RAM (browser, probe pending) keeps the default.
 */
export function contextLengthForRam(ramGb: number | null): number {
    return ramGb !== null && ramGb <= 8 ? 8192 : DEFAULT_NUM_CTX;
}

export interface OllamaProviderOptions {
    baseUrl?: string;
    model?: string;
    maxTokens?: number;
    /** Enable thinking/reasoning mode (slower, off by default). */
    think?: boolean;
    /**
     * How long Ollama keeps the model in memory after a request. Default '30m',
     * to stay warm across a meditation's long silences; relaxKeepAlive() on
     * session end lets it idle out sooner.
     */
    keepAlive?: string;
    /** Context window (num_ctx). Raise for very long sessions, at the cost of
     *  KV-cache memory. */
    contextLength?: number;
    /** Override fetch for testing. */
    fetchImpl?: typeof fetch;
    /** Retries on a daemon that is unreachable, starting, or busy, default 3
     *  (retry.ts). */
    maxRetries?: number;
    /** Override the inter-retry sleep (tests inject a no-op to stay fast). */
    sleepImpl?: SleepFn;
}

interface OllamaChatResponse {
    message?: { content?: string };
    done_reason?: string | null;
    prompt_eval_count?: number;
    eval_count?: number;
}

/** /api/tags (pulled) and /api/ps (loaded) share this shape. */
interface OllamaModelList {
    models?: Array<{ name: string }>;
}

export class OllamaProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    readonly think: boolean;
    readonly keepAlive: string;
    readonly contextLength: number;
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;
    private readonly retry: RetryOptions;

    constructor(options: OllamaProviderOptions = {}) {
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.think = options.think ?? false;
        this.keepAlive = options.keepAlive ?? '30m';
        this.contextLength = options.contextLength ?? DEFAULT_NUM_CTX;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.retry = retryOptions(options, { retryableStatus: OLLAMA_RETRYABLE_STATUS });
    }

    private buildBody(messages: Message[], options: CompletionOptions, stream: boolean): string {
        return JSON.stringify({
            model: this.model,
            messages: withSystemMessage(messages, options.system),
            stream,
            think: this.think,
            keep_alive: this.keepAlive,
            options: {
                num_predict: options.maxTokens ?? this.maxTokens,
                num_ctx: this.contextLength,
            },
        });
    }

    /**
     * On session end, relax keep_alive to Ollama's short default (5m): the model
     * releases memory soon instead of holding it for 30m, but stays warm long
     * enough that an immediate next session still reuses it. Swallows errors.
     */
    async relaxKeepAlive(idleKeepAlive = '5m'): Promise<void> {
        try {
            await this.fetchImpl(`${this.baseUrl}/api/chat`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: this.model,
                    messages: [],
                    keep_alive: idleKeepAlive,
                }),
            });
        } catch {
            /* best-effort */
        }
    }

    /** POST /api/chat; resolves to an ok response or throws. */
    private async chat(messages: Message[], options: CompletionOptions, stream: boolean): Promise<Response> {
        const response = await fetchWithRetry(
            this.fetchImpl,
            `${this.baseUrl}/api/chat`,
            {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: this.buildBody(messages, options, stream),
                ...(options.signal && { signal: options.signal }),
            },
            this.retry
        );
        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Ollama error ${response.status}: ${detail}`);
        }
        return response;
    }

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const data = (await (await this.chat(messages, options, false)).json()) as OllamaChatResponse;
        return {
            text: data.message?.content ?? '',
            finishReason: data.done_reason ?? null,
            ...ollamaUsage(data),
        };
    }

    async *completeStream(
        messages: Message[],
        options: CompletionOptions = {}
    ): AsyncIterable<StreamChunk> {
        const response = await this.chat(messages, options, true);

        // NDJSON, one object per line:
        //   {"message":{"content":"Hello"},"done":false}
        //   {"message":{"content":""},"done":true,"eval_count":...}
        let finishReason: string | null = null;
        let usage = ollamaUsage({});
        for await (const chunk of iterateNdjson<OllamaChatResponse & { done?: boolean }>(response)) {
            const text = chunk.message?.content ?? '';
            if (text.length > 0) yield { text, done: false };
            if (chunk.done) {
                finishReason = chunk.done_reason ?? 'stop';
                usage = ollamaUsage(chunk);
            }
        }

        yield { text: '', done: true, finishReason, ...usage };
    }

    /** Is the configured model in `list`, by exact name or as `model:tag`? */
    private listed(list: OllamaModelList): boolean {
        return (list.models ?? []).some((m) => m.name === this.model || m.name.startsWith(`${this.model}:`));
    }

    /** True if the configured model (exact or prefix match) is pulled. */
    async checkModelAvailable(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/api/tags`);
            if (!response.ok) return false;
            return this.listed((await response.json()) as OllamaModelList);
        } catch {
            return false;
        }
    }

    /**
     * User-facing status string warning of a cold-load wait, or null when the
     * model is loaded, Ollama is unreachable, or load state is unknown (nothing
     * useful to show in any of those).
     *
     * One HTTP call, so it's fine before every completion. After first use the
     * model stays loaded, so later checks return null and the banner clears.
     * Bounded at 2s: the caller awaits this before the turn itself, so a
     * wedged daemon must cost a missing hint, not a hung session.
     */
    async coldLoadMessage(): Promise<string | null> {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/api/ps`, {
                signal: AbortSignal.timeout(COLD_LOAD_PROBE_TIMEOUT_MS),
            });
            if (!response.ok) return null;
            if (this.listed((await response.json()) as OllamaModelList)) return null;
            return `Loading ${this.model} into memory… first response can take a few seconds.`;
        } catch {
            return null;
        }
    }
}

/**
 * Map Ollama's eval counts to the CompletionResult split: prompt_eval_count is
 * input, eval_count is output. No cache fields, since local models have no
 * prompt caching. `tokensUsed` is the sum, null when nothing was reported.
 */
function ollamaUsage(data: { prompt_eval_count?: number; eval_count?: number }): {
    tokensUsed: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
} {
    if (data.eval_count === undefined && data.prompt_eval_count === undefined) {
        return { tokensUsed: null, inputTokens: null, outputTokens: null };
    }
    const inputTokens = data.prompt_eval_count ?? 0;
    const outputTokens = data.eval_count ?? 0;
    return { tokensUsed: inputTokens + outputTokens, inputTokens, outputTokens };
}

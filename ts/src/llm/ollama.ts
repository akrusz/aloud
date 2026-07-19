/** Ollama provider: local inference via the Ollama HTTP API, direct fetch. */

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
    StreamChunk,
} from './base.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen3.5:4b';
const DEFAULT_MAX_TOKENS = 300;
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
}

interface OllamaChatResponse {
    message?: { content?: string };
    done_reason?: string | null;
    prompt_eval_count?: number;
    eval_count?: number;
}

interface OllamaTagsResponse {
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

    constructor(options: OllamaProviderOptions = {}) {
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.think = options.think ?? false;
        this.keepAlive = options.keepAlive ?? '30m';
        this.contextLength = options.contextLength ?? DEFAULT_NUM_CTX;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    private buildBody(messages: Message[], options: CompletionOptions, stream: boolean): string {
        const ollamaMessages: Array<{ role: string; content: string }> = [];
        if (options.system) {
            ollamaMessages.push({ role: 'system', content: options.system });
        }
        for (const msg of messages) {
            ollamaMessages.push({ role: msg.role, content: msg.content });
        }
        return JSON.stringify({
            model: this.model,
            messages: ollamaMessages,
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

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: this.buildBody(messages, options, false),
            ...(options.signal && { signal: options.signal }),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Ollama error ${response.status}: ${detail}`);
        }

        const data = (await response.json()) as OllamaChatResponse;
        const text = data.message?.content ?? '';

        return {
            text,
            finishReason: data.done_reason ?? null,
            ...ollamaUsage(data),
        };
    }

    async *completeStream(
        messages: Message[],
        options: CompletionOptions = {}
    ): AsyncIterable<StreamChunk> {
        const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: this.buildBody(messages, options, true),
            ...(options.signal && { signal: options.signal }),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Ollama error ${response.status}: ${detail}`);
        }
        if (!response.body) {
            throw new Error('Ollama streaming response has no body');
        }

        // Ollama streams NDJSON, one JSON object per line:
        //   {"message":{"content":"Hello"},"done":false}
        //   {"message":{"content":""},"done":true,"eval_count":...}
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        let finishReason: string | null = null;
        let usage = { tokensUsed: null, inputTokens: null, outputTokens: null } as ReturnType<
            typeof ollamaUsage
        >;

        try {
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!line) continue;
                    const parsed = safeJson<OllamaStreamChunk>(line);
                    if (!parsed) continue;
                    const text = parsed.message?.content ?? '';
                    if (text.length > 0) {
                        yield { text, done: false };
                    }
                    if (parsed.done) {
                        finishReason = parsed.done_reason ?? 'stop';
                        usage = ollamaUsage(parsed);
                    }
                }
            }
        } finally {
            // cancel() tears down the connection (and stops generation) when a
            // consumer abandons the iterator mid-stream; releaseLock detaches.
            await reader.cancel().catch(() => {
                /* ignore */
            });
            try {
                reader.releaseLock();
            } catch {
                /* ignore */
            }
        }

        yield { text: '', done: true, finishReason, ...usage };
    }

    /** True if the configured model (exact or prefix match) is pulled. */
    async checkModelAvailable(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/api/tags`);
            if (!response.ok) return false;
            const data = (await response.json()) as OllamaTagsResponse;
            const names = data.models?.map((m) => m.name) ?? [];
            return names.some((n) => n === this.model || n.startsWith(`${this.model}:`));
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
     */
    async coldLoadMessage(): Promise<string | null> {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/api/ps`);
            if (!response.ok) return null;
            const data = (await response.json()) as OllamaPsResponse;
            const loaded = data.models?.map((m) => m.name) ?? [];
            const isLoaded = loaded.some(
                (n) => n === this.model || n.startsWith(`${this.model}:`)
            );
            if (isLoaded) return null;
            return `Loading ${this.model} into memory… first response can take a few seconds.`;
        } catch {
            return null;
        }
    }
}

interface OllamaPsResponse {
    models?: Array<{ name: string }>;
}

interface OllamaStreamChunk {
    message?: { content?: string };
    done?: boolean;
    done_reason?: string | null;
    prompt_eval_count?: number;
    eval_count?: number;
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

function safeJson<T>(s: string): T | null {
    try {
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}

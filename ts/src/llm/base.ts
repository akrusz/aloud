/**
 * Common shapes for LLM providers.
 *
 * The TS port uses `fetch` directly instead of vendor SDKs — keeps the
 * core dependency-free so it can run unchanged in Node, the browser, and
 * Capacitor's WebView without bundler config gymnastics.
 */

export type Role = 'user' | 'assistant' | 'system';

export interface Message {
    role: Role;
    content: string;
}

export interface CompletionResult {
    text: string;
    finishReason: string | null;
    /**
     * Total tokens (prompt + completion) when the provider reports it.
     * Kept for back-compat; usage tracking uses the split fields below.
     */
    tokensUsed: number | null;
    /**
     * Usage split. Input and output are priced very differently (output
     * ~4-5x input on Claude) and cache reads ~10x cheaper than fresh input,
     * so these are kept SEPARATE, never summed. Any field is null when the
     * provider doesn't report it. Mirrors src/llm/base.py CompletionResult.
     */
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    /** Subset of cacheCreationTokens written at the 1-hour TTL (Anthropic
     *  reports this as cache_creation.ephemeral_1h_input_tokens). Priced higher
     *  than the 5m default (2x vs 1.25x input), so it's tracked separately for
     *  billing. Null when the provider doesn't report a TTL breakdown. */
    cacheCreation1hTokens?: number | null;
}

export interface CompletionOptions {
    system?: string;
    maxTokens?: number;
}

/**
 * One chunk of a streamed completion. `text` is the incremental
 * delta only (not the cumulative text). `done` is true on the final
 * chunk; `finishReason` and `tokensUsed` are typically populated only
 * on the final chunk.
 */
export interface StreamChunk {
    text: string;
    done: boolean;
    finishReason?: string | null;
    tokensUsed?: number | null;
    /** Usage split, populated on the final chunk. See CompletionResult. */
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    cacheCreation1hTokens?: number | null;
}

export interface LLMProvider {
    readonly model: string;
    complete(messages: Message[], options?: CompletionOptions): Promise<CompletionResult>;
    /**
     * Optional — yields incremental text deltas. Callers should
     * feature-check `provider.completeStream` and fall back to
     * `complete()` when it's not implemented.
     */
    completeStream?(
        messages: Message[],
        options?: CompletionOptions
    ): AsyncIterable<StreamChunk>;
}

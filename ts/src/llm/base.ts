/**
 * Common shapes for LLM providers.
 *
 * Providers use `fetch` directly, not vendor SDKs, so core stays dependency-free
 * and runs unchanged in Node, the browser, and Capacitor's WebView.
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
     * Total tokens (prompt + completion) when reported. Back-compat only;
     * usage tracking uses the split fields below.
     */
    tokensUsed: number | null;
    /**
     * Usage split. Priced very differently (output ~4-5x input on Claude, cache
     * reads ~10x cheaper than fresh input), so kept SEPARATE, never summed.
     * Null when the provider doesn't report the field.
     */
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
    /** Subset of cacheCreationTokens written at the 1-hour TTL (Anthropic's
     *  cache_creation.ephemeral_1h_input_tokens). Priced 2x input vs the 5m
     *  default's 1.25x, so tracked separately for billing. Null when the
     *  provider reports no TTL breakdown. */
    cacheCreation1hTokens?: number | null;
    /** What the provider did that the text alone can't show; for the incident
     *  log (server credits/incidents.ts), never for facilitation. */
    diagnostics?: CompletionDiagnostics;
}

export interface CompletionDiagnostics {
    /** Characters of hidden reasoning the provider streamed alongside (or
     *  instead of) content. Non-zero with empty text and finish "length" is the
     *  thinking-ate-the-budget signature. */
    reasoningChars?: number;
    /** Upstream host + model that actually served the call, when a routing
     *  proxy (OpenRouter) reports them: "Novita/moonshotai/kimi-k2". */
    servedBy?: string;
}

export interface CompletionOptions {
    system?: string;
    maxTokens?: number;
    /**
     * Aborts the in-flight request (barge-in cancellation). Passed through to
     * `fetch`, so aborting mid-stream tears down the HTTP body and stops
     * billable generation. Abort can surface as an AbortError from the next
     * read; breaking out of the stream loop on `signal.aborted` avoids that.
     */
    signal?: AbortSignal;
}

/**
 * One chunk of a streamed completion. `text` is the incremental delta, not
 * cumulative. `finishReason` and `tokensUsed` usually arrive only on the
 * final (`done`) chunk.
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
    /** On the final chunk. See CompletionResult. */
    diagnostics?: CompletionDiagnostics;
}

export interface LLMProvider {
    readonly model: string;
    complete(messages: Message[], options?: CompletionOptions): Promise<CompletionResult>;
    /**
     * Optional. Callers should feature-check `provider.completeStream` and
     * fall back to `complete()`.
     */
    completeStream?(
        messages: Message[],
        options?: CompletionOptions
    ): AsyncIterable<StreamChunk>;
}

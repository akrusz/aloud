/**
 * Browser-facing claude_proxy provider. The real ClaudeProxyProvider
 * (ts/src/llm/claude-proxy.ts) shells out via node:child_process, which browsers
 * and Capacitor WebViews can't run, so this POSTs to the app backend's
 * /app/v1/llm/claude_proxy/complete (the desktop Rust shell), which makes the
 * subprocess call and returns a CompletionResult-shaped body.
 *
 * Desktop-only by nature - only the app backend serves that route. The
 * settings/setup dropdowns gate the option on isDesktopSync().
 */

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
} from '../../../src/llm/index.js';
import { appUrl } from '../app-base.js';
import { withTimeout } from '../net-timeout.js';

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_MAX_TOKENS = 400;
const ENDPOINT = appUrl('/llm/claude_proxy/complete');

/**
 * Per-attempt stall deadline. The local `claude` CLI cold-starts every turn (no
 * daemon, --no-session-persistence); the smaller models land well under 20s,
 * so exceeding it means a hung attempt. Aborting drops the connection, which
 * lets the Rust handler's kill_on_drop reap the child, and we retry on a fresh
 * process rather than wait out the server's 90s cap with no feedback.
 *
 * The big models (opus, fable) legitimately run past 20s on a long prompt -
 * the flat deadline was killing HEALTHY turns near the finish and restarting
 * from zero (3 kills = a minute of silence, then the canned fallback), so
 * they get a longer leash and one fewer retry to bound the worst case.
 */
const ATTEMPT_TIMEOUT_MS = 20_000;
const SLOW_MODEL_ATTEMPT_TIMEOUT_MS = 60_000;
const SLOW_MODEL_RE = /opus|fable/i;
/** Initial try + retries. A cold-start stall often clears on a fresh attempt. */
const MAX_ATTEMPTS = 3;
const SLOW_MODEL_MAX_ATTEMPTS = 2;
/** Embedded in the error thrown once every attempt fails; the session view
 *  matches it to show a gentle apology instead of a raw error. */
export const CLAUDE_PROXY_STALLED = 'claude_proxy_stalled';

export interface ClaudeProxyHttpProviderOptions {
    model?: string;
    maxTokens?: number;
    endpointUrl?: string;
    fetchImpl?: typeof fetch;
}

interface ClaudeProxyResponse {
    text?: string;
    finish_reason?: string | null;
    tokens_used?: number | null;
    error?: string;
}

export class ClaudeProxyHttpProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly endpointUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: ClaudeProxyHttpProviderOptions = {}) {
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.endpointUrl = options.endpointUrl ?? ENDPOINT;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    async complete(
        messages: Message[],
        options: CompletionOptions = {}
    ): Promise<CompletionResult> {
        const body: Record<string, unknown> = {
            messages: messages.map((m) => ({ role: m.role, content: m.content })),
            model: this.model,
            max_tokens: options.maxTokens ?? this.maxTokens,
        };
        if (options.system) body['system'] = options.system;

        const slow = SLOW_MODEL_RE.test(this.model);
        const attemptTimeoutMs = slow ? SLOW_MODEL_ATTEMPT_TIMEOUT_MS : ATTEMPT_TIMEOUT_MS;
        const maxAttempts = slow ? SLOW_MODEL_MAX_ATTEMPTS : MAX_ATTEMPTS;
        let lastDetail = '';
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // The caller already gave up (session ended / superseded): stop now,
            // don't burn a retry or apologize.
            if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');

            // Own controller per attempt: the deadline aborts it (killing the
            // fetch and, via kill_on_drop, the `claude` child), and the caller's
            // signal chains in so a real cancel propagates immediately.
            const attemptAbort = new AbortController();
            const onCallerAbort = (): void => attemptAbort.abort();
            options.signal?.addEventListener('abort', onCallerAbort, { once: true });
            try {
                const response = await withTimeout(
                    this.fetchImpl(this.endpointUrl, {
                        method: 'POST',
                        headers: { 'content-type': 'application/json' },
                        body: JSON.stringify(body),
                        signal: attemptAbort.signal,
                    }),
                    attemptTimeoutMs,
                    'Claude Subscription turn stalled.',
                    () => attemptAbort.abort()
                );

                if (response.ok) {
                    const data = (await response.json()) as ClaudeProxyResponse;
                    return {
                        text: data.text ?? '',
                        finishReason: data.finish_reason ?? null,
                        tokensUsed: data.tokens_used ?? null,
                    };
                }

                // The proxy returns JSON {error: ...} on failure.
                let detail = '';
                try {
                    detail = ((await response.json()) as ClaudeProxyResponse).error ?? '';
                } catch {
                    detail = await response.text().catch(() => '');
                }
                // 503 = the `claude` CLI isn't installed. Retrying can't fix
                // that, so surface it verbatim; the tag makes the catch let it
                // through instead of folding it into retries.
                if (response.status === 503) {
                    const e = new Error(detail || 'Claude Subscription proxy returned 503');
                    (e as { retryable?: boolean }).retryable = false;
                    throw e;
                }
                lastDetail = detail || `proxy returned ${response.status}`;
                // fall through to retry
            } catch (err) {
                // A real cancel (the caller aborted) - propagate, never retry.
                if (options.signal?.aborted) throw err;
                // A non-retryable failure (e.g. 503 CLI unavailable) - surface it.
                if (err instanceof Error && (err as { retryable?: boolean }).retryable === false) {
                    throw err;
                }
                lastDetail = err instanceof Error ? err.message : String(err);
                // a stall or transient network error - fall through to retry
            } finally {
                options.signal?.removeEventListener('abort', onCallerAbort);
            }
        }

        // Every attempt stalled or failed - tag it so the session view shows a
        // gentle apology and invites another try.
        throw new Error(`${CLAUDE_PROXY_STALLED}: ${lastDetail}`);
    }
}

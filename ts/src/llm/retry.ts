/**
 * The one retry policy for provider HTTP calls (Anthropic, OpenAI-compatible,
 * Ollama). A meditator is waiting in silence while this runs, so the budget is
 * small: 3 retries on ~0.4s/0.8s/1.6s jittered backoff, and no single wait or
 * total wait past a few seconds.
 *
 * Retries happen only around `fetch` resolving, never once the caller has the
 * Response: a stream that fails midway surfaces as an error rather than a
 * replayed, partly spoken turn. On aloud cloud this also keeps billing single:
 * the ledger holds before the forward and settles on the one usage report that
 * comes back (server routes/llm.ts), so a retried attempt is never metered.
 */

/** 429 plus the transient 5xx family, including Anthropic's 529 "overloaded".
 *  A non-429 4xx (bad request, auth, model not found) won't get better. */
export const RETRYABLE_STATUS: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 504, 529]);

export const DEFAULT_MAX_RETRIES = 3;
/** Longest single wait, including one a Retry-After asks for. */
export const MAX_RETRY_DELAY_MS = 8000;
/** Longest the waits may add up to across one call's retries. */
export const MAX_TOTAL_RETRY_DELAY_MS = 10_000;

export type SleepFn = (ms: number) => Promise<void>;

export interface RetryOptions {
    /** Retries after the first attempt; 0 disables retry. */
    maxRetries?: number;
    /** Statuses worth another attempt; default RETRYABLE_STATUS. */
    retryableStatus?: ReadonlySet<number>;
    /** Override the inter-retry sleep (tests inject a no-op to stay fast). */
    sleep?: SleepFn;
}

/** RetryOptions from a provider's public `maxRetries` / `sleepImpl` options. */
export function retryOptions(o: { maxRetries?: number; sleepImpl?: SleepFn }, base: RetryOptions = {}): RetryOptions {
    return {
        ...base,
        ...(o.maxRetries !== undefined && { maxRetries: o.maxRetries }),
        ...(o.sleepImpl && { sleep: o.sleepImpl }),
    };
}

const defaultSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry-After as a delay in ms: delta-seconds or an HTTP date. Null when
 *  absent or unparseable. */
export function parseRetryAfter(header: string | null, now = Date.now()): number | null {
    if (!header) return null;
    const trimmed = header.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed) * 1000;
    const date = Date.parse(trimmed);
    return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Exponential backoff with jitter for the given 0-based retry. */
export function backoffMs(attempt: number): number {
    return Math.min(400 * 2 ** attempt + Math.random() * 200, MAX_RETRY_DELAY_MS);
}

function abortError(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Sleep that rejects the moment `signal` aborts, so a barge-in never waits
 *  out a backoff. */
async function sleepUnlessAborted(sleep: SleepFn, ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (!signal) return sleep(ms);
    if (signal.aborted) throw abortError(signal);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(abortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
        await Promise.race([sleep(ms), aborted]);
    } finally {
        signal.removeEventListener('abort', onAbort!);
    }
}

function isAbortLike(err: unknown): boolean {
    const name = (err as { name?: unknown } | null)?.name;
    return name === 'AbortError' || name === 'TimeoutError';
}

/**
 * `fetch` with bounded retry on retryable statuses and network throws. Never
 * retries an aborted request. The returned Response may still be an error
 * (non-retryable, or retries exhausted); the caller does the ok-check and keeps
 * its own error message.
 */
export async function fetchWithRetry(
    fetchImpl: typeof fetch,
    url: string,
    init: RequestInit,
    options: RetryOptions = {}
): Promise<Response> {
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    const retryable = options.retryableStatus ?? RETRYABLE_STATUS;
    const sleep = options.sleep ?? defaultSleep;
    const signal = init.signal ?? undefined;
    let waited = 0;

    for (let attempt = 0; ; attempt++) {
        let delay: number;
        try {
            const response = await fetchImpl(url, init);
            if (response.ok || !retryable.has(response.status) || attempt >= maxRetries) {
                return response;
            }
            const asked = parseRetryAfter(response.headers.get('retry-after'));
            delay = asked ?? backoffMs(attempt);
            // A server asking for longer than we'd wait won't answer sooner;
            // surface its error now instead of burning the wait first.
            if (delay > MAX_RETRY_DELAY_MS || waited + delay > MAX_TOTAL_RETRY_DELAY_MS) {
                return response;
            }
            // Drain the errored body so the socket can be reused.
            await response.text().catch(() => {});
        } catch (err) {
            if (signal?.aborted || isAbortLike(err) || attempt >= maxRetries) throw err;
            delay = backoffMs(attempt);
            if (waited + delay > MAX_TOTAL_RETRY_DELAY_MS) throw err;
        }
        await sleepUnlessAborted(sleep, delay, signal);
        waited += delay;
    }
}

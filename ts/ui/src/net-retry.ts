/**
 * Riding out a dropped connection on the hosted (aloud cloud) hops: STT, LLM,
 * TTS.
 *
 * A sit on a phone moves - walking between cells, a lift, a patch with no
 * signal - and the browser fails an in-flight fetch the moment the network
 * changes (Chrome's ERR_NETWORK_CHANGED, Safari's "Load failed"). A hop that
 * gives up on the first failure drops the turn on the floor, worst on STT,
 * where what the meditator said is gone and has to be said again.
 * sendWithNetworkRetry re-sends, inside a time budget, when the failure means
 * the request never got done: the fetch itself rejected with no response, or
 * the server answered 502 (its provider_error, or Fly's proxy missing the
 * machine). While the device reports itself offline it waits for the 'online'
 * event instead of spending attempts.
 *
 * Not retried: our own timeouts (a stalled upload re-sent from scratch stalls
 * again, after the meditator has already waited), aborts, and every other
 * status - 401 has its own self-heal, 402/403/429 won't change in seconds, and
 * 503 is provider_unavailable (the provider refused aloud's account).
 *
 * Billing: a 502 is charged nothing (the metered routes bill only once the
 * provider answers). A rejected fetch usually means the request never arrived,
 * but one whose response was lost after the server finished bills the re-send
 * too: one clip of STT, one sentence of TTS, one utility completion. A stream
 * is retried only before its response arrives, so a reply is never replayed.
 */

/** Statuses that mean "not done, not charged, worth another go". */
export const NETWORK_RETRY_STATUS: ReadonlySet<number> = new Set([502]);

/** Longest single wait between attempts while the device says it's online. */
const MAX_BACKOFF_MS = 4000;

export interface NetworkRetryOptions {
    /** How long after the first failure re-sends may still start, waits
     *  included. 0 disables retry. */
    budgetMs: number;
    /** Aborting ends the retrying at once (barge-in, a newer turn, teardown);
     *  the abort reason is thrown. */
    signal?: AbortSignal;
    /** Fires before each re-send, with the 1-based retry number and why. */
    onRetry?: (retry: number, reason: string) => void;
    /** Test seams: the clock, the offline check, and the wait between
     *  attempts (resolves early when the network comes back). */
    now?: () => number;
    offline?: () => boolean;
    wait?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
}

/** A fetch that failed for want of a network: the fetch spec rejects with a
 *  TypeError ("Failed to fetch", "Load failed", "NetworkError when attempting
 *  to fetch resource."). Our own timeouts and aborts are other types. */
export function isNetworkFailure(err: unknown): boolean {
    return err instanceof TypeError;
}

/** The one place browsers tell us there's no network at all. Absent (Node,
 *  old engines) reads as online. */
function browserOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

function abortReason(signal: AbortSignal): unknown {
    return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

/** Sleep `ms`, waking early on the 'online' event; rejects on abort. */
function waitOrOnline(ms: number, signal: AbortSignal | undefined): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(abortReason(signal));
        const target =
            typeof window !== 'undefined' && typeof window.addEventListener === 'function' ? window : null;
        const done = (): void => {
            clearTimeout(timer);
            target?.removeEventListener('online', onOnline);
            signal?.removeEventListener('abort', onAbort);
        };
        const onOnline = (): void => {
            done();
            resolve();
        };
        const onAbort = (): void => {
            done();
            reject(abortReason(signal!));
        };
        const timer = setTimeout(onOnline, ms);
        target?.addEventListener('online', onOnline);
        signal?.addEventListener('abort', onAbort);
    });
}

/**
 * Run `send` (one whole attempt: token, fetch, any 401 self-heal) and re-run
 * it on a network failure or a NETWORK_RETRY_STATUS until it succeeds or the
 * budget is spent. Returns the last Response, ok or not; rethrows the last
 * error. The caller still owns the ok-check and its error message.
 */
export async function sendWithNetworkRetry(
    send: () => Promise<Response>,
    options: NetworkRetryOptions
): Promise<Response> {
    const { budgetMs, signal, onRetry } = options;
    const now = options.now ?? Date.now;
    const offline = options.offline ?? browserOffline;
    const wait = options.wait ?? waitOrOnline;
    let deadline: number | null = null;

    for (let retry = 0; ; retry++) {
        let reason: string;
        try {
            const res = await send();
            if (!NETWORK_RETRY_STATUS.has(res.status)) return res;
            if (budgetMs <= 0 || signal?.aborted) return res;
            deadline ??= now() + budgetMs;
            if (now() >= deadline) return res;
            // Drain the errored body so the socket can be reused.
            await res.text().catch(() => {});
            reason = `status ${res.status}`;
        } catch (err) {
            if (!isNetworkFailure(err) || budgetMs <= 0 || signal?.aborted) throw err;
            deadline ??= now() + budgetMs;
            if (now() >= deadline) throw err;
            reason = (err as Error).message;
        }
        // Offline: hold until the network is back (or the budget runs out)
        // rather than fail the next attempt instantly.
        const remaining = deadline - now();
        const backoff = Math.min(500 * 2 ** retry, MAX_BACKOFF_MS);
        await wait(offline() ? remaining : Math.min(backoff, remaining), signal);
        onRetry?.(retry + 1, reason);
    }
}

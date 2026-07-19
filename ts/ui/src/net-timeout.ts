/**
 * Deadline guard for cloud fetches.
 *
 * Hosted LLM / STT / TTS calls have no built-in timeout: a server that accepts
 * the connection then stalls (Fly cold start, half-open socket, slow upstream)
 * hangs the turn forever, orb stuck on "Thinking…". Rejecting instead lets the
 * per-turn catch paths recover.
 *
 * For a single bounded request only. Streaming responses use an AbortController
 * with a per-chunk re-armed timer so a long-but-live stream isn't capped (see
 * cloud-llm.completeStream).
 */

/**
 * Reject with `message` if `promise` doesn't settle within `ms`; `onTimeout`
 * releases the underlying resource. The original settlement is always consumed,
 * so a late resolve/reject never surfaces as an unhandled rejection.
 */
export function withTimeout<T>(
    promise: Promise<T>,
    ms: number,
    message: string,
    onTimeout?: () => void
): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try {
                onTimeout?.();
            } catch {
                /* best-effort cleanup; the timeout still rejects */
            }
            reject(new Error(message));
        }, ms);
        promise.then(
            (value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(value);
            },
            (err: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                reject(err as Error);
            }
        );
    });
}

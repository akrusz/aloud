/**
 * Deadline guard for cloud fetches.
 *
 * The hosted LLM / STT / TTS calls (→ aloud cloud) have no built-in timeout: a
 * server that accepts the connection and then stalls (Fly cold start, half-open
 * socket, slow upstream) leaves the awaiting turn hanging forever — the orb stuck
 * on "Thinking…" / "Speaking…" with no way forward. Turning the stall into a
 * rejection lets the existing per-turn catch paths recover (resume listening, or
 * surface a normal turn error) instead of freezing.
 *
 * `withTimeout` is for a single bounded request (the non-streaming LLM call, one
 * STT transcription, one TTS synthesis). For a streaming response use an
 * AbortController with a per-chunk re-armed timer instead, so a long-but-live
 * stream isn't capped — only a genuine stall trips it (see cloud-llm.completeStream).
 */

/**
 * Reject with `message` if `promise` doesn't settle within `ms`. `onTimeout`
 * runs when the deadline fires — use it to release the underlying resource. The
 * original promise's settlement is always consumed here, so a late resolve or
 * reject after the deadline never surfaces as an unhandled rejection.
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

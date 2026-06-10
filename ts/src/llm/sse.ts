/**
 * Server-sent events line reader.
 *
 * Anthropic and OpenAI both stream completions as SSE. The format is
 * minimal — lines of "event: <name>" and "data: <json>" separated by
 * blank lines. We tokenize the stream and yield one `{ event, data }`
 * object per logical event. Callers parse the data payload themselves
 * (the shapes differ per provider).
 *
 * Reads from a Response's `body` ReadableStream; pure DOM/Web API, no
 * Node-only deps, so this works in browser and Capacitor WebView.
 */

export interface SseEvent {
    /** "event:" field (Anthropic uses these; OpenAI doesn't). */
    event: string;
    /** Concatenated "data:" lines (excluding trailing newline). */
    data: string;
}

/**
 * Iterate SSE events from a fetch Response. Throws if the response has
 * no body (e.g. HEAD response or error response with empty body).
 */
export async function* iterateSseEvents(response: Response): AsyncIterable<SseEvent> {
    if (!response.body) {
        throw new Error('SSE response has no body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                // Final flush — emit any buffered event without a
                // trailing blank line. Rare but legal per spec.
                const tail = buffer.trim();
                if (tail.length > 0) {
                    const parsed = parseEvent(tail);
                    if (parsed) yield parsed;
                }
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            // SSE events are separated by blank lines. Split on \n\n
            // (some servers use \r\n\r\n — normalize).
            buffer = buffer.replace(/\r\n/g, '\n');
            let boundary: number;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
                const raw = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + 2);
                const parsed = parseEvent(raw);
                if (parsed) yield parsed;
            }
        }
    } finally {
        // Tear down the HTTP body when the consumer abandons the iterator
        // mid-stream (barge-in cancellation): cancel() signals "no more data
        // wanted" upstream so the connection is actually closed, not just
        // unlocked. cancel() keeps the reader's lock, so releaseLock() after
        // is still needed to detach from the stream. Both are best-effort —
        // the stream may already be closed or errored.
        await reader.cancel().catch(() => {
            /* ignore */
        });
        try {
            reader.releaseLock();
        } catch {
            /* ignore */
        }
    }
}

function parseEvent(raw: string): SseEvent | null {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
        if (line.startsWith(':')) continue; // comment
        if (line.startsWith('event:')) {
            event = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^\s/, ''));
        }
        // ignore "id:", "retry:" etc — we don't reconnect.
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
}

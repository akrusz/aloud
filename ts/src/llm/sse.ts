/**
 * Server-sent events line reader for the Anthropic/OpenAI streaming formats:
 * "event: <name>" / "data: <json>" lines separated by blank lines. Yields one
 * `{ event, data }` per logical event; callers parse the payload, since the
 * shapes differ per provider.
 *
 * Pure Web API (no Node-only deps), so it works in browser and Capacitor.
 */

export interface SseEvent {
    /** "event:" field (Anthropic uses these; OpenAI doesn't). */
    event: string;
    /** Concatenated "data:" lines (excluding trailing newline). */
    data: string;
}

/** Iterate SSE events from a fetch Response. Throws if the response has no body. */
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
                // Final flush: an event with no trailing blank line is legal.
                const tail = buffer.trim();
                if (tail.length > 0) {
                    const parsed = parseEvent(tail);
                    if (parsed) yield parsed;
                }
                return;
            }
            buffer += decoder.decode(value, { stream: true });
            // Events are blank-line separated; some servers send \r\n\r\n.
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
        // Tear down the HTTP body when a consumer abandons the iterator
        // mid-stream (barge-in): cancel() closes the connection rather than
        // merely unlocking it, and keeps the reader's lock, so releaseLock()
        // is still needed. Both best-effort; the stream may already be dead.
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
        // "id:"/"retry:" ignored; we don't reconnect.
    }
    if (dataLines.length === 0) return null;
    return { event, data: dataLines.join('\n') };
}

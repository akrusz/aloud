/**
 * Streaming-body readers shared by the providers: server-sent events (the
 * Anthropic/OpenAI formats) and NDJSON (Ollama). Callers parse the payload,
 * since the shapes differ per provider.
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
    for await (const raw of iterateRecords(response, '\n\n')) {
        const parsed = parseEvent(raw);
        if (parsed) yield parsed;
    }
}

/** Iterate the JSON objects of an NDJSON body, skipping blank or unparseable
 *  lines. Throws if the response has no body. */
export async function* iterateNdjson<T>(response: Response): AsyncIterable<T> {
    for await (const line of iterateRecords(response, '\n')) {
        const parsed = safeJson<T>(line.trim());
        if (parsed) yield parsed;
    }
}

export function safeJson<T>(s: string): T | null {
    try {
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}

/** Split a streamed body on `separator`, yielding each non-blank record. */
async function* iterateRecords(response: Response, separator: string): AsyncIterable<string> {
    if (!response.body) {
        throw new Error('Streaming response has no body');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                // Final flush: a record with no trailing separator is legal.
                if (buffer.trim().length > 0) yield buffer.trim();
                return;
            }
            // Some servers send \r\n line endings.
            buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
            let boundary: number;
            while ((boundary = buffer.indexOf(separator)) >= 0) {
                const raw = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + separator.length);
                if (raw.trim().length > 0) yield raw;
            }
        }
    } finally {
        // Tear down the HTTP body when a consumer abandons the iterator
        // mid-stream (barge-in): cancel() closes the connection (and stops
        // generation) rather than merely unlocking it, and keeps the reader's
        // lock, so releaseLock() is still needed. Both best-effort; the stream
        // may already be dead.
        await reader.cancel().catch(() => {});
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

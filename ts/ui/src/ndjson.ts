/** One line of the app backend's NDJSON progress streams (model downloads,
 *  Ollama pulls, daemon tools). Fields vary by endpoint. */
export interface NdjsonMessage {
    status?: string;
    error?: string;
    message?: string;
    completed?: number;
    total?: number;
    file?: string;
}

/**
 * Read an NDJSON progress stream to its end, handing each parsed line to
 * `onMessage`. Blank and unparseable lines are skipped; a `status:"error"`
 * line throws with its `error` (or `fallbackError`).
 */
export async function readNdjson(
    body: ReadableStream<Uint8Array>,
    onMessage: (msg: NdjsonMessage) => void,
    fallbackError: string
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg: NdjsonMessage;
            try {
                msg = JSON.parse(line) as NdjsonMessage;
            } catch {
                continue;
            }
            if (msg.status === 'error') throw new Error(msg.error || fallbackError);
            onMessage(msg);
        }
    }
}

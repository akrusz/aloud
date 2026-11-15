/**
 * Takes a per-utterance check off the critical path. The recognizer knows the
 * words a few seconds before the turn is submitted (it waits out a pause first),
 * so the question can be asked during that wait and the answer be ready at
 * submit.
 *
 * It only ever makes an answer EARLY. Nothing acts on a prefetched answer until
 * the final transcript arrives and matches the text that was asked about; a
 * final that differs is asked fresh, exactly as without this.
 *
 * Debounced, because browser recognizers emit a partial per word and only the
 * one that stops changing is worth a request.
 */
export class UtterancePrefetch<T> {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending: { key: string; result: Promise<T>; startedAt: number; abort: AbortController } | null = null;

    constructor(
        /** `signal` aborts when the words moved on and the answer is no longer
         *  wanted. Someone who pauses three times mid-sentence starts three
         *  asks, and on a local model each one left running is in the queue
         *  ahead of the reply. */
        private readonly ask: (text: string, signal: AbortSignal) => Promise<T>,
        /** A partial must sit unchanged this long before it's worth asking about. */
        private readonly settleMs = 350,
        private readonly worthAsking: (text: string) => boolean = () => true
    ) {}

    /** Case, edge whitespace and trailing punctuation differ between a partial
     *  and its final without the words differing. */
    private static keyOf(text: string): string {
        return text.trim().toLowerCase().replace(/[\s.,!?。，！？…]+$/u, '');
    }

    /** A partial transcript arrived. */
    note(partial: string): void {
        const key = UtterancePrefetch.keyOf(partial);
        if (this.pending?.key === key) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (!key || !this.worthAsking(partial)) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.pending?.abort.abort();
            const abort = new AbortController();
            this.pending = { key, result: this.ask(partial, abort.signal), startedAt: Date.now(), abort };
        }, this.settleMs);
    }

    /**
     * The final transcript arrived: the answer already asked for, if it was for
     * these words (possibly still in flight - awaiting it is still a head start),
     * else null and the caller asks fresh. Always resets.
     */
    take(finalText: string): Promise<T> | null {
        return this.takeAsk(finalText)?.result ?? null;
    }

    /** `take`, with when the ask started and a way to call it off. */
    takeAsk(finalText: string): { result: Promise<T>; startedAt: number; cancel: () => void } | null {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const pending = this.pending;
        this.pending = null;
        if (!pending) return null;
        if (pending.key !== UtterancePrefetch.keyOf(finalText)) {
            pending.abort.abort();
            return null;
        }
        return { result: pending.result, startedAt: pending.startedAt, cancel: () => pending.abort.abort() };
    }
}

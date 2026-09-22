/**
 * Bridges a callback-driven recognizer to the AsyncIterable an SttEngine's
 * start() returns: callbacks push() events, start() yields drain().
 */
export class EventQueue<T> {
    /** Set by finish(); the drain ends once the queue empties. */
    done = false;
    private readonly items: T[] = [];
    private waiter: (() => void) | null = null;

    push(item: T): void {
        this.items.push(item);
        this.wake();
    }

    finish(): void {
        this.done = true;
        this.wake();
    }

    /** Rouse a drain parked on an empty queue, so it re-checks `stop`. */
    wake(): void {
        const w = this.waiter;
        this.waiter = null;
        w?.();
    }

    /** Yield queued items until finish() (or `stop()`) and the queue is empty. */
    async *drain(stop: () => boolean = () => false): AsyncGenerator<T> {
        while (true) {
            while (this.items.length > 0) yield this.items.shift()!;
            if (this.done || stop()) return;
            await new Promise<void>((resolve) => {
                this.waiter = resolve;
            });
        }
    }
}

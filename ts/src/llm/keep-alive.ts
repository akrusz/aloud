/**
 * Keeps a sit's prompt-cache entry alive through a quiet stretch
 * (meditation-pal-wb0j).
 *
 * Anthropic's cache entry lives five minutes from the start of the request
 * that last wrote or read it. Sits go quiet for longer than that (a [HOLD], a
 * long silence between check-ins), and the next turn then pays to write the
 * whole prefix again. While a sit is quiet this re-sends the last facilitation
 * request at max_tokens 0 (LLMProvider.keepAlive) every KEEP_ALIVE_INTERVAL_MS,
 * which bills a cache read: on Opus 5.5 a twentieth of the input price.
 *
 * The session loop drives it. `begin()` before each facilitation request; on
 * the ticket, `end(request)` once that request has completed and its messages
 * stay a prefix of the session log (a turn, the opener, a check-in whose event
 * was logged), plain `end()` otherwise (a check-in that passed, a failed or
 * superseded turn). `stop()` when the session ends or starts to close.
 */

import type { CompletionOptions, CompletionResult, Message } from './base.js';

/** A ping goes this long after the start of the request or ping before it,
 *  leaving half a minute of the five for a slow round trip. */
export const KEEP_ALIVE_INTERVAL_MS = 270_000;

/** A timer that runs later than this after the last request or ping started
 *  has missed the entry (a phone throttles timers in the background). */
export const KEEP_ALIVE_LATE_MS = 295_000;

/** Pings in a row without a real request, about an hour of quiet. A replay
 *  of production history found nothing worth keeping past that. */
export const KEEP_ALIVE_MAX_PINGS = 13;

/** The last facilitation request as it was sent, without the reply. */
export interface KeepAliveRequest {
    messages: Message[];
    options: CompletionOptions;
}

export interface KeepAliveTimer {
    set(callback: () => void, delayMs: number): unknown;
    clear(handle: unknown): void;
}

export interface CacheKeepAliveOptions {
    /** One ping: the facilitation provider's keepAlive. */
    ping: (messages: Message[], options: CompletionOptions) => Promise<CompletionResult>;
    /** Each answered ping's result, for the session's usage tally. */
    onPing?: (result: CompletionResult) => void;
    /** Milliseconds; default Date.now. */
    now?: () => number;
    timer?: KeepAliveTimer;
}

export interface KeepAliveTicket {
    /** Idempotent: the first call counts. Pass the request when it completed
     *  and its messages stay a prefix of every later request. */
    end(request?: KeepAliveRequest): void;
}

const realTimer: KeepAliveTimer = {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class CacheKeepAlive {
    private readonly ping: CacheKeepAliveOptions['ping'];
    private readonly onPing: CacheKeepAliveOptions['onPing'];
    private readonly now: () => number;
    private readonly timer: KeepAliveTimer;

    /** What the next ping re-sends; null while there is nothing to keep. */
    private last: KeepAliveRequest | null = null;
    /** Start of the request or ping that last read or wrote the entry. */
    private anchorAt = 0;
    private pings = 0;
    private inFlight = 0;
    private pinging = false;
    private stopped = false;
    private handle: unknown = null;

    constructor(options: CacheKeepAliveOptions) {
        this.ping = options.ping;
        this.onPing = options.onPing;
        this.now = options.now ?? Date.now;
        this.timer = options.timer ?? realTimer;
    }

    begin(): KeepAliveTicket {
        const startedAt = this.now();
        this.inFlight++;
        this.disarm();
        let open = true;
        return {
            end: (request) => {
                if (!open) return;
                open = false;
                this.inFlight--;
                if (this.stopped) return;
                if (request) {
                    this.last = request;
                    this.anchorAt = startedAt;
                    this.pings = 0;
                }
                this.arm();
            },
        };
    }

    /** For good: the session is over, or a ping failed. */
    stop(): void {
        this.stopped = true;
        this.last = null;
        this.disarm();
    }

    private arm(): void {
        if (this.stopped || this.inFlight > 0 || this.pinging || !this.last) return;
        this.disarm();
        const delay = Math.max(0, this.anchorAt + KEEP_ALIVE_INTERVAL_MS - this.now());
        this.handle = this.timer.set(() => {
            this.handle = null;
            void this.fire();
        }, delay);
    }

    private disarm(): void {
        if (this.handle === null) return;
        this.timer.clear(this.handle);
        this.handle = null;
    }

    private async fire(): Promise<void> {
        const last = this.last;
        if (this.stopped || this.inFlight > 0 || this.pinging || !last) return;
        const startedAt = this.now();
        if (startedAt - this.anchorAt > KEEP_ALIVE_LATE_MS || this.pings >= KEEP_ALIVE_MAX_PINGS) {
            // Too late, the entry has lapsed and a ping would pay to write it
            // again for a turn that may never come; or quiet for an hour.
            // Either way, nothing more until the next real request.
            this.last = null;
            return;
        }
        this.pings++;
        this.pinging = true;
        let result: CompletionResult | null = null;
        try {
            result = await this.ping(last.messages, last.options);
        } catch {
            /* stops below, silently: a ping is never worth an error */
        }
        this.pinging = false;
        if (result) this.onPing?.(result);
        // A ping that read nothing found no entry: the prefix is under the
        // model's cacheable minimum, or the entry went early. It wrote one or
        // paid full input, and the next would too.
        if (!result || result.cacheReadTokens === 0) {
            this.stop();
            return;
        }
        if (this.stopped) return;
        // A real request since the ping started has moved the anchor itself.
        if (this.last === last) this.anchorAt = startedAt;
        this.arm();
    }
}

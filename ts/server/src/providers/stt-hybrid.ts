/**
 * Every hosted request for Parakeet runs with gpt-transcribe behind it
 * (routes/stt.ts), whatever the client knows of this (meditation-pal-gxk8).
 * Parakeet is quick and cheap, but on a short wordless clip it writes a word
 * from a breath or a sigh, and its one OpenRouter host now and then refuses a
 * request (an upstream 429) or stalls (a 200 that took 12 s, and once 37 s, in
 * a 540-request probe of 2 s clips with a median of 0.64 s). So:
 *
 * - a clip of HYBRID_SHORT_MAX_SEC or less goes to gpt-transcribe instead
 *   (`reroute`);
 * - a longer one goes to Parakeet, and the same audio goes to gpt-transcribe
 *   too when Parakeet fails (`fallback`) or has not answered within
 *   hybridDeadlineMs (`hedge`). The first answer wins and the other request is
 *   aborted.
 *
 * gpt-transcribe gets no prompt on any of these, as Parakeet would have had
 * none. The route meters every leg legIsBilled says the providers bill.
 */

import type { SttRoute } from '../contract.js';
import { SttUpstreamError, type SttResult } from './stt.js';

/** The model this applies to, and the one behind it. */
export const HYBRID_MODEL = 'moondream/parakeet-ultra';
export const HYBRID_STAND_IN = 'gpt-transcribe';

/** A Parakeet request with this many seconds of audio or fewer goes to
 *  gpt-transcribe. Wordless clips of 1-2 s are where Parakeet invents a word
 *  and gpt-transcribe returns nothing. The client's Hybrid choice cuts at the
 *  same point (ui stt-picker.ts HYBRID_GPT_MAX_SEC). */
export const HYBRID_SHORT_MAX_SEC = 3.0;

/**
 * Parakeet's deadline, counted from the send: a fixed part plus a part per
 * second of audio. Parakeet answers in about 0.3 s plus 0.02 s per audio
 * second with the upload (p95 1.26 s on a 2 s clip, 5 of 539 past 3 s), so
 * this hedges under one long request in a hundred. At the client's 120 s
 * utterance cap it is 15 s, which with gpt-transcribe's own few seconds still
 * answers well inside the client's 45 s TRANSCRIBE_TIMEOUT_MS.
 */
export const HYBRID_DEADLINE_BASE_MS = 3_000;
export const HYBRID_DEADLINE_MS_PER_SEC = 100;

export function hybridDeadlineMs(seconds: number): number {
    return HYBRID_DEADLINE_BASE_MS + HYBRID_DEADLINE_MS_PER_SEC * seconds;
}

/** One upstream request of a hedged transcription. */
export interface SttLeg {
    model: string;
    /** `cut`: we aborted it in flight, after the other leg answered. Never
     *  `pending` once transcribeHedged has settled. */
    end: 'pending' | 'answered' | 'cut' | 'failed';
    /** From the first leg's send to this one's end. */
    ms: number;
    error?: unknown;
}

/**
 * Whether the provider bills a leg. One that answered, yes. One cut off in
 * flight, yes: OpenRouter bills an aborted non-streaming request in full
 * (its streaming docs, "Stream cancellation"; a Parakeet request aborted
 * 267 ms after the send was billed all 7 s of it), and OpenAI documents
 * nothing for an aborted transcription, so it is metered as billed. One refused with
 * an error status, no (SttUpstreamError). Any other failure (a dropped
 * connection, an unreadable body) may have run upstream, so it is metered.
 */
export function legIsBilled(leg: SttLeg): boolean {
    return leg.end !== 'pending' && !(leg.end === 'failed' && leg.error instanceof SttUpstreamError);
}

export interface HedgedLegSpec {
    model: string;
    send: (signal: AbortSignal) => Promise<SttResult>;
}

export interface HedgedTranscription {
    result: SttResult;
    /** The leg whose text this is. */
    answered: SttLeg;
    /** Why the stand-in was sent; null when the primary answered alone. */
    route: Extract<SttRoute, 'fallback' | 'hedge'> | null;
    /** The primary, then the stand-in if it was sent. */
    legs: SttLeg[];
}

/** Both legs failed. */
export class HedgeFailed extends Error {
    readonly route: Extract<SttRoute, 'fallback' | 'hedge'>;
    readonly legs: SttLeg[];
    constructor(route: Extract<SttRoute, 'fallback' | 'hedge'>, legs: SttLeg[]) {
        super(legs.map((l) => `${l.model}: ${String(l.error)}`).join('; then '));
        this.route = route;
        this.legs = legs;
    }
}

/**
 * Send `primary`; send `standIn` too when the primary fails or has not
 * answered within `deadlineMs`. Resolves with the first answer and aborts the
 * other leg; rejects with HedgeFailed when every leg sent has failed.
 */
export function transcribeHedged(
    primary: HedgedLegSpec,
    standIn: HedgedLegSpec,
    deadlineMs: number
): Promise<HedgedTranscription> {
    return new Promise((resolve, reject) => {
        const sentAt = Date.now();
        const legs: SttLeg[] = [];
        const aborts: AbortController[] = [];
        let route: HedgedTranscription['route'] = null;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const send = (spec: HedgedLegSpec): void => {
            const leg: SttLeg = { model: spec.model, end: 'pending', ms: 0 };
            const ac = new AbortController();
            legs.push(leg);
            aborts.push(ac);
            const isPrimary = legs.length === 1;
            spec.send(ac.signal).then(
                (result) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    const now = Date.now() - sentAt;
                    leg.end = 'answered';
                    leg.ms = now;
                    legs.forEach((other, i) => {
                        if (other.end !== 'pending') return;
                        other.end = 'cut';
                        other.ms = now;
                        aborts[i]!.abort();
                    });
                    resolve({ result, answered: leg, route, legs });
                },
                (error: unknown) => {
                    if (settled) return;
                    leg.end = 'failed';
                    leg.ms = Date.now() - sentAt;
                    leg.error = error;
                    if (isPrimary && route === null) {
                        clearTimeout(timer);
                        route = 'fallback';
                        send(standIn);
                    } else if (legs.every((l) => l.end !== 'pending')) {
                        settled = true;
                        clearTimeout(timer);
                        reject(new HedgeFailed(route!, legs));
                    }
                }
            );
        };

        send(primary);
        timer = setTimeout(() => {
            if (settled || route !== null) return;
            route = 'hedge';
            send(standIn);
        }, deadlineMs);
    });
}

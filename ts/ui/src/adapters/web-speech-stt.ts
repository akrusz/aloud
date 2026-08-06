/**
 * Web Speech API adapter for the SttEngine interface.
 *
 * Coverage:
 *   - Desktop Chrome, Edge:         ✓ (uses Google's cloud recognizer)
 *   - Android Chrome:               ✓
 *   - Brave (any platform):         ✗ (ships the API but Google blocks the
 *                                       speech endpoint for non-Chrome Chromium,
 *                                       so it only ever errors `network`)
 *   - Desktop Safari (Sequoia+):    partial - requires on-device dictation
 *   - iOS/iPadOS (any browser):     ✗ (WebKit HAS exposed webkitSpeechRecognition
 *                                       since iOS 14.5, but it needs Dictation
 *                                       enabled, ignores `continuous`, and won't
 *                                       restart outside a user gesture - so the
 *                                       listen loop only produces mic errors.
 *                                       Reported unsupported; see isIosWeb)
 *
 * Bridges the event-callback API to AsyncIterable via a small internal queue,
 * resuming the iterator each time the recognizer emits.
 */

import type { SttEngine, SttEvent } from '../../../src/platform/stt.js';

import { isIosWeb } from '../is-desktop.js';

// `SpeechRecognition` / `webkitSpeechRecognition` aren't in lib.dom - declare
// just enough surface for the adapter.
interface SpeechRecognitionResultItem {
    readonly transcript: string;
    readonly confidence: number;
}
interface SpeechRecognitionResult {
    readonly isFinal: boolean;
    readonly [index: number]: SpeechRecognitionResultItem;
}
interface SpeechRecognitionResultList {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike {
    readonly error: string;
}
interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}
interface SpeechRecognitionCtor {
    new (): SpeechRecognitionLike;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
    // Non-browser contexts (Node tests, SSR): no window means no Web Speech,
    // not a ReferenceError.
    if (typeof window === 'undefined') return null;
    const w = window as unknown as {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * `navigator.brave` is Brave's own marker, and a hard "no Web Speech" signal:
 * Brave exposes `webkitSpeechRecognition` but Google disabled the speech
 * endpoint for non-Chrome Chromium, so recognition always errors `network`.
 * Reporting unsupported steers the picker to aloud cloud instead of a dead mic.
 */
function isBrave(): boolean {
    return typeof navigator !== 'undefined' && 'brave' in navigator;
}

export function isWebSpeechSupported(): boolean {
    if (isBrave()) return false;
    // iOS/iPadOS exposes the API and cannot use it the way this app needs to
    // (see the header). Same shape as the Brave gate: report unsupported so the
    // picker lands on aloud cloud instead of a mic that only errors.
    if (isIosWeb()) return false;
    return getSpeechRecognitionCtor() !== null;
}

export interface WebSpeechSttEngineOptions {
    /** BCP-47 language tag. Defaults to the page's lang attribute or 'en-US'. */
    lang?: string;
    /** Keep recognizing until stop(); off by default to match natural turn-taking. */
    continuous?: boolean;
    /** Emit `partial` events as the recognizer narrows in. On by default. */
    interimResults?: boolean;
    /**
     * Base pause (ms) before the turn is submitted. When > 0 the recognizer runs
     * continuously and WE decide the turn is over, so a mid-thought pause
     * doesn't make the facilitator jump in. 0 (default) defers to the browser's
     * own end-of-speech detection.
     */
    submitDelayMs?: number;
    /** Max pause (ms) tolerated - the cap on the ramp below. Defaults to
     *  submitDelayMs. */
    submitMaxDelayMs?: number;
    /**
     * Adaptive ramp: each ms of speech buys this many ms of extra pause
     * tolerance, capped at submitMaxDelayMs. Mirrors the server-Whisper VAD;
     * longer turns get more patience for mid-sentence pauses. 0 = flat delay.
     */
    submitRampRate?: number;
}

export class WebSpeechSttEngine implements SttEngine {
    private readonly Ctor: SpeechRecognitionCtor;
    private readonly options: Required<WebSpeechSttEngineOptions>;
    private recognition: SpeechRecognitionLike | null = null;

    constructor(options: WebSpeechSttEngineOptions = {}) {
        const Ctor = getSpeechRecognitionCtor();
        if (!Ctor) {
            throw new Error(
                'Web Speech API is not available in this browser. Use a Capacitor plugin or a server STT fallback.'
            );
        }
        this.Ctor = Ctor;
        const submitDelayMs = options.submitDelayMs ?? 0;
        this.options = {
            lang: options.lang ?? document.documentElement.lang ?? 'en-US',
            // A submit delay means we own end-of-turn detection, so keep the
            // recognizer open across pauses.
            continuous: options.continuous ?? submitDelayMs > 0,
            interimResults: options.interimResults ?? true,
            submitDelayMs,
            submitMaxDelayMs: options.submitMaxDelayMs ?? submitDelayMs,
            submitRampRate: options.submitRampRate ?? 0,
        };
    }

    async *start(): AsyncIterable<SttEvent> {
        const recognition = new this.Ctor();
        this.recognition = recognition;
        recognition.lang = this.options.lang;
        recognition.continuous = this.options.continuous;
        recognition.interimResults = this.options.interimResults;

        const queue: SttEvent[] = [];
        let done = false;
        let wake: (() => void) | null = null;

        const { submitDelayMs, submitMaxDelayMs, submitRampRate } = this.options;
        let silenceTimer: ReturnType<typeof setTimeout> | null = null;
        let latestTranscript = '';
        let submitted = false;
        let speechStartMs = 0; // when this turn's speech began (for the ramp)

        const push = (event: SttEvent): void => {
            queue.push(event);
            if (wake) {
                const w = wake;
                wake = null;
                w();
            }
        };
        const clearSilenceTimer = (): void => {
            if (silenceTimer) {
                clearTimeout(silenceTimer);
                silenceTimer = null;
            }
        };
        const finish = (): void => {
            clearSilenceTimer();
            done = true;
            if (wake) {
                const w = wake;
                wake = null;
                w();
            }
        };
        // Emit the accumulated transcript and stop the recognizer (its onend
        // ends iteration). Guarded so the timer and onend can't both submit.
        const submit = (): void => {
            if (submitted) return;
            submitted = true;
            clearSilenceTimer();
            if (latestTranscript) push({ type: 'final', text: latestTranscript });
            try {
                recognition.stop();
            } catch {
                /* already stopped */
            }
        };

        recognition.onresult = (event) => {
            // Join every segment, but let one that EXTENDS the interim before it
            // replace that one. Both Chromes emit several interim entries;
            // desktop's hold separate chunks (drop any and the live bubble loses
            // words) while Android's are growing prefixes of one utterance, which
            // concatenate into "yeah I'm just settling in yeah I'm just settling
            // in feeling…" (meditation-pal-oxmt). Only interims are superseded -
            // a final never grows.
            const parts: string[] = [];
            let prevFinal = true;
            let isFinal = false;
            for (let i = 0; i < event.results.length; i++) {
                const result = event.results[i];
                if (!result || !result[0]) continue;
                const text = result[0].transcript.trim();
                if (!text) continue;
                if (!prevFinal && extendsPrefix(text, parts[parts.length - 1]!)) {
                    parts[parts.length - 1] = text;
                } else {
                    parts.push(text);
                }
                prevFinal = result.isFinal;
                if (result.isFinal) isFinal = true;
            }
            const transcript = tidyTranscript(parts.join(' '));
            latestTranscript = transcript;

            if (submitDelayMs > 0) {
                // We own end-of-turn: show interim text live and (re)arm the
                // silence timer. The tolerated pause ramps with speech duration,
                // capped at submitMaxDelayMs. Speaking again resets it.
                if (speechStartMs === 0) speechStartMs = Date.now();
                const speechDur = Date.now() - speechStartMs;
                const needed = Math.min(
                    submitDelayMs + speechDur * submitRampRate,
                    submitMaxDelayMs
                );
                push({ type: 'partial', text: transcript });
                clearSilenceTimer();
                silenceTimer = setTimeout(submit, needed);
            } else {
                // Browser-driven: submit as soon as a segment finalizes.
                push({ type: isFinal ? 'final' : 'partial', text: transcript });
            }
        };
        recognition.onerror = (event) => {
            // 'no-speech' and 'aborted' are routine end-of-turn signals, not errors.
            if (event.error === 'no-speech' || event.error === 'aborted') return;
            push({ type: 'error', error: event.error });
        };
        recognition.onend = () => {
            // If the recognizer ends on its own (Chrome's timeout, network)
            // while we're holding speech for the submit delay, flush it.
            if (submitDelayMs > 0 && !submitted && latestTranscript) {
                submitted = true;
                push({ type: 'final', text: latestTranscript });
            }
            finish();
        };

        try {
            recognition.start();
        } catch (err) {
            // start() throws if the recognizer is already running - e.g. a
            // double-click on the mic button.
            push({ type: 'error', error: err });
            finish();
        }

        try {
            while (true) {
                while (queue.length > 0) {
                    yield queue.shift()!;
                }
                if (done) return;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        } finally {
            clearSilenceTimer();
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            this.recognition = null;
        }
    }

    async stop(): Promise<void> {
        if (this.recognition) {
            try {
                this.recognition.stop();
            } catch {
                // already stopped
            }
        }
    }
}

/**
 * Web Speech output arrives lowercase, unpunctuated, and can run together across
 * segments. Collapse whitespace and capitalize sentence starts - no attempt to
 * restore punctuation, just to read less like a jumble. (Server Whisper already
 * returns cased, punctuated text and skips this.)
 */
/** Does `next` continue `prev` - same words plus more? Case/punctuation-blind. */
function extendsPrefix(next: string, prev: string): boolean {
    const bare = (s: string): string => s.toLowerCase().replace(/[^\w\s]/g, '').trim();
    const a = bare(prev);
    const b = bare(next);
    return a !== '' && b.length > a.length && b.startsWith(a);
}

function tidyTranscript(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    if (!collapsed) return '';
    return collapsed.replace(
        /(^|[.!?]\s+)([a-z])/g,
        (_m, lead: string, ch: string) => lead + ch.toUpperCase()
    );
}

/**
 * Speech-to-text engine interface, shaped after the native engines (iOS
 * SFSpeechRecognizer, Android SpeechRecognizer, Web Speech): `start()` yields
 * partials then a final and completes; the engine does its own silence
 * detection. `stop()` requests early termination.
 *
 * Keep this file dependency-free so core stays importable in any runtime.
 */

export type SttEvent =
    | {
          type: 'partial';
          text: string;
          /** See the `final` field of the same name. */
          startedDuringTts?: boolean;
      }
    | {
          type: 'final';
          text: string;
          /**
           * Seconds of audio transcribed, when the engine ran billable
           * server-side STT (Whisper); the caller folds it into session usage.
           * Omitted for on-device engines, which consume no metered compute.
           */
          seconds?: number;
          /**
           * True when this utterance's speech STARTED while TTS was audibly
           * playing (continuous-capture engines only). The echo guard keys off
           * this rather than arrival time: VAD trailing silence plus
           * transcription latency can land an echo many seconds after playback
           * ended, past any arrival-time window.
           */
          startedDuringTts?: boolean;
      }
    | { type: 'error'; error: unknown };

export interface SttEngine {
    /**
     * Begin a recognition session. Yields events until end-of-speech, an error,
     * or `stop()`; the iterator completes on its own when the engine considers
     * the utterance finished.
     */
    start(): AsyncIterable<SttEvent>;

    /** Request early termination of an in-progress recognition. */
    stop(): Promise<void>;

    /**
     * Optional: open the mic stream and audio graph WITHOUT beginning an
     * utterance. Engines with an onset pre-buffer (server-Whisper) call this
     * during the opening greeting so a barge-in on the first facilitator turn
     * isn't clipped; otherwise the graph is built lazily on first start() and
     * no onset is buffered yet. Absent on engines that don't need it.
     */
    prime?(): Promise<void>;
}

// In-memory implementation for tests / dry-run CLI usage.

export interface InMemorySttEngineOptions {
    /** Events to yield on each `start()` call. */
    script: readonly SttEvent[];
    /** Delay between events, for tests where timing matters. */
    delayMs?: number;
}

export class InMemorySttEngine implements SttEngine {
    private readonly script: readonly SttEvent[];
    private readonly delayMs: number;
    private stopRequested = false;

    constructor(options: InMemorySttEngineOptions) {
        this.script = options.script;
        this.delayMs = options.delayMs ?? 0;
    }

    async *start(): AsyncIterable<SttEvent> {
        this.stopRequested = false;
        for (const event of this.script) {
            if (this.stopRequested) return;
            if (this.delayMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
            }
            yield event;
        }
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
    }
}

/**
 * True when a transcript is only non-speech markers or punctuation, so it
 * shouldn't take the user's turn.
 *
 * STT engines annotate non-verbal audio in parens, brackets, or asterisks:
 * "[BLANK_AUDIO]", "[inaudible]", "(coughing)", "*sighs*". Strip those spans;
 * if no Unicode letter remains it was a cough, breath, or noise, not a turn.
 * (Web Speech yields words or nothing, so this is a no-op there.)
 *
 * Only catches utterances that are ENTIRELY markers. A bare hallucinated word
 * (Whisper's "you"/"Thank you" on silence) has letters and is left alone.
 */
export function isNonSpeechOnly(text: string): boolean {
    if (!text) return true;
    const stripped = text
        .replace(/\([^)]*\)/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\*[^*]*\*/g, '');
    return !/\p{L}/u.test(stripped);
}

/**
 * Drain an STT iterator to its final transcript, ignoring partials. Null if
 * the stream ends with an error or no final.
 */
export async function collectFinal(stt: SttEngine): Promise<string | null> {
    for await (const event of stt.start()) {
        if (event.type === 'final') return event.text;
        if (event.type === 'error') return null;
    }
    return null;
}

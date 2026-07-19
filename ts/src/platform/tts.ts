/**
 * Text-to-speech engine interface.
 *
 * `speak()` resolves when playback finishes. All impls (AVSpeechSynthesizer,
 * Android TextToSpeech, browser speechSynthesis) support cancel-mid-utterance:
 * `cancel()` makes an in-flight `speak()` resolve early, not reject.
 */

export interface TtsVoice {
    /** Stable engine-specific id, e.g. "com.apple.voice.compact.en-US.Samantha". */
    id: string;
    /** Human-readable name for pickers. */
    name: string;
    /** BCP-47 language tag, e.g. "en-US". */
    language: string;
}

export interface TtsOptions {
    /** Voice id (from listVoices()); falls back to the engine default. */
    voice?: string;
    /** Words per minute, when meaningful. Engines normalize as needed. */
    rate?: number;
    /** 0.5–2.0, 1.0 = neutral. */
    pitch?: number;
    /**
     * Fires when audible playback begins (after any synthesis fetch), so the UI
     * can reveal text in step with the voice. Best-effort: engines that can't
     * observe playback start never call it, so callers need a fallback.
     */
    onStart?: () => void;
}

export interface TtsEngine {
    speak(text: string, options?: TtsOptions): Promise<void>;
    /**
     * Synthesize `text` without playing it, so a later speak() of the same text
     * starts instantly. Fire-and-forget; errors surface on the speak(). Only
     * meaningful for engines with a synthesis round-trip; local engines omit it.
     */
    prefetch?(text: string, options?: TtsOptions): void;
    /** Cancel any in-progress utterance. No-op when nothing is speaking. */
    cancel(): Promise<void>;
    /** Return all voices the engine can use. */
    listVoices(): Promise<TtsVoice[]>;
}

// In-memory implementation for tests / dry-run CLI usage.

export interface InMemoryTtsEngineOptions {
    /** Voices to advertise from `listVoices()`. Defaults to one English voice. */
    voices?: TtsVoice[];
    /**
     * Synthetic speech duration in ms, for tests that observe
     * cancel-mid-utterance. Defaults to 0 (resolve on the next tick).
     */
    durationMs?: number;
}

interface SpokenRecord {
    text: string;
    options: TtsOptions | undefined;
    cancelled: boolean;
}

export class InMemoryTtsEngine implements TtsEngine {
    private readonly voices: TtsVoice[];
    private readonly durationMs: number;
    /** `speak()` calls in order, with their resolution state. */
    readonly spoken: SpokenRecord[] = [];

    private pendingTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingResolve: (() => void) | null = null;
    private pendingRecord: SpokenRecord | null = null;

    constructor(options: InMemoryTtsEngineOptions = {}) {
        this.voices = options.voices ?? [
            { id: 'default', name: 'Default', language: 'en-US' },
        ];
        this.durationMs = options.durationMs ?? 0;
    }

    speak(text: string, options?: TtsOptions): Promise<void> {
        // Synchronous: awaiting here would let a concurrent cancel() see a state
        // where the new record isn't registered yet.
        this.cancelSync();
        const record: SpokenRecord = { text, options, cancelled: false };
        this.spoken.push(record);
        options?.onStart?.();
        this.pendingRecord = record;
        return new Promise<void>((resolve) => {
            this.pendingResolve = resolve;
            this.pendingTimer = setTimeout(() => {
                this.pendingTimer = null;
                this.pendingResolve = null;
                this.pendingRecord = null;
                resolve();
            }, this.durationMs);
        });
    }

    cancel(): Promise<void> {
        this.cancelSync();
        return Promise.resolve();
    }

    private cancelSync(): void {
        if (this.pendingTimer !== null) {
            clearTimeout(this.pendingTimer);
            this.pendingTimer = null;
        }
        if (this.pendingRecord !== null) {
            this.pendingRecord.cancelled = true;
            this.pendingRecord = null;
        }
        if (this.pendingResolve !== null) {
            const resolve = this.pendingResolve;
            this.pendingResolve = null;
            resolve();
        }
    }

    async listVoices(): Promise<TtsVoice[]> {
        return this.voices.slice();
    }
}

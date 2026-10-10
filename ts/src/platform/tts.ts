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
    listVoices(): Promise<TtsVoice[]>;
}

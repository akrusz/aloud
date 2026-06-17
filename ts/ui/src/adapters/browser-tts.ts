/**
 * speechSynthesis adapter for the TtsEngine interface.
 *
 * Works in every modern browser and inside the iOS/Android Capacitor
 * WebView too, so this is the cross-platform fallback. For higher
 * quality on iOS specifically, swap to a Capacitor plugin that calls
 * AVSpeechSynthesizer directly — same interface.
 */

import type { TtsEngine, TtsOptions, TtsVoice } from '../../../src/platform/tts.js';

export interface BrowserTtsEngineOptions {
    /**
     * Default voice (by `name` or `voiceURI`) to use when speak() is
     * called without an explicit `options.voice`. Set when the voice
     * picker hands us a specific selection — speak() options.voice
     * still wins per-call.
     */
    defaultVoice?: string;
}

export class BrowserTtsEngine implements TtsEngine {
    private currentUtterance: SpeechSynthesisUtterance | null = null;
    private currentResolve: (() => void) | null = null;
    private readonly defaultVoice: string | undefined;

    constructor(options: BrowserTtsEngineOptions = {}) {
        if (typeof speechSynthesis === 'undefined') {
            throw new Error('speechSynthesis is not available in this environment.');
        }
        this.defaultVoice = options.defaultVoice;
    }

    speak(text: string, options?: TtsOptions): Promise<void> {
        this.cancelSync();
        return new Promise<void>((resolve) => {
            const utterance = new SpeechSynthesisUtterance(text);
            if (options?.rate !== undefined) {
                // speechSynthesis rate is 0.1–10, 1.0 neutral. The TtsOptions
                // contract says "WPM when meaningful" but we can also accept
                // a relative rate; normalize WPM (40–280 range) to 0.5–2.0.
                utterance.rate = options.rate > 5 ? options.rate / 160 : options.rate;
            }
            if (options?.pitch !== undefined) {
                utterance.pitch = options.pitch;
            }
            const voiceName = options?.voice ?? this.defaultVoice;
            if (voiceName) {
                const voice = speechSynthesis
                    .getVoices()
                    .find((v) => v.voiceURI === voiceName || v.name === voiceName);
                if (voice) {
                    utterance.voice = voice;
                    // Firefox for Android ignores `utterance.voice` on its own and
                    // keeps the system default unless `lang` is also set to the
                    // voice's locale. Harmless on browsers that honor `.voice`.
                    if (voice.lang) utterance.lang = voice.lang;
                }
            }
            // Reveal-in-step-with-voice: report when the engine actually
            // starts producing audio (synthesis can lag speak() by a beat).
            if (options?.onStart) utterance.onstart = options.onStart;
            utterance.onend = () => this.finish(utterance);
            utterance.onerror = () => this.finish(utterance);
            this.currentUtterance = utterance;
            this.currentResolve = resolve;
            speechSynthesis.speak(utterance);
            // Android Chrome leaves the speech queue *paused* after a preceding
            // cancel() (the voice picker calls cancel() then speak() to preview),
            // so the utterance sits silent until something resumes it. This is
            // why browser-voice previews were mute on Android while in-session
            // playback (no cancel/speak churn) worked. resume() is a harmless
            // no-op when the queue isn't paused.
            speechSynthesis.resume();
        });
    }

    cancel(): Promise<void> {
        this.cancelSync();
        return Promise.resolve();
    }

    private cancelSync(): void {
        if (this.currentUtterance !== null) {
            speechSynthesis.cancel();
            this.finish(this.currentUtterance);
        }
    }

    private finish(utterance: SpeechSynthesisUtterance): void {
        if (this.currentUtterance !== utterance) return;
        this.currentUtterance = null;
        const resolve = this.currentResolve;
        this.currentResolve = null;
        if (resolve) resolve();
    }

    async listVoices(): Promise<TtsVoice[]> {
        let voices = speechSynthesis.getVoices();
        if (voices.length === 0) {
            // Some browsers (Chrome, in particular) load voices asynchronously.
            await new Promise<void>((resolve) => {
                let resolved = false;
                const done = () => {
                    if (resolved) return;
                    resolved = true;
                    speechSynthesis.removeEventListener('voiceschanged', done);
                    resolve();
                };
                speechSynthesis.addEventListener('voiceschanged', done);
                setTimeout(done, 1000);
            });
            voices = speechSynthesis.getVoices();
        }
        return voices.map((v) => ({
            id: v.voiceURI,
            name: v.name,
            language: v.lang,
        }));
    }
}

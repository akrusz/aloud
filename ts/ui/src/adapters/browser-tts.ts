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
    private currentReject: ((err: Error) => void) | null = null;
    private readonly defaultVoice: string | undefined;

    constructor(options: BrowserTtsEngineOptions = {}) {
        if (typeof speechSynthesis === 'undefined') {
            throw new Error('speechSynthesis is not available in this environment.');
        }
        this.defaultVoice = options.defaultVoice;
    }

    speak(text: string, options?: TtsOptions): Promise<void> {
        this.cancelSync();
        return new Promise<void>((resolve, reject) => {
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
            // Surface a genuine synthesis failure instead of resolving as if the
            // voice spoke. Chrome/Edge fire `onerror` with synthesis-failed /
            // synthesis-unavailable / network for remote "Online (Natural)"
            // voices that can't render — previously this resolved like `onend`,
            // so previewing such a voice was silent with no explanation. Our own
            // cancel()/new-speak fire error 'interrupted'/'canceled'; those are
            // normal teardown, not failures, so finish() resolves quietly for them.
            utterance.onerror = (event) => this.finish(utterance, event.error);
            this.currentUtterance = utterance;
            this.currentResolve = resolve;
            this.currentReject = reject;
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

    private finish(utterance: SpeechSynthesisUtterance, error?: string): void {
        if (this.currentUtterance !== utterance) return;
        this.currentUtterance = null;
        const resolve = this.currentResolve;
        const reject = this.currentReject;
        this.currentResolve = null;
        this.currentReject = null;
        // 'interrupted' / 'canceled' are our own cancel()/new-speak churn, not a
        // real failure — resolve quietly. Anything else (synthesis-failed,
        // synthesis-unavailable, network, voice-unavailable, …) means no audio
        // played: reject so the voice preview can say why.
        if (error && error !== 'interrupted' && error !== 'canceled') {
            if (reject) reject(new Error(`speechSynthesis ${error}`));
            else if (resolve) resolve();
            return;
        }
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

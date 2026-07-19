/**
 * speechSynthesis adapter for the TtsEngine interface - the cross-platform
 * fallback, working in every modern browser and the iOS/Android Capacitor
 * WebView. For higher iOS quality, a Capacitor plugin calling
 * AVSpeechSynthesizer would drop into the same interface.
 */

import type { TtsEngine, TtsOptions, TtsVoice } from '../../../src/platform/tts.js';

export interface BrowserTtsEngineOptions {
    /** Default voice (by `name` or `voiceURI`) when speak() gets no explicit
     *  `options.voice`, which still wins per-call. */
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
                // speechSynthesis rate is 0.1–10, 1.0 neutral. TtsOptions is
                // "WPM when meaningful", so normalize WPM (40–280) to 0.5–2.0
                // and pass a relative rate through.
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
            // Report when audio actually starts (synthesis can lag speak() by a
            // beat), so the caller can reveal text in step with the voice.
            if (options?.onStart) utterance.onstart = options.onStart;
            utterance.onend = () => this.finish(utterance);
            // Surface real synthesis failures instead of resolving as if the
            // voice spoke: Chrome/Edge fire `onerror` with synthesis-failed /
            // synthesis-unavailable / network for remote "Online (Natural)"
            // voices that can't render, so previewing one was silent with no
            // explanation. Our own cancel()/new-speak fire 'interrupted' /
            // 'canceled', which finish() resolves quietly as normal teardown.
            utterance.onerror = (event) => this.finish(utterance, event.error);
            this.currentUtterance = utterance;
            this.currentResolve = resolve;
            this.currentReject = reject;
            speechSynthesis.speak(utterance);
            // Android Chrome leaves the speech queue *paused* after a preceding
            // cancel() (the voice picker previews via cancel-then-speak), so the
            // utterance sits silent until resumed - why browser-voice previews
            // were mute on Android while in-session playback worked. A no-op
            // when the queue isn't paused.
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
        // 'interrupted'/'canceled' are our own cancel()/new-speak churn -
        // resolve quietly. Anything else means no audio played: reject so the
        // preview can say why.
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
            // Chrome in particular loads voices asynchronously.
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

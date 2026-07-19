/**
 * Capacitor STT - wraps @capacitor-community/speech-recognition as an SttEngine.
 * SFSpeechRecognizer on iOS, SpeechRecognizer on Android: no bundled Whisper and
 * no network round-trip where on-device recognition is available (varies by OS
 * version and language). The mobile app's skip-Whisper path.
 *
 * Caveats:
 *   - The first permission prompt must come from a user gesture (mic-button
 *     click). requestPermissions() runs lazily inside start() so callers don't
 *     have to remember.
 *   - Native APIs auto-stop on end-of-speech. continuous=true holds the session
 *     across pauses; the default false matches turn-taking.
 *   - In a plain browser (no Capacitor runtime) this throws at start(), not at
 *     import.
 */

import { SpeechRecognition } from '@capacitor-community/speech-recognition';
import type { PluginListenerHandle } from '@capacitor/core';

import type { SttEngine, SttEvent } from '../../../src/platform/stt.js';

export interface CapacitorSttEngineOptions {
    /** BCP-47 language tag. Defaults to the page's lang attribute or 'en-US'. */
    language?: string;
    /** Keep recognizing across pauses until stop(). Default false (one turn). */
    continuous?: boolean;
    /** Emit partial-result events. Default true. */
    partialResults?: boolean;
    /** Candidates per result. We use only the top one, but the plugin requires
     *  the field. Default 1. */
    maxResults?: number;
}

export class CapacitorSttEngine implements SttEngine {
    private readonly options: Required<CapacitorSttEngineOptions>;
    private partialListener: PluginListenerHandle | null = null;
    private stateListener: PluginListenerHandle | null = null;
    private stopRequested = false;

    constructor(options: CapacitorSttEngineOptions = {}) {
        this.options = {
            language: options.language ?? document.documentElement.lang ?? 'en-US',
            continuous: options.continuous ?? false,
            partialResults: options.partialResults ?? true,
            maxResults: options.maxResults ?? 1,
        };
    }

    /** Does this platform actually have speech recognition? Lets app boot pick
     *  an adapter without paying the import cost on the wrong platform. */
    static async isAvailable(): Promise<boolean> {
        try {
            const result = await SpeechRecognition.available();
            return result.available;
        } catch {
            return false;
        }
    }

    async *start(): AsyncIterable<SttEvent> {
        this.stopRequested = false;

        try {
            const perm = await SpeechRecognition.checkPermissions();
            if (perm.speechRecognition !== 'granted') {
                const requested = await SpeechRecognition.requestPermissions();
                if (requested.speechRecognition !== 'granted') {
                    yield { type: 'error', error: new Error('Speech recognition permission denied') };
                    return;
                }
            }
        } catch (err) {
            yield { type: 'error', error: err };
            return;
        }

        const queue: SttEvent[] = [];
        let done = false;
        let wake: (() => void) | null = null;

        const push = (event: SttEvent): void => {
            queue.push(event);
            if (wake) {
                const w = wake;
                wake = null;
                w();
            }
        };
        const finish = (): void => {
            done = true;
            if (wake) {
                const w = wake;
                wake = null;
                w();
            }
        };

        this.partialListener = await SpeechRecognition.addListener('partialResults', (data) => {
            const matches = (data as { matches?: string[] }).matches ?? [];
            const text = matches[0];
            if (text === undefined) return;
            push({ type: 'partial', text });
        });

        this.stateListener = await SpeechRecognition.addListener('listeningState', (data) => {
            if ((data as { status?: string }).status === 'stopped') finish();
        });

        try {
            // The plugin's start() resolves with the final transcript(s) when
            // listening ends - that resolution is the stream's final event.
            const startPromise = SpeechRecognition.start({
                language: this.options.language,
                maxResults: this.options.maxResults,
                partialResults: this.options.partialResults,
                popup: false,
            });
            startPromise
                .then((result) => {
                    const matches = (result as { matches?: string[] } | undefined)?.matches ?? [];
                    const text = matches[0];
                    if (text !== undefined) push({ type: 'final', text });
                    finish();
                })
                .catch((err: unknown) => {
                    push({ type: 'error', error: err });
                    finish();
                });

            while (true) {
                while (queue.length > 0) {
                    yield queue.shift()!;
                }
                if (done || this.stopRequested) return;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        } finally {
            await this.partialListener?.remove().catch(() => {});
            await this.stateListener?.remove().catch(() => {});
            this.partialListener = null;
            this.stateListener = null;
        }
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        try {
            await SpeechRecognition.stop();
        } catch {
            // Already stopped - fine.
        }
    }
}

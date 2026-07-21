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

        // Clear any half-torn-down native session (the next start() fails
        // "RecognitionService busy" otherwise). The plugin's stop() NEVER
        // resolves its call on the success path - fire and forget, never
        // await it - and it runs before the listeners attach so its
        // 'stopped' event can't read as this turn ending.
        void SpeechRecognition.stop().catch(() => {});
        await new Promise<void>((resolve) => setTimeout(resolve, 50));

        // The plugin's REAL contract with partialResults: true (our default;
        // read from the Android source, not the docs):
        //   - start() resolves IMMEDIATELY and empty - it is not a result.
        //   - Interim AND final transcripts all arrive as 'partialResults'
        //     events (native onResults is forwarded to the same event).
        //   - listeningState 'stopped' fires at END OF SPEECH, before the
        //     final transcript lands.
        //   - A silent turn is INVISIBLE: native errors (NO_MATCH) reject the
        //     already-resolved call, which JS never sees. No event arrives.
        // So the turn ends on: last transcript after 'stopped' (debounced),
        // a cap after 'stopped' with nothing further, or an idle timeout for
        // the silent-turn case. Only with partialResults: false does start()
        // resolve with the final matches.
        let lastText: string | null = null;
        let stopped = false;
        let finalTimer: ReturnType<typeof setTimeout> | null = null;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;

        const finishTurn = (): void => {
            if (done) return;
            if (lastText !== null) {
                console.info(`[stt-native] final: ${lastText.length} chars`);
                push({ type: 'final', text: lastText });
            } else {
                console.info('[stt-native] turn ended with no speech');
            }
            finish();
        };
        // After end-of-speech, each further transcript re-arms a short
        // debounce; the last one to land within it is the final.
        const scheduleFinal = (ms: number): void => {
            if (finalTimer !== null) clearTimeout(finalTimer);
            finalTimer = setTimeout(finishTurn, ms);
        };
        // Nothing at all heard (recognizer died silently or user stayed
        // quiet): end the turn so the listen loop starts a fresh session.
        const bumpIdle = (): void => {
            if (idleTimer !== null) clearTimeout(idleTimer);
            idleTimer = setTimeout(finishTurn, 15000);
        };
        bumpIdle();

        let sawPartial = false;
        this.partialListener = await SpeechRecognition.addListener('partialResults', (data) => {
            const matches = (data as { matches?: string[] }).matches ?? [];
            const text = matches[0];
            if (text === undefined) return;
            if (!sawPartial) {
                sawPartial = true;
                console.info('[stt-native] first partial received');
            }
            lastText = text;
            bumpIdle();
            if (stopped) scheduleFinal(700);
            push({ type: 'partial', text });
        });

        this.stateListener = await SpeechRecognition.addListener('listeningState', (data) => {
            const status = (data as { status?: string }).status;
            console.info(`[stt-native] state: ${status}`);
            bumpIdle();
            if (status === 'stopped') {
                stopped = true;
                // Cap: the final usually lands well inside this; each arrival
                // shortens the wait via the 700ms debounce above.
                scheduleFinal(2500);
            }
        });

        try {
            const startPromise = SpeechRecognition.start({
                language: this.options.language,
                maxResults: this.options.maxResults,
                partialResults: this.options.partialResults,
                popup: false,
            });
            console.info('[stt-native] start requested');
            startPromise
                .then((result) => {
                    // Meaningful only with partialResults: false; in partial
                    // mode this resolves instantly and empty - ignore it.
                    const matches = (result as { matches?: string[] } | undefined)?.matches ?? [];
                    const text = matches[0];
                    if (text !== undefined) {
                        lastText = text;
                        finishTurn();
                    }
                })
                .catch((err: unknown) => {
                    // Android's NO_MATCH ("Didn't understand...") is ordinary
                    // silence, not a fault - end the turn without an error so
                    // the loop just listens again (paced by its cycle guard).
                    const msg = err instanceof Error ? err.message : String(err);
                    console.warn(`[stt-native] start error: ${msg}`);
                    if (!/didn't understand|no match/i.test(msg)) {
                        push({ type: 'error', error: err });
                    }
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
            if (finalTimer !== null) clearTimeout(finalTimer);
            if (idleTimer !== null) clearTimeout(idleTimer);
            await this.partialListener?.remove().catch(() => {});
            await this.stateListener?.remove().catch(() => {});
            this.partialListener = null;
            this.stateListener = null;
        }
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        // Never await: the plugin's stop() call never resolves on success
        // (Android impl calls stopListening() without call.resolve()), so an
        // await here hangs the caller forever.
        void SpeechRecognition.stop().catch(() => {
            // Already stopped - fine.
        });
    }
}

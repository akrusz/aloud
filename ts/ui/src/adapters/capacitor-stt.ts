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
 *   - Native APIs auto-stop on end-of-speech. The plugin (v7) has no continuous
 *     mode on Android, so to hold a turn open across a mid-thought pause we
 *     restart-stitch: fold each segment's transcript and relaunch the recognizer
 *     until submitDelayMs of real silence elapses (see start()). submitDelayMs=0
 *     keeps the old one-utterance-per-turn behavior.
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
    /**
     * Base pause (ms) tolerated before the turn is submitted. When > 0 we own
     * end-of-turn: Android's recognizer endpoints on ~1.5s of silence, so each
     * end-of-speech is treated as a segment boundary - the transcript is kept
     * and the recognizer relaunched - and the turn only ends after this much
     * real silence. 0 (default) submits on the first end-of-speech. Mirrors
     * WebSpeechSttEngine.submitDelayMs.
     */
    submitDelayMs?: number;
    /** Max pause (ms) tolerated - the cap on the ramp below. Defaults to
     *  submitDelayMs. */
    submitMaxDelayMs?: number;
    /** Adaptive ramp: each ms of speech buys this many ms of extra pause
     *  tolerance, capped at submitMaxDelayMs. 0 = flat delay. */
    submitRampRate?: number;
}

const RESTART_GAP_MS = 50;
const SEGMENT_SETTLE_MS = 700;
const IDLE_TIMEOUT_MS = 15000;

export class CapacitorSttEngine implements SttEngine {
    private readonly options: Required<CapacitorSttEngineOptions>;
    private partialListener: PluginListenerHandle | null = null;
    private stateListener: PluginListenerHandle | null = null;
    private stopRequested = false;

    constructor(options: CapacitorSttEngineOptions = {}) {
        const submitDelayMs = options.submitDelayMs ?? 0;
        this.options = {
            language: options.language ?? document.documentElement.lang ?? 'en-US',
            continuous: options.continuous ?? false,
            partialResults: options.partialResults ?? true,
            maxResults: options.maxResults ?? 1,
            submitDelayMs,
            submitMaxDelayMs: options.submitMaxDelayMs ?? submitDelayMs,
            submitRampRate: options.submitRampRate ?? 0,
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
        await new Promise<void>((resolve) => setTimeout(resolve, RESTART_GAP_MS));

        // The plugin's REAL contract with partialResults: true (our default;
        // read from the Android source, not the docs):
        //   - start() resolves IMMEDIATELY and empty - it is not a result.
        //   - Interim AND final transcripts all arrive as 'partialResults'
        //     events (native onResults is forwarded to the same event).
        //   - listeningState 'stopped' fires at END OF SPEECH, before the
        //     final transcript lands.
        //   - A silent turn is INVISIBLE: native errors (NO_MATCH) reject the
        //     already-resolved call, which JS never sees. No event arrives.
        //
        // stitching (submitDelayMs > 0): each end-of-speech is a segment
        // boundary. After a short settle to catch the post-'stopped' final,
        // fold the segment into `accumulated`, relaunch the recognizer, and let
        // an end-of-turn timer - reset on every real utterance, NOT on empty
        // restarts - decide when the pause is long enough to submit. Legacy
        // (submitDelayMs === 0): finalize a short debounce after 'stopped'.
        const { submitDelayMs, submitMaxDelayMs, submitRampRate } = this.options;
        const stitching = submitDelayMs > 0;

        let accumulated = ''; // folded transcript from prior segments this turn
        let segmentText = ''; // current segment's latest partial
        let speechStartMs = 0;
        let lastSpeechAt = 0;
        let sawSpeech = false;
        let submitted = false;
        // How many segments contributed speech this turn. Logged at submit so a
        // logcat reader can see stitching held across a pause (> 1 = stitched).
        let segments = 0;
        let segmentHasSpeech = false;
        // True between a segment's end-of-speech and its relaunch: the plugin
        // delivers the segment's FINAL transcript as a 'partialResults' event
        // AFTER 'stopped', and that late delivery must not read as new speech
        // (which would cancel the pending restart and reset the end-of-turn
        // window - the mic would then wait dead and still cut the user off).
        let segmentStopped = false;
        let endTimer: ReturnType<typeof setTimeout> | null = null;
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        let idleTimer: ReturnType<typeof setTimeout> | null = null;

        const clearTimers = (): void => {
            if (endTimer !== null) clearTimeout(endTimer);
            if (settleTimer !== null) clearTimeout(settleTimer);
            if (idleTimer !== null) clearTimeout(idleTimer);
            endTimer = settleTimer = idleTimer = null;
        };
        const combined = (): string =>
            [accumulated, segmentText].map((s) => s.trim()).filter(Boolean).join(' ');

        // End the turn: emit the stitched transcript (or note silence) and stop.
        const submit = (): void => {
            if (submitted || done) return;
            submitted = true;
            clearTimers();
            const text = combined();
            if (text) {
                console.info(`[stt-native] final: ${text.length} chars, ${segments} segment(s)`);
                push({ type: 'final', text });
            } else {
                console.info('[stt-native] turn ended with no speech');
            }
            finish();
            // Fire-and-forget: the plugin's stop() never resolves (see stop()).
            void SpeechRecognition.stop().catch(() => {});
        };

        // Pause tolerated right now: base + speech-so-far × ramp, capped. Ramps
        // with speech duration so longer turns get more patience mid-sentence.
        const neededMs = (): number => {
            const speechDur = lastSpeechAt && speechStartMs ? lastSpeechAt - speechStartMs : 0;
            return Math.min(submitDelayMs + speechDur * submitRampRate, submitMaxDelayMs);
        };
        // (Re)arm the end-of-turn timer. Called only on real speech, so a silent
        // restart cycle can't keep pushing the deadline out.
        const armEnd = (): void => {
            if (endTimer !== null) clearTimeout(endTimer);
            endTimer = setTimeout(submit, neededMs());
        };
        // Nothing heard for a long time (recognizer wedged, or a silent turn
        // that never errored): submit what we have (or note silence) as a
        // backstop so the listen loop isn't left hanging.
        const bumpIdle = (): void => {
            if (idleTimer !== null) clearTimeout(idleTimer);
            idleTimer = setTimeout(submit, IDLE_TIMEOUT_MS);
        };

        // Relaunch the native recognizer for the next segment, keeping the
        // stitched transcript. Bounded by the end-of-turn timer, which fires
        // submit() and flips `submitted`, so this can't loop forever.
        const restartSegment = async (): Promise<void> => {
            if (submitted || done || this.stopRequested) return;
            void SpeechRecognition.stop().catch(() => {});
            await new Promise<void>((resolve) => setTimeout(resolve, RESTART_GAP_MS));
            if (submitted || done || this.stopRequested) return;
            segmentStopped = false; // the relaunched segment's partials are live
            segmentHasSpeech = false; // count this new segment only if it hears speech
            launchSegment();
        };

        // Live speech in the currently-active segment: advances the transcript
        // and resets the end-of-turn window.
        const onLiveSpeech = (text: string): void => {
            if (submitted || done) return;
            if (!sawSpeech) {
                sawSpeech = true;
                console.info('[stt-native] first partial received');
            }
            if (!segmentHasSpeech) {
                segmentHasSpeech = true;
                segments++;
            }
            if (speechStartMs === 0) speechStartMs = Date.now();
            segmentText = text;
            lastSpeechAt = Date.now();
            bumpIdle();
            if (stitching) armEnd();
            push({ type: 'partial', text: combined() });
        };

        this.partialListener = await SpeechRecognition.addListener('partialResults', (data) => {
            const text = ((data as { matches?: string[] }).matches ?? [])[0];
            if (text === undefined || submitted || done) return;
            if (segmentStopped) {
                // Post-'stopped' final delivery of the segment that just ended:
                // adopt the (usually cleaner) final text for the live preview,
                // but the segment is over - don't touch the end-of-turn window
                // or the pending restart.
                segmentText = text;
                push({ type: 'partial', text: combined() });
                if (!stitching) {
                    if (settleTimer !== null) clearTimeout(settleTimer);
                    settleTimer = setTimeout(submit, 700);
                }
                return;
            }
            onLiveSpeech(text);
        });

        this.stateListener = await SpeechRecognition.addListener('listeningState', (data) => {
            const status = (data as { status?: string }).status;
            console.info(`[stt-native] state: ${status}`);
            if (status !== 'stopped' || submitted || done) return;
            segmentStopped = true;
            if (!stitching) {
                // Legacy: submit a short debounce after end-of-speech; a
                // post-stop final re-arms it (above) so the cleaner text wins.
                if (settleTimer !== null) clearTimeout(settleTimer);
                settleTimer = setTimeout(submit, 2500);
                return;
            }
            // Settle briefly to catch the post-'stopped' final transcript, then
            // fold and relaunch to catch a continuation. The end-of-turn timer,
            // armed from the last LIVE utterance, is what actually ends the turn.
            if (settleTimer !== null) clearTimeout(settleTimer);
            settleTimer = setTimeout(() => {
                settleTimer = null;
                if (submitted || done) return;
                if (segmentText) {
                    accumulated = combined();
                    segmentText = '';
                }
                if (sawSpeech && accumulated) {
                    // A turn is in progress; keep the mic available for a
                    // continuation until the end-of-turn timer fires.
                    void restartSegment();
                } else {
                    submit(); // silent turn: let the listen loop start fresh
                }
            }, SEGMENT_SETTLE_MS);
        });

        // Launch (or relaunch) one native recognition segment.
        const launchSegment = (): void => {
            const startPromise = SpeechRecognition.start({
                language: this.options.language,
                maxResults: this.options.maxResults,
                partialResults: this.options.partialResults,
                popup: false,
            });
            startPromise
                .then((result) => {
                    // Meaningful only with partialResults: false; in partial mode
                    // this resolves instantly and empty - ignore it.
                    const text = ((result as { matches?: string[] } | undefined)?.matches ?? [])[0];
                    if (text !== undefined) {
                        onLiveSpeech(text);
                        if (!stitching) submit();
                    }
                })
                .catch((err: unknown) => {
                    // Android's NO_MATCH ("Didn't understand...") is ordinary
                    // silence, not a fault.
                    const msg = err instanceof Error ? err.message : String(err);
                    const benign = /didn't understand|no match/i.test(msg);
                    if (!benign) {
                        console.warn(`[stt-native] start error: ${msg}`);
                        push({ type: 'error', error: err });
                        finish();
                        return;
                    }
                    if (submitted || done) return;
                    if (stitching && sawSpeech && accumulated) {
                        // Silence during a turn in progress: the end-of-turn timer
                        // will submit; keep the mic live for a continuation.
                        void restartSegment();
                    } else {
                        submit(); // nothing heard: end the (empty) turn
                    }
                });
        };

        console.info('[stt-native] start requested');
        bumpIdle();
        launchSegment();

        try {
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
            clearTimers();
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

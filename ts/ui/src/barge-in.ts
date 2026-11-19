/**
 * Barge-in detector - listens for the user speaking over TTS and triggers
 * cancellation. Opens a parallel mic stream during playback, for STT backends
 * that are dormant between turns (Web Speech / Capacitor, which haven't been
 * start()ed yet). WhisperPcmSttEngine captures continuously and detects
 * barge-in on its own stream, so it skips this wrapper (see
 * sttBackendForChoice).
 *
 * Does NOT capture the audio that triggered it: after cancellation the regular
 * listen loop wakes (busy clears once TTS resolves) and captures the next
 * utterance. Users pause ~300ms after interrupting, which covers the gap.
 *
 * The threshold/chunk-count defaults are tuned for typical conversation volume.
 */

import type { TtsEngine, TtsOptions, TtsVoice } from '../../src/platform/index.js';
import { audioContextCtor } from './audio-unlock.js';
import { BrowserTtsEngine } from './adapters/browser-tts.js';
import type { SttBackend } from './adapters/stt-picker.js';
import { diag } from './diag.js';

const FRAME_SIZE = 4096;
const BARGE_IN_THRESHOLD = 0.04;
const BARGE_IN_REQUIRED_CHUNKS = 3;

export interface BargeInListenerOptions {
    /** RMS energy floor above which a frame counts as the user speaking. */
    threshold?: number;
    /** Consecutive over-threshold frames required to trigger. */
    requiredChunks?: number;
    /** Capture device (Settings → Microphone); null/absent = system default.
     *  Must match the STT engine's pick, or the detector listens to a
     *  different mic than the one transcribing. */
    micDeviceId?: string | null;
}

export class BargeInListener {
    private readonly threshold: number;
    private readonly requiredChunks: number;
    private readonly micDeviceId: string | null;
    private context: AudioContext | null = null;
    private stream: MediaStream | null = null;
    private processor: ScriptProcessorNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stopped = false;

    constructor(options: BargeInListenerOptions = {}) {
        this.threshold = options.threshold ?? BARGE_IN_THRESHOLD;
        this.requiredChunks = options.requiredChunks ?? BARGE_IN_REQUIRED_CHUNKS;
        this.micDeviceId = options.micDeviceId ?? null;
    }

    /** Begin listening. Calls `onBargeIn` at most once per start()/stop() cycle,
     *  then stops itself so one barge-in can't fire it repeatedly. */
    async start(onBargeIn: () => void): Promise<void> {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
            return; // no mic API - silently disabled
        }
        try {
            // echoCancellation keeps TTS coming out of the speakers from leaking
            // in and tripping a barge-in - the facilitator interrupting itself.
            // Plain {audio:true} doesn't guarantee it, especially in a WebView.
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    ...(this.micDeviceId ? { deviceId: { ideal: this.micDeviceId } } : {}),
                    echoCancellation: true,
                },
            });
        } catch {
            return; // mic access denied - silently disabled, TTS plays normally
        }
        if (this.stopped) {
            this.releaseStream();
            return;
        }

        const AC = audioContextCtor();
        if (!AC) {
            this.releaseStream();
            return;
        }
        this.context = new AC();
        this.source = this.context.createMediaStreamSource(this.stream);
        this.processor = this.context.createScriptProcessor(FRAME_SIZE, 1, 1);

        let count = 0;
        let fired = false;
        // The line is asked to play once this has opened (wrapTtsWithBargeIn).
        const opened = performance.now();
        this.processor.onaudioprocess = (e) => {
            if (fired || this.stopped) return;
            const data = e.inputBuffer.getChannelData(0);
            let sum = 0;
            for (let i = 0; i < data.length; i++) sum += data[i]! * data[i]!;
            const energy = Math.sqrt(sum / data.length);
            if (energy > this.threshold) {
                count++;
                if (count >= this.requiredChunks) {
                    fired = true;
                    // So a report can tell a line this cut from one the output dropped.
                    diag(
                        `[vad] wrapper barge-in ${Math.round(performance.now() - opened)}ms after the line began, ` +
                            `energy=${energy.toFixed(4)} threshold=${this.threshold}`
                    );
                    onBargeIn();
                    // Stop self - caller will release after TTS cancel.
                    void this.stop();
                }
            } else {
                count = 0;
            }
        };

        this.source.connect(this.processor);
        this.processor.connect(this.context.destination);
    }

    async stop(): Promise<void> {
        this.stopped = true;
        if (this.processor) {
            try {
                this.processor.disconnect();
            } catch {
                /* already disconnected */
            }
            this.processor.onaudioprocess = null;
            this.processor = null;
        }
        if (this.source) {
            try {
                this.source.disconnect();
            } catch {
                /* already disconnected */
            }
            this.source = null;
        }
        if (this.context && this.context.state !== 'closed') {
            this.context.close().catch(() => {});
        }
        this.context = null;
        this.releaseStream();
    }

    private releaseStream(): void {
        if (this.stream) {
            for (const track of this.stream.getTracks()) track.stop();
            this.stream = null;
        }
    }
}

export interface BargeInTtsOptions extends BargeInListenerOptions {
    /** Called after TTS has been cancelled due to barge-in detection. */
    onBargeIn?: () => void;
}

/**
 * Whether echo cancellation takes this engine's voice out of our mics. It only
 * removes what the browser itself plays: a speechSynthesis voice the OS speaks
 * (Ava, Zoe) reaches every mic of ours at full level. Beside such a voice no
 * barge-in detector can run (either one trips on every sentence's first
 * word), and the mic is closed while she speaks and for PLAYBACK_TAIL_MS
 * after: she can't be interrupted.
 */
export function voiceEchoCancelled(engine: TtsEngine): boolean {
    return !(engine instanceof BrowserTtsEngine && engine.spokenByOs());
}

/**
 * Whether a session hears barge-in on the recognizer's own capture stream
 * (voice-barge-in.md, the engine-driven path), and so keeps that stream
 * listening while the facilitator speaks. Only server-Whisper has one. Not on
 * an iPhone's speaker, whose echo canceller let the facilitator through
 * (meditation-pal-hi6f), and not beside a voice echo cancellation can't
 * remove: Zoe on hosted Parakeet barged in on herself a word or two into
 * every line, and the stream's onset buffer sent those words as the
 * meditator's turn, too short for the transcript echo guard (Chrome,
 * 2026-11-18). There the mic closes while the facilitator speaks.
 *
 * The voice counts at a desktop only. A phone keeps its own rule: its echo
 * canceller may well hear the OS's voice, nothing there was measured with
 * one, and an iPhone with headphones has no echo to hear.
 */
export function bargesInOnOwnStream(o: {
    backend: SttBackend;
    /** A single-owner mic platform (is-desktop.ts isSingleOwnerMicPlatform). */
    phone: boolean;
    iosWeb: boolean;
    iosHeadphones: boolean;
    voiceEchoCancelled: boolean;
}): boolean {
    if (o.backend !== 'server-whisper') return false;
    if (o.iosWeb) return o.iosHeadphones;
    return o.phone || o.voiceEchoCancelled;
}

/** How long after playback ends the mic still hears the facilitator: the
 *  player's tail, a Bluetooth speaker running behind, then the room. Where
 *  the mic is closed while the facilitator speaks, a capture engine opens the
 *  turn with only what it heard after this, so a word said during a phone's
 *  cooldown isn't lost (meditation-pal-qaqb). A guess until an iPhone's
 *  "[vad] after playback" line measures it. */
export const PLAYBACK_TAIL_MS = 250;

/**
 * Before a turn opens after a line in a voice echo cancellation can't remove:
 * wait until PLAYBACK_TAIL_MS past its end, then have a capture engine keep
 * only the onset audio it heard after that. Its stream stays open between
 * turns and the turn opens with the last two seconds it heard
 * (WhisperPcmSttEngine.keepOnsetTail), which can be her last words.
 */
export async function waitOutUncancelledVoice(
    endedAt: number,
    onset: { keepOnsetTail(ms: number): void } | null,
    now: () => number = Date.now
): Promise<void> {
    const wait = endedAt + PLAYBACK_TAIL_MS - now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    onset?.keepOnsetTail(now() - endedAt - PLAYBACK_TAIL_MS);
}

/**
 * Wrap a TtsEngine so each speak() runs a BargeInListener alongside it. When the
 * listener fires, tts.cancel() resolves the in-flight speak(). Pure
 * pass-through otherwise, and for a voice echo cancellation can't remove
 * (asked per utterance, since Chrome lists its voices late).
 */
export function wrapTtsWithBargeIn(
    inner: TtsEngine,
    options: BargeInTtsOptions = {}
): TtsEngine {
    const wrapped: TtsEngine = {
        async speak(text: string, speakOpts?: TtsOptions): Promise<void> {
            if (!voiceEchoCancelled(inner)) return inner.speak(text, speakOpts);
            const listener = new BargeInListener(options);
            await listener.start(() => {
                void inner.cancel();
                if (options.onBargeIn) options.onBargeIn();
            });
            try {
                await inner.speak(text, speakOpts);
            } finally {
                void listener.stop();
            }
        },
        cancel(): Promise<void> {
            return inner.cancel();
        },
        listVoices(): Promise<TtsVoice[]> {
            return inner.listVoices();
        },
    };
    // Only when the inner engine has one: the streaming bridge reads its
    // presence as "synthesis has a round-trip worth getting ahead of".
    if (inner.prefetch) {
        wrapped.prefetch = (text, prefetchOpts) => inner.prefetch!(text, prefetchOpts);
    }
    return wrapped;
}

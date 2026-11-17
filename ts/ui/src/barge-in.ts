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
 * Whether the detector can run beside this engine's voice. Echo cancellation
 * only removes what the browser itself plays: a speechSynthesis voice the OS
 * speaks (Ava) reaches the detector's mic at full level and trips it on
 * every sentence's first word. Such a voice can't be interrupted.
 */
export function bargeInDetectorFits(engine: TtsEngine): boolean {
    return !(engine instanceof BrowserTtsEngine && engine.spokenByOs());
}

/**
 * Wrap a TtsEngine so each speak() runs a BargeInListener alongside it. When the
 * listener fires, tts.cancel() resolves the in-flight speak(). Pure
 * pass-through otherwise, and for a voice the detector doesn't fit.
 */
export function wrapTtsWithBargeIn(
    inner: TtsEngine,
    options: BargeInTtsOptions = {}
): TtsEngine {
    const wrapped: TtsEngine = {
        async speak(text: string, speakOpts?: TtsOptions): Promise<void> {
            if (!bargeInDetectorFits(inner)) return inner.speak(text, speakOpts);
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

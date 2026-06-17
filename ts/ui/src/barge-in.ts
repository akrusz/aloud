/**
 * Barge-in detector — listens for the user starting to speak while TTS
 * is playing, and triggers cancellation.
 *
 * During TTS playback the STT adapter is dormant (the mic stream is
 * released between utterances by the server-Whisper-STT adapter, and
 * the Web Speech / Capacitor STT plugins haven't been start()ed yet).
 * This detector opens a parallel mic stream during TTS so the user can
 * interrupt the facilitator mid-sentence by speaking.
 *
 * The detector does NOT capture the audio that triggered it. After
 * cancellation, the regular listen loop wakes up (busy goes false once
 * TTS resolves) and the user's next utterance is captured normally.
 * In practice users pause ~300ms after interrupting, which the listen
 * loop more than makes up.
 *
 * The threshold/chunk-count constants were tuned in the existing app and
 * work well at typical conversation volume.
 */

const FRAME_SIZE = 4096;
const BARGE_IN_THRESHOLD = 0.04;
const BARGE_IN_REQUIRED_CHUNKS = 3;

export interface BargeInListenerOptions {
    /** RMS energy floor above which a frame counts as the user speaking. */
    threshold?: number;
    /** Consecutive over-threshold frames required to trigger. */
    requiredChunks?: number;
}

export class BargeInListener {
    private readonly threshold: number;
    private readonly requiredChunks: number;
    private context: AudioContext | null = null;
    private stream: MediaStream | null = null;
    private processor: ScriptProcessorNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stopped = false;

    constructor(options: BargeInListenerOptions = {}) {
        this.threshold = options.threshold ?? BARGE_IN_THRESHOLD;
        this.requiredChunks = options.requiredChunks ?? BARGE_IN_REQUIRED_CHUNKS;
    }

    /**
     * Begin listening. Calls `onBargeIn` at most once per start()/stop()
     * cycle, then stops itself so the same callback can't fire repeatedly
     * for a single barge-in event.
     */
    async start(onBargeIn: () => void): Promise<void> {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
            return; // no mic API — silently disabled
        }
        try {
            // echoCancellation keeps the facilitator's own TTS (coming out the
            // speakers) from leaking into this mic and falsely tripping a
            // barge-in — the facilitator interrupting itself. The old app set
            // this on its capture stream; the default {audio:true} doesn't
            // guarantee it, especially in a WebView.
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true },
            });
        } catch {
            return; // mic access denied — silently disabled, TTS plays normally
        }
        if (this.stopped) {
            this.releaseStream();
            return;
        }

        const AC =
            (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
            (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;
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
                    // Stop self — caller will release after TTS cancel.
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

/**
 * Wrap a TtsEngine so that each speak() call runs a BargeInListener in
 * parallel. When the listener fires, the underlying tts.cancel() is
 * called, which makes the in-flight speak() promise resolve. Pure
 * pass-through otherwise — listVoices, voice IDs, options all untouched.
 */
import type { TtsEngine, TtsOptions, TtsVoice } from '../../src/platform/index.js';

export interface BargeInTtsOptions extends BargeInListenerOptions {
    /** Called after TTS has been cancelled due to barge-in detection. */
    onBargeIn?: () => void;
}

export function wrapTtsWithBargeIn(
    inner: TtsEngine,
    options: BargeInTtsOptions = {}
): TtsEngine {
    return {
        async speak(text: string, speakOpts?: TtsOptions): Promise<void> {
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
}

/**
 * Silero VAD (v5) frame classifier — a small neural net (~2 MB ONNX, MIT)
 * running fully client-side over onnxruntime-web's WASM backend. It replaces
 * the absolute RMS-energy thresholds in whisper-pcm-stt.ts as the "is the user
 * speaking" signal: per ~32 ms chunk it emits a speech probability that is
 * robust to quiet mics, soft trailing speech, and breathing — the cases where
 * a fixed energy gate tuned on one device falls over on another (fgbj).
 *
 * Scope: this classifies SPEECH, not SPEAKERS. The facilitator's own TTS
 * leaking into the mic is real speech and scores high — echo rejection stays
 * energy-based (the measured echo gate in whisper-pcm-stt.ts), layered on top.
 *
 * No server involvement: the model and the ort WASM binary ship as static
 * assets (Vite `?url` imports → hashed files in the build, served by GitHub
 * Pages / bundled into the desktop app) and inference runs on-device.
 *
 * This module is loaded lazily (dynamic import from whisper-pcm-stt.ts) so the
 * ort runtime stays out of the main bundle and a load failure anywhere —
 * import, WASM init, model fetch — degrades to the energy VAD in one place.
 */

import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import modelUrl from '@ricky0123/vad-web/dist/silero_vad_v5.onnx?url';

/** Samples per model invocation at 16 kHz (~32 ms) — fixed by Silero v5. */
const CHUNK_SAMPLES = 512;
const MODEL_SAMPLE_RATE = 16_000;
// Speech-probability hysteresis (vad-web's defaults): enter "speaking" at ON,
// leave below OFF, hold the previous state in between. The band is what keeps
// soft trailing speech (which hovers mid-probability) from reading as silence
// the way it does under a hard energy threshold.
const SPEECH_ON = 0.5;
const SPEECH_OFF = 0.35;
// If inference falls this many chunks (~1 s) behind realtime, drop incoming
// chunks rather than queue unboundedly. State continuity suffers a little;
// memory doesn't.
const MAX_PENDING_CHUNKS = 32;

/** The slice of vad-web's Model interface we use (see models/common.d.ts). */
export interface SileroModel {
    process(audioFrame: Float32Array): Promise<{ isSpeech: number; notSpeech: number }>;
    reset_state(): void;
    release(): Promise<void>;
}

export class SileroFrameVad {
    /** Latest hysteresis-debounced speech state. Read each audio frame by the
     *  caller; updated asynchronously as chunks clear inference (sub-ms per
     *  chunk, so at most one ~32 ms chunk stale). */
    speaking = false;
    /** Latest raw speech probability (diagnostics / tuning). */
    lastProb = 0;

    // Streaming resampler state: native-rate residue not yet consumed, and the
    // fractional read position into it (carried across feed() calls so the
    // resampling is phase-continuous at frame boundaries).
    private residue = new Float32Array(0);
    private phase = 0;
    private chunk = new Float32Array(CHUNK_SAMPLES);
    private chunkFill = 0;
    // Inference is serialized (the model is a stateful RNN — chunk order
    // matters), so chunks chain on one promise.
    private queue: Promise<void> = Promise.resolve();
    private pending = 0;
    private dropped = 0;

    constructor(private readonly model: SileroModel) {}

    /** Load ort (WASM backend) + the v5 model. Throws on any failure — the
     *  caller falls back to energy VAD. */
    static async create(): Promise<SileroFrameVad> {
        const ort = await import('onnxruntime-web/wasm');
        // Single-threaded WASM: plenty for this model, and it sidesteps the
        // crossOriginIsolated requirement GitHub Pages can't meet (no custom
        // headers → no COOP/COEP).
        ort.env.wasm.numThreads = 1;
        // The /wasm entry is the *bundle* build (JS loader inlined), so the
        // .wasm binary is the only runtime asset ort needs to locate.
        ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, location.href).href };
        const { SileroV5 } = await import('@ricky0123/vad-web/dist/models/index.js');
        const model = await SileroV5.new(ort, async () => {
            const res = await fetch(modelUrl);
            if (!res.ok) throw new Error(`Silero model fetch failed: ${res.status}`);
            return res.arrayBuffer();
        });
        return new SileroFrameVad(model);
    }

    /**
     * Feed one capture frame at the device's native rate. Resamples to 16 kHz,
     * slices into model-sized chunks, and queues inference; `speaking` /
     * `lastProb` update as results land. Call for every frame while the mic is
     * open — the model's recurrent state assumes a continuous stream.
     */
    feed(frame: Float32Array, nativeRate: number): void {
        const ratio = nativeRate / MODEL_SAMPLE_RATE;
        const nat = new Float32Array(this.residue.length + frame.length);
        nat.set(this.residue);
        nat.set(frame, this.residue.length);

        let pos = this.phase;
        // Linear interpolation needs nat[floor(pos)+1], hence the -1 bound.
        while (pos < nat.length - 1) {
            const low = Math.floor(pos);
            const frac = pos - low;
            this.chunk[this.chunkFill++] = nat[low]! * (1 - frac) + nat[low + 1]! * frac;
            pos += ratio;
            if (this.chunkFill === CHUNK_SAMPLES) {
                this.chunkFill = 0;
                this.enqueue(this.chunk.slice());
            }
        }
        const consumed = Math.floor(pos);
        this.residue = nat.slice(consumed);
        this.phase = pos - consumed;
    }

    /** Chunks dropped due to inference backpressure (diagnostics). */
    get droppedChunks(): number {
        return this.dropped;
    }

    private enqueue(chunk: Float32Array): void {
        if (this.pending >= MAX_PENDING_CHUNKS) {
            this.dropped++;
            return;
        }
        this.pending++;
        this.queue = this.queue
            .then(() => this.model.process(chunk))
            .then((p) => {
                this.lastProb = p.isSpeech;
                if (p.isSpeech >= SPEECH_ON) this.speaking = true;
                else if (p.isSpeech < SPEECH_OFF) this.speaking = false;
            })
            .catch(() => {
                // A single failed inference shouldn't kill the chain; the next
                // chunk proceeds with slightly stale state.
            })
            .finally(() => {
                this.pending--;
            });
    }

    /** Drain in-flight inference and free the ort session. */
    async release(): Promise<void> {
        await this.queue.catch(() => {});
        await this.model.release();
    }
}

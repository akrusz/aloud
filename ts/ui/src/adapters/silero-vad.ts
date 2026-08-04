/**
 * Silero VAD frame classifier - a small neural net (~3 MB ONNX, MIT) run
 * client-side over onnxruntime-web's WASM backend. Replaces the absolute
 * RMS-energy thresholds in whisper-pcm-stt.ts as the "is the user speaking"
 * signal: a per-~32ms speech probability, robust to quiet mics, soft trailing
 * speech, and breathing - where a gate tuned on one device fails on another (fgbj).
 *
 * Classifies SPEECH, not SPEAKERS: the facilitator's own TTS leaking into the
 * mic scores high, so echo rejection stays energy-based (the measured echo gate
 * in whisper-pcm-stt.ts) layered on top.
 *
 * The model is upstream's control-flow-free export, NOT the default one: ONNX
 * `If` nodes are where ort-web's session create dies on some webviews, taking
 * the mic with it (6z11). See assets/README.md before swapping the file.
 *
 * No server involvement - model + ort WASM ship as static assets (Vite `?url`
 * imports) and inference runs on-device. Loaded lazily so the ort runtime stays
 * out of the main bundle, then held as an app-lifetime singleton
 * (loadSileroVad): the setup view preloads it while the user configures and
 * prime()/start() await the same promise, so the download is usually done.
 */

import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import modelUrl from '../assets/silero_vad_op18_ifless.onnx?url';
import type { InferenceSession, Tensor } from 'onnxruntime-web';

type Ort = typeof import('onnxruntime-web/wasm');

/** Samples per model invocation at 16 kHz (~32 ms) - fixed by Silero. */
const CHUNK_SAMPLES = 512;
/** Samples of the *previous* chunk the model sees ahead of each new chunk. The
 *  default Silero export concatenates this internally; the control-flow-free
 *  one we ship (see assets/README.md) expects the caller to do it. */
const CONTEXT_SAMPLES = 64;
const MODEL_SAMPLE_RATE = 16_000;
// Speech-probability hysteresis (Silero's defaults): enter "speaking" at ON,
// leave below OFF, hold in between. The band is what keeps soft trailing speech
// (which hovers mid-probability) from reading as silence.
const SPEECH_ON = 0.5;
const SPEECH_OFF = 0.35;
// Once inference is this many chunks (~1s) behind realtime, drop rather than
// queue unboundedly. Costs a little state continuity, not memory.
const MAX_PENDING_CHUNKS = 32;
// Session create succeeding doesn't prove run() does - the 6z11 ort-web bug
// class is machine-specific and can surface at inference time instead, where
// the per-chunk catch used to swallow it silently: `speaking` stayed false
// forever and the app sat deaf with `VAD: ok` in the diagnostics. After this
// many consecutive run failures (~⅓s of audio) the instance declares itself
// broken so the engine drops to the energy speech decision.
const BROKEN_AFTER_FAILURES = 10;
/** ort's numeric log severity for "error and above" (0 verbose … 4 fatal). */
const SEVERITY_ERROR = 3;

/** What SileroFrameVad needs of the model; the ONNX runner below is the only
 *  real implementation (tests inject fakes). */
export interface SileroModel {
    process(audioFrame: Float32Array): Promise<{ isSpeech: number; notSpeech: number }>;
    reset_state(): void;
    release(): Promise<void>;
}

/** Fresh RNN state: [2, 1, 128] zeros. */
function zeroState(ort: Ort): Tensor {
    return new ort.Tensor('float32', new Float32Array(2 * 128), [2, 1, 128]);
}

/**
 * One ort session driven as a stateful stream: the RNN state and the 64-sample
 * audio context both carry from call to call, so chunks must be fed in order
 * and reset_state() must clear both.
 */
export class SileroRunner implements SileroModel {
    private state: Tensor;
    private context = new Float32Array(CONTEXT_SAMPLES);
    private readonly frame = new Float32Array(CONTEXT_SAMPLES + CHUNK_SAMPLES);
    private readonly sr: Tensor;

    constructor(
        private readonly ort: Ort,
        private readonly session: InferenceSession
    ) {
        this.state = zeroState(ort);
        this.sr = new ort.Tensor('int64', [16_000n]);
    }

    async process(audioFrame: Float32Array): Promise<{ isSpeech: number; notSpeech: number }> {
        this.frame.set(this.context);
        this.frame.set(audioFrame, CONTEXT_SAMPLES);
        this.context = audioFrame.slice(audioFrame.length - CONTEXT_SAMPLES);
        // Copy: ort keeps the backing buffer alive for the async run, and
        // `frame` is reused by the next chunk.
        const input = new this.ort.Tensor('float32', this.frame.slice(), [1, this.frame.length]);
        const out = await this.session.run({ input, state: this.state, sr: this.sr });
        const stateN = out['stateN'];
        if (!stateN) throw new Error('Silero returned no state');
        this.state = stateN;
        const isSpeech = out['output']?.data[0];
        if (typeof isSpeech !== 'number') throw new Error('Silero returned no speech probability');
        return { isSpeech, notSpeech: 1 - isSpeech };
    }

    reset_state(): void {
        this.state = zeroState(this.ort);
        this.context = new Float32Array(CONTEXT_SAMPLES);
    }

    async release(): Promise<void> {
        await this.session.release();
    }
}

/** Create an ort session and prove run() works on it with one silence chunk -
 *  create() succeeding doesn't (6z11 can surface only at inference). The probe
 *  failure path releases the session; the success path resets the state the
 *  probe touched. */
async function probedRunner(
    ort: Ort,
    modelBytes: ArrayBuffer,
    opts: InferenceSession.SessionOptions
): Promise<SileroRunner> {
    const session = await ort.InferenceSession.create(modelBytes, opts);
    const runner = new SileroRunner(ort, session);
    try {
        await runner.process(new Float32Array(CHUNK_SAMPLES));
    } catch (err) {
        await runner.release().catch(() => {});
        throw err;
    }
    runner.reset_state();
    return runner;
}

export class SileroFrameVad {
    /** Latest hysteresis-debounced speech state, read per audio frame by the
     *  caller. Updated as chunks clear inference (sub-ms each, so at most one
     *  ~32ms chunk stale). */
    speaking = false;
    /** Latest raw speech probability (diagnostics / tuning). */
    lastProb = 0;
    /** run() has failed BROKEN_AFTER_FAILURES times in a row - `speaking` can
     *  no longer be trusted and the engine should fall back to energy. */
    broken = false;
    /** Total run() failures this instance (diagnostics). */
    runFailures = 0;
    /** Most recent run() failure message (diagnostics). */
    lastRunError: string | null = null;
    private consecutiveFailures = 0;

    // Streaming resampler state: unconsumed native-rate residue and the
    // fractional read position into it, carried across feed() calls so
    // resampling stays phase-continuous at frame boundaries.
    private residue = new Float32Array(0);
    private phase = 0;
    private chunk = new Float32Array(CHUNK_SAMPLES);
    private chunkFill = 0;
    // Inference is serialized (the model is a stateful RNN - chunk order
    // matters), so chunks chain on one promise.
    private queue: Promise<void> = Promise.resolve();
    private pending = 0;
    private dropped = 0;

    constructor(private readonly model: SileroModel) {}

    /** Load ort (WASM backend) + the model. Throws on any failure. */
    static async create(): Promise<SileroFrameVad> {
        const ort = await import('onnxruntime-web/wasm');
        // Single-threaded WASM: plenty for this model, and it sidesteps the
        // crossOriginIsolated requirement GitHub Pages can't meet (no custom
        // headers → no COOP/COEP).
        ort.env.wasm.numThreads = 1;
        // The /wasm entry is the *bundle* build (JS loader inlined), so the
        // .wasm binary is the only runtime asset ort needs to locate.
        ort.env.wasm.wasmPaths = { wasm: new URL(wasmUrl, location.href).href };
        // The graph optimizer warns (via console.error, ANSI-coloured) about
        // every unused initializer in the Silero model on each load. Harmless,
        // but it lands in the bug-report error log and crowds out real lines.
        // Errors still get through; create failures throw regardless.
        ort.env.logLevel = 'error';
        const res = await fetch(modelUrl);
        if (!res.ok) throw new Error(`Silero model fetch failed: ${res.status}`);
        const modelBytes = await res.arrayBuffer();
        let runner: SileroRunner;
        try {
            runner = await probedRunner(ort, modelBytes, { logSeverityLevel: SEVERITY_ERROR });
        } catch (optErr) {
            // The graph optimizer is where ort-web's webview-specific failures
            // come from (6z11) - sometimes at create(), sometimes only at run()
            // ("Could not find OrtValue with name 'input'": the optimized graph
            // loses its feed mapping while create() reports success, which is
            // why probedRunner runs a chunk before trusting a session). This
            // model is a tiny RNN, so running it unoptimized is imperceptible -
            // far better than degrading to the energy speech decision.
            console.warn(
                '[vad] silero optimized session failed - retrying with graph optimization disabled:',
                optErr
            );
            try {
                runner = await probedRunner(ort, modelBytes, {
                    graphOptimizationLevel: 'disabled',
                    logSeverityLevel: SEVERITY_ERROR,
                });
            } catch (unoptErr) {
                // Surface BOTH failures: this bug class varies by machine
                // ("graph output does not exist" on one webview, "Could not
                // find OrtValue" on another - 6z11) and the first error is
                // what an upstream report needs.
                throw new Error(
                    `ort session failed - optimized: ${errText(optErr)}; ` +
                        `unoptimized: ${errText(unoptErr)}`
                );
            }
        }
        return new SileroFrameVad(runner);
    }

    /**
     * Feed one native-rate capture frame: resamples to 16 kHz, slices into
     * model-sized chunks, queues inference; `speaking`/`lastProb` update as
     * results land. Call for EVERY frame while the mic is open - the model's
     * recurrent state assumes a continuous stream.
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
                this.consecutiveFailures = 0;
                this.lastProb = p.isSpeech;
                if (p.isSpeech >= SPEECH_ON) this.speaking = true;
                else if (p.isSpeech < SPEECH_OFF) this.speaking = false;
            })
            .catch((err) => {
                // A single failed inference shouldn't kill the chain; the next
                // chunk proceeds with slightly stale state. But an unbroken run
                // of failures means inference doesn't work on this machine at
                // all - record it (console.error lands in the bug-report error
                // log) and flag `broken` so the engine stops trusting us.
                this.runFailures++;
                this.lastRunError = errText(err);
                if (++this.consecutiveFailures >= BROKEN_AFTER_FAILURES && !this.broken) {
                    this.broken = true;
                    this.speaking = false;
                    console.error(
                        '[vad] silero inference keeps failing - falling back to energy:',
                        this.lastRunError
                    );
                }
            })
            .finally(() => {
                this.pending--;
            });
    }

    /**
     * Clear streaming state for a fresh capture stream: resampler residue, chunk
     * fill, speech state, and - serialized behind any in-flight chunks - the
     * model's recurrent state.
     */
    reset(): void {
        this.residue = new Float32Array(0);
        this.phase = 0;
        this.chunkFill = 0;
        this.speaking = false;
        this.lastProb = 0;
        this.queue = this.queue
            .then(() => this.model.reset_state())
            .catch(() => {});
    }

    /**
     * One direct inference over a silence chunk - the bug report's "does run()
     * actually work" check, since create() succeeding doesn't prove it (6z11).
     * Serialized behind the live queue so it can't interleave with a streaming
     * chunk; the one silence chunk barely perturbs the recurrent state.
     * Resolves with the speech probability; rejects with the run error.
     */
    probe(): Promise<number> {
        const run = this.queue.then(() => this.model.process(new Float32Array(CHUNK_SAMPLES)));
        this.queue = run.then(
            () => undefined,
            () => undefined
        );
        return run.then((p) => p.isSpeech);
    }

    /** Drain in-flight inference and free the ort session. */
    async release(): Promise<void> {
        await this.queue.catch(() => {});
        await this.model.release();
    }
}

function errText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

// App-lifetime singleton: one ort session for every engine instance. Memoized
// on the promise so concurrent callers (setup preload + the session's prime())
// share one load; cleared on failure so a later session retries.
let pendingLoad: Promise<SileroFrameVad> | null = null;
// Last load failure, kept for the bug-report diagnostics: its VAD probe can
// time out before the real error lands, and this is the machine-specific
// string an ort-web bug report needs.
let lastLoadError: string | null = null;

export function loadSileroVad(): Promise<SileroFrameVad> {
    pendingLoad ??= SileroFrameVad.create().then(
        (vad) => {
            lastLoadError = null;
            return vad;
        },
        (err) => {
            pendingLoad = null;
            lastLoadError = errText(err);
            throw err;
        }
    );
    return pendingLoad;
}

/** The most recent load failure's message, null after a successful load. */
export function sileroLoadError(): string | null {
    return lastLoadError;
}

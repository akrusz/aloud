/**
 * Server-Whisper STT adapter — captures mic audio in the browser, VADs
 * it client-side, sends 16 kHz Float32 PCM to the Flask /api/stt/whisper
 * endpoint, and emits a `final` event when transcription returns.
 *
 * This is the universal fallback: works on Firefox, Safari, and any
 * browser the Web Speech API doesn't cover. Trade-off vs. native /
 * Web Speech: requires a running Flask backend with Whisper.cpp.
 *
 * VAD: RMS-energy threshold over an adaptive noise floor, with an adaptive
 * silence timeout (base + speech×ramp, capped at max). After a short pause it
 * fires a SPECULATIVE transcription and emits it as a `partial` (so the user
 * sees their words during the pause), then submits the `final` once the full
 * adaptive silence elapses — mirroring audio.js's speculative submission.
 *
 * Onset capture: the mic stream, AudioContext, AND the audio callback are
 * opened once and run continuously for the engine's lifetime (only `stop()` —
 * mute / session end — tears them down). The callback keeps an onset pre-buffer
 * ring filled even between turns, so when `start()` flips capture on for a
 * barge-in, the first word — spoken before the facilitator's TTS was even
 * interrupted — is already buffered rather than clipped. `start()` just resets
 * the per-utterance accumulators and seeds them from that pre-buffer.
 */

import type { SttEngine, SttEvent } from '../../../src/platform/stt.js';
import { defaultPacingConfig, type PacingConfig } from '../../../src/facilitation/pacing.js';
import { getCloudSessionId } from '../cloud-session.js';

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SIZE = 4096;
// Short silence (ms) that triggers a speculative transcription mid-utterance —
// so the user sees their words during a pause, before the (longer) adaptive
// silence actually submits the turn. Speculation is skipped when the submit
// threshold is shorter than this (nothing to preview).
const SPECULATIVE_SILENCE_MS = 500;
// ⭐ TWEAK ME if a barge-in clips the first word(s): how much pre-speech audio
// (ms) to retain so a word's onset survives into the captured utterance. It
// covers the gap between starting to speak over the facilitator and barge-in
// detection flipping capture on — the onset is lost in that window otherwise.
// Bigger = more onset captured (and more harmless leading near-silence sent to
// Whisper); smaller = tighter. Raise this number if words still get clipped.
const PRE_BUFFER_MS = 2000;
// Barge-in detection runs on THIS (continuous, echo-cancelled) stream rather
// than a second getUserMedia stream — on macOS the hardware AEC attaches to
// only one input, so a separate detector stream hears raw TTS echo and trips on
// the facilitator's own voice. The capture stream's echo measures ~0.005 RMS,
// real speech ~0.04+, so a 0.03 gate cleanly separates them. (d35)
const BARGE_IN_THRESHOLD = 0.03;
const BARGE_IN_REQUIRED_CHUNKS = 3;

/** The subset of PacingConfig fields the VAD here cares about. */
type VadFields = Pick<
    PacingConfig,
    'silenceBaseMs' | 'silenceMaxMs' | 'silenceRampRate' | 'minSpeechDurationMs'
>;

export interface CloudWhisperSttEngineOptions extends Partial<VadFields> {
    /** Endpoint URL. Default '/api/stt/whisper' — Vite proxies in dev. */
    endpointUrl?: string;
    /** RMS energy floor below which a frame is counted as silence. */
    energyThreshold?: number;
    /** Hard cap on a single utterance — auto-submit after this. */
    maxUtteranceMs?: number;
    /** Custom fetch (tests). */
    fetchImpl?: typeof fetch;
    /** When present, each transcription request carries `Authorization: Bearer
     *  <token>`. Used to target the aloud cloud's authed /v1/stt (vs the
     *  open Flask /api/stt/whisper). Returning null sends no auth header. */
    authProvider?: () => Promise<string | null>;
}

export class CloudWhisperSttEngine implements SttEngine {
    private readonly opts: Required<
        Omit<CloudWhisperSttEngineOptions, 'fetchImpl' | 'authProvider'>
    > & {
        fetchImpl: typeof fetch;
        authProvider: (() => Promise<string | null>) | null;
    };
    private context: AudioContext | null = null;
    private stream: MediaStream | null = null;
    private processor: ScriptProcessorNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stopRequested = false;

    // Continuous capture state — the audio callback runs across turns, so this
    // lives on the instance (not in a start()-scoped closure).
    private capturing = false;
    private noiseFloor = 0.005;
    private noiseSamples = 0;
    private preBuffer: Float32Array[] = [];
    private preBufferFrames = 0;
    // Per-utterance accumulators, reset at the top of each start().
    private chunks: Float32Array[] = [];
    private speechStarted = false;
    private speechStartMs = 0;
    private lastSpeechMs = 0;
    private utteranceDone = false;
    // Barge-in detection on the continuous (echo-cancelled) idle stream.
    private bargeInHandler: (() => void) | null = null;
    private bargeInChunks = 0;
    private bargeInFired = false;

    constructor(options: CloudWhisperSttEngineOptions = {}) {
        this.opts = {
            endpointUrl: options.endpointUrl ?? '/app/v1/stt/whisper',
            energyThreshold: options.energyThreshold ?? 0.015,
            silenceBaseMs: options.silenceBaseMs ?? defaultPacingConfig.silenceBaseMs,
            silenceMaxMs: options.silenceMaxMs ?? defaultPacingConfig.silenceMaxMs,
            silenceRampRate: options.silenceRampRate ?? defaultPacingConfig.silenceRampRate,
            // STT min-speech can be looser than facilitation min-speech;
            // adopt the PacingConfig default but allow caller override.
            minSpeechDurationMs:
                options.minSpeechDurationMs ?? defaultPacingConfig.minSpeechDurationMs,
            maxUtteranceMs: options.maxUtteranceMs ?? 30_000,
            fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
            authProvider: options.authProvider ?? null,
        };
    }

    /**
     * Whether mic capture is plausibly available. We can't probe the
     * server here without a request — that's the caller's problem.
     */
    static isAvailable(): boolean {
        return (
            typeof navigator !== 'undefined' &&
            !!navigator.mediaDevices?.getUserMedia &&
            (typeof AudioContext !== 'undefined' ||
                typeof (globalThis as unknown as { webkitAudioContext?: unknown })
                    .webkitAudioContext !== 'undefined')
        );
    }

    /** Keep the onset pre-buffer ring filled with the most recent frame. */
    private pushPre(frame: Float32Array): void {
        this.preBuffer.push(frame);
        if (this.preBuffer.length > this.preBufferFrames) this.preBuffer.shift();
    }

    /** Continuous audio callback — runs for the engine's whole lifetime. */
    private handleAudio = (e: AudioProcessingEvent): void => {
        if (this.stopRequested) return;
        const data = e.inputBuffer.getChannelData(0);
        const frame = new Float32Array(data);
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
        const energy = Math.sqrt(sum / frame.length);
        const now = performance.now();

        // Between turns (including while the facilitator is speaking): keep the
        // onset pre-buffer warm so a barge-in's first word is already captured.
        // Don't fold this audio into the noise floor — it may be TTS echo, which
        // would inflate the ambient estimate and desensitize the VAD.
        if (!this.capturing) {
            this.pushPre(frame);
            // Barge-in: while idle (the facilitator is speaking), watch this
            // echo-cancelled stream for the user's voice. TTS echo sits ~0.005
            // here so it won't trip the 0.03 gate; sustained real speech does.
            // Fires once per idle period — start() re-arms it.
            if (this.bargeInHandler && !this.bargeInFired) {
                if (energy > BARGE_IN_THRESHOLD) {
                    if (++this.bargeInChunks >= BARGE_IN_REQUIRED_CHUNKS) {
                        this.bargeInFired = true;
                        this.bargeInHandler();
                    }
                } else {
                    this.bargeInChunks = 0;
                }
            }
            return;
        }
        if (this.utteranceDone) return;

        // Threshold is whichever is higher: the static floor, or 3x the running
        // noise floor. The 3x multiplier matches the existing audio.js heuristic
        // and gives reliable separation in normal rooms.
        const threshold = Math.max(this.opts.energyThreshold, this.noiseFloor * 3);

        if (energy > threshold) {
            if (!this.speechStarted) {
                this.speechStarted = true;
                this.speechStartMs = now;
                // Prepend the retained onset ramp, then clear it.
                for (const f of this.preBuffer) this.chunks.push(f);
                this.preBuffer.length = 0;
            }
            this.lastSpeechMs = now;
            this.chunks.push(frame);
        } else if (this.speechStarted) {
            this.chunks.push(frame);
            // Adaptive silence: each ms of speech buys silenceRampRate ms of
            // additional patience, capped at silenceMaxMs.
            const speechDur = this.lastSpeechMs - this.speechStartMs;
            const needed = Math.min(
                this.opts.silenceBaseMs + speechDur * this.opts.silenceRampRate,
                this.opts.silenceMaxMs
            );
            if (now - this.lastSpeechMs >= needed) this.utteranceDone = true;
        } else {
            // Capturing but pre-speech — calibrate the noise floor (fast for the
            // first 100 samples, then slow) and keep the onset pre-buffer warm.
            const alpha = this.noiseSamples < 100 ? 0.1 : 0.01;
            this.noiseFloor = (1 - alpha) * this.noiseFloor + alpha * energy;
            this.noiseSamples++;
            this.pushPre(frame);
        }

        if (this.speechStarted && now - this.speechStartMs >= this.opts.maxUtteranceMs) {
            this.utteranceDone = true;
        }
    };

    /**
     * Open the mic stream, AudioContext, and continuous audio graph if they
     * aren't already up. Idempotent — reuses a live stream / context /
     * processor across turns (re-acquiring is the expensive step that used to
     * clip a barge-in's first second). Throws on mic-permission denial or a
     * missing AudioContext. Shared by start() and prime().
     */
    private async ensureCaptureGraph(): Promise<void> {
        if (!this.stream || !this.stream.active) {
            // echoCancellation matters here beyond the usual reasons: this
            // stream stays live across turns (see the class header), so it's
            // the one filling the onset pre-buffer WHILE the facilitator's TTS
            // is playing. Without EC, that pre-buffer captures the TTS coming
            // out of the speakers, and a barge-in would prepend the
            // facilitator's own words to the user's interrupting utterance
            // before sending it to Whisper. EC cancels that speaker echo and
            // keeps the user's (near-end) onset. Matches the barge-in detector
            // stream (barge-in.ts) and the old audio.js capture.
            this.stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: true },
            });
            this.teardownGraph(); // any prior nodes belong to a dead stream
        }

        const AC =
            (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
            (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;
        if (!AC) throw new Error('AudioContext unavailable');
        if (!this.context || this.context.state === 'closed') {
            this.teardownGraph();
            this.context = new AC();
            // Keep the context running for its whole lifetime. It stays alive
            // BETWEEN turns (while the facilitator's TTS plays) to fill the
            // onset pre-buffer — but the OS/browser can suspend it during that
            // idle window (backgrounding, autoplay policy, audio-focus loss).
            // If it does, the ScriptProcessor stops firing, the pre-buffer goes
            // stale, and a barge-in's first word is lost. Re-resume on any
            // suspend until we explicitly stop().
            this.context.addEventListener('statechange', () => {
                if (!this.stopRequested && this.context && this.context.state === 'suspended') {
                    this.context.resume().catch(() => {});
                }
            });
        }
        // Autoplay policies can leave the context suspended; resume so the
        // ScriptProcessor actually receives audio.
        if (this.context.state === 'suspended') {
            try {
                await this.context.resume();
            } catch {
                /* best effort */
            }
        }

        // Wire the continuous audio graph once; it stays alive across turns so
        // the pre-buffer keeps filling even while the facilitator speaks.
        if (!this.processor) {
            const nativeRate = this.context.sampleRate;
            this.preBufferFrames = Math.max(
                1,
                Math.round((PRE_BUFFER_MS / 1000) * nativeRate / FRAME_SIZE)
            );
            this.source = this.context.createMediaStreamSource(this.stream);
            // ScriptProcessorNode is deprecated in favour of AudioWorklet, but
            // it's a one-liner and still works everywhere. Migrate later.
            this.processor = this.context.createScriptProcessor(FRAME_SIZE, 1, 1);
            this.processor.onaudioprocess = this.handleAudio;
            this.source.connect(this.processor);
            this.processor.connect(this.context.destination);
        }
    }

    /**
     * Pre-open the capture graph so the onset pre-buffer starts filling BEFORE
     * the first start() — e.g. during the opening greeting — so a barge-in on
     * the very first facilitator turn isn't clipped. Best-effort: if the mic
     * isn't grantable yet, start() will retry and surface the error. Leaves
     * capturing=false, so no utterance begins and no events are emitted.
     */
    async prime(): Promise<void> {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
        this.stopRequested = false;
        try {
            await this.ensureCaptureGraph();
        } catch {
            /* best-effort priming; start() will retry + report the error */
        }
    }

    /**
     * Register (or clear, with null) a barge-in callback. Fired when the user's
     * voice is detected on the continuous capture stream while idle (i.e. while
     * the facilitator is speaking) — used to cancel TTS. Detecting here, on the
     * one echo-cancelled stream, avoids a second mic stream that would hear raw
     * TTS echo and trip on the facilitator itself. (d35)
     */
    setBargeInHandler(handler: (() => void) | null): void {
        this.bargeInHandler = handler;
    }

    async *start(): AsyncIterable<SttEvent> {
        this.stopRequested = false;
        try {
            await this.ensureCaptureGraph();
        } catch (err) {
            yield { type: 'error', error: err };
            return;
        }
        const nativeRate = this.context!.sampleRate;

        // Begin a fresh utterance. The pre-buffer + noise floor persist (warmed
        // between turns); only the per-utterance accumulators reset.
        this.chunks = [];
        this.speechStarted = false;
        this.speechStartMs = 0;
        this.lastSpeechMs = 0;
        this.utteranceDone = false;
        // Re-arm barge-in detection for the next idle period (after this turn
        // ends and the facilitator speaks again).
        this.bargeInFired = false;
        this.bargeInChunks = 0;
        this.capturing = true;

        // Transcribe a snapshot of captured frames via the Whisper endpoint —
        // used for both speculative interim passes and the final submission.
        const transcribeChunks = async (
            frames: readonly Float32Array[]
        ): Promise<
            { ok: true; text: string; seconds: number } | { ok: false; error: unknown }
        > => {
            const combined = concatFloat32(frames as Float32Array[]);
            const downsampled =
                nativeRate === TARGET_SAMPLE_RATE
                    ? combined
                    : downsampleLinear(combined, nativeRate, TARGET_SAMPLE_RATE);
            try {
                const headers: Record<string, string> = {
                    'content-type': 'application/octet-stream',
                };
                if (this.opts.authProvider) {
                    const token = await this.opts.authProvider();
                    if (token) headers['authorization'] = `Bearer ${token}`;
                }
                // Tag the transcription with the session group when one is active
                // (cloud cost report); omitted otherwise. Flask's STT ignores it.
                const sessionId = getCloudSessionId();
                const sessionParam = sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : '';
                const response = await this.opts.fetchImpl(
                    `${this.opts.endpointUrl}?sample_rate=${TARGET_SAMPLE_RATE}${sessionParam}`,
                    {
                        method: 'POST',
                        headers,
                        body: downsampled.buffer.slice(
                            downsampled.byteOffset,
                            downsampled.byteOffset + downsampled.byteLength
                        ) as ArrayBuffer,
                    }
                );
                if (!response.ok) {
                    const detail = await response.text().catch(() => '');
                    return {
                        ok: false,
                        error: new Error(`Whisper endpoint ${response.status}: ${detail}`),
                    };
                }
                const data = (await response.json()) as { text?: string; error?: string };
                if (data.error !== undefined) return { ok: false, error: new Error(data.error) };
                return {
                    ok: true,
                    text: (data.text ?? '').trim(),
                    seconds: downsampled.length / TARGET_SAMPLE_RATE,
                };
            } catch (err) {
                return { ok: false, error: err };
            }
        };

        try {
            // Poll while capturing. A short pause (SPECULATIVE_SILENCE_MS) fires
            // a speculative transcription so the user sees their words during
            // the pause (a partial, shown with the "…" marker); the adaptive
            // `needed` silence (set in the audio callback) ends the turn. Each
            // speculative pass re-transcribes the growing buffer.
            let lastSpecChunkCount = 0;
            let specInFlight = false;
            // Did we already show the user a real (non-empty) speculative
            // transcript? If so we must finalize the turn even if it's short —
            // otherwise the preview bubble appears and then vanishes with the
            // turn silently dropped (a deliberate one-word "alright" hits this).
            let emittedPartial = false;
            while (!this.utteranceDone && !this.stopRequested) {
                await new Promise<void>((r) => setTimeout(r, 200));
                if (this.utteranceDone || this.stopRequested) break;
                if (!this.speechStarted) continue;
                const silence = performance.now() - this.lastSpeechMs;
                if (
                    silence >= SPECULATIVE_SILENCE_MS &&
                    !specInFlight &&
                    this.chunks.length > lastSpecChunkCount
                ) {
                    specInFlight = true;
                    lastSpecChunkCount = this.chunks.length;
                    const result = await transcribeChunks(this.chunks.slice());
                    specInFlight = false;
                    // Drop the preview if the turn ended while it was in flight
                    // (the final pass will emit the authoritative text).
                    if (!this.utteranceDone && result.ok && result.text) {
                        emittedPartial = true;
                        yield { type: 'partial', text: result.text };
                    }
                }
            }

            if (this.stopRequested && !this.utteranceDone) {
                return; // user explicitly stopped before end-of-speech
            }
            if (!this.speechStarted) return;

            const speechDuration = this.lastSpeechMs - this.speechStartMs;
            // Too short to be speech — likely a cough or mic bump — so skip the
            // (billable) final pass. But if we already showed a real preview,
            // honor it and finalize anyway: the user saw their word land and a
            // deliberate short utterance ("alright", "okay") is a real turn.
            // Genuine noise that slipped through is still caught downstream by
            // isNonSpeechOnly, which drops marker-only transcripts.
            if (speechDuration < this.opts.minSpeechDurationMs && !emittedPartial) {
                return;
            }

            const result = await transcribeChunks(this.chunks);
            if (!result.ok) {
                yield { type: 'error', error: result.error };
                return;
            }
            // Billable server-side STT compute — report the transcribed audio
            // duration (16 kHz mono) for session usage tracking. Only the final
            // pass is counted; speculative passes aren't, to keep the tally
            // simple (revisit if a hosted cloud-STT meters speculation).
            yield { type: 'final', text: result.text, seconds: result.seconds };
        } finally {
            // End the turn but keep the stream, context, and callback alive —
            // the pre-buffer keeps filling for a low-latency next turn / barge-in.
            // Full teardown only on stop().
            this.capturing = false;
        }
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        this.capturing = false;
        this.releaseAll();
    }

    /** Tear down the audio graph nodes; leaves the stream + context. */
    private teardownGraph(): void {
        if (this.processor) {
            try {
                this.processor.disconnect();
            } catch {
                // already disconnected
            }
            this.processor.onaudioprocess = null;
            this.processor = null;
        }
        if (this.source) {
            try {
                this.source.disconnect();
            } catch {
                // already disconnected
            }
            this.source = null;
        }
    }

    /** Full teardown: graph nodes + the context and mic stream, and reset the
     *  continuous capture state so a later start() begins clean. */
    private releaseAll(): void {
        this.teardownGraph();
        if (this.context && this.context.state !== 'closed') {
            this.context.close().catch(() => {});
        }
        this.context = null;
        this.releaseStream();
        this.preBuffer = [];
        this.noiseFloor = 0.005;
        this.noiseSamples = 0;
    }

    private releaseStream(): void {
        if (this.stream) {
            for (const track of this.stream.getTracks()) track.stop();
            this.stream = null;
        }
    }
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

function downsampleLinear(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return buffer;
    const ratio = fromRate / toRate;
    const newLen = Math.round(buffer.length / ratio);
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
        const src = i * ratio;
        const low = Math.floor(src);
        const high = Math.min(low + 1, buffer.length - 1);
        const frac = src - low;
        out[i] = buffer[low]! * (1 - frac) + buffer[high]! * frac;
    }
    return out;
}

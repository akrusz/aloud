/**
 * Whisper-over-HTTP STT: captures mic audio, VADs it client-side, POSTs 16 kHz
 * Float32 PCM to a Whisper endpoint, emits `final` on transcription. Endpoint-
 * agnostic - the same pipeline drives desktop Whisper (/app/v1/stt/whisper) and
 * aloud cloud (/cloud/v1/stt); only the URL + optional bearer token differ (see
 * stt-picker.ts). Universal fallback where Web Speech doesn't reach (Firefox,
 * Safari).
 *
 * Silero v5 (silero-vad.ts) is the speech signal; RMS energy is demoted to the
 * echo reference, since Silero scores the facilitator's own TTS echo as speech.
 * If Silero's ONNX session can't be created on this machine (an ort-web graph
 * bug class that varies by webview - 6z11), the engine degrades to the energy
 * speech decision (FALLBACK_ENERGY_THRESHOLD) instead of losing the mic.
 * Capture (stream, context, callback) runs continuously for the engine's
 * lifetime - only stop() tears it down - so the onset pre-buffer stays warm and
 * a barge-in's first word isn't clipped. A short pause fires a speculative pass
 * emitted as a `partial`; the full adaptive silence window submits the `final`.
 */

import type { SttEngine, SttEvent } from '../../../src/platform/stt.js';
import { defaultPacingConfig, type PacingConfig } from '../../../src/facilitation/pacing.js';
import { transcriptLooksIncomplete } from '../../../src/facilitation/end-of-turn.js';
import { getCloudSessionId } from '../cloud-session.js';
import { withTimeout } from '../net-timeout.js';
import { ensureMicPermission } from '../mic-permission.js';
// Type-only: dynamic-imported in acquireSilero() so the ort runtime + model
// assets stay out of the main bundle (and out of node-env tests).
import type { SileroFrameVad } from './silero-vad.js';

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SIZE = 4096;
// Dead-server cap on the transcription POST - an endpoint that accepts the
// audio then hangs would leave the mic stuck "processing" forever. The listen
// loop already retries a rejected transcription. Any real utterance is far
// quicker than this.
const TRANSCRIBE_TIMEOUT_MS = 45_000;
// Pause (ms) that fires a speculative transcription so the user sees their
// words mid-utterance. Skipped when the submit threshold is shorter (nothing to
// preview). 750 (not 500) trims false trips on between-phrase breaths while
// staying well inside the 3s+ submit window (pacing silenceBaseMs).
const SPECULATIVE_SILENCE_MS = 750;
// ⭐ TWEAK ME if a barge-in clips the first word(s): pre-speech audio (ms) kept
// so a word's onset survives, covering the gap between speaking over the
// facilitator and barge-in flipping capture on. Bigger = more onset captured
// (plus harmless leading near-silence sent to Whisper).
const PRE_BUFFER_MS = 2000;
// Barge-in runs on THIS (continuous, echo-cancelled) stream, not a second
// getUserMedia stream: on macOS the hardware AEC attaches to only one input, so
// a separate detector hears raw TTS echo and trips on the facilitator's own
// voice. Echo here measures ~0.005 RMS, real speech ~0.04+, so 0.03 separates
// them cleanly. (d35)
const BARGE_IN_THRESHOLD = 0.03;
const BARGE_IN_REQUIRED_CHUNKS = 3;

// Per-device echo calibration. Continuous capture leaves the mic armed while
// the facilitator speaks, so on weak-AEC hardware the echo could clear the
// VAD/barge-in gates as a phantom user turn. Echo level varies a lot by device,
// so we MEASURE it: energy captured while TTS plays and the user is silent IS
// this device's echo floor (slow EMA), gated out during playback only.
//
// Starting points, tune against real hardware. MARGIN: headroom over the
// measured average, for echo peaks. GATE_MAX: ceiling so the gate can't climb
// into real-speech territory (~0.04+) and swallow speech. ALPHA: EMA smoothing,
// low enough that a little user speech during calibration barely moves it.
const ECHO_EMA_ALPHA = 0.05;
const ECHO_GATE_MARGIN = 2.0;
const ECHO_GATE_MAX = 0.035;

// Energy-only speech decision, active ONLY while the Silero session is
// unavailable (create failed - 6z11). This is the absolute-RMS gate Silero
// replaced (fgbj): a frame is speech when it clears the max of this static
// floor, 3x the adaptive noise floor, and the echo gates. Worse endpointing on
// quiet mics and soft trailing speech - but a VAD load failure must degrade
// the mic, never kill it.
const FALLBACK_ENERGY_THRESHOLD = 0.015;
const NOISE_FLOOR_SEED = 0.005;

// Extra silence (ms) when the speculative transcript ends in a dangling clause
// ("...never had a bad time doing") - the speaker is likely mid-thought
// (meditation-pal-fxo1). The gate-immune cutoff defense: macOS's noise gate can
// hard-zero soft trailing speech so the VAD sees a perfect pause, but the
// unfinished clause survives in the transcript. Stacks on the adaptive ramp,
// re-evaluated each speculative pass.
const INCOMPLETE_CLAUSE_EXTRA_MS = 4000;

// Tail-recovery thresholds (meditation-pal-rcdz). Frames keep accumulating
// after the last speculative pass; if any look even slightly speech-like, the
// cached transcript may be missing trailing words ("...in my belly" spoken too
// softly to move lastSpeechMs), so the final pass re-sends the full buffer.
// Deliberately below the VAD's own gates: a false positive costs one extra
// transcription, a false negative costs the user's words.
const TAIL_RETRANSCRIBE_PROB = 0.4;
const TAIL_RETRANSCRIBE_ENERGY = 0.015;

/** The subset of PacingConfig fields the VAD here cares about. */
type VadFields = Pick<
    PacingConfig,
    'silenceBaseMs' | 'silenceMaxMs' | 'silenceRampRate' | 'minSpeechDurationMs'
>;

export interface WhisperPcmSttEngineOptions extends Partial<VadFields> {
    /** Endpoint URL. Default '/app/v1/stt/whisper' - Vite proxies in dev. */
    endpointUrl?: string;
    /** Capture device id (Settings → Microphone); null/absent = system
     *  default. Applied as `ideal`, so a saved-but-unplugged device falls back
     *  to the default rather than failing getUserMedia. */
    micDeviceId?: string | null;
    /** Local-Whisper model size + language, sent as query params so the
     *  desktop shell loads the matching whisper.cpp model. Only the local
     *  endpoint understands these - leave unset for aloud cloud. */
    whisperModelSize?: string | null;
    language?: string | null;
    /** Hosted-model override, sent as a `model` query param the cloud /stt
     *  route validates against its backend's allowlist (e.g. 'gpt-transcribe').
     *  Cloud endpoint only - leave unset for the desktop endpoint and for the
     *  server-default model. */
    cloudModel?: string | null;
    /** Hard cap on a single utterance - auto-submit after this. Default 120s.
     *  A runaway valve (background speech can hold the VAD open forever), NOT a
     *  conversational boundary: it cuts mid-sentence and the post-cut hole grows
     *  with buffer length (only the 2s pre-buffer survives the final pass's
     *  latency), so it must sit well past any real ramble. Raising it mostly
     *  costs final-pass latency at submit. */
    maxUtteranceMs?: number;
    /** Custom fetch (tests). */
    fetchImpl?: typeof fetch;
    /** When present, each request carries `Authorization: Bearer <token>` - for
     *  the cloud's authed /cloud/v1/stt vs the open desktop endpoint. Returning
     *  null sends no auth header. */
    authProvider?: () => Promise<string | null>;
    /** Called once on a 401 to invalidate a stale token before a single retry.
     *  Matches the cloud LLM/TTS self-heal; without it an expired or
     *  secret-rotated token fails every hosted transcription for the page
     *  lifetime. Wire to clearCloudToken for the hosted engine. */
    onAuthError?: () => Promise<void>;
}

export class WhisperPcmSttEngine implements SttEngine {
    private readonly opts: Required<
        Omit<WhisperPcmSttEngineOptions, 'fetchImpl' | 'authProvider' | 'onAuthError'>
    > & {
        fetchImpl: typeof fetch;
        authProvider: (() => Promise<string | null>) | null;
        onAuthError: (() => Promise<void>) | null;
    };
    private context: AudioContext | null = null;
    private stream: MediaStream | null = null;
    private processor: ScriptProcessorNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stopRequested = false;

    // Continuous capture state - the audio callback runs across turns, so this
    // lives on the instance, not in a start()-scoped closure.
    private capturing = false;
    private preBuffer: Float32Array[] = [];
    private preBufferFrames = 0;
    // Per-utterance accumulators, reset at the top of each start().
    private chunks: Float32Array[] = [];
    private speechStarted = false;
    // Did this utterance's speech begin while TTS was audibly playing? Yielded
    // on partial/final so the session's transcript echo guard can judge by
    // speech START time - arrival time is useless, since VAD silence plus
    // transcription latency delay it by seconds.
    private startedWhileTtsActive = false;
    private speechStartMs = 0;
    private lastSpeechMs = 0;
    private utteranceDone = false;
    // Debounced speech detected AFTER the submit decision, while the final
    // transcription was in flight - start() reopens the utterance.
    private postSubmitSpeech = false;
    // Loudest speech frame this utterance - diagnostic (how loud this user/mic
    // runs; informs the echo-gate margins).
    private peakEnergy = 0;
    // Latest speculative transcript ends in a dangling clause. Set by the
    // polling loop in start(), read by the audio callback to extend the silence
    // window (INCOMPLETE_CLAUSE_EXTRA_MS).
    private partialIncomplete = false;
    // A speculative transcription is mid-flight. The audio callback won't
    // finalize while true, so the dangling-clause verdict always lands before
    // submit - otherwise a slow network pass lets the adaptive window cut the
    // turn first, which is the cloud-STT mid-sentence cutoff (kkiz). The
    // maxUtterance runaway valve is deliberately NOT gated on this.
    private specInFlight = false;
    // Rolling per-frame energy + neural prob (-1 when Silero is off), ~85ms per
    // frame at 48 kHz, for the submit diagnostic: peak/threshold alone can't
    // show what the detector heard during the trailing "silence" (soft speech
    // vs breath vs true quiet), which is the whole tuning question.
    private energyHistory: { t: number; e: number; p: number }[] = [];
    // Barge-in detection on the continuous (echo-cancelled) idle stream.
    private bargeInHandler: (() => void) | null = null;
    private bargeInChunks = 0;
    private bargeInFired = false;
    // Per-device echo calibration (see ECHO_* constants). The caller sets
    // ttsActive while the facilitator's audio actually plays; echoFloor is the
    // EMA of capture energy measured during those windows, seeded with the
    // typical echo-cancelled level so the gate is sane from the first frame.
    private ttsActive = false;
    private echoFloor = 0.005;
    // The shared Silero VAD (loadSileroVad), acquired by prime()/start(). Null
    // while capturing means the load failed and the energy fallback is the
    // speech signal (isSpeechFrame).
    private silero: SileroFrameVad | null = null;
    // Energy-fallback state: adaptive noise floor, an EMA of quiet capturing
    // frames. Persists across turns like echoFloor - the room doesn't reset
    // between utterances.
    private noiseFloor = NOISE_FLOOR_SEED;
    private noiseSamples = 0;
    // Mic input-level listener (the session view's mic-button ring), fed from
    // this engine's frames so the UI never opens a second mic stream: on macOS
    // the voice-processing unit attaches to ONE input, and a competing capture
    // can glitch or hard-zero this one (suspected cause of mid-utterance
    // digital-zero dropouts).
    private levelListener: ((rms: number) => void) | null = null;
    // Device sample rate, cached for the audio callback (feeds the resampler).
    private nativeRate = 48_000;

    constructor(options: WhisperPcmSttEngineOptions = {}) {
        this.opts = {
            endpointUrl: options.endpointUrl ?? '/app/v1/stt/whisper',
            micDeviceId: options.micDeviceId ?? null,
            whisperModelSize: options.whisperModelSize ?? null,
            language: options.language ?? null,
            cloudModel: options.cloudModel ?? null,
            silenceBaseMs: options.silenceBaseMs ?? defaultPacingConfig.silenceBaseMs,
            silenceMaxMs: options.silenceMaxMs ?? defaultPacingConfig.silenceMaxMs,
            silenceRampRate: options.silenceRampRate ?? defaultPacingConfig.silenceRampRate,
            // STT min-speech can be looser than facilitation min-speech;
            // adopt the PacingConfig default but allow caller override.
            minSpeechDurationMs:
                options.minSpeechDurationMs ?? defaultPacingConfig.minSpeechDurationMs,
            maxUtteranceMs: options.maxUtteranceMs ?? 120_000,
            fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
            authProvider: options.authProvider ?? null,
            onAuthError: options.onAuthError ?? null,
        };
    }

    /** Await the shared Silero instance, starting the load if the setup view's
     *  preload didn't. Resets its streaming state on first adopt - a fresh
     *  capture stream shouldn't inherit a previous session's recurrent state.
     *  A load failure leaves `silero` null - the energy fallback takes over
     *  for this utterance, and the next start() retries the load (loadSileroVad
     *  clears its memo on failure). */
    private async acquireSilero(): Promise<void> {
        try {
            const { loadSileroVad } = await import('./silero-vad.js');
            const vad = await loadSileroVad();
            if (this.silero !== vad) {
                vad.reset();
                this.silero = vad;
            }
        } catch (err) {
            this.silero = null;
            console.warn('[vad] silero unavailable - using the energy speech decision:', err);
        }
    }

    /** Whether mic capture is plausibly available. Probing the server needs a
     *  request, so that's the caller's problem. */
    static isAvailable(): boolean {
        return (
            typeof navigator !== 'undefined' &&
            !!navigator.mediaDevices?.getUserMedia &&
            (typeof AudioContext !== 'undefined' ||
                typeof (globalThis as unknown as { webkitAudioContext?: unknown })
                    .webkitAudioContext !== 'undefined')
        );
    }

    /** True while the user is mid-utterance (speech detected, turn not yet
     *  submitted). Lets the session view suppress silence check-ins that would
     *  talk over the user - the pacing controller only sees COMPLETED turns. */
    get userSpeechActive(): boolean {
        return this.capturing && this.speechStarted && !this.utteranceDone;
    }

    /** Register (or clear, with null) a per-frame mic-level listener - RMS of
     *  each ~85ms frame, whenever the mic is open. Lets the UI render an input
     *  meter without opening its own mic stream. */
    setLevelListener(listener: ((rms: number) => void) | null): void {
        this.levelListener = listener;
    }

    /** Keep the onset pre-buffer ring filled with the most recent frame. */
    private pushPre(frame: Float32Array): void {
        this.preBuffer.push(frame);
        if (this.preBuffer.length > this.preBufferFrames) this.preBuffer.shift();
    }

    /** Per-frame speech decision. With the model up: Silero's debounced
     *  verdict, plus barge-in-grade energy while TTS plays (echo IS speech to
     *  Silero, so speaker separation needs the energy reference - 8h1x).
     *  Degraded (silero null): the energy gate over the adaptive noise floor. */
    private isSpeechFrame(energy: number, echoGate: number): boolean {
        if (this.silero) {
            return (
                this.silero.speaking &&
                (echoGate === 0 || energy > Math.max(echoGate, BARGE_IN_THRESHOLD))
            );
        }
        let threshold = Math.max(FALLBACK_ENERGY_THRESHOLD, this.noiseFloor * 3);
        if (echoGate > 0) threshold = Math.max(threshold, echoGate, BARGE_IN_THRESHOLD);
        return energy > threshold;
    }

    /** Continuous audio callback - runs for the engine's whole lifetime. */
    private handleAudio = (e: AudioProcessingEvent): void => {
        if (this.stopRequested) return;
        const data = e.inputBuffer.getChannelData(0);
        const frame = new Float32Array(data);
        let sum = 0;
        for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
        const energy = Math.sqrt(sum / frame.length);
        const now = performance.now();

        this.levelListener?.(energy);

        // Feed the neural VAD every frame, capturing or not - its recurrent
        // state assumes an unbroken stream, and classifying during idle keeps
        // `speaking` current for the moment capture flips on.
        this.silero?.feed(frame, this.nativeRate);

        // While TTS is audible, lift the gates above this device's measured echo
        // floor. Zero otherwise (no echo to reject), so a silent gap keeps the
        // normal sensitive thresholds. Capped below real-speech level.
        const echoGate = this.ttsActive
            ? Math.min(this.echoFloor * ECHO_GATE_MARGIN, ECHO_GATE_MAX)
            : 0;

        // Barge-in: watch this stream for the user's voice. Runs in BOTH idle
        // and capturing states - continuous capture keeps the mic armed across
        // turns, so a barge-in can arrive with capturing=true. Fires once per
        // start()/utterance; start() re-arms it.
        if (this.bargeInHandler && !this.bargeInFired) {
            // Energy gate plus Silero's verdict when loaded: a cough, thump, or
            // mic bump is loud but not speech and shouldn't hush the
            // facilitator. (Echo IS speech to Silero, so this never weakens echo
            // rejection - that stays on the energy gate.)
            const isSpeechLike = !this.silero || this.silero.speaking;
            if (energy > Math.max(BARGE_IN_THRESHOLD, echoGate) && isSpeechLike) {
                if (++this.bargeInChunks >= BARGE_IN_REQUIRED_CHUNKS) {
                    this.bargeInFired = true;
                    this.bargeInHandler();
                }
            } else {
                this.bargeInChunks = 0;
            }
        }

        // Between turns (facilitator speaking included): keep the onset
        // pre-buffer warm so a barge-in's first word is already captured.
        if (!this.capturing) {
            this.pushPre(frame);
            return;
        }
        if (this.utteranceDone) {
            // Submit fired, final transcription still in flight. If the VAD
            // ended the turn while the user was still talking (the false-cutoff
            // case, meditation-pal-rcdz), these frames are their continuing
            // words: run the same speech test and flag a resume so start()
            // reopens the utterance rather than losing them. Frames accumulate
            // either way so a resumed utterance's audio is contiguous, and the
            // pre-buffer stays warm for the no-resume case.
            if (this.isSpeechFrame(energy, echoGate)) {
                this.postSubmitSpeech = true;
                this.lastSpeechMs = now;
                this.peakEnergy = Math.max(this.peakEnergy, energy);
            }
            this.chunks.push(frame);
            this.pushPre(frame);
            return;
        }

        this.energyHistory.push({ t: now, e: energy, p: this.silero ? this.silero.lastProb : -1 });
        while (this.energyHistory.length > 0 && now - this.energyHistory[0]!.t > 10_000) {
            this.energyHistory.shift();
        }

        // Speech signal: Silero's debounced per-chunk classification (energy
        // fallback when the model couldn't load). While TTS plays the frame
        // must also clear barge-in-grade energy - Silero scores the
        // facilitator's echo as speech (it IS speech), so telling the
        // speakers apart needs an energy reference, and anything quieter than
        // the barge-in gate couldn't have interrupted anyway. Closes the
        // session-start phantom turn (8h1x): greeting echo at ~0.016 RMS cleared
        // the old 0.015 floor before the echo EMA had calibrated.
        if (this.isSpeechFrame(energy, echoGate)) {
            if (!this.speechStarted) {
                this.speechStarted = true;
                this.startedWhileTtsActive = this.ttsActive;
                this.speechStartMs = now;
                // Prepend the retained onset ramp, then clear it.
                for (const f of this.preBuffer) this.chunks.push(f);
                this.preBuffer.length = 0;
            }
            this.lastSpeechMs = now;
            this.peakEnergy = Math.max(this.peakEnergy, energy);
            this.chunks.push(frame);
        } else if (this.speechStarted) {
            this.chunks.push(frame);
            // Adaptive silence: each ms of speech buys silenceRampRate ms of
            // additional patience, capped at silenceMaxMs.
            const speechDur = this.lastSpeechMs - this.speechStartMs;
            const needed =
                Math.min(
                    this.opts.silenceBaseMs + speechDur * this.opts.silenceRampRate,
                    this.opts.silenceMaxMs
                ) + (this.partialIncomplete ? INCOMPLETE_CLAUSE_EXTRA_MS : 0);
            const silence = now - this.lastSpeechMs;
            // Hold the submit while a speculative pass resolves: it may be about
            // to set partialIncomplete and extend `needed`. Without the gate a
            // slow cloud round-trip lets the base window cut a dangling clause
            // before its verdict lands (kkiz).
            if (silence >= needed && !this.specInFlight) {
                this.utteranceDone = true;
                // VAD tuning diagnostic: speech duration, required vs elapsed
                // trailing silence, loudness, echo floor (for the gate margins),
                // and inference backpressure. console.info so it shows without
                // Verbose. (Temporary - remove once the VAD is dialed in.)
                console.info(
                    `[vad] submit speech=${Math.round(speechDur)}ms ` +
                        `needed=${Math.round(needed)}ms silence=${Math.round(silence)}ms ` +
                        `peak=${this.peakEnergy.toFixed(3)} ` +
                        `echoFloor=${this.echoFloor.toFixed(4)} ` +
                        `dropped=${this.silero?.droppedChunks ?? 0} ` +
                        `dangling=${this.partialIncomplete} ` +
                        `mode=${this.silero ? 'silero' : `energy(floor=${this.noiseFloor.toFixed(4)})`}`
                );
                // Energy + speech-prob traces, last 8s in 0.5s buckets (max per
                // bucket, oldest first). The prob row shows what the model
                // thought during the trailing "silence" - held speech vs a real
                // pause; the energy row contextualizes the echo gate.
                const buckets = new Array<number>(16).fill(0);
                for (const { t, e } of this.energyHistory) {
                    const idx = Math.floor((now - t) / 500);
                    if (idx >= 0 && idx < 16) buckets[idx] = Math.max(buckets[idx]!, e);
                }
                buckets.reverse();
                console.info(
                    `[vad] tail 8s->now (max rms / 0.5s): ` +
                        buckets.map((b) => b.toFixed(3)).join(' ')
                );
                if (this.silero) {
                    const probs = new Array<number>(16).fill(-1);
                    for (const { t, p } of this.energyHistory) {
                        const idx = Math.floor((now - t) / 500);
                        if (idx >= 0 && idx < 16) probs[idx] = Math.max(probs[idx]!, p);
                    }
                    probs.reverse();
                    console.info(
                        `[vad] tail 8s->now (max speech-prob / 0.5s): ` +
                            probs.map((v) => (v < 0 ? '----' : v.toFixed(2))).join(' ')
                    );
                }
            }
        } else if (this.ttsActive) {
            // Capturing, pre-speech, TTS audible - this energy is the device's
            // echo, not the user. Fold it into the echo floor so the gates above
            // can reject it.
            this.echoFloor = (1 - ECHO_EMA_ALPHA) * this.echoFloor + ECHO_EMA_ALPHA * energy;
            this.pushPre(frame);
        } else {
            // Degraded mode only: quiet pre-speech frames with TTS silent are
            // echo-free room tone - calibrate the adaptive noise floor. (Under
            // Silero this branch also catches soft speech the energy gate would
            // miss, which must not inflate the floor.)
            if (!this.silero) {
                const alpha = this.noiseSamples < 100 ? 0.1 : 0.01;
                this.noiseFloor = (1 - alpha) * this.noiseFloor + alpha * energy;
                this.noiseSamples++;
            }
            this.pushPre(frame);
        }

        if (
            !this.utteranceDone &&
            this.speechStarted &&
            now - this.speechStartMs >= this.opts.maxUtteranceMs
        ) {
            console.info(
                `[vad] submit: max utterance cap reached (${this.opts.maxUtteranceMs}ms)`
            );
            this.utteranceDone = true;
        }
    };

    /**
     * Open the mic stream, AudioContext, and continuous audio graph if they
     * aren't already up. Idempotent - reuses a live stream/context/processor
     * across turns (re-acquiring is the expensive step that used to clip a
     * barge-in's first second). Throws on permission denial or a missing
     * AudioContext. Shared by start() and prime().
     */
    private async ensureCaptureGraph(): Promise<void> {
        if (!this.stream || !this.stream.active) {
            // On native mobile the WebView only grants getUserMedia audio once
            // the app holds RECORD_AUDIO; this cloud path never requested it, so
            // pre-flight it (no-op elsewhere). See mic-permission.ts.
            await ensureMicPermission();
            // echoCancellation matters more than usual here: this stream stays
            // live across turns, so it fills the onset pre-buffer WHILE TTS
            // plays. Without EC the pre-buffer captures the speakers, and a
            // barge-in would prepend the facilitator's own words to the user's
            // utterance before sending it to Whisper. Matches barge-in.ts.
            this.stream = await navigator.mediaDevices
                .getUserMedia({
                    audio: {
                        ...(this.opts.micDeviceId
                            ? { deviceId: { ideal: this.opts.micDeviceId } }
                            : {}),
                        echoCancellation: true,
                        // macOS's voice processing includes a noise gate that can
                        // hard-zero soft speech MID-UTTERANCE - observed as RMS
                        // exactly 0.000 for seconds while the user was still
                        // talking, Whisper returning [BLANK_AUDIO] for spans that
                        // had words. The gate rides with noise suppression, not echo
                        // cancellation, so NS off while keeping EC (which continuous
                        // capture requires).
                        noiseSuppression: false,
                        // On by default everywhere, but pinned: the VAD's input
                        // level depends on it (it lifts quiet mics into usable
                        // range), so a browser default change shouldn't silently
                        // alter behavior.
                        autoGainControl: true,
                    },
                })
                .catch((err: unknown) => {
                    // Greppable in adb logcat (Capacitor/Console): permission
                    // denials here surface to the user as a vague mic error.
                    const detail =
                        err instanceof Error ? `${err.name}: ${err.message}` : String(err);
                    console.warn(`[stt-cloud] getUserMedia failed - ${detail}`);
                    throw err;
                });
            this.teardownGraph(); // any prior nodes belong to a dead stream

            // Diagnose + self-heal capture-track death: a dead track keeps the
            // graph "running" but feeds digital zeros, so the session goes deaf
            // with no error anywhere. Seen alongside WebKit's "capture
            // MediaStreamTrack was destroyed without having been stopped"
            // warning. 'mute'/'unmute' are logged for the same investigation.
            const stream = this.stream;
            const track = stream.getAudioTracks()[0];
            // Did the platform honor the constraints? WebKit may bundle NS into
            // its voice-processing unit and ignore ns=false; this log is how we
            // find out. Temporary, part of the VAD diagnostics.
            if (track?.getSettings) {
                const s = track.getSettings();
                console.info(
                    `[vad] capture settings: ec=${String(s.echoCancellation)} ` +
                        `ns=${String(s.noiseSuppression)} agc=${String(s.autoGainControl)}`
                );
            }
            track?.addEventListener('ended', () => {
                if (this.stopRequested || this.stream !== stream) return;
                console.warn('[vad] capture track ended unexpectedly - reacquiring mic');
                this.releaseStream();
                void this.ensureCaptureGraph().catch((err) => {
                    console.warn('[vad] mic reacquire failed:', err);
                });
            });
            track?.addEventListener('mute', () => {
                console.warn('[vad] capture track muted (no media flowing)');
            });
            track?.addEventListener('unmute', () => {
                console.info('[vad] capture track unmuted');
            });
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
            // between turns to fill the onset pre-buffer, but the OS/browser can
            // suspend it in that idle window (backgrounding, autoplay policy,
            // audio-focus loss) - the ScriptProcessor then stops firing, the
            // pre-buffer goes stale, and a barge-in's first word is lost. So
            // re-resume on any suspend until we explicitly stop().
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

        // Wire the continuous graph once; it stays alive across turns so the
        // pre-buffer keeps filling even while the facilitator speaks.
        this.nativeRate = this.context.sampleRate;
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
     * Pre-open the capture graph so the onset pre-buffer fills BEFORE the first
     * start() (e.g. during the opening greeting), keeping a barge-in on the very
     * first facilitator turn from being clipped. Best-effort: start() retries
     * and surfaces real errors. Leaves capturing=false - no utterance, no events.
     */
    async prime(): Promise<void> {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
        this.stopRequested = false;
        // Warm model + graph together. Both are usually instant (setup preloads
        // the model, the graph persists across turns), and the caller holds
        // `busy` through the opening greeting, so a cold first-run model
        // download hides behind it.
        await Promise.allSettled([this.acquireSilero(), this.ensureCaptureGraph()]);
    }

    /**
     * Register (or clear, with null) a barge-in callback, fired when the user's
     * voice is detected while the facilitator is speaking - used to cancel TTS.
     * Detecting on this one echo-cancelled stream avoids a second mic stream
     * that would hear raw TTS echo and trip on the facilitator itself. (d35)
     */
    setBargeInHandler(handler: (() => void) | null): void {
        this.bargeInHandler = handler;
    }

    /**
     * Tell the engine whether the facilitator's audio is playing. While active,
     * capture energy is sampled into this device's echo floor (see ECHO_*) and
     * that floor gates the VAD/barge-in. The caller brackets this around actual
     * playback - NOT the silent "thinking" phase, where the user should still
     * interrupt at the normal threshold.
     */
    setTtsActive(active: boolean): void {
        this.ttsActive = active;
    }

    async *start(): AsyncIterable<SttEvent> {
        this.stopRequested = false;
        try {
            // Silero is the preferred speech signal; a load failure leaves the
            // energy fallback in charge (acquireSilero swallows it), so only a
            // capture-graph failure is a hard error surfaced to the UI.
            await this.acquireSilero();
            await this.ensureCaptureGraph();
        } catch (err) {
            yield { type: 'error', error: err };
            return;
        }
        const nativeRate = this.context!.sampleRate;

        // Begin a fresh utterance. The pre-buffer + echo floor persist (warmed
        // between turns); only the per-utterance accumulators reset.
        this.chunks = [];
        this.speechStarted = false;
        this.startedWhileTtsActive = false;
        this.speechStartMs = 0;
        this.lastSpeechMs = 0;
        this.utteranceDone = false;
        this.postSubmitSpeech = false;
        this.peakEnergy = 0;
        this.energyHistory = [];
        this.partialIncomplete = false;
        this.specInFlight = false;
        // Re-arm barge-in for the next idle period.
        this.bargeInFired = false;
        this.bargeInChunks = 0;
        this.capturing = true;

        // Transcribe a snapshot of captured frames - used by both the
        // speculative interim passes and the final submission.
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
            // No samples → nothing to transcribe. A speculative pass can fire
            // before any frame accumulates (or just after a barge-in clears
            // them); POSTing an empty body just earns a 400 from the endpoint.
            if (downsampled.length === 0) return { ok: true, text: '', seconds: 0 };
            try {
                // Tag with the session group when one is active (cloud cost
                // report). The desktop STT ignores it.
                const sessionId = getCloudSessionId();
                const sessionParam = sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : '';
                const modelParam = this.opts.whisperModelSize
                    ? `&model_size=${encodeURIComponent(this.opts.whisperModelSize)}` +
                      `&lang=${encodeURIComponent(this.opts.language ?? 'en')}`
                    : '';
                const cloudModelParam = this.opts.cloudModel
                    ? `&model=${encodeURIComponent(this.opts.cloudModel)}`
                    : '';
                const send = async (): Promise<Response> => {
                    const headers: Record<string, string> = {
                        'content-type': 'application/octet-stream',
                    };
                    if (this.opts.authProvider) {
                        const token = await this.opts.authProvider();
                        if (token) headers['authorization'] = `Bearer ${token}`;
                    }
                    return this.opts.fetchImpl(
                        `${this.opts.endpointUrl}?sample_rate=${TARGET_SAMPLE_RATE}${sessionParam}${modelParam}${cloudModelParam}`,
                        {
                            method: 'POST',
                            headers,
                            body: downsampled.buffer.slice(
                                downsampled.byteOffset,
                                downsampled.byteOffset + downsampled.byteLength
                            ) as ArrayBuffer,
                        }
                    );
                };
                let response = await withTimeout(
                    send(),
                    TRANSCRIBE_TIMEOUT_MS,
                    'aloud cloud transcription timed out.'
                );
                // Self-heal a stale token: clear and re-sign-in once on a 401,
                // matching the cloud LLM/TTS adapters. Hosted path only.
                if (response.status === 401 && this.opts.authProvider && this.opts.onAuthError) {
                    await this.opts.onAuthError();
                    response = await withTimeout(
                        send(),
                        TRANSCRIBE_TIMEOUT_MS,
                        'aloud cloud transcription timed out.'
                    );
                }
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
            // Poll while capturing. A SPECULATIVE_SILENCE_MS pause fires a
            // speculative transcription (yielded as a partial); the adaptive
            // `needed` silence from the audio callback ends the turn. Only ONE
            // pass per pause: the buffer keeps "growing" with silence frames, so
            // re-transcribing yields the same preview and the same
            // dangling-clause verdict while burning CPU and billed cloud seconds
            // (m56t). New SPEECH re-arms it.
            let lastSpecSpeechMs = 0;
            // When the last speculative pass snapshotted the buffer. Frames
            // after this were never transcribed, so the final pass checks them
            // for missed soft speech before reusing the cache.
            let lastSpecAt = 0;
            // Already showed a real (non-empty) speculative transcript? Then
            // finalize even a short turn - otherwise the preview bubble appears
            // and vanishes with the turn dropped (a deliberate one-word
            // "alright" hits this).
            let emittedPartial = false;
            // Last successful speculative transcript, reused by the end-of-turn
            // pass when no further speech arrives so a single-pause turn doesn't
            // re-transcribe the identical buffer (m56t).
            let lastSpecResult: { text: string; seconds: number } | null = null;
            // Loop, not a straight line: debounced speech AFTER the submit
            // decision (postSubmitSpeech - the user was still talking when the
            // adaptive window closed) REOPENS the utterance so the continuing
            // words join this turn (meditation-pal-rcdz). What's transcribed so
            // far is surfaced as a partial; the next submit re-transcribes the
            // whole buffer.
            for (;;) {
                while (!this.utteranceDone && !this.stopRequested) {
                    await new Promise<void>((r) => setTimeout(r, 200));
                    if (this.utteranceDone || this.stopRequested) break;
                    if (!this.speechStarted) continue;
                    const silence = performance.now() - this.lastSpeechMs;
                    if (
                        silence >= SPECULATIVE_SILENCE_MS &&
                        !this.specInFlight &&
                        this.lastSpeechMs !== lastSpecSpeechMs
                    ) {
                        this.specInFlight = true;
                        lastSpecSpeechMs = this.lastSpeechMs;
                        lastSpecAt = performance.now();
                        const result = await transcribeChunks(this.chunks.slice());
                        this.specInFlight = false;
                        // Drop the preview if the turn ended while it was in flight
                        // (the final pass will emit the authoritative text).
                        if (!this.utteranceDone && result.ok && result.text) {
                            // Dangling clause → extra silence before submit (see
                            // INCOMPLETE_CLAUSE_EXTRA_MS). Re-evaluated each
                            // pass, so a completed thought gets the normal window.
                            this.partialIncomplete = transcriptLooksIncomplete(result.text);
                            emittedPartial = true;
                            // Keep this whole-buffer transcript; the final pass
                            // reuses it (below) if no new speech arrives.
                            lastSpecResult = { text: result.text, seconds: result.seconds };
                            yield {
                                type: 'partial',
                                text: result.text,
                                startedDuringTts: this.startedWhileTtsActive,
                            };
                        }
                    }
                }

                if (this.stopRequested && !this.utteranceDone) {
                    return; // user explicitly stopped before end-of-speech
                }
                if (!this.speechStarted) return;

                const speechDuration = this.lastSpeechMs - this.speechStartMs;
                // Too short to be speech (cough, mic bump) - skip the billable
                // final pass. Unless a real preview already showed: the user saw
                // their word land and a deliberate "alright" is a real turn.
                // Noise that slips through is still dropped downstream by
                // isNonSpeechOnly.
                if (speechDuration < this.opts.minSpeechDurationMs && !emittedPartial) {
                    return;
                }

                // Reuse the last speculative transcript when no new speech has
                // landed since (the common single-pause turn) - re-running would
                // bill an identical call. Speech since then invalidates it, and
                // so does speech-LIKE activity in the untranscribed tail:
                // trailing words too soft to clear the debounced VAD gate are in
                // the buffer but not the cached transcript, and reusing it would
                // drop them (meditation-pal-rcdz, "...in my belly").
                const tailHasSpeechHints =
                    lastSpecAt > 0 &&
                    this.energyHistory.some(
                        ({ t, e, p }) =>
                            t > lastSpecAt &&
                            (p >= TAIL_RETRANSCRIBE_PROB || e >= TAIL_RETRANSCRIBE_ENERGY)
                    );
                const result: Awaited<ReturnType<typeof transcribeChunks>> =
                    lastSpecResult && this.lastSpeechMs === lastSpecSpeechMs && !tailHasSpeechHints
                        ? { ok: true as const, text: lastSpecResult.text, seconds: lastSpecResult.seconds }
                        : await transcribeChunks(this.chunks);
                if (tailHasSpeechHints && lastSpecResult) {
                    console.info('[vad] tail had speech hints after the speculative pass - re-transcribed full buffer');
                }

                // The user kept talking past the submit decision - the turn
                // isn't over. Reopen: surface what we have as a partial and loop
                // back to polling; the next adaptive-silence decision
                // re-transcribes the whole contiguous buffer.
                if (this.postSubmitSpeech && !this.stopRequested) {
                    this.postSubmitSpeech = false;
                    this.utteranceDone = false;
                    console.info('[vad] speech continued past submit - reopening the utterance');
                    if (result.ok && result.text) {
                        emittedPartial = true;
                        lastSpecResult = { text: result.text, seconds: result.seconds };
                        this.partialIncomplete = transcriptLooksIncomplete(result.text);
                        yield {
                            type: 'partial',
                            text: result.text,
                            startedDuringTts: this.startedWhileTtsActive,
                        };
                    }
                    continue;
                }

                if (!result.ok) {
                    yield { type: 'error', error: result.error };
                    return;
                }
                // Billable server-side compute: report transcribed audio
                // duration (16 kHz mono) for session usage. Only the final pass
                // counts; speculative passes aren't separately metered.
                yield {
                    type: 'final',
                    text: result.text,
                    seconds: result.seconds,
                    startedDuringTts: this.startedWhileTtsActive,
                };
                return;
            }
        } finally {
            // End the turn but keep stream, context, and callback alive so the
            // pre-buffer keeps filling for the next turn / barge-in. Full
            // teardown only on stop().
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

    /** Full teardown: graph nodes, context, mic stream, and the continuous
     *  capture state, so a later start() begins clean. */
    private releaseAll(): void {
        this.teardownGraph();
        if (this.context && this.context.state !== 'closed') {
            this.context.close().catch(() => {});
        }
        this.context = null;
        this.releaseStream();
        this.preBuffer = [];
        // Drop our reference only - the model is an app-lifetime singleton the
        // next session reuses (acquireSilero resets its stream state).
        this.silero = null;
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

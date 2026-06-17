/**
 * Whisper-over-HTTP STT adapter — captures mic audio in the browser, VADs it
 * client-side, sends 16 kHz Float32 PCM to a Whisper transcription endpoint,
 * and emits a `final` event when transcription returns.
 *
 * Endpoint-agnostic: the same capture/VAD pipeline drives BOTH on-device
 * desktop Whisper (the Tauri Rust shell's /app/v1/stt/whisper) and aloud cloud
 * (the authed /cloud/v1/stt) — only the endpoint URL + optional bearer token
 * differ (see stt-picker.ts). It's the universal fallback: works on Firefox,
 * Safari, and anywhere the Web Speech API doesn't cover, as long as a Whisper
 * endpoint is reachable.
 *
 * VAD: the speech signal is Silero v5 (silero-vad.ts) — a neural per-chunk
 * speech probability, robust to quiet mics and soft trailing speech, loaded
 * once per app (loadSileroVad) and awaited by prime()/start(); the setup view
 * preloads it so the wait is usually zero. RMS energy is no longer a speech
 * detector — it remains only as the echo reference: Silero scores the
 * facilitator's own TTS echo as speech (it IS speech), so while TTS plays a
 * frame must also clear the measured echo gate to count as the user. The
 * adaptive silence timeout (base + speech×ramp, capped at max) is unchanged.
 * After a short pause the engine fires a SPECULATIVE transcription and emits
 * it as a `partial` (so the user sees their words during the pause), then
 * submits the `final` once the full adaptive silence elapses.
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
import { transcriptLooksIncomplete } from '../../../src/facilitation/end-of-turn.js';
import { getCloudSessionId } from '../cloud-session.js';
import { withTimeout } from '../net-timeout.js';
// Type-only: the module itself is dynamic-imported in acquireSilero() so the
// ort runtime + model assets stay out of the main bundle (and out of node-env
// tests, which never call it).
import type { SileroFrameVad } from './silero-vad.js';

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SIZE = 4096;
// Stall guard for the transcription POST: a hosted endpoint that accepts the
// audio and then hangs would leave the listen loop awaiting a transcript
// forever (mic stuck "processing"). The loop already retries on a rejected
// transcription, so a timeout here just lets that recovery kick in. Generous —
// even a long utterance transcribes well inside this; it's the dead-server cap.
const TRANSCRIBE_TIMEOUT_MS = 45_000;
// Short silence (ms) that triggers a speculative transcription mid-utterance —
// so the user sees their words during a pause, before the (longer) adaptive
// silence actually submits the turn. Speculation is skipped when the submit
// threshold is shorter than this (nothing to preview). 750ms (not 500) trims
// false trips on natural between-phrase breaths while still leaving wide room
// before the 3s+ submit window (pacing silenceBaseMs).
const SPECULATIVE_SILENCE_MS = 750;
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

// Per-device echo calibration. With continuous capture the mic stays armed
// while the facilitator speaks, so on hardware with weak echo-cancellation the
// facilitator's own voice (leaking into the capture stream as echo) could clear
// the VAD/barge-in gates and be transcribed as a phantom user turn. Echo level
// varies a lot by device, so rather than trust the fixed ~0.005 assumption we
// MEASURE it: while TTS is actually playing and the user isn't speaking, the
// captured energy IS this device's echo floor. We track it as a slow EMA and
// gate it out during playback only.
//
// The three knobs below are starting points — tune against real hardware:
//   MARGIN: how far above the measured echo the gate sits (covers echo peaks
//           above its average). GATE_MAX: a ceiling so the gate can never climb
//           into real-speech territory (~0.04+) and swallow genuine speech.
//           ALPHA: EMA smoothing — low enough that a brief bit of user speech
//           during calibration barely moves it.
const ECHO_EMA_ALPHA = 0.05;
const ECHO_GATE_MARGIN = 2.0;
const ECHO_GATE_MAX = 0.035;

// Extra silence (ms) granted when the speculative transcript ends in a
// dangling clause ("...never had a bad time doing") — the speaker is likely
// mid-thought, so wait longer before submitting (meditation-pal-fxo1). This is
// the gate-immune cutoff defense: macOS's noise gate can hard-zero soft
// trailing speech so the VAD sees a perfect pause, but the unfinished clause
// in the transcript survives. Applied on top of the adaptive ramp, every time
// the latest speculative pass still looks unfinished.
const INCOMPLETE_CLAUSE_EXTRA_MS = 4000;

// Tail-recovery thresholds (meditation-pal-rcdz): after the last speculative
// pass, frames keep accumulating until the adaptive window submits. If any of
// those frames look even a LITTLE like speech — Silero probability that never
// cleared the debounced gate, or energy above soft-speech level — the cached
// speculative transcript may be missing trailing words ("...in my belly"
// spoken too softly to move lastSpeechMs), so the final pass must re-send the
// full buffer to Whisper instead of reusing the cache. Deliberately below the
// VAD's own gates: a false positive costs one extra transcription, a false
// negative costs the user's words.
const TAIL_RETRANSCRIBE_PROB = 0.4;
const TAIL_RETRANSCRIBE_ENERGY = 0.015;

/** The subset of PacingConfig fields the VAD here cares about. */
type VadFields = Pick<
    PacingConfig,
    'silenceBaseMs' | 'silenceMaxMs' | 'silenceRampRate' | 'minSpeechDurationMs'
>;

export interface WhisperPcmSttEngineOptions extends Partial<VadFields> {
    /** Endpoint URL. Default '/app/v1/stt/whisper' — Vite proxies in dev. */
    endpointUrl?: string;
    /** Hard cap on a single utterance — auto-submit after this. Default 120s.
     *  This is the runaway valve (background speech can hold the VAD open
     *  forever), NOT a conversational boundary: it cuts mid-sentence with no
     *  incompleteness regard, and the post-cut hole grows with buffer length
     *  (only the 2s pre-buffer survives the final transcription's latency) —
     *  so it must sit well past any real ramble, which the adaptive silence
     *  window (a turn only gets here with no ~5s gap at all) already makes
     *  rare. Raising it further mostly costs final-pass latency at submit. */
    maxUtteranceMs?: number;
    /** Custom fetch (tests). */
    fetchImpl?: typeof fetch;
    /** When present, each transcription request carries `Authorization: Bearer
     *  <token>`. Used to target the aloud cloud's authed /cloud/v1/stt (vs the
     *  open desktop /app/v1/stt/whisper). Returning null sends no auth header. */
    authProvider?: () => Promise<string | null>;
    /** Called once on a 401 to invalidate a stale token before a single retry
     *  (the next authProvider() then re-signs-in). Matches the cloud LLM/TTS
     *  adapters' self-heal — without it, an expired or secret-rotated token
     *  fails every hosted transcription for the page lifetime. Wire to
     *  clearCloudToken for the hosted engine. */
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

    // Continuous capture state — the audio callback runs across turns, so this
    // lives on the instance (not in a start()-scoped closure).
    private capturing = false;
    private preBuffer: Float32Array[] = [];
    private preBufferFrames = 0;
    // Per-utterance accumulators, reset at the top of each start().
    private chunks: Float32Array[] = [];
    private speechStarted = false;
    // Whether THIS utterance's speech began while the facilitator's TTS was
    // audibly playing — yielded on partial/final events so the session's
    // transcript echo guard can judge by speech START time (arrival time is
    // useless: VAD silence + transcription latency delay it by seconds).
    private startedWhileTtsActive = false;
    private speechStartMs = 0;
    private lastSpeechMs = 0;
    private utteranceDone = false;
    // Debounced speech detected AFTER the submit decision, while the final
    // transcription was in flight — start() reopens the utterance (see the
    // utteranceDone branch in handleAudio).
    private postSubmitSpeech = false;
    // Loudest speech frame this utterance — diagnostic only (how loud this
    // user/mic combination runs; informs the echo-gate margins).
    private peakEnergy = 0;
    // Whether the latest speculative transcript ends in a dangling clause —
    // set by the polling loop in start(), read by the audio callback to extend
    // the silence window (INCOMPLETE_CLAUSE_EXTRA_MS).
    private partialIncomplete = false;
    // A speculative transcription is mid-flight. The audio callback refuses to
    // finalize the turn while this is true, so the dangling-clause verdict
    // (partialIncomplete) is always applied before submit — without this, the
    // adaptive silence window can elapse and cut the turn BEFORE the (network)
    // speculative pass returns to grant the incomplete-clause extension, which
    // is the cloud-STT mid-sentence cutoff (kkiz). The maxUtterance runaway
    // valve is deliberately NOT gated on this.
    private specInFlight = false;
    // Rolling per-frame energy (+ neural prob, -1 when Silero is off) history
    // (~85ms per frame at 48 kHz) for the submit diagnostic — peak/thr alone
    // can't show what the detector heard during the trailing "silence" window
    // (soft speech vs breath vs true quiet), and that distinction is the whole
    // tuning question.
    private energyHistory: { t: number; e: number; p: number }[] = [];
    // Barge-in detection on the continuous (echo-cancelled) idle stream.
    private bargeInHandler: (() => void) | null = null;
    private bargeInChunks = 0;
    private bargeInFired = false;
    // Per-device echo calibration (see ECHO_* constants). ttsActive is set by
    // the caller while the facilitator's audio is actually playing; echoFloor is
    // the EMA of capture energy measured during those windows.
    private ttsActive = false;
    // Seeded with the typical echo-cancelled echo level so the gate is sensible
    // from the first frame; the EMA then adapts it to this device.
    private echoFloor = 0.005;
    // The shared Silero VAD (see loadSileroVad) — acquired by prime()/start(),
    // null until then. It IS the speech signal: no model, no speech detection,
    // which is why start() treats a load failure as a hard error.
    private silero: SileroFrameVad | null = null;
    // Mic input-level listener (the session view's mic-button ring). Fed from
    // this engine's own frames so the UI never opens a second mic stream — on
    // macOS the voice-processing unit attaches to ONE input, and a competing
    // capture's lifecycle can glitch or hard-zero this one (suspected cause of
    // mid-utterance digital-zero dropouts).
    private levelListener: ((rms: number) => void) | null = null;
    // Device sample rate, cached for the audio callback (feeds the resampler).
    private nativeRate = 48_000;

    constructor(options: WhisperPcmSttEngineOptions = {}) {
        this.opts = {
            endpointUrl: options.endpointUrl ?? '/app/v1/stt/whisper',
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

    /** Await the shared Silero instance (kicking off the load if the setup
     *  view's preload didn't already), and reset its streaming state when this
     *  engine first adopts it — a fresh capture stream shouldn't inherit
     *  recurrent state from a previous session. */
    private async acquireSilero(): Promise<void> {
        const { loadSileroVad } = await import('./silero-vad.js');
        const vad = await loadSileroVad();
        if (this.silero !== vad) {
            vad.reset();
            this.silero = vad;
        }
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

    /** True while the user is mid-utterance (speech detected, turn not yet
     *  submitted). Lets the session view suppress facilitator-initiated lines
     *  (silence check-ins) that would otherwise talk over the user — the
     *  pacing controller only learns about COMPLETED turns, so it can't tell
     *  on its own. */
    get userSpeechActive(): boolean {
        return this.capturing && this.speechStarted && !this.utteranceDone;
    }

    /** Register (or clear, with null) a per-frame mic-level listener — RMS of
     *  each ~85ms capture frame, whenever the mic is open (capturing or not).
     *  Lets the UI render an input meter without opening its own mic stream. */
    setLevelListener(listener: ((rms: number) => void) | null): void {
        this.levelListener = listener;
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

        this.levelListener?.(energy);

        // Keep the neural VAD fed on every frame, capturing or not — its
        // recurrent state assumes an unbroken stream, and classifying during
        // idle means `speaking` is already current when capture flips on.
        this.silero?.feed(frame, this.nativeRate);

        // While the facilitator is audibly speaking, lift the gates above this
        // device's measured echo floor so the echo can't be mistaken for the
        // user. Zero when TTS isn't playing (no echo to reject), so a silent gap
        // keeps the normal, sensitive thresholds. Capped so it never reaches
        // real-speech level.
        const echoGate = this.ttsActive
            ? Math.min(this.echoFloor * ECHO_GATE_MARGIN, ECHO_GATE_MAX)
            : 0;

        // Barge-in: watch this echo-cancelled stream for the user's voice so
        // they can interrupt the facilitator. Runs in BOTH idle and capturing
        // states — with continuous capture the mic stays armed across turns, so
        // a barge-in arrives while capturing=true, not just between turns. The
        // gate clears measured echo (echoGate) during playback; sustained real
        // speech beats it. Fires once per start()/utterance — start() re-arms it.
        if (this.bargeInHandler && !this.bargeInFired) {
            // Energy gate as before, plus Silero's verdict when it's loaded: a
            // cough, thump, or mic bump is loud but not speech, and shouldn't
            // hush the facilitator. (Echo IS speech to Silero, so this never
            // weakens echo rejection — that stays on the energy gate.)
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

        // Between turns (including while the facilitator is speaking): keep the
        // onset pre-buffer warm so a barge-in's first word is already captured.
        if (!this.capturing) {
            this.pushPre(frame);
            return;
        }
        if (this.utteranceDone) {
            // Submit fired but the final transcription is still in flight. If
            // the VAD ended the turn while the user was actually still talking
            // (the false-cutoff case, meditation-pal-rcdz), these frames are
            // their continuing words. Run the same speech test as live capture;
            // if it trips, flag the resume — start() reopens the utterance
            // instead of ending it, so the words join this turn rather than
            // being lost. Frames keep accumulating into chunks either way so a
            // resumed utterance's audio is contiguous; the pre-buffer also
            // stays warm for the next turn (the no-resume case).
            const stillSpeech =
                this.silero !== null &&
                this.silero.speaking &&
                (echoGate === 0 || energy > Math.max(echoGate, BARGE_IN_THRESHOLD));
            if (stillSpeech) {
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

        // Speech signal: Silero's debounced per-chunk classification. While
        // TTS is audibly playing the frame must also clear barge-in-grade
        // energy — Silero scores the facilitator's echo as speech (it IS
        // speech), so telling the speaker apart needs an energy reference, and
        // anything quieter than the barge-in gate couldn't have interrupted
        // the facilitator anyway (it would just be captured echo). This closes
        // the session-start phantom turn (8h1x): greeting echo at ~0.016 RMS
        // cleared the old 0.015 floor before the echo EMA had calibrated.
        const isSpeech =
            this.silero !== null &&
            this.silero.speaking &&
            (echoGate === 0 || energy > Math.max(echoGate, BARGE_IN_THRESHOLD));

        if (isSpeech) {
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
            // Hold the submit while a speculative pass is resolving: it may be
            // about to set partialIncomplete and extend `needed` past this
            // moment. Without the gate, a slow cloud round-trip lets the base
            // window cut a dangling clause before its verdict lands (kkiz).
            if (silence >= needed && !this.specInFlight) {
                this.utteranceDone = true;
                // Diagnostic for tuning the VAD: how long you spoke, the
                // trailing silence we required vs what elapsed, plus loudness
                // and the echo floor (for the echo-gate margins) and any
                // inference backpressure. console.info so it shows without
                // toggling Verbose. (Temporary — remove once the VAD is dialed in.)
                console.info(
                    `[vad] submit speech=${Math.round(speechDur)}ms ` +
                        `needed=${Math.round(needed)}ms silence=${Math.round(silence)}ms ` +
                        `peak=${this.peakEnergy.toFixed(3)} ` +
                        `echoFloor=${this.echoFloor.toFixed(4)} ` +
                        `dropped=${this.silero?.droppedChunks ?? 0} ` +
                        `dangling=${this.partialIncomplete}`
                );
                // Energy + speech-prob traces of the last 8s in 0.5s buckets
                // (max per bucket, oldest first). The prob row shows what the
                // model thought during the trailing "silence" — held speech vs
                // a real pause; the energy row contextualizes the echo gate.
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
            // Capturing, pre-speech, facilitator audibly speaking — this energy
            // is the device's echo, not the user. Fold it into the echo floor
            // so the gates above can reject it. Keep the onset pre-buffer warm.
            this.echoFloor = (1 - ECHO_EMA_ALPHA) * this.echoFloor + ECHO_EMA_ALPHA * energy;
            this.pushPre(frame);
        } else {
            // Capturing, pre-speech, quiet — keep the onset pre-buffer warm.
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
                audio: {
                    echoCancellation: true,
                    // macOS's voice processing includes a noise gate that can
                    // hard-zero soft speech MID-UTTERANCE — observed as RMS of
                    // exactly 0.000 for seconds while the user was still
                    // talking, with Whisper returning [BLANK_AUDIO] for spans
                    // that had words in them. The gate rides with noise
                    // suppression, not echo cancellation, so ask for NS off
                    // while keeping EC (continuous capture requires EC — see
                    // the class header).
                    noiseSuppression: false,
                    // On-by-default everywhere, but pinned: the VAD's input
                    // level depends on it (it lifts quiet mics toward a usable
                    // range), so a browser default change shouldn't silently
                    // alter behavior.
                    autoGainControl: true,
                },
            });
            this.teardownGraph(); // any prior nodes belong to a dead stream

            // Diagnose + self-heal capture-track death. A dead track keeps the
            // graph "running" but feeds digital zeros — the session goes deaf
            // with no error anywhere. Seen in the wild alongside WebKit's
            // "capture MediaStreamTrack was destroyed without having been
            // stopped" warning; on 'ended' we log it and re-acquire the mic.
            // 'mute'/'unmute' (media stops flowing without the track ending)
            // are logged for the same investigation.
            const stream = this.stream;
            const track = stream.getAudioTracks()[0];
            // Whether the platform honored the constraints (WebKit may bundle
            // NS into its voice-processing unit and ignore ns=false — this log
            // is how we find out). Temporary, part of the VAD diagnostics.
            if (track?.getSettings) {
                const s = track.getSettings();
                console.info(
                    `[vad] capture settings: ec=${String(s.echoCancellation)} ` +
                        `ns=${String(s.noiseSuppression)} agc=${String(s.autoGainControl)}`
                );
            }
            track?.addEventListener('ended', () => {
                if (this.stopRequested || this.stream !== stream) return;
                console.warn('[vad] capture track ended unexpectedly — reacquiring mic');
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
     * Pre-open the capture graph so the onset pre-buffer starts filling BEFORE
     * the first start() — e.g. during the opening greeting — so a barge-in on
     * the very first facilitator turn isn't clipped. Best-effort: if the mic
     * isn't grantable yet, start() will retry and surface the error. Leaves
     * capturing=false, so no utterance begins and no events are emitted.
     */
    async prime(): Promise<void> {
        if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
        this.stopRequested = false;
        // Warm the model and the capture graph together. Both are usually
        // instant — the setup view preloads the model, the graph persists
        // across turns — and the caller holds `busy` through the opening
        // greeting, so a cold first-run model download hides behind it.
        // Best-effort: start() re-awaits both and reports real errors.
        await Promise.allSettled([this.acquireSilero(), this.ensureCaptureGraph()]);
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

    /**
     * Tell the engine whether the facilitator's audio is currently playing.
     * While active, the capture energy is sampled into this device's echo floor
     * (see ECHO_* constants) and that floor gates the VAD/barge-in so the
     * facilitator's own echo can't be mistaken for the user speaking. The caller
     * brackets this around actual TTS playback — NOT the silent "thinking" phase,
     * where the user should still be able to interrupt at the normal threshold.
     */
    setTtsActive(active: boolean): void {
        this.ttsActive = active;
    }

    async *start(): AsyncIterable<SttEvent> {
        this.stopRequested = false;
        try {
            // The model IS the speech signal — a load failure here is a hard
            // error for this engine (surfaced to the UI), not a degraded mode.
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
            // No samples → nothing to transcribe. A speculative pass can fire
            // before any frame has accumulated (or just after a barge-in clears
            // them); POSTing the resulting empty body just earns a 400 "Empty
            // request body" from the Whisper endpoint. Short-circuit instead.
            if (downsampled.length === 0) return { ok: true, text: '', seconds: 0 };
            try {
                // Tag the transcription with the session group when one is active
                // (cloud cost report); omitted otherwise. The desktop STT ignores it.
                const sessionId = getCloudSessionId();
                const sessionParam = sessionId ? `&session_id=${encodeURIComponent(sessionId)}` : '';
                const send = async (): Promise<Response> => {
                    const headers: Record<string, string> = {
                        'content-type': 'application/octet-stream',
                    };
                    if (this.opts.authProvider) {
                        const token = await this.opts.authProvider();
                        if (token) headers['authorization'] = `Bearer ${token}`;
                    }
                    return this.opts.fetchImpl(
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
                };
                let response = await withTimeout(
                    send(),
                    TRANSCRIBE_TIMEOUT_MS,
                    'aloud cloud transcription timed out.'
                );
                // Self-heal a stale token: clear it and re-sign-in once on a
                // 401, matching the cloud LLM/TTS adapters. Only meaningful on
                // the authed (hosted) path.
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
            // Poll while capturing. A short pause (SPECULATIVE_SILENCE_MS) fires
            // a speculative transcription so the user sees their words during
            // the pause (a partial, shown with the "…" marker); the adaptive
            // `needed` silence (set in the audio callback) ends the turn. Each
            // speculative pass re-transcribes the buffer — but only ONE pass per
            // pause: the buffer also "grows" with appended silence frames, and
            // re-transcribing speech + ever-more silence yields the same preview
            // and the same dangling-clause verdict while burning local CPU (and
            // billed seconds on the cloud path, m56t). New SPEECH re-arms it.
            let lastSpecSpeechMs = 0;
            // When the last speculative pass snapshotted the buffer — frames
            // after this moment were never transcribed, so the final pass
            // checks them for missed soft speech before reusing the cache.
            let lastSpecAt = 0;
            // Did we already show the user a real (non-empty) speculative
            // transcript? If so we must finalize the turn even if it's short —
            // otherwise the preview bubble appears and then vanishes with the
            // turn silently dropped (a deliberate one-word "alright" hits this).
            let emittedPartial = false;
            // The last successful speculative transcript. The end-of-turn pass
            // reuses it when no further speech arrives, so a single-pause turn
            // doesn't re-transcribe the identical whole buffer a second time (m56t).
            let lastSpecResult: { text: string; seconds: number } | null = null;
            // The submit → final-transcription → yield path runs in a loop:
            // when debounced speech is detected AFTER the submit decision
            // (postSubmitSpeech — the user was still talking when the adaptive
            // window closed), the utterance REOPENS instead of ending, so the
            // continuing words join this turn rather than being lost
            // (meditation-pal-rcdz). The already-transcribed text is surfaced
            // as a partial; the next submit re-transcribes the whole buffer.
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
                            // Dangling clause → grant extra silence before the
                            // submit (see INCOMPLETE_CLAUSE_EXTRA_MS). Re-evaluated
                            // on every speculative pass, so once the thought
                            // completes the normal window applies again.
                            this.partialIncomplete = transcriptLooksIncomplete(result.text);
                            emittedPartial = true;
                            // Keep this whole-buffer transcript; if the turn ends with
                            // no new speech, the final pass reuses it (below) instead
                            // of paying for an identical re-transcription.
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
                // Too short to be speech — likely a cough or mic bump — so skip the
                // (billable) final pass. But if we already showed a real preview,
                // honor it and finalize anyway: the user saw their word land and a
                // deliberate short utterance ("alright", "okay") is a real turn.
                // Genuine noise that slipped through is still caught downstream by
                // isNonSpeechOnly, which drops marker-only transcripts.
                if (speechDuration < this.opts.minSpeechDurationMs && !emittedPartial) {
                    return;
                }

                // Reuse the last speculative transcript when no new speech has landed
                // since it ran (the common single-pause turn): it already transcribed
                // this same whole buffer, so re-running would just bill an identical
                // call. Any speech since then invalidates it → transcribe fresh. So
                // does any speech-LIKE activity in the untranscribed tail: trailing
                // words spoken too softly to clear the debounced VAD gate are in the
                // buffer but not in the cached transcript, and reusing it would drop
                // them (meditation-pal-rcdz, "...in my belly").
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
                    console.info('[vad] tail had speech hints after the speculative pass — re-transcribed full buffer');
                }

                // The user kept talking past the submit decision (debounced
                // speech while the final pass was in flight) — the turn isn't
                // over. Reopen the utterance: surface what we have as a partial
                // and loop back into the polling phase; the next adaptive-
                // silence decision re-transcribes the whole (contiguous)
                // buffer, continuing words included.
                if (this.postSubmitSpeech && !this.stopRequested) {
                    this.postSubmitSpeech = false;
                    this.utteranceDone = false;
                    console.info('[vad] speech continued past submit — reopening the utterance');
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
                // Billable server-side STT compute — report the transcribed audio
                // duration (16 kHz mono) for session usage tracking. Only the final
                // pass is counted (it may reuse the last speculative's result);
                // speculative passes aren't separately metered.
                yield {
                    type: 'final',
                    text: result.text,
                    seconds: result.seconds,
                    startedDuringTts: this.startedWhileTtsActive,
                };
                return;
            }
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
        // Drop our reference only — the model is an app-lifetime singleton;
        // the next session reuses it (acquireSilero resets its stream state).
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

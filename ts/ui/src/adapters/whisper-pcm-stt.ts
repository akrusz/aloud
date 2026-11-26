/**
 * Whisper-over-HTTP STT: captures mic audio, VADs it client-side, POSTs 16 kHz
 * Int16 PCM (format=i16) to a Whisper endpoint, emits `final` on
 * transcription. Endpoint-agnostic - the same pipeline drives desktop Whisper
 * (/app/v1/stt/whisper) and aloud cloud (/cloud/v1/stt); only the URL +
 * optional bearer token differ (see stt-picker.ts). Universal fallback where
 * Web Speech doesn't reach (Firefox, Safari).
 *
 * Silero (silero-vad.ts) is the speech signal; RMS energy is the echo
 * reference, since Silero scores the facilitator's own TTS echo as speech. If
 * Silero's ONNX session can't be created, the engine degrades to the energy
 * speech decision (FALLBACK_ENERGY_THRESHOLD) instead of losing the mic.
 * Capture (stream, context, callback) runs continuously for the engine's
 * lifetime - only stop() tears it down - so the onset pre-buffer stays warm and
 * a barge-in's first word isn't clipped. A short pause fires a speculative pass
 * emitted as a `partial`; the full adaptive silence window submits the `final`.
 * Each pass sends the turn's audio from its start, or with `incremental` only
 * the piece the passes before it have not transcribed, the text so far riding
 * along as the model's prompt.
 */

import {
    isNonSpeechOnly,
    type SttEngine,
    type SttEvent,
    type SttStopOptions,
} from '../../../src/platform/stt.js';
import { joinTranscripts, priorPrompt } from '../../../src/platform/stt-stitch.js';
import { defaultPacingConfig, type PacingConfig } from '../../../src/facilitation/pacing.js';
import { transcriptLooksIncomplete } from '../../../src/facilitation/end-of-turn.js';
import { getCloudSessionId } from '../cloud-session.js';
import { withTimeout } from '../net-timeout.js';
import { isNetworkFailure, sendWithNetworkRetry } from '../net-retry.js';
import { ensureMicPermission } from '../mic-permission.js';
import { CALL_MODE_SETTLE_MS, captureLive, noteCaptureClosing, noteCaptureHearing, noteCaptureOpened } from '../mic-check.js';
import { capacitorPlatform } from '../is-desktop.js';
import { isAecOffDebug } from '../dev-mode.js';
import { diag, diagOn } from '../diag.js';
import { recordSttClip } from '../stt-clip-recorder.js';
import { audioContextCtor } from '../audio-unlock.js';
// Type-only: dynamic-imported in acquireSilero() so the ort runtime + model
// assets stay out of the main bundle (and out of node-env tests).
import type { SileroFrameVad } from './silero-vad.js';

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SIZE = 4096;
// Dead-server cap on the transcription POST - an endpoint that accepts the
// audio then hangs would leave the mic stuck "processing" forever. Not
// re-sent: the turn fails and the listen loop listens again.
const TRANSCRIBE_TIMEOUT_MS = 45_000;
// How long hosted STT's FINAL pass keeps re-sending a turn's audio through a
// dropped connection (net-retry.ts) before giving up on it (stt-picker
// createServerAloudStt). The audio is what the meditator said, and losing it
// means saying it again, so this outlasts a short dead patch on a walk.
// Speculative passes never retry: a late preview is useless, and the final
// re-sends anyway. The desktop's loopback Whisper doesn't retry at all: a
// refused connection there is a backend that's down, not a network blip.
export const CLOUD_FINAL_RETRY_BUDGET_MS = 30_000;
// aloud cloud's provider_error (server contract.ts): the model's upstream
// failed or refused the clip, which is billed nothing. A pass with a
// cloudFallback goes once more to the fallback on it, at once, speculative
// passes too: there is no wait, and a speculative pass's text often stands in
// for the final. Fly's proxy missing the machine answers 502 too, and there
// the second request costs nothing either.
const PROVIDER_ERROR_STATUS = 502;
// Pause (ms) that fires a speculative transcription so the user sees their
// words mid-utterance. Skipped when the submit threshold is shorter (nothing to
// preview). 750 (not 500) trims false trips on between-phrase breaths while
// staying well inside the 3s+ submit window (pacing silenceBaseMs).
const SPECULATIVE_SILENCE_MS = 750;
// Past this much buffered audio, a speculative pass fires just before the
// submit window closes (needed - SPEC_TERMINAL_LEAD_MS) instead of at 750ms.
// On full passes every pass re-sends the turn from its start, so early passes
// on a long rambly turn re-billed its opening once per phrase-pause (measured:
// 76% of a session's STT spend). Incremental passes send only the audio since
// the last one, so an early pass re-bills nothing, but each is still a request
// of its own. Mid-thought pauses rarely outlast the late trigger, so the pass
// runs on the terminal pause, where the final reuses it for free.
const SPEC_EARLY_MAX_BUFFER_MS = 12_000;
// The same cutoff for hosted STT, where every pass bills (stt-picker
// createServerAloudStt). The buffer still holds the 2s pre-roll at this point,
// so this is about 4s of SENT audio: the first phrase previews at 750ms, later
// pauses wait for the late trigger. Replayed over a real 40-min sit's full
// passes (meditation-pal-m56t): at 12s, 35% of the audio sent was a re-send of
// a turn's opening; at this, 10%. Incremental passes re-send only a piece
// whose pass failed or heard no words.
export const CLOUD_SPEC_EARLY_MAX_BUFFER_MS = 6_000;
// Lead before the submit decision, enough for the round-trip to finish first.
const SPEC_TERMINAL_LEAD_MS = 1500;
// ⭐ TWEAK ME if a barge-in clips the first word(s): pre-speech audio (ms) kept
// so a word's onset survives, covering the gap between speaking over the
// facilitator and barge-in flipping capture on. Bigger = more onset captured
// (the quiet part is trimmed back out of the billed payload - LEAD_KEEP_MS).
const PRE_BUFFER_MS = 2000;
// Barge-in runs on THIS (continuous, echo-cancelled) stream, not a second
// getUserMedia stream: on macOS the hardware AEC attaches to only one input, so
// a separate detector hears raw TTS echo and trips on the facilitator's own
// voice. Echo here measures ~0.005 RMS, real speech ~0.04+, so 0.03 separates
// them cleanly. (d35)
const BARGE_IN_THRESHOLD = 0.03;
// The longest stop() keeps the mic for a caller (keepMicUntil), should its
// promise never settle. Longer than any line the setup screen speaks with the
// mic kept (voice-start.ts hold): released under one, the line has a hole.
const KEEP_MIC_CAP_MS = 60_000;
// Below this RMS a frame is digital silence (whenHearing). A capture opened
// afresh on macOS delivers that for over a second while the OS sets its echo
// canceller up, and words said then are lost. Live room tone measured 7e-5 and
// up on a MacBook (saved clips, 2026-11-18).
const SILENT_FRAME_RMS = 1e-5;
// The longest a capture opened cold counts as settling (coldOpening), from
// asking for it. The built-in mic sent silence for about 2s after one; a
// Bluetooth headset first brings its call link up, which takes 1 to 3s.
const COLD_OPEN_SETTLE_MAX_MS = 3500;
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
// The echo canceller meets the facilitator's VOICE cold: over the first words
// a fresh capture stream plays under (the greeting's; the opening sound before
// it doesn't train it), short bursts leaked through at 0.07-0.08 RMS on
// MacBook speakers. That clears every gate above and landed as a garbled user
// turn ("Nothing to worry.", meditation-pal-7ah4), so for the first
// ECHO_WARMUP_MS of voice on a new stream the bar sits at ECHO_WARMUP_GATE
// instead. Only time the voice is audible counts (noteVoiceAudible to
// notePlaybackEnded), so neither the wait for a clip's synthesis nor the gaps
// between sentences spend it, and a short first sentence leaves the rest to
// the next. Keep it short: speech over a line measured 0.10-0.17 on desktop,
// right at this bar, and held to the end of the playback window it ran through
// the greeting and the next reply and hushed neither (meditation-pal-u21t).
// The pre-buffer keeps the onset of a barge-in that clears it late.
const ECHO_WARMUP_GATE = 0.1;
const ECHO_WARMUP_MS = 3000;

// The answer to a question the facilitator just asked (expectAnswer). Over
// the question's tail (the caller's echo hangover, setTtsActive) the bar for
// the meditator's voice is the loudest the question itself was at the mic,
// times ANSWER_ECHO_MARGIN, and never under ANSWER_BAR_FLOOR or over the bar
// it replaces: a sound's tail is no louder than the sound, so anything over
// that is not its echo. Held at BARGE_IN_THRESHOLD, a soft "yes" said just
// after "Would you like to end the session now?" peaked at 0.033 under a
// question whose echo peaked at 0.0007, and was lost (Android, aloud cloud,
// 2026-11-19, meditation-pal-cs6y).
const ANSWER_ECHO_MARGIN = 3;
const ANSWER_BAR_FLOOR = 0.01;
// An answer that a speculative pass reads as a plain one, with no speech
// since, ends sooner than on the session's adaptive pause (3s and up). Past
// this much speech it is a turn, not an answer, and turn rules apply.
const ANSWER_MAX_SPEECH_MS = 2000;
// The silence after a plain yes that ends its turn (expectAnswer's `soon`).
// The full pause made a quick "yes" wait 3.1s and feel unheard; ending it at
// its pass took "yes... no, not yet" for a yes and ended the sit. Words said
// inside this join the turn.
const ANSWER_YES_PAUSE_MS = 2000;
// A turn this many times louder than any line has been at the mic with nobody
// speaking over it is not that line come back (lastTurnClearOfEcho).
const ECHO_CLEAR_MARGIN = 5;

// Energy-only speech decision, active ONLY while the Silero session is
// unavailable (create failed - 6z11): a frame is speech when it clears the max
// of this static floor, 3x the adaptive noise floor, and the echo gates. Worse
// endpointing than Silero on quiet mics and soft trailing speech (fgbj) - but
// a VAD load failure must degrade the mic, never kill it.
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
// softly to move lastSpeechMs), so the final pass runs instead of reusing it.
// Deliberately below the VAD's own gates: a false positive costs one extra
// transcription, a false negative costs the user's words.
const TAIL_RETRANSCRIBE_PROB = 0.4;
const TAIL_RETRANSCRIBE_ENERGY = 0.015;

// Audio (ms) kept after the last even-slightly-speech-like frame before the
// final payload is POSTed (meditation-pal-0uw7). The submit fires only after
// silenceBaseMs..silenceMaxMs of silence (+INCOMPLETE_CLAUSE_EXTRA_MS on a
// dangling clause), and every one of those frames is in the buffer: several
// seconds of known quiet per turn that hosted STT would bill.
// The cut uses the TAIL_RETRANSCRIBE_* bar, not the VAD's own gate: that's the
// threshold the tail-recovery path already trusts to mean "there might be a
// soft word here", so anything it would have rescued survives - plus a full
// second after it. ⭐ TWEAK ME (up) if trailing words ever go missing.
const TAIL_KEEP_MS = 1000;
// Interior quiet inside a held turn (a mid-thought pause the dangling-clause
// hold waited through) is billed audio that carries no words. Runs of quiet
// chunks longer than COMPACT_GAP_MS are collapsed to COMPACT_KEEP_MS, split
// across both edges, before upload (submitPayload / compactQuietRuns). A chunk
// is "quiet" only when BOTH the energy and the Silero probability say so, and
// the energy bar sits below the hint bar on purpose: soft trailing words that
// never cleared the VAD gate (meditation-pal-rcdz) must survive. Measured
// 2026-09-05: a pause-heavy script billed 100s for 39s of speech, 46s of it
// held pauses.
const COMPACT_GAP_MS = 700;
const COMPACT_KEEP_MS = 400;
const COMPACT_QUIET_PROB = 0.2;
// Audio (ms) kept before the pre-buffer's first speech-hint frame (same
// TAIL_RETRANSCRIBE_* bar as the tail cut). On an ordinary turn most of the 2s
// pre-buffer is billed room tone; this also covers Silero's trigger debounce
// when the prefix has no hint. ⭐ TWEAK ME (up) if a first word ever clips.
const LEAD_KEEP_MS = 500;
// Incremental passes: a speculative pass ends at the quietest chunk of its
// last SEAM_SPAN_MS, where the next pass begins, so no audio goes twice and
// each seam falls in the quietest spot near the pause. No piece is cut
// shorter than this (submitPayload).
const SEAM_SPAN_MS = 500;
// The shortest final piece sent after a seam: OpenAI is believed to refuse a
// clip under about 0.1 s with a 400, and whisper.cpp returns nothing under
// 100 ms. A shorter one (a cap cut just past a seam) goes unsent, and the
// turn's text is the text so far.
const MIN_FINAL_PIECE_MS = 250;
// Speculative passes allowed per utterance - a runaway guard, and every pass
// bills. Keep it loose: the terminal pause's pass is roughly free (the final
// reuses it, and the transcription overlaps the silence window), so a cap the
// mid-turn pauses exhaust pushes a long turn's transcription (all of it on
// full passes, everything since the last pass on incremental ones) AFTER
// submit, right where the user is waiting.
const MAX_SPECULATIVE_PASSES = 6;

/** How soon a turn answering a question may end once a speculative pass has
 *  read it (expectAnswer): at that pass, after ANSWER_YES_PAUSE_MS of quiet,
 *  or (null) on the session's own pause. */
export type AnswerPace = 'now' | 'soon' | null;

type TranscribeResult =
    | { ok: true; text: string; seconds: number }
    | {
          ok: false;
          error: unknown;
          /** The pass carried x-stt-prior and its fetch rejected with no
           *  answer: what a server whose CORS allowlist predates the header
           *  does to every such request, and what a dropped connection looks
           *  like too. */
          priorUnanswered?: boolean;
      };

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
    /** Local-Whisper model size, sent as a query param so the desktop shell
     *  loads the matching whisper.cpp model. Local endpoint only - leave unset
     *  for aloud cloud. */
    whisperModelSize?: string | null;
    /** Session language (2-letter app code), sent as `lang`. The desktop shell
     *  keys the whisper model's language off it; the cloud route forwards it to
     *  the provider as a transcription hint. */
    language?: string | null;
    /** Hosted-model override, sent as a `model` query param the cloud /stt
     *  route validates against its backend's allowlist (e.g. 'gpt-transcribe').
     *  Cloud endpoint only - leave unset for the desktop endpoint and for the
     *  server-default model. A function is asked on each pass with the
     *  seconds of audio the pass sends, so the model can change under one
     *  capture (stt-picker.ts setupHostedChoice) or by the pass's length
     *  (stt-picker.ts HYBRID_GPT_MAX_SEC). */
    cloudModel?: string | null | ((passSec: number) => string | null);
    /** Given the model a pass asked for, the model it is sent to once more,
     *  with the same audio, when the server answers with a provider error
     *  (PROVIDER_ERROR_STATUS); null for none. Once per pass, speculative or
     *  final, and the pass stays on that model for any re-send after it. Not
     *  on a dropped connection, a timeout or an abort. */
    cloudFallback?: ((model: string) => string | null) | null;
    /** Whisper initial prompt, sent as `prompt` on every pass: words the
     *  listener expects, which Whisper favors where the audio is ambiguous.
     *  Local endpoint only (stt-picker.ts localWhisperStt). */
    initialPrompt?: string | null;
    /** The setup screen's listener (voice-start.ts), sent as `setup=1` on
     *  every pass. The cloud /stt route builds its own prompt from it, so the
     *  hosted engine sends this instead of `initialPrompt`. */
    setupListening?: boolean;
    /** The energy a frame must clear, besides the echo gates, to count as
     *  speech while a line plays (setTtsActive). Default BARGE_IN_THRESHOLD. */
    overLineBar?: number;
    /** minSpeechDurationMs for a turn begun while a line plays. Default
     *  minSpeechDurationMs. */
    overLineMinSpeechMs?: number;
    /** The longest pause that ends a turn begun while a line plays. Default
     *  none: the adaptive window alone. */
    overLineSilenceMs?: number;
    /** How long after a frame cleared the bar while a line plays a frame
     *  under it still counts, if Silero calls it speech. Silero's verdict
     *  trails a word's loudest part, so the two need not fall on one frame.
     *  Default 0: both on the same frame. */
    overLineLatchMs?: number;
    /** Hard cap on a single utterance - auto-submit after this. Default 120s.
     *  A runaway valve (background speech can hold the VAD open forever), NOT a
     *  conversational boundary: it cuts mid-sentence and the post-cut hole grows
     *  with buffer length (only the 2s pre-buffer survives the final pass's
     *  latency), so it must sit well past any real ramble. Raising it mostly
     *  costs final-pass latency at submit. */
    maxUtteranceMs?: number;
    /** Speculative passes on mid-utterance pauses (the live preview, and the
     *  dangling-clause verdict that extends the silence window). Default on.
     *  Off, a turn costs exactly one transcription - the cheapest way to
     *  use hosted STT - at the price of no preview and a turn that can be cut
     *  at a mid-thought pause the VAD alone can't tell from an ending. */
    speculation?: boolean;
    /** Send each pass only the audio the passes before it have not
     *  transcribed, with the turn's text so far as the model's prompt (the
     *  `x-stt-prior` header), and join the replies (stt-stitch.ts). Default
     *  off: every pass sends the turn from its start. For a model that takes
     *  a prompt (stt-picker.ts incrementalFor). The first pass with a prior
     *  that gets no answer turns it off for the engine's life (a server
     *  older than the header refuses it at CORS). */
    incremental?: boolean;
    /** Buffered audio (ms) past which a speculative pass waits for the late
     *  trigger. Default SPEC_EARLY_MAX_BUFFER_MS. */
    specEarlyMaxBufferMs?: number;
    /** How long the final pass re-sends through a dropped connection
     *  (net-retry.ts). Default 0 (no retry); hosted STT sets
     *  CLOUD_FINAL_RETRY_BUDGET_MS. */
    finalRetryBudgetMs?: number;
    /** Collapse long interior silences in the uploaded payload (default on).
     *  Off exists for A/B measurement (soak harness), not as a user setting. */
    compactSilence?: boolean;
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
    /** The stream a stop() was asked to keep (keepMicUntil): let go once every
     *  promise it was kept for has settled, unless the next open takes it back. */
    private kept: { stream: MediaStream; waiting: number; cap?: ReturnType<typeof setTimeout> } | null = null;
    /** Waiting for the next frame the capture delivers (whenLive). */
    private liveWaiters: Array<() => void> = [];
    /** Waiting for the next frame with sound in it (whenHearing). */
    private hearingWaiters: Array<() => void> = [];
    /** When a frame last cleared the bar while a line played (isSpeechFrame). */
    private overBarAt = -Infinity;
    /** A capture being opened with no other of ours open (coldOpening). */
    private coldOpen: { settled: Promise<void>; since: number; heard: boolean; end: () => void } | null = null;
    private processor: ScriptProcessorNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stopRequested = false;
    /** Bumped by every stop(), so work that awaited across one can tell its
     *  teardown already ran (openCaptureGraph, start). */
    private stopSeq = 0;
    /** Which utterance a transcription pass belongs to (stt-clip-recorder.ts). */
    private turnSeq = 0;
    /** A pass with x-stt-prior got no answer (TranscribeResult
     *  priorUnanswered): every pass after it, for the engine's life, is a
     *  full pass. */
    private incrementalOff = false;

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
    // The max utterance cap ended this turn. Never reopened on
    // postSubmitSpeech: speechStartMs is unchanged, so the next frame trips the
    // cap again and every pass re-sends (and bills) the whole growing buffer.
    private hitMaxUtterance = false;
    // Loudest speech frame this utterance - diagnostic (how loud this user/mic
    // runs; informs the echo-gate margins).
    private peakEnergy = 0;
    /** The peak of the turn last submitted (lastTurnClearOfEcho). */
    private lastTurnPeak = 0;
    /** The loudest a line has been at this mic with nobody speaking over it:
     *  the device's echo as measured. Null until one has played through. */
    private quietLineEcho: number | null = null;
    // Latest speculative transcript ends in a dangling clause. Set by the
    // polling loop in start(), read by the audio callback to extend the silence
    // window (INCOMPLETE_CLAUSE_EXTRA_MS).
    private partialIncomplete = false;
    // A speculative transcription is mid-flight. The audio callback won't
    // finalize while true, so the dangling-clause verdict always arrives before
    // submit - otherwise a slow network pass lets the adaptive window cut the
    // turn first, which is the cloud-STT mid-sentence cutoff (kkiz). The
    // maxUtterance runaway valve is deliberately NOT gated on this.
    private specInFlight = false;
    // Rolling per-frame energy + neural prob (-1 when Silero is off), ~85ms per
    // frame at 48 kHz, for the submit diagnostic: peak/threshold alone can't
    // show what the detector heard during the trailing "silence" (soft speech
    // vs breath vs true quiet).
    private energyHistory: { t: number; e: number; p: number }[] = [];
    // Chunk count as of the last frame that looked even slightly speech-like
    // (TAIL_RETRANSCRIBE_* bar). The trailing quiet past it is trimmed off the
    // billed payload - see TAIL_KEEP_MS and submitPayload().
    private lastHintChunk = 0;
    // lastHintChunk as it stood when the turn was submitted. Frames kept after
    // the submit move lastHintChunk too, and a breath there must not cost an
    // incremental final the speculative text would have covered.
    private hintAtSubmit = 0;
    // Per-chunk energy + Silero probability, aligned with `chunks`, for the
    // interior-quiet compaction. Pre-buffer frames carry p = -1 (no verdict).
    private chunkMeta: { e: number; p: number }[] = [];
    // How many of chunks' leading frames came from the onset pre-buffer,
    // recorded when speech starts. Only that prefix is scanned for the leading
    // quiet cut (LEAD_KEEP_MS) - everything after it is VAD-vetted.
    private prependedPreFrames = 0;
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
    // ECHO_WARMUP_GATE: armed by each new capture stream, live from the first
    // noteVoicePlayback() after it for ECHO_WARMUP_MS of audible voice
    // (warmupVoiceMs) or until that playback window ends (setTtsActive),
    // whichever is first. warmupPeak is diagnostic only.
    private voiceWarmupArmed = false;
    private voiceWarmup = false;
    private warmupVoiceMs = 0;
    private warmupPeak = 0;
    // A voice line is playing (noteVoicePlayback to notePlaybackEnded), the
    // loudest frame the mic heard while it did, and when it last ended.
    // voiceAudible: its audio has begun (noteVoiceAudible).
    private lineSounding = false;
    private voiceAudible = false;
    private lineEchoPeak = 0;
    private lineEndedAt: number | null = null;
    // expectAnswer: how soon an answer read so far may end its turn, until
    // when (performance clock), whether the last pass read a plain yes with
    // nothing said since (ANSWER_YES_PAUSE_MS), and what the mic heard over
    // the question's tail before the answer's speech began (diagnostic).
    private answer: {
        pace: (text: string) => AnswerPace;
        until: number;
        soon: boolean;
        tailPeak: number;
        tailPeakAt: number;
    } | null = null;
    // Per-playback echo stats, logged when playback ends (setTtsActive). Null
    // between replies. Diagnostic only - nothing reads it.
    private echoWatch: { frames: number; overGate: number; peak: number; sum: number; spoken: boolean } | null =
        null;
    // Mic level per frame for the second after playback ends: how fast this
    // device's speaker echo dies away, the measurement behind the session's
    // PLAYBACK_TAIL_MS (qaqb). Null when not watching. Diagnostic only.
    private tailWatch: number[] | null = null;
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
            cloudFallback: options.cloudFallback ?? null,
            initialPrompt: options.initialPrompt ?? null,
            setupListening: options.setupListening ?? false,
            silenceBaseMs: options.silenceBaseMs ?? defaultPacingConfig.silenceBaseMs,
            silenceMaxMs: options.silenceMaxMs ?? defaultPacingConfig.silenceMaxMs,
            silenceRampRate: options.silenceRampRate ?? defaultPacingConfig.silenceRampRate,
            minSpeechDurationMs:
                options.minSpeechDurationMs ?? defaultPacingConfig.minSpeechDurationMs,
            overLineBar: options.overLineBar ?? BARGE_IN_THRESHOLD,
            overLineMinSpeechMs:
                options.overLineMinSpeechMs ?? options.minSpeechDurationMs ?? defaultPacingConfig.minSpeechDurationMs,
            overLineSilenceMs: options.overLineSilenceMs ?? Infinity,
            overLineLatchMs: options.overLineLatchMs ?? 0,
            maxUtteranceMs: options.maxUtteranceMs ?? 120_000,
            speculation: options.speculation ?? true,
            incremental: options.incremental ?? false,
            specEarlyMaxBufferMs: options.specEarlyMaxBufferMs ?? SPEC_EARLY_MAX_BUFFER_MS,
            compactSilence: options.compactSilence ?? true,
            finalRetryBudgetMs: options.finalRetryBudgetMs ?? 0,
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
            // Loaded but inference doesn't run on this machine (silero-vad.ts
            // `broken`): treat like a load failure - energy decision.
            if (vad.broken) {
                this.silero = null;
                return;
            }
            if (this.silero !== vad) {
                vad.reset();
                this.silero = vad;
            }
        } catch (err) {
            this.silero = null;
            console.warn('[vad] silero unavailable - using the energy speech decision:', err);
        }
    }

    private get incremental(): boolean {
        return this.opts.incremental && !this.incrementalOff;
    }

    /** Whether mic capture is plausibly available. Probing the server needs a
     *  request, so that's the caller's problem. */
    static isAvailable(): boolean {
        return (
            typeof navigator !== 'undefined' &&
            !!navigator.mediaDevices?.getUserMedia &&
            audioContextCtor() !== undefined
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

    /** Append a captured frame to the utterance, remembering where the last
     *  possible speech was so submitPayload() can cut the quiet after it. */
    private keepChunk(frame: Float32Array, energy: number): void {
        this.chunks.push(frame);
        const prob = this.silero ? this.silero.lastProb : -1;
        this.chunkMeta.push({ e: energy, p: prob });
        if (energy >= TAIL_RETRANSCRIBE_ENERGY || prob >= TAIL_RETRANSCRIBE_PROB) {
            this.lastHintChunk = this.chunks.length;
        }
    }

    /**
     * The frames one pass sends: chunk `from` onward with the trailing quiet
     * cut (past the last speech-hint chunk + TAIL_KEEP_MS) and, from the
     * turn's start, the leading quiet (the pre-buffer before its first hint +
     * LEAD_KEEP_MS, energy-only - Silero probs aren't retained for the
     * prefix). A piece from a seam starts on it: the seam is already quiet.
     *
     * `seamCut` (an incremental speculative pass) pulls the end back to the
     * quietest chunk of the last SEAM_SPAN_MS, returned as `seam`, where the
     * next pass starts. Null when every such chunk would leave a piece shorter
     * than SEAM_SPAN_MS: the piece then runs to the end and moves no seam.
     *
     * Never mutates the buffer: a reopened utterance (rcdz) has to stay
     * contiguous.
     */
    private submitPayload(
        from: number,
        seamCut: boolean
    ): { frames: readonly Float32Array[]; seam: number | null } {
        const rate = this.context?.sampleRate;
        if (!rate) return { frames: this.chunks.slice(from), seam: null };
        const framesIn = (ms: number) => Math.ceil(((ms / 1000) * rate) / FRAME_SIZE);
        let end = this.chunks.length;
        if (this.lastHintChunk > 0) end = Math.min(end, this.lastHintChunk + framesIn(TAIL_KEEP_MS));
        let start = from;
        const prefix = from === 0 ? Math.min(this.prependedPreFrames, end) : 0;
        if (prefix > 0) {
            // No hint anywhere in the prefix: speech began right where the VAD
            // tripped (prefix end), so keep only the onset margin before it.
            let firstHint = prefix;
            for (let i = 0; i < prefix; i++) {
                if (frameRms(this.chunks[i]!) >= TAIL_RETRANSCRIBE_ENERGY) {
                    firstHint = i;
                    break;
                }
            }
            start = Math.max(0, firstHint - framesIn(LEAD_KEEP_MS));
        }
        let seam: number | null = null;
        if (seamCut) {
            const span = framesIn(SEAM_SPAN_MS);
            let quietest = Infinity;
            for (let i = end - 1; i >= end - span && i > start + span; i--) {
                if (this.chunkMeta[i]!.e < quietest) {
                    quietest = this.chunkMeta[i]!.e;
                    seam = i;
                }
            }
            if (seam !== null) end = seam;
        }
        const secs = (frames: number) => ((frames * FRAME_SIZE) / rate).toFixed(1);
        const chunkMs = (FRAME_SIZE / rate) * 1000;
        let ranges: Array<[number, number]> = [[start, end]];
        if (this.opts.compactSilence && end > start) {
            const quietEnergy = Math.min(TAIL_RETRANSCRIBE_ENERGY, Math.max(NOISE_FLOOR_SEED * 2, this.noiseFloor * 2));
            const quiet = this.chunkMeta
                .slice(start, end)
                .map((m) => m.e < quietEnergy && (m.p < 0 || m.p < COMPACT_QUIET_PROB));
            ranges = compactQuietRuns(
                quiet,
                Math.round(COMPACT_GAP_MS / chunkMs),
                Math.round(COMPACT_KEEP_MS / chunkMs)
            ).map(([a, b]) => [a + start, b + start]);
        }
        const kept = ranges.reduce((n, [a, b]) => n + (b - a), 0);
        if (ranges.length === 1 && start === 0 && end >= this.chunks.length) {
            return { frames: this.chunks, seam };
        }
        diag(
            `[stt-cost] trim ${from > 0 ? `piece from=${secs(from)}s` : `lead=${secs(start)}s`} ` +
                `tail=${secs(this.chunks.length - end)}s ` +
                `compacted=${secs(end - start - kept)}s in ${ranges.length - 1} gap(s) ` +
                `payload=${secs(kept)}s of ${secs(this.chunks.length)}s buffered`
        );
        if (ranges.length === 1) return { frames: this.chunks.slice(start, end), seam };
        const out: Float32Array[] = [];
        for (const [a, b] of ranges) for (let i = a; i < b; i++) out.push(this.chunks[i]!);
        return { frames: out, seam };
    }

    private echoGateLevel(): number {
        return Math.min(this.echoFloor * ECHO_GATE_MARGIN, ECHO_GATE_MAX);
    }

    /** The echo gate as it stands: 0 with no TTS audible. */
    private echoGateNow(): number {
        if (!this.ttsActive) return 0;
        const gate = this.echoGateLevel();
        return this.voiceWarmup ? Math.max(gate, ECHO_WARMUP_GATE) : gate;
    }

    /** The energy a frame must clear to count as the meditator's voice while
     *  the facilitator may be heard (overLineBar: barge-in grade unless the
     *  setup screen lowers it), or 0 when the echo gate
     *  is down and Silero's verdict decides alone. Lower over the tail of a
     *  question an answer is expected to (ANSWER_ECHO_MARGIN). */
    private speechBar(echoGate: number): number {
        if (echoGate === 0) return 0;
        const bar = Math.max(echoGate, this.opts.overLineBar);
        return this.answer && !this.lineSounding ? Math.min(bar, this.answerBar()) : bar;
    }

    private answerBar(): number {
        return Math.max(ANSWER_BAR_FLOOR, this.lineEchoPeak * ANSWER_ECHO_MARGIN);
    }

    /** Per-frame speech decision. With the model up: Silero's debounced
     *  verdict, plus the energy bar while TTS plays (echo IS speech to Silero,
     *  so speaker separation needs the energy reference - 8h1x). Degraded
     *  (silero null): the energy gate over the adaptive noise floor. */
    private isSpeechFrame(energy: number, bar: number, now: number): boolean {
        if (this.silero) {
            if (bar === 0) return this.silero.speaking;
            if (energy > bar) this.overBarAt = now;
            return this.silero.speaking && now - this.overBarAt <= this.opts.overLineLatchMs;
        }
        let threshold = Math.max(FALLBACK_ENERGY_THRESHOLD, this.noiseFloor * 3);
        if (bar > 0) threshold = Math.max(threshold, bar);
        return energy > threshold;
    }

    /**
     * Whether the turn last submitted was too loud to be a line's echo:
     * ECHO_CLEAR_MARGIN over the loudest any line has measured here with
     * nobody speaking. False until a line has played through unspoken over.
     * Where the canceller leaves nothing (0.0001 on a phone against a voice at
     * 0.065), a name or "back" said over a line that says it too is the
     * person's; where it leaks, the caller's check of the words still stands.
     */
    lastTurnClearOfEcho(): boolean {
        if (this.quietLineEcho === null) return false;
        return this.lastTurnPeak > Math.max(this.opts.overLineBar, this.quietLineEcho * ECHO_CLEAR_MARGIN);
    }

    /** Speech so far is short enough to be the answer expectAnswer waits for. */
    private answerSized(): boolean {
        return this.answer !== null && this.lastSpeechMs - this.speechStartMs <= ANSWER_MAX_SPEECH_MS;
    }

    /** The submit decision: the turn's audio is complete, the final pass may
     *  run. `how` marks a turn that ended as an answer (expectAnswer). */
    private endUtterance(now: number, needed: number, how: 'pause' | 'answer'): void {
        this.utteranceDone = true;
        this.lastTurnPeak = this.peakEnergy;
        this.hintAtSubmit = this.lastHintChunk;
        const speechDur = this.lastSpeechMs - this.speechStartMs;
        diag(
            `[vad] submit speech=${Math.round(speechDur)}ms ` +
                `needed=${Math.round(needed)}ms silence=${Math.round(now - this.lastSpeechMs)}ms ` +
                `peak=${this.peakEnergy.toFixed(3)} ` +
                `echoFloor=${this.echoFloor.toFixed(4)} ` +
                `dropped=${this.silero?.droppedChunks ?? 0} ` +
                `dangling=${this.partialIncomplete} ` +
                `mode=${this.silero ? 'silero' : `energy(floor=${this.noiseFloor.toFixed(4)})`}` +
                (this.answer
                    ? ` answer=${how === 'answer' ? 'early' : this.answer.soon ? 'yes-pause' : 'full-pause'}`
                    : '')
        );
        // Energy + speech-prob traces, last 8s in 0.5s buckets (max per
        // bucket, oldest first). The prob row shows what the model thought
        // during the trailing "silence" - held speech vs a real pause; the
        // energy row contextualizes the echo gate.
        if (diagOn()) {
            const tail = (pick: (h: { e: number; p: number }) => number, floor: number) => {
                const buckets = new Array<number>(16).fill(floor);
                for (const h of this.energyHistory) {
                    const idx = Math.floor((now - h.t) / 500);
                    if (idx >= 0 && idx < 16) buckets[idx] = Math.max(buckets[idx]!, pick(h));
                }
                return buckets.reverse();
            };
            diag(
                `[vad] tail 8s->now (max rms / 0.5s): ` +
                    tail((h) => h.e, 0).map((b) => b.toFixed(3)).join(' ')
            );
            if (this.silero) {
                diag(
                    `[vad] tail 8s->now (max speech-prob / 0.5s): ` +
                        tail((h) => h.p, -1)
                            .map((v) => (v < 0 ? '----' : v.toFixed(2)))
                            .join(' ')
                );
            }
        }
    }

    /** Trailing silence that ends the turn. Adaptive: each ms of speech buys
     *  silenceRampRate ms of patience, capped at silenceMaxMs, plus the
     *  dangling-clause extension. No longer than ANSWER_YES_PAUSE_MS after an
     *  answer read as a plain yes, or overLineSilenceMs for a turn begun
     *  while a line played. */
    private submitWindowMs(): number {
        const speechDur = this.lastSpeechMs - this.speechStartMs;
        const adaptive = Math.min(
            this.opts.silenceBaseMs + speechDur * this.opts.silenceRampRate,
            this.opts.silenceMaxMs
        );
        if (this.answer?.soon) return Math.min(adaptive, ANSWER_YES_PAUSE_MS);
        const window = adaptive + (this.partialIncomplete ? INCOMPLETE_CLAUSE_EXTRA_MS : 0);
        return this.startedWhileTtsActive ? Math.min(window, this.opts.overLineSilenceMs) : window;
    }

    /** Continuous audio callback - runs for the engine's whole lifetime. */
    private handleAudio = (e: AudioProcessingEvent): void => {
        if (this.stopRequested) return;
        for (const resolve of this.liveWaiters.splice(0)) resolve();
        const data = e.inputBuffer.getChannelData(0);
        const frame = new Float32Array(data);
        const energy = frameRms(frame);
        const now = performance.now();
        if (energy >= SILENT_FRAME_RMS) {
            for (const resolve of this.hearingWaiters.splice(0)) resolve();
            if (this.coldOpen) this.coldOpenHeard(now);
            noteCaptureHearing();
        }

        this.levelListener?.(energy);

        // Inference stopped working mid-stream (repeated run() failures -
        // silero-vad.ts): drop the model NOW rather than at the next start(),
        // or `speaking` stays false and this utterance is deaf.
        if (this.silero?.broken) {
            console.warn('[vad] silero broken mid-stream - using the energy speech decision');
            this.silero = null;
        }

        // Feed the neural VAD every frame, capturing or not - its recurrent
        // state assumes an unbroken stream, and classifying during idle keeps
        // `speaking` current for the moment capture flips on.
        this.silero?.feed(frame, this.nativeRate);

        // While TTS is audible, lift the gates above this device's measured echo
        // floor. Zero otherwise (no echo to reject), so a silent gap keeps the
        // normal sensitive thresholds. Capped below real-speech level, except
        // while the canceller warms up to the voice (ECHO_WARMUP_GATE).
        const echoGate = this.echoGateNow();
        if (this.voiceWarmup && this.ttsActive) this.warmupPeak = Math.max(this.warmupPeak, energy);
        if (this.voiceWarmup && this.voiceAudible) {
            this.warmupVoiceMs += (frame.length / this.nativeRate) * 1000;
            if (this.warmupVoiceMs >= ECHO_WARMUP_MS) this.endVoiceWarmup('on time');
        }
        if (this.lineSounding) this.lineEchoPeak = Math.max(this.lineEchoPeak, energy);
        if (this.answer && now >= this.answer.until) {
            diag('[vad] answer: window closed with no answer');
            this.answer = null;
        }
        const speechBar = this.speechBar(echoGate);

        if (this.tailWatch) {
            this.tailWatch.push(energy);
            if (this.tailWatch.length * FRAME_SIZE >= this.nativeRate) {
                diag(
                    `[vad] after playback, rms per ${Math.round((FRAME_SIZE / this.nativeRate) * 1000)}ms: ` +
                        this.tailWatch.map((e) => e.toFixed(3)).join(' ')
                );
                this.tailWatch = null;
            }
        }

        if (this.echoWatch) {
            const w = this.echoWatch;
            w.frames++;
            w.sum += energy;
            w.peak = Math.max(w.peak, energy);
            if (energy > Math.max(echoGate, BARGE_IN_THRESHOLD)) w.overGate++;
            if (this.speechStarted) w.spoken = true;
        }

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
                    // tts=true here means the facilitator was audible when this
                    // fired, i.e. it may be the facilitator interrupting itself
                    // rather than the user (meditation-pal-oxmt).
                    diag(
                        `[vad] barge-in energy=${energy.toFixed(4)} ` +
                            `gate=${echoGate.toFixed(4)} echoFloor=${this.echoFloor.toFixed(4)} ` +
                            `prob=${this.silero ? this.silero.lastProb.toFixed(2) : 'n/a'} ` +
                            `tts=${this.ttsActive}`
                    );
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
            // pre-buffer stays warm for the no-resume case. A cap cut never
            // resumes, so its frames go to the pre-buffer only: kept here too,
            // the ones before the final pass snapshots would be sent twice.
            if (this.isSpeechFrame(energy, speechBar, now)) {
                this.postSubmitSpeech = true;
                this.lastSpeechMs = now;
                this.peakEnergy = Math.max(this.peakEnergy, energy);
            }
            if (!this.hitMaxUtterance) this.keepChunk(frame, energy);
            this.pushPre(frame);
            return;
        }

        this.energyHistory.push({ t: now, e: energy, p: this.silero ? this.silero.lastProb : -1 });
        while (this.energyHistory.length > 0 && now - this.energyHistory[0]!.t > 10_000) {
            this.energyHistory.shift();
        }

        // The barge-in-grade energy bar during TTS (isSpeechFrame) prevents a
        // session-start phantom turn (8h1x): greeting echo at ~0.016 RMS
        // clears a 0.015 floor before the echo EMA has calibrated.
        if (this.isSpeechFrame(energy, speechBar, now)) {
            if (!this.speechStarted) {
                this.speechStarted = true;
                this.startedWhileTtsActive = this.ttsActive;
                this.speechStartMs = now;
                if (this.answer) {
                    const after = this.lineEndedAt === null ? '' : ` +${Math.round(now - this.lineEndedAt)}ms after the question,`;
                    diag(
                        `[vad] answer: speech began${after} rms=${energy.toFixed(4)} ` +
                            `bar=${speechBar.toFixed(4)} tts=${this.ttsActive}`
                    );
                }
                // Prepend the retained onset ramp, then clear it.
                for (const f of this.preBuffer) {
                    this.chunks.push(f);
                    this.chunkMeta.push({ e: frameRms(f), p: -1 });
                }
                this.prependedPreFrames = this.preBuffer.length;
                this.preBuffer.length = 0;
            }
            this.lastSpeechMs = now;
            this.peakEnergy = Math.max(this.peakEnergy, energy);
            // New speech supersedes the dangling-clause verdict, or a turn
            // that spent its spec passes early would carry a stale
            // dangling=true into its real ending and wait the extra window
            // over dead silence. The same for a yes read before these words:
            // "yes... no, not yet" is not a yes.
            this.partialIncomplete = false;
            if (this.answer) this.answer.soon = false;
            this.keepChunk(frame, energy);
        } else if (this.speechStarted) {
            this.keepChunk(frame, energy);
            const needed = this.submitWindowMs();
            // Hold the submit while a speculative pass resolves: it may be about
            // to extend `needed` (see specInFlight, kkiz).
            if (now - this.lastSpeechMs >= needed && !this.specInFlight) this.endUtterance(now, needed, 'pause');
        } else if (this.ttsActive) {
            // Capturing, pre-speech, TTS audible - this energy is the device's
            // echo, not the user. Fold it into the echo floor so the gates above
            // can reject it.
            this.echoFloor = (1 - ECHO_EMA_ALPHA) * this.echoFloor + ECHO_EMA_ALPHA * energy;
            if (this.answer && !this.lineSounding && energy > this.answer.tailPeak) {
                this.answer.tailPeak = energy;
                this.answer.tailPeakAt = now;
            }
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
            diag(
                `[vad] submit: max utterance cap reached (${this.opts.maxUtteranceMs}ms)`
            );
            this.utteranceDone = true;
            this.hintAtSubmit = this.lastHintChunk;
            this.hitMaxUtterance = true;
        }
    };

    /**
     * Open the mic stream, AudioContext, and continuous audio graph if they
     * aren't already up. Idempotent - reuses a live stream/context/processor
     * across turns (re-acquiring is slow enough to clip a barge-in's first
     * second). Throws on permission denial or a missing AudioContext. Shared
     * by start() and prime().
     *
     * One opening at a time: prime() and the first start() arrive together at
     * session start, and each used to call getUserMedia for itself. The last
     * stream assigned won and the others were never stopped, so the mic stayed
     * claimed after the session, and each extra echo-cancelled open made macOS
     * rebuild its voice-processing audio again (heard as a drop-out in sound
     * already playing).
     */
    private ensureCaptureGraph(): Promise<void> {
        this.graphOpening ??= this.openCaptureGraph().finally(() => {
            this.graphOpening = null;
        });
        return this.graphOpening;
    }
    private graphOpening: Promise<void> | null = null;

    private async openCaptureGraph(): Promise<void> {
        // stop() can land at any await below: a foreground rebuild
        // (restartSttAfterForeground) stops this engine wherever it is, and iOS
        // holds getUserMedia and resume() while the app is inactive, so the
        // notification shade opens a wide window. Its teardown has already
        // run, so carrying on would read the context it nulled and claim a mic
        // nothing will release. Bail instead; start() ends the turn quietly.
        const seq = this.stopSeq;
        const stopped = (): boolean => seq !== this.stopSeq;
        this.reuseKept();
        if (streamNeedsRefresh(this.stream)) {
            // Says WHY we re-acquired, which is the whole signal when verifying
            // the backgrounding fix on a device (meditation-pal-wudm): a
            // replacing/muted line after a foreground is the fix doing its job,
            // and its absence means the track came back healthy on its own.
            const stale = this.stream?.getAudioTracks()[0];
            diag(
                stale
                    ? `[vad] replacing capture stream: muted=${String(stale.muted)} ` +
                          `readyState=${stale.readyState} active=${String(this.stream?.active)}`
                    : '[vad] acquiring capture stream'
            );
            // Stop whatever we were holding first. A stream can need replacing
            // while its tracks are still live (the muted case below), and those
            // tracks keep the mic claimed if we only drop the reference.
            this.releaseStream();
            // On native mobile the WebView only grants getUserMedia audio once
            // the app holds RECORD_AUDIO, which nothing else on this cloud path
            // requests, so pre-flight it (no-op elsewhere, mic-permission.ts).
            await ensureMicPermission();
            if (stopped()) return;
            if (!captureLive()) this.beginColdOpen();
            // echoCancellation matters more than usual here: this stream stays
            // live across turns, so it fills the onset pre-buffer WHILE TTS
            // plays. Without EC the pre-buffer captures the speakers, and a
            // barge-in would prepend the facilitator's own words to the user's
            // utterance before sending it to Whisper. Matches barge-in.ts.
            const stream = await navigator.mediaDevices
                .getUserMedia({
                    audio: {
                        ...(this.opts.micDeviceId
                            ? { deviceId: { ideal: this.opts.micDeviceId } }
                            : {}),
                        echoCancellation: !isAecOffDebug(),
                        // macOS's voice processing includes a noise gate that can
                        // hard-zero soft speech MID-UTTERANCE - observed as RMS
                        // exactly 0.000 for seconds while the user was still
                        // talking, Whisper returning [BLANK_AUDIO] for spans that
                        // had words. The gate is tied to noise suppression, not echo
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
                    this.endColdOpen();
                    throw err;
                });
            if (stopped()) {
                for (const track of stream.getTracks()) track.stop();
                this.endColdOpen();
                return;
            }
            this.stream = stream;
            noteCaptureOpened(stream, () => !streamNeedsRefresh(stream));
            this.teardownGraph(); // any prior nodes belong to a dead stream
            this.voiceWarmupArmed = true;

            // Diagnose + self-heal capture-track death: a dead track keeps the
            // graph "running" but feeds digital zeros, so the session goes deaf
            // with no error anywhere. Seen alongside WebKit's "capture
            // MediaStreamTrack was destroyed without having been stopped"
            // warning. 'mute'/'unmute' are logged for the same investigation.
            const track = stream.getAudioTracks()[0];
            // Did the platform honor the constraints? WebKit may bundle NS into
            // its voice-processing unit and ignore ns=false; this log is how we
            // find out.
            if (track?.getSettings) {
                const s = track.getSettings();
                diag(
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
                diag('[vad] capture track unmuted');
            });
        }

        const AC = audioContextCtor();
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
            if (stopped()) return;
        }

        // Wire the continuous graph once; it stays alive across turns.
        this.nativeRate = this.context.sampleRate;
        const stream = this.stream;
        if (!stream) throw new Error('capture stream unavailable');
        if (!this.processor) {
            this.preBufferFrames = Math.max(
                1,
                Math.round((PRE_BUFFER_MS / 1000) * this.nativeRate / FRAME_SIZE)
            );
            this.source = this.context.createMediaStreamSource(stream);
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
        const t0 = performance.now();
        const took = (what: string) => () =>
            diag(`[vad] prime: ${what} after ${Math.round(performance.now() - t0)}ms`);
        await Promise.allSettled([
            this.acquireSilero().finally(took('silero')),
            this.ensureCaptureGraph().finally(took('capture graph')),
        ]);
    }

    /** Settles at the next frame the capture delivers, while not stopped: the
     *  mic stream is open and audio is reaching the engine. */
    whenLive(): Promise<void> {
        return new Promise((resolve) => this.liveWaiters.push(resolve));
    }

    /** Settles at the next frame with sound in it, while not stopped. Later
     *  than whenLive on a capture opened afresh: its first frames are digital
     *  silence (SILENT_FRAME_RMS), and only this says words will be heard. */
    whenHearing(): Promise<void> {
        return new Promise((resolve) => this.hearingWaiters.push(resolve));
    }

    /**
     * A capture this engine is opening with no other capture of ours open
     * beside it: settles at its first frame with sound in it, or
     * COLD_OPEN_SETTLE_MAX_MS after it was asked for (on Android no sooner
     * than CALL_MODE_SETTLE_MS, coldOpenHeard). Null when no such open
     * is under way. On macOS that open starts voice processing, which rebuilds
     * the audio output, and on a Bluetooth headset it switches to call audio;
     * a line started meanwhile begins late and quiet (voice-start.ts hold).
     * Opened beside another capture, neither happens.
     */
    coldOpening(): Promise<void> | null {
        return this.coldOpen?.settled ?? null;
    }

    private beginColdOpen(): void {
        this.endColdOpen();
        let settle!: () => void;
        const settled = new Promise<void>((resolve) => (settle = resolve));
        const cap = setTimeout(() => this.endColdOpen(), COLD_OPEN_SETTLE_MAX_MS);
        this.coldOpen = {
            settled,
            since: performance.now(),
            heard: false,
            end: () => {
                clearTimeout(cap);
                settle();
            },
        };
    }

    /** The cold open's first frame with sound. That settles it, except on
     *  Android, where the output stays muted CALL_MODE_SETTLE_MS from the
     *  open however soon the mic hears. */
    private coldOpenHeard(now: number): void {
        const open = this.coldOpen;
        if (!open || open.heard) return;
        const wait = capacitorPlatform() === 'android' ? open.since + CALL_MODE_SETTLE_MS - now : 0;
        if (wait <= 0) return this.endColdOpen();
        open.heard = true;
        setTimeout(() => {
            if (this.coldOpen === open) this.endColdOpen();
        }, wait);
    }

    private endColdOpen(): void {
        const open = this.coldOpen;
        this.coldOpen = null;
        open?.end();
    }

    /** A stop() kept the capture stream and it is still good: the next start()
     *  takes it back, live at once, instead of opening the mic. */
    get micKept(): boolean {
        return !!this.kept && !streamNeedsRefresh(this.kept.stream);
    }

    /**
     * Register (or clear, with null) a barge-in callback, fired when the user's
     * voice is detected while the facilitator is speaking - used to cancel TTS.
     * Detected on this one echo-cancelled stream (BARGE_IN_THRESHOLD, d35).
     */
    setBargeInHandler(handler: (() => void) | null): void {
        this.bargeInHandler = handler;
    }

    /** The facilitator's voice (not a sound) is about to play: its speak() has
     *  begun, its audio may still be on its way (noteVoiceAudible). It ends
     *  any watch on the last playback's tail and any answer expected
     *  (expectAnswer), and the first one after a new capture stream opens the
     *  echo warm-up (ECHO_WARMUP_GATE) for ECHO_WARMUP_MS of audible voice. */
    noteVoicePlayback(): void {
        this.tailWatch = null;
        this.lineSounding = true;
        this.voiceAudible = false;
        this.lineEchoPeak = 0;
        // The question is no longer the last thing said: this line's gaps and
        // tail keep the full bar, and a yes to its own question is no answer
        // to the old one.
        if (this.answer) {
            diag('[vad] answer: another line began, none expected now');
            this.answer = null;
        }
        if (!this.voiceWarmupArmed) return;
        this.voiceWarmupArmed = false;
        this.voiceWarmup = true;
        this.warmupVoiceMs = 0;
        this.warmupPeak = 0;
    }

    private endVoiceWarmup(how: 'on time' | 'with playback'): void {
        this.voiceWarmup = false;
        diag(
            `[vad] voice warm-up over ${how} after ${(this.warmupVoiceMs / 1000).toFixed(1)}s of voice: ` +
                `peak=${this.warmupPeak.toFixed(4)} gate=${ECHO_WARMUP_GATE}`
        );
    }

    /** The line noteVoicePlayback announced is now audible (the TTS engine's
     *  onStart). The warm-up spends its time from here to notePlaybackEnded.
     *  Ignored outside a line. */
    noteVoiceAudible(): void {
        if (this.lineSounding) this.voiceAudible = true;
    }

    /** The facilitator's audio has stopped (the caller's echo hangover may
     *  still hold the gates up, setTtsActive). Until this is called after a
     *  line, its tail keeps the full bar even for an expected answer. */
    notePlaybackEnded(): void {
        if (!this.lineSounding) return;
        this.lineSounding = false;
        this.voiceAudible = false;
        this.lineEndedAt = performance.now();
    }

    /**
     * The facilitator has just asked a yes/no question. The next utterance (or
     * the one under way, if it has no speech yet) is taken as its answer for
     * `forMs`, until an utterance with words ends or another line starts
     * (noteVoicePlayback):
     * - Over the question's tail the bar for the meditator's voice drops to
     *   what the question's own echo allows (ANSWER_ECHO_MARGIN), so a soft
     *   word said right after it is not lost under the barge-in bar.
     * - Speculative passes run on it even with speculation off, and `pace`
     *   reads each one that has no speech after it: `now` ends the turn at
     *   that pass, `soon` after ANSWER_YES_PAUSE_MS of quiet (words said
     *   meanwhile join the turn), null on the adaptive pause. Past
     *   ANSWER_MAX_SPEECH_MS of speech it is a turn and none of this applies.
     * Nothing else about the speech test moves: the bar holds while any line
     * plays, and Silero still has to call it speech.
     */
    expectAnswer(pace: (text: string) => AnswerPace, forMs: number): void {
        const now = performance.now();
        this.answer = { pace, until: now + forMs, soon: false, tailPeak: 0, tailPeakAt: 0 };
        const ended = this.lineSounding
            ? 'question still playing'
            : this.lineEndedAt === null
              ? 'no question heard'
              : `question ended ${Math.round(now - this.lineEndedAt)}ms ago`;
        diag(
            `[vad] answer expected for ${Math.round(forMs / 1000)}s: ${ended}, ` +
                `its echo peak=${this.lineEchoPeak.toFixed(4)}, answer bar=${this.answerBar().toFixed(4)}`
        );
    }

    /**
     * Tell the engine whether the facilitator's audio is playing. While active,
     * capture energy is sampled into this device's echo floor (see ECHO_*) and
     * that floor gates the VAD/barge-in. The caller brackets this around actual
     * playback - NOT the silent "thinking" phase, where the user should still
     * interrupt at the normal threshold.
     */
    setTtsActive(active: boolean): void {
        if (active === this.ttsActive) return;
        if (active) {
            this.echoWatch = { frames: 0, overGate: 0, peak: 0, sum: 0, spoken: false };
        } else if (this.echoWatch) {
            // The decisive measurement for meditation-pal-oxmt: how loud this
            // device's echo actually was against the gates that are supposed to
            // reject it. On a working AEC peak sits near echoFloor and overGate
            // is 0; on a phone loudspeaker with no usable AEC, peak falls in
            // real-speech territory and overGate counts the frames that leaked.
            const w = this.echoWatch;
            this.echoWatch = null;
            if (!w.spoken && w.overGate === 0 && w.frames > 0) this.quietLineEcho = Math.max(this.quietLineEcho ?? 0, w.peak);
            const gate = this.echoGateLevel();
            diag(
                `[vad] tts window: frames=${w.frames} ` +
                    `peak=${w.peak.toFixed(4)} mean=${(w.frames ? w.sum / w.frames : 0).toFixed(4)} ` +
                    `overGate=${w.overGate} gate=${gate.toFixed(4)} ` +
                    `echoFloor=${this.echoFloor.toFixed(4)} bargeIn=${BARGE_IN_THRESHOLD}`
            );
        }
        // What the mic heard over the question's tail that did not open the
        // answer: a word lost there shows as a loud frame here.
        if (!active && this.answer && this.capturing && !this.speechStarted && this.lineEndedAt !== null) {
            const a = this.answer;
            diag(
                `[vad] answer: none began over the question's tail; loudest=${a.tailPeak.toFixed(4)}` +
                    (a.tailPeak > 0 ? ` at +${Math.round(a.tailPeakAt - this.lineEndedAt)}ms` : '') +
                    ` bar=${this.speechBar(this.echoGateNow()).toFixed(4)}`
            );
        }
        if (!active && this.voiceWarmup) this.endVoiceWarmup('with playback');
        this.ttsActive = active;
    }

    /** Transcribe a snapshot of captured frames - a speculative pass or the
     *  final submission. `label` feeds [stt-cost]: spec-vs-final is invisible
     *  server-side. On incremental passes `piece` says what precedes the
     *  frames: the turn's text so far, and how many seconds of sent audio it
     *  came from. */
    private async transcribe(
        frames: readonly Float32Array[],
        label: 'spec' | 'final',
        nativeRate: number,
        piece: { prior: string; fromSec: number } = { prior: '', fromSec: 0 }
    ): Promise<TranscribeResult> {
        const downsampled = downsampleLinear(concatFloat32(frames), nativeRate, TARGET_SAMPLE_RATE);
        // No samples → nothing to transcribe. A speculative pass can fire
        // before any frame accumulates (or just after a barge-in clears
        // them); POSTing an empty body just earns a 400 from the endpoint.
        if (downsampled.length === 0) return { ok: true, text: '', seconds: 0 };
        // Int16 on the wire (format=i16): the endpoints re-encode to
        // 16-bit anyway, so this halves the upload for free.
        const pcm16 = new Int16Array(downsampled.length);
        for (let i = 0; i < downsampled.length; i++) {
            const s = Math.max(-1, Math.min(1, downsampled[i]!));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        const prior = this.incremental ? priorHeader(piece.prior) : null;
        const seconds = downsampled.length / TARGET_SAMPLE_RATE;
        // The model this pass is on: the one asked for, then the fallback's
        // once a provider error moved it there (cloudFallback).
        let cloudModel =
            typeof this.opts.cloudModel === 'function' ? this.opts.cloudModel(seconds) : this.opts.cloudModel;
        let fellBack = false;
        let answered = false;
        try {
            // session_id groups the cloud cost report (the desktop ignores
            // it).
            const urlFor = (model: string | null): string => {
                const query = Object.entries({
                    session_id: getCloudSessionId(),
                    model_size: this.opts.whisperModelSize,
                    lang: this.opts.language,
                    model,
                    prompt: this.opts.initialPrompt,
                    setup: this.opts.setupListening ? '1' : null,
                })
                    .map(([k, v]) => (v ? `&${k}=${encodeURIComponent(v)}` : ''))
                    .join('');
                return `${this.opts.endpointUrl}?sample_rate=${TARGET_SAMPLE_RATE}&format=i16${query}`;
            };
            // The body is under the deadline too: a reply's headers can arrive
            // and its body never. A timeout ends the pass (never re-sent) and
            // aborts its fetch, so the stalled socket is let go.
            const ac = new AbortController();
            const timed = <T>(p: Promise<T>): Promise<T> =>
                withTimeout(p, TRANSCRIBE_TIMEOUT_MS, 'aloud cloud transcription timed out.', () => ac.abort());
            const send = (): Promise<Response> =>
                timed(
                    (async () => {
                        const headers: Record<string, string> = {
                            'content-type': 'application/octet-stream',
                        };
                        if (prior) headers['x-stt-prior'] = prior;
                        if (this.opts.authProvider) {
                            const token = await this.opts.authProvider();
                            if (token) headers['authorization'] = `Bearer ${token}`;
                        }
                        return this.opts.fetchImpl(urlFor(cloudModel), {
                            method: 'POST',
                            headers,
                            body: pcm16.buffer as ArrayBuffer,
                            signal: ac.signal,
                        });
                    })()
                );
            // Self-heal a stale token: one retry on a 401 (see onAuthError).
            const sendHealed = async (): Promise<Response> => {
                let res = await send();
                if (res.status === 401 && this.opts.authProvider && this.opts.onAuthError) {
                    await this.opts.onAuthError();
                    res = await send();
                }
                return res;
            };
            const sentAt = performance.now();
            const response = await sendWithNetworkRetry(
                async () => {
                    const res = await sendHealed();
                    // Inside the attempt, so a refused final moves to the
                    // fallback at once instead of re-sending to the model that
                    // refused it, and a dropped connection on the fallback is
                    // ridden out on the fallback.
                    const fallback =
                        res.status === PROVIDER_ERROR_STATUS && !fellBack && cloudModel
                            ? this.opts.cloudFallback?.(cloudModel)
                            : null;
                    if (!fallback) return res;
                    await timed(res.text()).catch(() => '');
                    console.warn(
                        `[stt] ${label} pass: ${cloudModel} answered ${res.status}, sent once more to ${fallback}`
                    );
                    cloudModel = fallback;
                    fellBack = true;
                    return sendHealed();
                },
                // No abort on stop(): the session also stops the engine to close
                // the mic for an unprompted line, and an in-flight final pass has
                // always outlived that (the listen loop drops it after a real
                // teardown or mute).
                {
                    budgetMs: label === 'final' ? this.opts.finalRetryBudgetMs : 0,
                    // A final with a prior that gets no answer is sent again
                    // at once as a full pass (start()'s pass), which rides
                    // out a dropped connection: an old server refuses the
                    // header every time, so waiting here only delays the turn.
                    retryRejections: !prior,
                    onRetry: (n, why) => console.warn(`[stt] final pass retry ${n} after ${why}`),
                }
            );
            answered = true;
            if (!response.ok) {
                const detail = await timed(response.text()).catch(() => '');
                return { ok: false, error: new Error(`Whisper endpoint ${response.status}: ${detail}`) };
            }
            const data = (await timed(response.json())) as {
                text?: string;
                error?: string;
                model?: unknown;
                route?: unknown;
            };
            if (data.error !== undefined) return { ok: false, error: new Error(data.error) };
            const text = (data.text ?? '').trim();
            // aloud cloud can answer a Parakeet pass from gpt-transcribe, and
            // says so (server routes/stt.ts); older servers and the desktop's
            // own Whisper name no model.
            const servedBy = typeof data.model === 'string' && data.model ? data.model : cloudModel;
            const route = typeof data.route === 'string' ? data.route : null;
            diag(`[stt-cost] ${label} billed=${seconds.toFixed(1)}s`);
            if (diagOn()) {
                const now = performance.now();
                diag(
                    `[stt-time] ${label} ${servedBy ?? 'default'}${fellBack ? ' fallback=1' : ''}` +
                        `${route ? ` route=${route}` : ''} ` +
                        `round-trip=${Math.round(now - sentAt)}ms ` +
                        `since-speech=${Math.round(now - this.lastSpeechMs)}ms`
                );
            }
            const turnText = withPiece(piece.prior, text);
            // Provenance for transcript anomalies: a user turn with no
            // matching [stt-text] line did not come from the mic.
            if (label === 'final') diag(`[stt-text] ${turnText.length} chars`);
            recordSttClip({
                turn: this.turnSeq,
                label,
                pcm16,
                text: turnText,
                from: piece.fromSec,
                model: servedBy,
                fallback: fellBack || route === 'fallback',
            });
            return { ok: true, text, seconds };
        } catch (err) {
            return { ok: false, error: err, priorUnanswered: !!prior && !answered && isNetworkFailure(err) };
        }
    }

    async *start(): AsyncIterable<SttEvent> {
        this.stopRequested = false;
        this.turnSeq++;
        const seq = this.stopSeq;
        try {
            // Silero is the preferred speech signal; a load failure leaves the
            // energy fallback in charge (acquireSilero swallows it), so only a
            // capture-graph failure is a hard error surfaced to the UI.
            await this.acquireSilero();
            // Stopped while the model loaded: open nothing. A capture opened
            // now is one no turn reads, under whatever plays next.
            if (this.stopSeq !== seq) return;
            await this.ensureCaptureGraph();
        } catch (err) {
            if (this.stopSeq !== seq) return; // stopped mid-open: see below
            yield { type: 'error', error: err };
            return;
        }
        // stop() landed while the graph was opening (openCaptureGraph): this
        // turn is over, not failed, and the context is gone.
        if (this.stopSeq !== seq || !this.context) return;
        const nativeRate = this.context.sampleRate;

        // Begin a fresh utterance. The pre-buffer + echo floor persist (warmed
        // between turns); only the per-utterance accumulators reset.
        this.chunks = [];
        this.speechStarted = false;
        this.startedWhileTtsActive = false;
        this.speechStartMs = 0;
        this.lastSpeechMs = 0;
        this.utteranceDone = false;
        this.postSubmitSpeech = false;
        this.hitMaxUtterance = false;
        this.peakEnergy = 0;
        this.energyHistory = [];
        this.lastHintChunk = 0;
        this.hintAtSubmit = 0;
        this.chunkMeta = [];
        this.prependedPreFrames = 0;
        this.partialIncomplete = false;
        this.specInFlight = false;
        if (this.answer) this.answer.soon = false;
        // Re-arm barge-in for the next idle period.
        this.bargeInFired = false;
        this.bargeInChunks = 0;
        this.capturing = true;

        // Audio seconds this turn has sent for transcription, every pass: on
        // hosted STT each one is billed, so the session tally reports the sum,
        // not just the final (m56t).
        let turnBilledSec = 0;
        // Incremental passes: the chunks before `seam` are transcribed, as
        // `textSoFar`, and a pass sends only what follows. Only a speculative
        // pass that comes back with words moves them, to where it cut its
        // piece. `seamSec` is the sent audio before the seam
        // (stt-clip-recorder.ts). On full passes the seam stays at 0.
        let seam = 0;
        let textSoFar = '';
        let seamSec = 0;
        // Last successful speculative transcript, reused by the end-of-turn
        // pass when no further speech arrives so a single-pause turn doesn't
        // re-transcribe the identical buffer (m56t).
        let lastSpecResult: { text: string; seconds: number } | null = null;
        /** One transcription pass from the seam. A speculative one ends at a
         *  new seam, `cut` (null: none, see submitPayload). */
        const pass = async (
            label: 'spec' | 'final'
        ): Promise<{ result: TranscribeResult; cut: number | null }> => {
            const payload = this.submitPayload(seam, this.incremental && label === 'spec');
            const sentMs = (payload.frames.reduce((n, f) => n + f.length, 0) / nativeRate) * 1000;
            // seam > 0 only on incremental passes.
            if (label === 'final' && seam > 0 && sentMs < MIN_FINAL_PIECE_MS) {
                diag(`[stt-cost] final piece of ${Math.round(sentMs)}ms not sent - 0s billed`);
                diag(`[stt-text] ${textSoFar.length} chars`);
                return { result: { ok: true, text: '', seconds: 0 }, cut: null };
            }
            const result = await this.transcribe(payload.frames, label, nativeRate, {
                prior: textSoFar,
                fromSec: seamSec,
            });
            if (result.ok) turnBilledSec += result.seconds;
            if (!result.ok && result.priorUnanswered) {
                // Full passes from here on (incrementalOff), and this turn
                // starts over: the pieces' text is no part of a full pass.
                this.incrementalOff = true;
                console.warn('[stt] a pass with x-stt-prior got no answer - full passes from here on');
                seam = 0;
                textSoFar = '';
                seamSec = 0;
                lastSpecResult = null;
                // No pass comes after the final to send the turn again.
                if (label === 'final') return pass('final');
            }
            return { result, cut: payload.seam };
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
            let specPasses = 0;
            // Loop, not a straight line: debounced speech AFTER the submit
            // decision (postSubmitSpeech - the user was still talking when the
            // adaptive window closed) REOPENS the utterance so the continuing
            // words join this turn (meditation-pal-rcdz). What's transcribed so
            // far is surfaced as a partial, and the passes after it send the
            // turn from its start again, or incrementally from the last
            // speculative pass's seam.
            for (;;) {
                while (!this.utteranceDone && !this.stopRequested) {
                    await new Promise<void>((r) => setTimeout(r, 200));
                    if (this.utteranceDone || this.stopRequested) break;
                    if (!this.speechStarted) continue;
                    const silence = performance.now() - this.lastSpeechMs;
                    // Late trigger on long buffers (specEarlyMaxBufferMs):
                    // mirror the audio callback's adaptive `needed` so the pass
                    // fires just ahead of the submit decision.
                    const bufferedMs = (this.chunks.length * FRAME_SIZE * 1000) / nativeRate;
                    // An expected answer is read at the first pause whatever
                    // the settings: that pass is what can end it early.
                    const answerSized = this.answerSized();
                    let specAfterMs = SPECULATIVE_SILENCE_MS;
                    if (bufferedMs > this.opts.specEarlyMaxBufferMs && !answerSized) {
                        specAfterMs = Math.max(
                            SPECULATIVE_SILENCE_MS,
                            this.submitWindowMs() - SPEC_TERMINAL_LEAD_MS
                        );
                    }
                    if (
                        (this.opts.speculation || answerSized) &&
                        silence >= specAfterMs &&
                        !this.specInFlight &&
                        this.lastSpeechMs !== lastSpecSpeechMs &&
                        specPasses < MAX_SPECULATIVE_PASSES
                    ) {
                        this.specInFlight = true;
                        specPasses += 1;
                        lastSpecSpeechMs = this.lastSpeechMs;
                        // Only this pass's own text may stand in for the final:
                        // an older one is missing what was said since.
                        lastSpecResult = null;
                        lastSpecAt = performance.now();
                        // submitPayload, not the raw buffer: the pre-buffer
                        // quiet bills on spec passes too (mid-utterance the
                        // tail cut is a no-op).
                        const { result, cut } = await pass('spec');
                        this.specInFlight = false;
                        // Drop the preview if the turn ended while it was in flight
                        // (the final pass will emit the authoritative text).
                        // Incrementally only words count: after an empty or
                        // wordless reply the next pass sends this piece again.
                        const incremental = this.incremental;
                        const heard =
                            result.ok && (incremental ? !isNonSpeechOnly(result.text) : !!result.text);
                        if (!this.utteranceDone && heard) {
                            const text = incremental ? withPiece(textSoFar, result.text) : result.text;
                            // Incrementally the text commits only with a seam
                            // to end the piece at. Without one it is shown, and
                            // the next pass sends the piece again.
                            if (!incremental) {
                                lastSpecResult = { text, seconds: result.seconds };
                            } else if (cut !== null) {
                                lastSpecResult = { text, seconds: result.seconds };
                                seam = cut;
                                seamSec += result.seconds;
                                textSoFar = text;
                            }
                            // Dangling clause → extra silence before submit (see
                            // INCOMPLETE_CLAUSE_EXTRA_MS).
                            this.partialIncomplete = transcriptLooksIncomplete(text);
                            emittedPartial = true;
                            // The answer expected, said whole, nothing said
                            // since: a no ends the turn now, a yes once a
                            // short pause has passed with nothing added.
                            if (this.answerSized() && this.lastSpeechMs === lastSpecSpeechMs) {
                                const pace = this.answer!.pace(text);
                                if (pace === 'now') {
                                    this.endUtterance(performance.now(), this.submitWindowMs(), 'answer');
                                } else {
                                    this.answer!.soon = pace === 'soon';
                                }
                            }
                            yield {
                                type: 'partial',
                                text,
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
                const minSpeechMs = this.startedWhileTtsActive
                    ? this.opts.overLineMinSpeechMs
                    : this.opts.minSpeechDurationMs;
                // Too short to be speech (cough, mic bump) - skip the billable
                // final pass, unless a real preview already showed
                // (emittedPartial). Noise that slips through is still dropped
                // downstream by isNonSpeechOnly.
                if (speechDuration < minSpeechMs && !emittedPartial) {
                    return;
                }

                // Reuse the last speculative transcript when no new speech has
                // arrived since (the common single-pause turn) - re-running would
                // bill an identical call. Speech since then invalidates it, and
                // so does speech-LIKE activity in the untranscribed tail (see
                // TAIL_RETRANSCRIBE_*, meditation-pal-rcdz): incrementally any
                // hint chunk past the seam up to the submit, the withheld
                // SEAM_SPAN_MS included, since no pass has sent it.
                const tailHasSpeechHints = this.incremental
                    ? this.hintAtSubmit > seam
                    : lastSpecAt > 0 &&
                      this.energyHistory.some(
                          ({ t, e, p }) =>
                              t > lastSpecAt &&
                              (p >= TAIL_RETRANSCRIBE_PROB || e >= TAIL_RETRANSCRIBE_ENERGY)
                      );
                let result: TranscribeResult;
                if (lastSpecResult && this.lastSpeechMs === lastSpecSpeechMs && !tailHasSpeechHints) {
                    diag('[stt-cost] final reused the speculative transcript - 0s billed');
                    diag(`[stt-text] ${lastSpecResult.text.length} chars`);
                    result = { ok: true, text: lastSpecResult.text, seconds: lastSpecResult.seconds };
                } else {
                    const sent = (await pass('final')).result;
                    // Incrementally the reply covers only the piece past the seam.
                    result = sent.ok && this.incremental ? { ...sent, text: withPiece(textSoFar, sent.text) } : sent;
                }
                if (tailHasSpeechHints && lastSpecResult) {
                    diag('[vad] tail had speech hints after the speculative pass - not reused');
                }

                // The user kept talking past the submit decision: reopen (see
                // the loop comment above). The seam stays where the last
                // speculative pass put it: this final's snapshot ended while
                // they were still talking.
                if (this.postSubmitSpeech && !this.hitMaxUtterance && !this.stopRequested) {
                    this.postSubmitSpeech = false;
                    this.utteranceDone = false;
                    if (this.answer) this.answer.soon = false;
                    diag('[vad] speech continued past submit - reopening the utterance');
                    if (result.ok && result.text) {
                        emittedPartial = true;
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
                // Words answer the question; a cough leaves it open.
                if (this.answer && !isNonSpeechOnly(result.text)) this.answer = null;
                // seconds = every pass this turn sent, not the final alone
                // (turnBilledSec).
                yield {
                    type: 'final',
                    text: result.text,
                    seconds: turnBilledSec,
                    startedDuringTts: this.startedWhileTtsActive,
                };
                return;
            }
        } finally {
            // End the turn but keep stream, context, and callback alive for the
            // next turn / barge-in. Full teardown only on stop().
            this.capturing = false;
        }
    }

    /** Takes effect on the utterance in progress: the submit check reads these
     *  every frame. */
    setPauseWindow(baseMs: number, maxMs: number): void {
        this.opts.silenceBaseMs = baseMs;
        this.opts.silenceMaxMs = Math.max(baseMs, maxMs);
    }

    /** Playback just ended: log the next second of mic level ([vad] after
     *  playback), unless more playback starts first (noteVoicePlayback). */
    watchPlaybackTail(): void {
        this.tailWatch = [];
    }

    /** Keep only the last `ms` of the audio held for the next turn's onset.
     *  For a caller that keeps the mic shut while the facilitator speaks (no
     *  barge-in): the stream heard the reply, which must not open the turn,
     *  but a word said after the reply ended is the turn's (qaqb). */
    keepOnsetTail(ms: number): void {
        const keep = framesWithin(ms, this.nativeRate);
        this.preBuffer = keep > 0 ? this.preBuffer.slice(-keep) : [];
    }

    async stop(options?: SttStopOptions): Promise<void> {
        this.stopRequested = true;
        this.stopSeq++;
        this.capturing = false;
        if (options?.keepMicUntil) this.keepStream(options.keepMicUntil);
        this.releaseAll();
    }

    /**
     * Take the capture stream out of releaseAll's reach until `until` settles.
     * Everything else is torn down, and nothing reads the stream meanwhile.
     * A stop with no stream of its own extends the hold on one already kept:
     * two lines back to back must not let it go between them.
     */
    private keepStream(until: Promise<unknown>): void {
        if (this.stream) {
            this.releaseKept();
            this.kept = { stream: this.stream, waiting: 0 };
            this.stream = null;
        }
        const kept = this.kept;
        if (!kept) return;
        kept.waiting++;
        clearTimeout(kept.cap);
        kept.cap = setTimeout(() => {
            if (this.kept === kept) this.releaseKept();
        }, KEEP_MIC_CAP_MS);
        const settle = (): void => {
            // Taken back by an open since, or already let go.
            if (this.kept !== kept) return;
            if (--kept.waiting === 0) this.releaseKept();
        };
        void until.then(settle, settle);
    }

    private releaseKept(): void {
        const kept = this.kept;
        if (!kept) return;
        this.kept = null;
        clearTimeout(kept.cap);
        noteCaptureClosing(kept.stream);
        for (const track of kept.stream.getTracks()) track.stop();
    }

    /** The next open takes a kept stream back while it is still good, so the
     *  mic is never let go between turns that keep it (voice-start.ts). */
    private reuseKept(): void {
        const kept = this.kept;
        if (!kept || this.stream) return;
        if (streamNeedsRefresh(kept.stream)) return this.releaseKept();
        this.kept = null;
        clearTimeout(kept.cap);
        this.stream = kept.stream;
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
            noteCaptureClosing(this.stream);
            for (const track of this.stream.getTracks()) track.stop();
            this.stream = null;
            this.endColdOpen();
        }
    }
}

/** Whole capture frames in `ms` at `rate`. Pure, for tests. */
export function framesWithin(ms: number, rate: number): number {
    return Math.max(0, Math.floor(((ms / 1000) * rate) / FRAME_SIZE));
}

/**
 * Index ranges to keep from a chunk sequence once every run of quiet chunks
 * longer than `gap` is collapsed to `keep` chunks (half from each edge, so the
 * cut falls inside the silence, never on a word). Runs of `gap` or fewer are
 * untouched. Pure, for tests; submitPayload feeds it the per-chunk verdicts.
 */
export function compactQuietRuns(
    quiet: readonly boolean[],
    gap: number,
    keep: number
): Array<[number, number]> {
    const n = quiet.length;
    const ranges: Array<[number, number]> = [];
    let cursor = 0;
    let i = 0;
    while (i < n) {
        if (!quiet[i]) {
            i++;
            continue;
        }
        let j = i;
        while (j < n && quiet[j]) j++;
        const run = j - i;
        if (run > gap && run > keep) {
            const head = Math.ceil(keep / 2);
            const tail = keep - head;
            ranges.push([cursor, i + head]);
            cursor = j - tail;
        }
        i = j;
    }
    ranges.push([cursor, n]);
    return ranges.filter(([a, b]) => b > a);
}

/**
 * Whether a held capture stream is unusable and must be re-acquired.
 *
 * The trap is `muted`. Backgrounding an app on Android mutes the capture track
 * but leaves the stream `active` and the track `live`, and it stays muted after
 * returning to the foreground. A graph rebuilt on that track feeds digital
 * zeros forever, so the session goes deaf with no error anywhere
 * (meditation-pal-wudm). A track that `ended` fires its own reacquire handler;
 * a muted one fires nothing, so it has to be caught on the way in.
 *
 * Only consulted from ensureCaptureGraph, i.e. from start()/prime() at a turn
 * boundary - so re-acquiring here can never clip a live utterance.
 */
export function streamNeedsRefresh(stream: MediaStream | null): boolean {
    if (!stream || !stream.active) return true;
    const track = stream.getAudioTracks()[0];
    if (!track) return true;
    return track.muted || track.readyState === 'ended';
}

/** The turn's text once an incremental piece's reply joins it. A wordless
 *  reply adds nothing to the words before it, and stands as it is when there
 *  are none, as a full pass's would. */
function withPiece(textSoFar: string, reply: string): string {
    if (!textSoFar) return reply;
    return isNonSpeechOnly(reply) ? textSoFar : joinTranscripts(textSoFar, reply);
}

/** The `x-stt-prior` header for an incremental piece: a header, not a query
 *  param, because it is the meditator's words and URLs get logged. Null when
 *  there is no text yet, or when it won't encode (a lone surrogate in a
 *  transcript): the piece then goes unprompted rather than failing. */
function priorHeader(textSoFar: string): string | null {
    if (!textSoFar) return null;
    try {
        return encodeURIComponent(priorPrompt(textSoFar));
    } catch {
        return null;
    }
}

function frameRms(frame: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
    return Math.sqrt(sum / frame.length);
}

function concatFloat32(chunks: readonly Float32Array[]): Float32Array {
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

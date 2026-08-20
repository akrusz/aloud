# Voice Barge-In Behavior

Barge-in lets the user interrupt the facilitator mid-sentence by speaking over
its TTS. It is **entirely client-side** - the backend just streams TTS audio and
receives the next utterance; it's unaware a barge-in occurred. The energy/timing
heuristics below are tuned for typical conversation volume.

## Two pathways

The path is chosen by STT backend (`ts/ui/src/views/session.ts`,
`engineDrivenBargeIn = sttBackend === 'server-whisper'`):

1. **Engine-driven (server-Whisper)** - `ts/ui/src/adapters/whisper-pcm-stt.ts`.
   The adapter keeps a continuous, echo-cancelled capture stream alive between
   turns and runs barge-in detection on it (wired via `setBargeInHandler` in
   `session.ts`). Because that stream is always warm, it can keep an onset
   **pre-buffer** (`PRE_BUFFER_MS`, 2000ms ring) so the first word(s) spoken over
   the facilitator survive into the captured utterance - **no re-speak needed.**

2. **Generic wrapper (Web Speech and any other non-self-detecting engine, desktop only)** - `ts/ui/src/barge-in.ts` (`wrapTtsWithBargeIn` / `BargeInListener`). During each
   `speak()` it opens a *parallel* echo-cancelled mic stream and watches RMS
   energy. It does **not** capture the triggering audio; once TTS is cancelled the
   normal listen loop wakes (busy → false as the `speak()` promise resolves) and
   captures the user's next words. In practice users pause ~300ms after
   interrupting, which the listen loop more than makes up.

3. **None (phones)** - `session.ts` skips the wrapper entirely on the Capacitor
   plugin and on any single-owner-mic platform (`isSingleOwnerMicPlatform`). A
   phone's loudspeaker defeats echo cancellation, so the parallel stream hears
   the facilitator and cancels its own TTS (only the first sentence of a reply
   plays), and the extra capture starves the one recognizer the platform allows.
   First seen in Android's WebView (meditation-pal-x4h4), then in mobile Chrome
   on the web build (meditation-pal-oxmt) - it's the speaker, not the wrapper.
   Capture already pauses while busy on both, so nothing is lost but the
   interruption. Those platforms also hold the mic shut for
   `MIC_RESUME_COOLDOWN_MS` (700ms, `session.ts`) after playback ends before
   reopening it, so the speaker's decay isn't transcribed as the user; desktop
   skips the wait, which would cost the start of a real barge-in.

## Detection

A frame counts as a barge-in attempt when its **mic RMS energy exceeds the
barge-in threshold**, and a trigger fires only when that holds for
`BARGE_IN_REQUIRED_CHUNKS` (3) **consecutive** frames (~280ms); a single
below-threshold frame resets the counter. The threshold is intentionally higher
than normal speech detection (~0.015) so the facilitator's own TTS, bleeding
into the mic, doesn't trip a false barge-in.

On the engine-driven path two things sit on top of that energy test
(`whisper-pcm-stt.ts`, `isSpeechLike`):

- **Silero's verdict.** The frame must also land while `silero.speaking` - a
  cough, a thump, or a knocked mic is loud without being speech, and shouldn't
  hush the facilitator. Energy alone is the **degraded fallback**: if the model
  fails to load, `isSpeechLike` is `true` by definition and detection is exactly
  the pre-Silero behavior. Note this never weakens *echo* rejection, because
  echo is speech to Silero - echo stays the energy gate's job.
- **A dynamic echo gate.** While TTS is audible the effective threshold rises to
  `max(BARGE_IN_THRESHOLD, min(echoFloor × ECHO_GATE_MARGIN, ECHO_GATE_MAX))`,
  where `echoFloor` is an EMA of this device's measured echo level. Between
  turns the gate is 0, so a silent gap keeps the sensitive thresholds.

The generic wrapper (`barge-in.ts`) has neither: it is the plain
energy-over-threshold test described above.

The Silero model itself (which export, why, and how to upgrade it) is documented
in [`ts/ui/src/assets/README.md`](../ts/ui/src/assets/README.md).

### Echo cancellation (first line of defense)

Both pathways open their mic stream with `echoCancellation: true`. Echo
cancellation matters most here: the browser subtracts speaker output from the
mic feed, so the facilitator's own TTS is far less likely to cross the barge-in
threshold. The elevated threshold is the *second* line of defense, for
environments where AEC is imperfect - notably some WebViews and speaker-heavy
setups. If false barge-ins recur, suspect AEC not being honored on that
platform.

### Transcript echo guard (last line of defense)

What the acoustic gates miss still must not take a turn, wake a silence hold, or
answer a hold-confirm question, so `session.ts` funnels every finished utterance
through `looksLikeTtsEcho` (`ts/src/facilitation/echo-guard.ts`) when it landed
during playback or within `ECHO_TEXT_WINDOW_MS` (4s) of it. Two matchers against
the text just spoken: an exact contiguous run of 4+ normalized words, and a
fuzzy pass for 6+ words that recovers 80% of the utterance as an in-order
subsequence of a tight window of the spoken text - recognizers mangle leaked
speaker audio, so exact runs miss most real phone echo
(meditation-pal-oxmt). Short utterances and paraphrases are never dropped:
meditators do legitimately repeat the facilitator back.

## What happens on trigger

1. The detector calls `tts.cancel()`, which stops the underlying playback
   (`HTMLAudioElement` for cloud TTS, `speechSynthesis` for browser TTS, the
   native engine on desktop) and makes the in-flight `speak()` promise resolve.
2. The generic listener stops itself (one fire per `speak()`); the engine-driven
   adapter flips its continuous stream from idle to capturing.
3. The listen loop resumes and captures the user's utterance - seeded from the
   onset pre-buffer on the engine-driven path, or from the user's next words on
   the generic path.

The generic wrapper ties the listener's lifecycle to the `speak()` promise
(`try/finally`), so there's no separate "TTS is playing" flag to get stuck on,
and no watchdog/cooldown machinery is needed.

## Thresholds

| Constant | Value | Where | Purpose |
|---|---|---|---|
| `BARGE_IN_THRESHOLD` | 0.04 | `barge-in.ts` | Speech-over-TTS detection (generic wrapper) |
| `BARGE_IN_REQUIRED_CHUNKS` | 3 | `barge-in.ts` | ~280ms sustained required |
| `FRAME_SIZE` | 4096 | `barge-in.ts` | ScriptProcessor analysis frame |
| `BARGE_IN_THRESHOLD` | 0.03 | `whisper-pcm-stt.ts` | Detection floor on the continuous idle stream |
| `ECHO_GATE_MARGIN` | 2.0 | `whisper-pcm-stt.ts` | Multiplier on the measured echo floor while TTS is audible |
| `ECHO_GATE_MAX` | 0.035 | `whisper-pcm-stt.ts` | Cap on that gate, kept below real-speech level |
| `PRE_BUFFER_MS` | 2000 | `whisper-pcm-stt.ts` | Onset retained so a barge-in's first word survives |
| `LEAD_KEEP_MS` | 500 | `whisper-pcm-stt.ts` | How much of that onset survives the pre-POST quiet trim (`submitPayload`), so the retained ramp isn't billed as room tone. Raise if a first word ever clips |

## Key files

| File | Role |
|---|---|
| `ts/ui/src/barge-in.ts` | `BargeInListener` + `wrapTtsWithBargeIn` - the generic parallel-stream detector |
| `ts/ui/src/adapters/whisper-pcm-stt.ts` | Engine-driven barge-in on the continuous stream + onset pre-buffer |
| `ts/ui/src/adapters/silero-vad.ts` | The speech-probability model behind `isSpeechLike` (onnxruntime-web; model + provenance in [`ts/ui/src/assets/README.md`](../ts/ui/src/assets/README.md)) |
| `ts/ui/src/views/session.ts` | Picks the pathway (`engineDrivenBargeIn`), wires `onBargeIn` / `setBargeInHandler`, owns the phone mic cooldown + the echo-window check |
| `ts/src/facilitation/echo-guard.ts` | `looksLikeTtsEcho` - the transcript-level backstop |
| `ts/tests/barge-in.test.ts` | Detector unit tests |

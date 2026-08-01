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

2. **Generic wrapper (Web Speech, Capacitor, any non-self-detecting engine)** - `ts/ui/src/barge-in.ts` (`wrapTtsWithBargeIn` / `BargeInListener`). During each
   `speak()` it opens a *parallel* echo-cancelled mic stream and watches RMS
   energy. It does **not** capture the triggering audio; once TTS is cancelled the
   normal listen loop wakes (busy → false as the `speak()` promise resolves) and
   captures the user's next words. In practice users pause ~300ms after
   interrupting, which the listen loop more than makes up.

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

## Key files

| File | Role |
|---|---|
| `ts/ui/src/barge-in.ts` | `BargeInListener` + `wrapTtsWithBargeIn` - the generic parallel-stream detector |
| `ts/ui/src/adapters/whisper-pcm-stt.ts` | Engine-driven barge-in on the continuous stream + onset pre-buffer |
| `ts/ui/src/adapters/silero-vad.ts` | The speech-probability model behind `isSpeechLike` (onnxruntime-web; model + provenance in [`ts/ui/src/assets/README.md`](../ts/ui/src/assets/README.md)) |
| `ts/ui/src/views/session.ts` | Picks the pathway (`engineDrivenBargeIn`), wires `onBargeIn` / `setBargeInHandler` |
| `ts/tests/barge-in.test.ts` | Detector unit tests |

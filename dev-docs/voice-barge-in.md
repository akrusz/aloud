# Voice Barge-In Behavior

Barge-in lets the user interrupt the facilitator mid-sentence by speaking over
its TTS. It is **entirely client-side** - the backend just streams TTS audio and
receives the next utterance; it's unaware a barge-in occurred. The energy/timing
heuristics below are tuned for typical conversation volume.

## Three pathways

The path is chosen by STT backend and platform (`ts/ui/src/views/session.ts`,
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
   interruption. A check-in or timer notice starts on its own, outside `busy`,
   so `tts.speak` closes any recognizer off the engine-driven path
   (`continuousCapture`) before the line plays (`[echo-guard]` in the diag log) and the
   listen loop waits out `ttsSpeakingDepth`: left open, a phone's recognizer
   took those lines from the speaker as the meditator's turn. Those platforms
   also hold the mic shut for `MIC_RESUME_COOLDOWN_MS` (700ms, `session.ts`)
   after playback ends before reopening it, so the speaker's decay isn't
   transcribed as the user; desktop skips the wait, which would cost the start
   of a real barge-in.

## The opening and closing sounds

A session's opening and closing sounds (`ts/ui/src/signature-sound.ts`) play
through the speakers with the mic open, and on macOS the mic's echo-cancelled
capture is voice processing, which rebuilds the audio output when it starts
and again a couple of seconds after it stops. Three rules keep the two apart
(heard and fixed on the desktop app, MacBook speakers, 2026-10-12):

- **Opening starts after the mic is up.** `playOpening` takes the engine's
  `prime()` and starts the sound once the mic is up plus `MIC_SETTLE_MS`.
  Started first, it dropped out for a fraction of a second as the mic arrived.
  Android is the other way round (`micOpensAfterOpening`): the mic puts the
  app in call mode, and Android mutes media playback for 2s when a call
  starts, so the sound plays first and the mic opens after it. The exception
  is a Begin during the last session's close, whose held mic keeps call mode
  on: the mic opens first there, so letting the old one go doesn't end call
  mode under the opening (meditation-pal-x4n9). Either way the session never
  primes the mic itself, and the greeting waits for both.
- **The listen loop and barge-in ignore the opening.** Both wait out
  `openingSounding` in `session.ts`. The echo canceller is cold at session
  start, so the sound reaches the mic near full strength, and the default pair
  is tonal enough that the recognizer hears vowels: it started turns and hushed
  the greeting.
- **The capture stream is held until the close finishes.** `stop({ keepMicUntil })`
  (`SttStopOptions`) stops listening at once but holds the capture stream until
  the closing sound is over. Released at End, the output was rebuilt mid-sound.

Until `ensureCaptureGraph` became single-flight (2026-10-12) every session
start leaked a capture stream, which kept voice processing running between
sessions and hid all three. If session-start echo (meditation-pal-8h1x) looks
worse than it used to, that is a place to look: the canceller now starts cold
every session.

## Detection

A frame counts as a barge-in attempt when its **mic RMS energy exceeds the
barge-in threshold**, and a trigger fires only when that holds for
`BARGE_IN_REQUIRED_CHUNKS` (3) **consecutive** frames (~280ms); a single
below-threshold frame resets the counter. The threshold is intentionally higher
than normal speech detection (~0.015) so the facilitator's own TTS, bleeding
into the mic, doesn't trip a false barge-in.

On the engine-driven path two things sit on top of that energy test
(`whisper-pcm-stt.ts`, `isSpeechLike`):

- **Silero's verdict.** The frame must also fall while `silero.speaking` - a
  cough, a thump, or a knocked mic is loud without being speech, and shouldn't
  hush the facilitator. Energy alone is the **degraded fallback**: if the model
  fails to load, `isSpeechLike` is `true` by definition and detection is exactly
  the pre-Silero behavior. Note this never weakens *echo* rejection, because
  echo is speech to Silero - echo stays the energy gate's job.
- **A dynamic echo gate.** While TTS is audible the effective threshold rises to
  `max(BARGE_IN_THRESHOLD, min(echoFloor × ECHO_GATE_MARGIN, ECHO_GATE_MAX))`,
  where `echoFloor` is an EMA of this device's measured echo level. Between
  turns the gate is 0, so a silent gap keeps the sensitive thresholds.
- **A warm-up gate on the first voice.** The canceller meets the facilitator's
  voice cold: during the first voice playback a new capture stream plays over
  (the greeting; the opening sound doesn't train it), bursts leak at 0.07-0.08
  RMS on MacBook speakers and landed as garbled turns (meditation-pal-7ah4).
  So for that one playback the gate is at least `ECHO_WARMUP_GATE` (0.1),
  armed per stream and opened by `noteVoicePlayback()` from
  `ttsPlaybackStarted`. Deliberate speech measured 0.17-0.28.

The generic wrapper (`barge-in.ts`) has neither: it is the plain
energy-over-threshold test described above.

The Silero model (run by `ts/ui/src/adapters/silero-vad.ts`; which export, why,
and how to upgrade it) is documented in
[`ts/ui/src/assets/README.md`](../ts/ui/src/assets/README.md).

### Echo cancellation (first line of defense)

Both detecting pathways open their mic stream with `echoCancellation: true`. Echo
cancellation matters most here: the browser subtracts speaker output from the
mic feed, so the facilitator's own TTS is far less likely to cross the barge-in
threshold. The elevated threshold is the *second* line of defense, for
environments where AEC is imperfect - notably some WebViews and speaker-heavy
setups. If false barge-ins recur, suspect AEC not being honored on that
platform.

### Transcript echo guard (last line of defense)

What the acoustic gates miss still must not take a turn, wake a silence hold, or
answer a hold-confirm question, so `session.ts` funnels every finished utterance
through `looksLikeTtsEcho` (`ts/src/facilitation/echo-guard.ts`) when it finished
during playback or within `ECHO_TEXT_WINDOW_MS` (4s) of it. Two matchers against
the text just spoken: an exact contiguous run of 4+ normalized words, and a
fuzzy pass for 6+ words that recovers 80% of the utterance as an in-order
subsequence of a tight window of the spoken text - recognizers mangle leaked
speaker audio, so exact runs miss most real phone echo
(meditation-pal-oxmt). Short utterances and paraphrases are never dropped:
meditators do legitimately repeat the facilitator back.

The live preview bubble takes less convincing (`previewLooksLikeTtsEcho`): a
partial that is so far only a run of the spoken words is hidden at any length,
since a partial starts at a word or two and would otherwise show the
facilitator's words as the meditator's until the rest arrived. Hiding a
preview costs a real speaker nothing; their turn is still judged strictly.

## What happens on trigger

1. The detector calls `tts.cancel()`, which stops the underlying playback
   (`HTMLAudioElement` for cloud TTS, `speechSynthesis` for browser TTS, the
   native engine on desktop) and makes the in-flight `speak()` promise resolve.
2. The generic listener stops itself (one fire per `speak()`); the engine-driven
   adapter flips its continuous stream from idle to capturing.
3. The listen loop resumes and captures the user's utterance - seeded from the
   onset pre-buffer on the engine-driven path, or from the user's next words on
   the generic path.

The greeting is a turn like any reply (`speakOpener` in `session.ts` takes its
own `turnGen` and AbortControllers): a barge-in hushes the whole greeting, not
one sentence, an utterance supersedes it with no static fallback, and only the
live turn releases `busy`, so the reply that took over still hears barge-ins
(meditation-pal-x060).

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
| `ECHO_WARMUP_GATE` | 0.1 | `whisper-pcm-stt.ts` | Gate floor during a new capture stream's first voice playback |
| `PRE_BUFFER_MS` | 2000 | `whisper-pcm-stt.ts` | Onset retained so a barge-in's first word survives |
| `LEAD_KEEP_MS` | 500 | `whisper-pcm-stt.ts` | How much of that onset survives the pre-POST quiet trim (`submitPayload`), so the retained ramp isn't billed as room tone. Raise if a first word ever clips |

Detector unit tests: `ts/tests/barge-in.test.ts`.

# Voice Barge-In Behavior

> **Historical (Flask era).** This documents the original Python app's
> client-side barge-in (`src/web/static/js/audio.js`). The TypeScript UI has a
> different implementation — see `ts/ui/src/audio.ts` and the barge-in wrapper
> in `ts/ui/src/views/session.ts` (`wrapTtsWithBargeIn`), plus
> `ts/tests/barge-in.test.ts`. The design notes below still explain the *why*
> and the energy/timing heuristics, which carried over.

The barge-in system is **entirely client-side**, implemented in the audio loop
(`src/web/static/js/audio.js`, the `onaudioprocess` handler). The server is
unaware of barge-in — it simply receives audio and sends TTS audio back.

## Detection

Three conditions must all be true:

1. **TTS is active** — any of: `ttsSpeaking`, `synth.speaking`, or `serverAudioPlaying` is true
2. **Mic RMS energy > `BARGE_IN_THRESHOLD` (0.04)** — intentionally higher than the normal speech threshold (`SILENCE_THRESHOLD`, 0.015) to avoid triggering on TTS bleed picked up by the mic
3. **Sustained for `BARGE_IN_CHUNKS` (3) consecutive chunks (~280ms)** — if any chunk drops below threshold, the counter resets to 0

## Echo cancellation (first line of defense)

The mic stream is opened with `echoCancellation`, `noiseSuppression`, and `autoGainControl` enabled (the `getUserMedia` constraints in `audio.js`). Echo cancellation matters most here: the browser subtracts the speaker output from the mic feed, so the facilitator's own TTS is far less likely to cross `BARGE_IN_THRESHOLD` and trigger a false barge-in. The elevated threshold is the *second* line of defense, for environments where AEC is imperfect — notably some WebViews (pywebview) and speaker-heavy setups. If false barge-ins recur, suspect AEC not being honored on that platform.

## What Happens on Trigger

When `BARGE_IN_CHUNKS` consecutive above-threshold chunks are detected:

1. `stopServerAudio()` — kills the Web Audio `AudioBufferSourceNode`, sets `serverAudioPlaying = false`
2. `synth.cancel()` — kills browser speechSynthesis
3. State reset — `ttsSpeaking = false`, `ttsMismatchStart = 0`, `bargeInCount = 0`
4. `preBuffer = [chunk]` — discards the old pre-buffer (which contains TTS audio that would contaminate transcription) and seeds with only the current chunk
5. Falls through to normal VAD, which begins detecting the user's speech

## TTS Playback Pathways

Two TTS pathways exist, and barge-in interrupts both:

- **Server-generated WAV** — macOS `say` generates WAV bytes on the server → sent over Socket.IO in the `facilitator_message` event → played via Web Audio API (`playServerAudio()`)
- **Browser speechSynthesis** — fallback when server TTS is unavailable or audio bytes are missing

## Post-TTS Cooldown (Normal End Only)

When TTS ends naturally (not via barge-in), an 800ms cooldown (`TTS_COOLDOWN_MS`) keeps `ttsSpeaking = true` to suppress mic input that might capture the tail of the TTS audio. This cooldown is **bypassed** during barge-in — `ttsSpeaking` is set to `false` immediately.

## TTS Watchdog

Chrome sometimes fails to fire `onend` on `SpeechSynthesisUtterance`. A watchdog checks: if `ttsSpeaking` is true but neither `synth.speaking` nor `serverAudioPlaying` is true for longer than `TTS_WATCHDOG_MS` (1500ms), it force-resets `ttsSpeaking`. This prevents the system from getting permanently stuck in the "TTS is playing" state.

## Thresholds

Defined as constants in `audio.js`:

| Constant | Value | Purpose |
|---|---|---|
| `SILENCE_THRESHOLD` | 0.015 | Normal VAD speech detection |
| `BARGE_IN_THRESHOLD` | 0.04 | Speech-over-TTS detection |
| `BARGE_IN_CHUNKS` | 3 | ~280ms sustained required |
| `TTS_COOLDOWN_MS` | 800 | Post-TTS mic suppression |
| `TTS_WATCHDOG_MS` | 1500 | Force-reset stuck TTS state |

## Post-Barge-In Flow

After barge-in, the normal VAD state machine takes over:

1. `silence` → `speech_started` → `speaking`
2. Audio accumulates in `audioChunks`
3. Adaptive silence detection triggers end-of-utterance
4. `submitUtterance()` sends audio to the server for Whisper transcription
5. Server processes it as a normal `user_message` — no awareness that barge-in occurred

## Key Files

| File | Role |
|---|---|
| `src/web/static/js/audio.js` | Threshold constants, barge-in detection (`onaudioprocess`), VAD state machine, `submitUtterance()` |
| `src/web/static/js/tts.js` | `speak()`, `playServerAudio()`, `stopServerAudio()` |
| `src/tts/macos.py` | `speak_to_bytes()` — generates WAV for client playback |
| `src/web/message_handlers.py` | `handle_user_message` — server processing after barge-in |
| `src/web/audio_handlers.py` | `handle_audio_data` — Whisper transcription handler |

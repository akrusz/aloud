# Desktop audio output

How sound leaves the desktop app (Tauri, macOS WKWebView), and the WebKit trap
that decides it. Bead `meditation-pal-wk4u`.

## The trap

In WebKit every AudioContext of a page with the same channel count and sample
rate shares one output pipe to the GPU process. A new context joins the pipe
already there, and the pipe outlives `close()` and a page reload. If the page's
audio thread stalls while the output keeps pulling, the pipe stays late by
about the length of the stall, for good. Past about 2.7 s it stays silent for
good. The page cannot tell: the context still reports `running`, `currentTime`
advances and `onended` fires. Only relaunching the app clears it.

`<audio>` elements take another path and are not affected. Seen once in the
field (silent session after a Bluetooth headset left) and reproduced with a
forced stall on macOS 27, WebKit 22625. Open WebKit bugs: 293296, 276687,
291892, 298378, 327275.

## Rules

- **Speech plays through the shared `<audio>` element on every platform**
  (`playbackAudio` in `ts/ui/src/audio-unlock.ts`): hosted voices, desktop
  local voices (Piper, `say`), voice previews (`CloudTtsEngine` in
  `ts/ui/src/adapters/cloud-tts.ts`) and the canned apology (`playBlob` in
  `ts/ui/src/canned-apology.ts`). Setup clips use their own elements
  (`playClip` in `ts/ui/src/setup-speech.ts`).
- **Nothing that must be heard may depend on an AudioContext that is kept
  running.** One running context exposes every other context at its rate.
- **Still on Web Audio output today**, and so exposed:
  - the signature sound (`ts/ui/src/signature-sound.ts`, through
    `playbackAudioContext`);
  - the noting chime (`playChime` in `ts/ui/src/views/noting-session.ts`, same
    context) and its preview (`previewChime` in `ts/ui/src/views/setup.ts`).
- The capture graph's context (`WhisperPcmSttEngine` in
  `ts/ui/src/adapters/whisper-pcm-stt.ts`) makes no sound, but it runs at the
  default rate, connected to the destination, the whole time the mic is open.
  So during a session the default-rate pipe is always running and always
  exposed to a stall.

A playing element makes the app macOS's now-playing app. In June 2026 that
once raised an "access Apple Music and your media library" dialog, which is
why speech was on Web Audio until wk4u. Elements had been playing on desktop
daily since (setup clips, the Begin prime) with no such request in the system
log. If the dialog returns, this is the cause.

## Media keys

macOS sends the now-playing app a Pause when a headset disconnects or the
Play/Pause key (F8) is pressed, and `CloudTtsEngine` treats an element pause as
a cancel: the reply would skip to its next sentence. `initMediaKeys` in
`ts/ui/src/media-keys.ts` (desktop only) registers no-op `navigator.mediaSession`
handlers for `play`, `pause` and `stop` so WebKit's default action never runs.
Unverified: that WebKit really skips its default once a handler is registered.
Check by pressing F8 during a line; the line should carry on.

## Echo thresholds are owed a re-measure

These were measured with desktop speech on Web Audio, and the element may
differ in level and in when `ended` fires against the audible tail:

- `BARGE_IN_THRESHOLD`, `ECHO_GATE_MARGIN`, `ECHO_GATE_MAX`, `ECHO_WARMUP_GATE`
  in `ts/ui/src/adapters/whisper-pcm-stt.ts`;
- `TTS_ACTIVE_HANGOVER_MS` in `ts/ui/src/views/session.ts`.

The `[vad] tts window` diag line gives the echo level per reply.

## Diagnosing

`bd memories macos-webkit-audio-forensics`: how to tell from the unified log,
outside the app, whether its audio reached the speakers. `bd memories
webkit-shared-web-audio-pipe` has the pipe's measurements. The bead describes
the in-page probes (a tone per output path with mic loopback, a worklet stall).

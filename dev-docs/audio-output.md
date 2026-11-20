# Audio output

How sound leaves the app on every platform, and the WebKit trap that decides
it. Bead `meditation-pal-wk4u`.

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

- **Everything audible plays through an `<audio>` element**, on every
  platform. There is no Web Audio output and no second path to fall back to.
- **Which element plays what:**
  - the voice's one shared element (`playbackAudio` in
    `ts/ui/src/audio-unlock.ts`): hosted voices, desktop local voices (Piper,
    `say`), voice previews (`CloudTtsEngine` in
    `ts/ui/src/adapters/cloud-tts.ts`) and the canned apology (`playBlob` in
    `ts/ui/src/canned-apology.ts`);
  - setup clips, an element each (`playClip` in `ts/ui/src/setup-speech.ts`);
  - every other sound, on the sound player's elements (`playSound` in
    `ts/ui/src/sound-player.ts`), one per slot, kept and reused: the
    signature sound's opening and close (`ts/ui/src/signature-sound.ts`), the
    noting chime and the named noting cues. Previews in Settings and on the
    setup screen use the same elements. A sound never uses the voice's
    element, so it can't cut a line off or be cut off by one, and two elements
    playing at once is fine on every platform.
- **A slot keeps its src** until it is asked for another file: a new src loads
  a new player (AVPlayer, Chromium's media player), which costs time at the
  play. The opening and close hold their preset's file as an object URL of the
  fetched bytes (`objectUrl` in `signature-sound.ts`).
- **Priming.** Safari lets an element play only once its `play()` has been
  called inside a user gesture, and the permission survives later src changes.
  The Begin click (`primeAudioPlayback`) and each preview click (`primeSounds`)
  play every idle element once, silently. An element that is sounding is left
  alone.
- **No AudioContext makes sound.** The only contexts are the mic capture
  graphs: `WhisperPcmSttEngine` in `ts/ui/src/adapters/whisper-pcm-stt.ts`, and
  on Web Speech `ts/ui/src/barge-in.ts` and `ts/ui/src/mic-meter.ts`. They
  connect to the destination only to keep their processor pulled.
- **Level lives in the files.** An iPhone ignores an element's `volume` (it
  takes the value and puts it back a task later). The signature files are 4 dB
  under the candidates they come from
  (`assets/promo/signature-candidates/app_copies.py`); the chime is rendered at
  its level by `ts/scripts/render-chime.mjs`.
- **A sound cut short fades** (`fadeOut` in `sound-player.ts`): the volume
  ramps to 0 over 250 ms on timers (a hidden page gets no animation frames),
  then the element pauses, and a sound waiting for it starts once it is quiet.
  Where the volume can't be set (checked ahead of time, and again at each
  step), it pauses at once.
- **A sound is over** at the first of `ended`, `pause` (a system pause comes
  with no `ended`), `error`, `emptied`, or the clock: its time left plus
  300 ms.
- **The guard.** `ts/tests/no-web-audio-output.test.ts` fails on
  `createBufferSource`, `createOscillator`, or a `.connect(` to a
  `.destination` outside the capture graphs.

Safari fires `playing` 0.2 to 0.3 s before a sound is audible (WebKit bug
277265), so a `[signature] ... start at` diag line is that much early.

A playing element makes the app the system's now-playing app. In June 2026 that
once raised an "access Apple Music and your media library" dialog on macOS,
which is why speech was on Web Audio until wk4u. Elements had been playing on
desktop daily since (setup clips, the Begin prime) with no such request in the
system log. If the dialog returns, this is the cause.

## The mic around a session's sounds

A session's capture is open across everything the session makes audible:

- **Begin.** Nothing plays until the session's capture is open (`playOpening`
  in `signature-sound.ts` opens the mic, then waits a beat). A capture that
  was listening on the setup screen stops listening but stays open until the
  session's own can hear beside it (`holdCaptureForSession` in
  `ui/src/mic-check.ts`, from `beginFromSetup` in `views/setup.ts` and a
  spoken "begin" in `voice-start.ts`), so the OS never sees the mic close
  between the two. Begin opens no probe stream once a mic has opened on the
  page (`micForBegin`).
- **End.** `playClosing` stops listening at once and keeps the capture open,
  read by nothing, until the close has played out, or until a cut opening has
  faded; then it closes (`SttStopOptions.keepMicUntil`). Every way a session
  ends goes through it, a mount that fails after the opening included. The
  setup screen comes up as a session ends, under the close (1.5 s in after a
  session summary, at once without one), and its listener opens nothing until
  the close is over; the session's capture then stays open until the
  listener's hears (`waitForClose` in `signature-sound.ts`, held in
  `createMicHandover` in `voice-start.ts`). The diag lines
  `[signature] close: setup mic waited ...` and
  `[signature] close: session mic let go at ...` show the order.
- **Mute** really closes the capture, as before.

Why, measured on an Android phone (2026-11-19, hosted STT and voice): the
WebView puts the app in call mode exactly while a getUserMedia capture is open
and leaves it about 1 s after the capture stops, and gives each player the
usage of the mode it opened in (media without a capture, call with one). At a
switch the players already running are muted for 2 s (call mode starting) or
torn down and reopened on the other stream (call mode ending). A mic opened
after the opening muted the first line's first two seconds; a mic closed
during the close made it waver; a mic closed and reopened at Begin left the
volume keys on the media stream. On Android a mic that switched call mode on
holds the opening `CALL_MODE_SETTLE_MS` (2.2 s) instead of `MIC_SETTLE_MS`,
since the elements primed at the Begin click opened before the switch. On
macOS the same opens and closes rebuild the audio output (meditation-pal-uz8t).

A capture opened beside ours switches no mode, but it starts a player: its
capture graph's AudioContext plays silence into the destination to keep its
processor pulled, and on Android that is a call-stream player of its own. The
setup screen's listener opened one 1.5 s into a close, and the close dropped in
level then and stayed down (phone, evening of 2026-11-19, the one player event
under that close in `dumpsys audio`).

## Phones

Read in the WebKit and Chromium sources, partly measured on Android (above):

- **Android.** A track's usage is fixed when it opens. A session's sounds
  start while call mode is on, so they play as call audio: the Call volume
  slider, the communication route. A chime under aloud cloud STT too. Read off
  a phone (2026-11-19, `dumpsys audio`): elements whose sound has the same
  rate and channels share one output player, which keeps running 10 s past
  their last sound. So the opening plays on the stereo player the Begin
  click's prime started (with call usage when Begin came from a listening
  setup screen), and a close that follows within 10 s on the same one. A
  capture graph's AudioContext is a player of its own, stopped after 30 s of
  silence. Inferred from the same log: elements share a player across rates
  too, at the rate of the first sound played on it. The Begin prime's silent
  clip was 8 kHz mono, its player ran until the session ended and 10 s more,
  and no 24 kHz player opened for the greeting, so the voice played
  band-limited to 4 kHz while it lasted. The clip is 48 kHz since
  (`SILENT_WAV` in `sound-player.ts`); a 48 kHz mono player under the first
  line on the next phone run confirms it.
- **Android, a capture graph closing on the setup screen.** Two setup clips
  that began within a second of the hosted listener's graph closing (and the
  next turn's opening another) lost their first 0.4 to 1.4s, and the same
  clip played whole with none open (2026-11-19, read from the timing; the
  mechanism is not known). In the Android app the setup screen's hosted
  listener now keeps its graph running between turns and through lines
  (`continuous` in [voice-commands.md](voice-commands.md)), as a session that
  barges in on that engine always has.
- **iPhone.** An audible element with no mic open puts the audio session in the
  playback category: a chime or a preview with no mic open ignores the silent
  switch and stops other apps' music, where Web Audio alone was ambient.

## Media keys

The system sends the now-playing app a Pause when a headset disconnects or a
Play/Pause key is pressed (F8 on a Mac), and `CloudTtsEngine` treats an element
pause as a cancel: the reply would skip to its next sentence. A voice that
takes a whole reply per request (`CloudVoice.wholeReply`) plays several
sentences as one clip, and the engine reports which of them its position had
reached; the streaming bridge then says the ones it hadn't one at a time
(`speakTogether` in `streaming-tts.ts`), so it too loses only the rest of one
sentence. `initMediaKeys` in
`ts/ui/src/media-keys.ts` registers no-op `navigator.mediaSession` handlers for
`play`, `pause` and `stop` on every platform, and WebKit calls a registered
handler instead of pausing the element (read in its source). The exception: on
iOS, unplugging headphones pauses the audible elements directly and skips the
handlers.

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

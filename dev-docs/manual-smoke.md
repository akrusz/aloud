# Manual smoke list

The five to ten minutes of by-hand checks worth running before a release, in
priority order. Nothing here is automated, and that's the point: every walk-back
in the mic path so far passed typecheck, the full vitest run, and `ui:build`,
and was caught by a human talking into a laptop.

`npm run soak` drives the engine on a fake clock, and `npm run soak:web` drives
real Chrome over a virtual audio device (see [soak-harness.md](soak-harness.md)).
Run those first - they're cheaper than you are. What's left below is what they
structurally cannot reach: the desktop Tauri shell, permission refusals, real
speakers and real microphones, and phones.

Related: [pre-release-checklist.md](pre-release-checklist.md) is docs/copy drift,
not behaviour. [mobile-device-validation.md](mobile-device-validation.md) is the
per-device STT/TTS quality matrix.

---

## This release (everything after v2.20.1)

One pass over branch `stt-incremental`, which is `main` plus incremental
transcription, the setup voice work and the move of every sound to `<audio>`
elements. Delete this section once it ships. The order is desktop on the
branch, two minutes in Chrome, merge into `main`, deploy the server, one
listen after the deploy, then the phone.

Cut on 2026-11-18 to what only a person at a real microphone and speaker can
vet. What was dropped, and what stands in for it, is listed at the end.

**Desktop**, `npm run tauri:dev` on the branch, speakers, Harper. About 20
minutes.

Setup, on local Whisper:

- [x] **Launch.** The wordmark is in its own face.
- [x] **It hears you and not itself.** The mic beside Begin is lit with no
      click. Say "add playful": the box checks and "Playful is on." is spoken.
      Then "following", "balanced", "noting": each is answered once and
      nothing fires a second time.

One session on hosted GPT speech recognition, in this order:

- [x] (used Ethan and Harper) **Begin, mic lit.** The opening sound plays before her first line, as
      far under her voice as before, with no drop-out, and the first line is
      whole (Begin skips its mic probe now when a capture is live).
- [x] **Incremental, by ear.** Two long turns with a pause mid-sentence in
      each, and make the first thing you say one of them: each arrives as one
      turn, nothing dropped or doubled at the pause, no period and capital
      where you only paused, and the reply no slower than usual. Then answer
      with one word ("seven"): it arrives as a turn.
- [?] **Barge-in.** Ask for a few sentences and talk over the second. She
      stops, the rest never plays, and the bubble ends at the sentence you cut
      into. Ask "what was the last thing you said?": she knows only the part
      you heard. Across the whole session she never interrupts herself and
      your turns never arrive with her words in them (the echo thresholds
      were tuned on the old Web Audio path).
- [x] **Media key.** Press F8 while she is speaking: the line carries on.
- [x] **Silence, then the frightened line.** Ask for silence and say yes to
      the bid. Think out loud once: it stays quiet. Say "I feel like I'm
      disappearing and it's scaring me": she comes back and tells you plainly
      to open your eyes and look around.
- [x] **"End the session", "yes".** The closing sound plays, History has the
      session with a summary, and the setup mic is lit again.

Then:

- [ ] **Begin, mic slashed, noting.** Tap the setup mic off and press Begin on
      a noting session: it still starts and listens, and the chime marks each
      turn. Two notes are enough.
- [ ] **Headset**, if one is in reach. Connect a Bluetooth headset
      mid-session, then switch it off: she carries on from the speakers, and
      the next session is audible too. (This is what left the app silent on
      2026-11-17, `meditation-pal-wk4u`.)
- [ ] **The tour, once.** Settings → Developer → "Setup welcome card" → first
      run. With the card up, drag the window by its top bar: it moves, and a
      click on the bar does not dismiss the card. Wait a few seconds, then
      "Show me around", and on each card let the line finish and wait two
      seconds before going on, by "next" at least once. No line loses half a
      second partway through, no sentence of Harper's is missing its first
      word, and none starts with an audible "Okay" (her spoken lead). Before
      the Exploration card she says "aloud has three different ways to
      meditate using your voice…", and after its line "By the way, you can
      say 'back' or 'next' to control this tour."

**From the notes on this pass** (fixed 2026-11-18, none of it heard yet).
Desktop, hosted GPT speech recognition:

- [ ] **Mute mid-line.** Mute with the button a second or two into a long
      reply: the rest plays with no skip, across its sentences, and the
      menu-bar mic indicator goes off a moment after she finishes. Muted with
      nothing playing, it goes off at once. (A mute 1.4 s into a sentence was
      what made Ethan skip at "on".)
- [ ] **Unmute.** The status reads "Opening the mic…" for a second or so, then
      "Listening…". Start speaking as it changes: the first word arrives
      whole ("Actually" came back "She").
- [ ] **Voice picker mid-session.** Open it during a reply and play a preview:
      neither has a hole in it, and after closing the next thing said is heard
      from its first word.
- [ ] **Repeat.** "Say that again": the last line is spoken again. "What did
      you say before that?": your words stay on screen and she answers in a
      new line. (The local server has the new ask now, production after the
      deploy.)
- [ ] **Setup.** The guidance stops read 1 to 5 with the current one on the
      thumb, in dark mode and in Firefox too. "Guidance four" moves it and is
      answered. Special requests folded over text shows a dot and its first
      words. "End the session" in a session asks "Would you like to end the
      session now?".

**Chrome**, `npm run web:dev`, browser recognizer, speakers. Four minutes.

- [ ] **Sounds.** Begin a noting session on Harper: the opening sound and the
      chime are heard.
- [ ] **Harper.** In exploration, ask "tell me in three or four sentences
      what we'll do" and talk over the second: she stops within a beat,
      nothing more plays, and the bubble ends where you cut in. Press the
      keyboard's Play/Pause during a line: nothing happens.
- [ ] **Google UK English Female** (what a signed-out "Use a free voice"
      gets). Let one reply play without speaking: it plays whole. Talk over
      the next: the same as Harper.
- [ ] **Ava**, or another macOS voice. A reply plays in whole sentences, not
      cut after each first word. Talking over her does nothing, which is
      expected (`bargeInDetectorFits`).

**If that is clean:** merge `stt-incremental` into `main` and deploy the
server from `main` before any client build (a new client on the old server
falls back to full passes, and Harper's lead, the voice levels, the Chinese
voice names and the narrower repeat command are the server's). Then:

```bash
curl -si -X OPTIONS https://aloud-cloud.fly.dev/app/v1/models \
  -H 'Origin: https://aloud.rest' -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: x-provider-key' | grep -i allow-headers
```

The answer should name `x-provider-key`.

- [ ] **After the deploy, one listen.** In a session Harper is as loud as her
      tour lines and sits sensibly against the opening sound (she is 4.5 dB
      quieter than before).

**Phone**, a build from `main` against production, sounds first: no sound has
played on a phone since the move to `<audio>` elements.

- [ ] **Android sounds.** The opening plays before the first line, not late.
      The close and a noting chime are audible; with the mic open they follow
      the Call volume now, so check they sit sensibly against the voice.
- [ ] **iPhone sounds.** A chime does not cut the voice. Ending a session
      inside its opening sound stops the sound at once, with no loud click. A
      chime or preview with no mic open sounds even with the silent switch on.
- [ ] **The lock-screen or headset play/pause button** does nothing to the
      facilitator.
- [ ] **Setup mic.** It starts slashed and music from another app keeps
      playing. Tap it, say "twenty minutes" (the answer is audible; on an
      iPhone it is not noticeably quieter or call-quality next to a session),
      then "begin" (the first line is audible).
- [ ] **Volume banner.** Turn the volume down or off before a session: the
      banner says so. On iOS, first check the reading follows the volume
      buttons at all.
- [ ] **Touch targets.** Back on setup, tap Begin: a session starts, not the
      "What are ☁?" panel. Tap the bottom edge of the model select: it opens.
      Tap "Show all models" itself: it still toggles.
- [ ] **Keyboard**, iOS (never run there). Tap the intention box and type:
      Begin sits above the keys.
- [ ] **GPT, two long turns with a pause in each.** Each arrives whole.
- [ ] **Parakeet, two turns.** A 30-second stall means the production
      OpenRouter key or host pin is wrong.
- [ ] **Airplane mode while the reply dots show.** The status reads
      "Connection lost - trying again" and the reply still lands (30 s now).
- [ ] **中文.** With no voice picked, a session starts on 小月. Grok
      transcribes a turn, 小月 and 大海 preview in Chinese, and "二十分钟" on
      setup is answered aloud.
- [ ] **Balance.** It moved for the session and not for the setup listening.

**Dropped from the by-hand pass**, and what covers each instead:

- Five long turns of incremental: `npm --prefix ts run soak:web --
  --scenarios=pauses --stt=aloud-gpt-transcribe` reads nine lines with pauses
  of 2 to 8 seconds through Chrome and scores each against what was said.
- The setup voice's commands, voice mode's three states and the tour's
  controls (tap mid-line, the mic toggled under a card, "stop listening",
  the silent tour, "next" on the last card): `npm --prefix ts run voice:check`
  and the `setup-command` tests. The room half of it stays above.
- "Twenty minutes" on hosted GPT leaving the balance alone: the client sends
  `setup=1` on every pass (`tests/whisper-pcm-setup-params.test.ts`,
  `tests/stt-picker-setup.test.ts`) and the server charges nothing for a
  short setup clip (`server/tests/stt.test.ts`).
- The second tour pass in Ethan, and Harper against Ethan for loudness: the
  levels are measured per clip at render (`sessionLufs`).
- Settings wording and placement, the 中文 pass on desktop (Alex heard both
  voices on 2026-11-18) and a saved voice that no longer exists: copy and
  catalog, nothing a room changes.
- Stepping out on Ollama: the code under it has not moved since the
  2026-11-14 soak, and small models missing the rule is its own bead
  (`meditation-pal-vwhf`).
- In Chrome, the free-voice pick, the setup mic's first click and the BYOK
  error screen: `tests/voice-picker.test.ts` pins the pick, and the other two
  are layout and routing.
- After the deploy, Opus 5 gone and 大海 for a saved Yunfan are pinned by
  `tests/model-line.test.ts` and `server/tests/voices.test.ts`; the judge
  line is read from the server's log.
- Stepping out on a phone: it is the engine's, the same code as desktop.

---

## 0. Before you start

```bash
npm run typecheck && npm test && npm run ui:build && npm run test:server
npm run soak:web          # needs the BlackHole device; see soak-harness.md
```

If any of those fail, stop and fix those first.

## 1. Desktop app (Tauri) - the path no test touches

`npm run tauri:dev`. This is the highest-value section: local Whisper and Piper
exist only here.

- [ ] **First Begin asks for the mic**, and granting it starts a session. (Revoke
      in System Settings → Privacy → Microphone beforehand to get a real prompt.)
- [ ] **Whisper transcribes.** Say a full sentence, pause, and watch it come through as
      one turn - not two, not truncated mid-clause.
- [ ] **The facilitator speaks, audibly.** Not "a bubble appeared" - listen. A
      played-but-silent turn is a real failure mode (`meditation-pal-ypjj`) and
      nothing automated catches it.
- [ ] **The opening and closing sounds play whole.** Both are audible, and the
      opening sits as far under the voice as before (its -4 dB is in the files
      now, [audio-output.md](audio-output.md)). At Begin the sound has no
      drop-out in it, the facilitator's first words come after it, and it never
      shows up as a user turn or flashes in the live preview. At End the close
      rings out with no hole in it. Each of those failed on MacBook speakers
      before it was fixed ([voice-barge-in.md](voice-barge-in.md) → "The
      opening and closing sounds"), and no test hears them.
- [ ] **The noting chime is audible**, before each of your turns in a noting
      session with the turn cue on, and as its preview on the setup screen.
      It is a file now (`chime.wav`), no longer synthesized.
- [ ] **Barge-in**: talk over the facilitator mid-sentence. It should stop and
      take your turn, and its own voice must not be transcribed as a user turn.
- [ ] **Voice preview on the setup page, then again in-session** from the voice
      panel. Both must be audible. (Setup-only was working when all in-session
      playback had gone dead, so check both.)
- [ ] **Say "mute"** as a whole utterance. The mic goes off; only the button
      brings it back.
- [ ] **Spoken commands** (signed in; on a BYOK/local sit, turn Voice commands
      on first - Settings → Advanced, or the ⓘ panel's row mid-sit). Make the
      very first thing you say a command: "can you cancel the timer?" A cold
      judge used to lose exactly that one. Then two at once ("talk slower and
      show me the orb"), "mute the speaker" / "unmute the speaker", and one
      asked in a long rambling sentence: the facilitator should say it can't do
      that itself and name the command, never claim it did.
- [ ] **Silence mode round trip**: get a `[HOLD]` bid, say yes, sit quiet, think
      out loud once (it should NOT bring the facilitator back), then clearly ask
      to resume.
- [ ] **Stepping out, on a local model** (Ollama, qwen3.5:4b): a few turns in,
      say "I feel like I'm disappearing and it's scaring me." The reply should
      tell you plainly to open your eyes and look around, not ask what it feels
      like, and should arrive no later than an ordinary reply. Then get into a
      held silence and say it again: the facilitator should come back.
      ([stepping-out.md](stepping-out.md); no test drives this through the real
      turn loop.)
- [ ] **End the session** and confirm it appears in History with a summary.

Failure states, in a dev build, via `?nomic=` (see `ui/src/mic-check.ts`):

- [ ] `?nomic=denied` → setup shows the no-mic banner and **Begin is disabled**.
- [ ] `?nomic=no-device` → same, with the no-device wording.

## 2. Browser

`npm run web:dev`, then <http://localhost:4649>.

- [ ] **Chrome**: a session runs on Web Speech. Interim results should refine in
      place, not concatenate into stutter.
- [ ] **Safari**: sessions run, and the speech-recognition error copy (if any)
      names the right platform.
- [ ] **A non-secure origin** (hit the dev server by LAN IP over http) explains
      itself rather than failing silently.
- [ ] **A sitting with no hands after the first touch.** Voice control on the
      setup screen is on by default (Settings → Language & Speech
      Recognition); use a BYOK or local provider with voice commands off. On
      setup the mic beside Begin is lit; say "begin", say a sentence, say "end
      the session", answer "yes", and it is lit again on setup. Talk about
      something else on setup and nothing starts. Tap the mic and it goes
      slashed and stops hearing; tap again and it is back. Leave it two
      minutes with nothing asked and the mic falls asleep (unlit, not
      slashed). On **desktop** it should
      be lit from launch with no click (the shell reads the macOS grant), so
      check that the first session speaks, watch CPU while it listens (local
      Whisper), and try it once on aloud cloud speech recognition; on
      **Android** and **iOS** the mic starts slashed, so tap it and listen
      for a recognizer chime on every listening turn.

### Voice on the setup screen

Scripted through the real UI (`node ts/scripts/voice-loop-check.mjs`) and
never run with a microphone and a speaker in a room. That is what these are
for. `dev-docs/voice-commands.md` ("Voice on the setup screen") says how it is
meant to work.

- [ ] **A change is heard, made and said back.** With the mic lit, say "add
      playful". The Playful box checks, "Playful is on." shows above Begin and
      is spoken. With a hosted voice the line is a clip in a house voice
      (Harper unless the tour picked another); with Piper or `say` it is that
      voice. The mic icon stays lit afterwards.
- [ ] **It does not hear itself.** Speakers, not headphones, at a normal
      volume. Say "following", then "balanced", then "noting": each is
      answered once and nothing fires a second time. Worst case to try: a
      Bluetooth speaker.
- [ ] **The sheet below, read aloud**, once per recognizer you care about
      (local Whisper, aloud cloud, the phone's own). Note what was misheard:
      what you said and what showed above Begin, or that nothing happened.
      Those notes are the corpus `npm run jev:setup` and `HEARD_AS` in
      `setup-command.ts` are waiting for.
- [ ] **A television or a conversation in the room, five minutes.** Count
      settings changed and sessions begun. Sessions begun should be zero. On
      hosted recognition the mic should be closed by itself at two minutes if
      nothing it understood was said, or sooner on 20 things heard that were
      not requests. On local Whisper and in Chrome it has no
      clock: it should close after about five minutes of unbroken talk (30
      things heard that were not requests), and stay open all afternoon in a
      quiet room.
- [ ] **Voice mode: on, asleep, off.** Tap the lit button: slashed (off), and
      still slashed after leaving the screen and coming back, and after a
      relaunch; the Settings toggle reads off too. Off, start "Take the full
      tour": nothing is spoken and nothing listens until "Turn on the
      microphone". Tap the slashed button: lit, listening, and lit on the next
      visit. Say "stop listening": unlit with no slash (asleep), and Settings
      still reads on; a tap wakes it. The three looks should read apart at a
      glance on the real button, light theme and dark, and the permission not
      yet given should look slashed, never asleep. On a phone a fresh install
      starts slashed, and other apps' audio is untouched until it is tapped.
- [ ] **The ring around the button** on the setup screen swells as you speak,
      as it does in a session, and is still while the app answers and between
      turns (on local Whisper the engine stops then; the ring must not stay
      where it last was). Lit only, never on an asleep or slashed button.
      Scripted only against the browser's recognizer.
- [ ] **The pill** with what was heard or changed sits in the bar to the left
      of the mic on a wide window, floats above the bar on a narrow one or for
      a long line, holds for six seconds and fades. With the voice picker open
      it shows at the bottom of the screen, over the dimming.
- [ ] **The clock, by voice.** With a timer set: "hide the clock" (the button
      reads "20 min timer (hidden)"), "show the clock", "turn off the clock"
      (it reads "Hidden", and no timer).
- [ ] **"Set my intention."** It asks "What is your intention?". Answer with a
      full sentence that has a pause in it: the whole sentence should land in
      the field (local Whisper waits longer for this one answer; the browser's
      and a phone's recognizer end the turn when they like). Again, and answer
      "never mind": the field is as it was.
- [ ] **"Special requests."** On the Exploration tab with the field closed:
      it opens and asks "What's your request?". Answer "keep it slow": the
      line lands in the field. "Special request: no bells" puts a second line
      under it, "clear my special requests" empties it. Ask again and answer
      "done": "Okay, all set.", nothing added, and the empty field folds shut.
      "Cancel" likewise, answered "Okay, not adding a request."
- [ ] **A name alone flips it.** "Playful." twice: on, then off, and each
      answer says which. "Add playful" twice stays on. On speakers, a name
      that flips back by itself is the app hearing its own line.
- [ ] **Voices, by voice.** "Open the voice picker", then a voice's name: its
      row is picked and its sample plays, and the mic does not hear the
      sample. "Preview" and another name plays that one and picks nothing.
      "Close." Then "set the voice to" a name with the picker closed. Note any
      name the recognizer can't spell (`namedIn` matches by sound only when
      one voice is close).
- [ ] **"Set the model to Opus"** on aloud cloud: the picker changes, the
      estimate follows, "Model set to ..." shows above Begin. Not reached by
      the scripted check (its provider lists one model).
- [ ] **Signed out on desktop**, local Whisper and a local voice: all of the
      above works with no account.
- [ ] **An account at zero ☁** on aloud cloud speech recognition can still say
      "begin" (the request only fails later, where a session needs credits).
- [ ] **Android: how a clip sounds once the mic has opened.** The WebView is
      in call mode by then, so the clip plays on the call stream. With the
      phone's speaker, and with Bluetooth headphones.
- [ ] **Phones: the recognizer still starts** with the phrase list (the
      patched plugin's `biasPhrases`; compiled, never run). If the setup mic
      fails on Android 13+ where sessions don't, `adb logcat -s AloudSTT`
      right after `startListening`.
- [ ] **The tour, spoken.** A fresh profile, "Show me around". Where the mic
      is not yet allowed: the first card offers to turn it on and a voice
      reads it; allow it. The voice card: both voices introduce themselves,
      say a name (or "the second one"), the pick confirms itself and becomes
      the Voice on the form. Then "next", "back", "repeat", "mute" by voice,
      and the speaker on the card by hand. The last card ("You're ready")
      carries the voice tip and is read as one line; say "twenty minutes" there
      (the timer is set and the card stays), then "next": the tour closes as
      "Got it" would.
      Listen to the two voices' introductions and the picked line for a first
      word cut short or a line said twice.
- [ ] **The tour, by tap, mid-line.** Tap "Turn on the microphone" while the
      first line plays: the line stops and the next card is up within about a
      second, not when the line would have ended. Tap Next, Back and a voice
      partway through a line: each acts at once. Tap the mic beside Begin on a
      centered card and on a section card: it switches, and the tour stays
      where it was. Switched on under a line, it lights at once.
- [ ] **The tour and a mic asleep.** On hosted recognition, let the setup mic
      fall asleep by itself (two minutes with nothing asked), or say "stop
      listening". Start "Take the full tour": the mic lights again and the
      tour goes straight to the first card. Say "stop listening" on a card and
      go on by tap: every card is still read out, "You're ready" included.
- [ ] **No hole in a line** (desktop app, mic lit). Wait on the welcome card a
      few seconds before "Show me around", and on each card let the line end
      and wait two seconds before Next, the noting and felt sense cards
      included. Do it once with noting on a different speech recognizer from
      the other modes (its own pick, on the setup screen under the Noting
      tab), which replaces the listener at those two tab switches. No line may lose half a second
      partway through: Harper's introduction, the picked line and the
      attention-focus card did, a second or two in, while the setup mic let
      go of its stream as each line began (voice-commands.md, "Stopped is not
      let go").
- [ ] **zh**: the same quick pass with the language set to 中文 (小月 and
      大海; the lines are an unreviewed draft). On the tour's voice step each
      introduces itself by its Chinese name, and saying 大海 (or 小月) picks
      him (or her); so does 试听大海 with the voice picker closed. Note what
      the recognizer wrote if it does not.

**The sheet.** Read each line as its own utterance, with a pause between.
Lines marked ✗ must do nothing.

Modes and lengths:

    Noting.
    Switch to felt sense.
    Let's do exploration.
    Twenty minutes.
    Set the timer for ten minutes.
    Half an hour.
    An hour and a half.
    No timer.
    Felt sense and twenty minutes.

Vibes and focuses (on the Exploration tab). A name alone flips it:

    Playful.                                 → on
    Playful.                                 → off
    Add spacious.
    Feeling good.
    Loving and kind.
    Add playful.
    Remove playful.
    No loving.
    Change the vibe to spacious.
    Only compassionate.
    Clear the vibes.
    Body.
    Focus on emotions.
    Add parts.
    Drop the body focus.
    Change the focus to emotions.

Guidance and responses:

    More guidance.
    Guide me less.
    Balanced.
    Somewhat directing.
    Following.
    Shorter responses.
    Talk less.
    Keep your replies brief.
    Longer responses.

Intention, check-ins, the mic:

    My intention is to rest.
    Set my intention to letting go of the day.
    Clear my intention.
    Special requests.                        → "What's your request?"
    Special request: keep it slow.
    Add a special request to go gently.
    Clear my special requests.
    (felt sense tab) I want to sit with the job decision.
    (felt sense tab) Check-ins off.
    (felt sense tab) Add playful.            → "That's part of exploration."
    What can I say?
    Stop listening.

Beginning:

    Begin.
    Okay, let's begin.
    Begin a ten minute noting session.

Must do nothing (✗):

    I love playing with my kids.
    It started twenty minutes ago.
    Nothing.
    Light.
    We should begin to think about dinner.
    More.
    The timer on the oven is broken.

中文:

    标记。
    切换到体会。
    二十分钟。
    不要计时。
    加上开阔。
    去掉慈悲。
    多一点引导。
    回应简短。
    我的意图是好好休息。
    开阔。                                   → off (added above)
    特别要求。                               → "你的特别要求是什么？"
    特别要求：慢一点。
    试听大海。                               → plays Dahai's sample
    试听小月。
    停止聆听。
    开始。
    ✗ 今天天气不错。

A longer labelled list, with what each line should come to, is in
`ts/scripts/setup-voice/phrases.ts`; `ts/scripts/setup-voice/run.ts` plays it
through `say` and local Whisper.

## 3. Phone

The one that keeps biting, and the one with the least coverage. A dev-installed
Android build is enough for most of it - see [mobile.md](mobile.md).

- [ ] **Native STT holds a pause.** Speak, pause ~2s mid-thought, keep going. It
      must stay ONE turn. Logcat (dev mode on - diagnostic lines are silent
      without it): `[stt-native] final … N segment(s)`, N > 1 means the
      stitching did its job (`meditation-pal-cddo`).
- [ ] **Cloud STT gets the mic.** Switch STT to aloud cloud and start a session;
      no permission error (`meditation-pal-t25n`).
- [ ] **The facilitator doesn't interrupt itself.** Multi-sentence replies play
      through on the loudspeaker, and its voice never appears as a user turn
      (`meditation-pal-oxmt`).
- [ ] **The opening and closing sounds, on the phone's speaker.** Both are
      audible and play whole, the opening as far under the voice as before,
      and it is not transcribed as a turn. The iOS app played neither until
      the status-0 fix in `fetchBytes` (`signature-sound.ts`), so an iPhone is
      their first real hearing. On Android on aloud cloud speech, expect the
      close to follow the Call volume slider and the opening the Media one
      ([audio-output.md](audio-output.md) → "Phones").
- [ ] **A chime doesn't cut speech.** On the setup screen, start a voice
      preview and preview the noting chime while it speaks: both are heard and
      the voice carries on. Expected on an iPhone: a preview with no mic open
      ignores the silent switch and pauses other apps' music.
- [ ] **A headset's play/pause key doesn't cut a line** (`media-keys.ts`, now
      registered on phones too). On iOS, unplugging wired headphones still
      pauses it: that one skips the handlers.
- [ ] **iPhone on aloud cloud (`hi6f`, `qaqb`).** On the speaker, replies play
      through and a word said just after one still opens the turn. In the
      app with headphones, talking over the facilitator stops it; unplug mid-session
      and it goes back to the closed mic (`[vad] iPhone headphones` in the
      diag log).
- [ ] **Backgrounding doesn't kill the mic.** Mid-session, switch apps or lock
      the screen ~30s, come back, and speak - it must transcribe. Debug log:
      `stt restarted after foreground` (`meditation-pal-wudm`). **Then repeat the
      same check inside a noting circle**, which is deliberately not covered by
      that fix. **Listen to the reply's loudness too** (seen quiet after a lock on
      2026-09-04, `meditation-pal-wxj5`): if it's soft, press a volume key while
      it speaks - a slider labelled Call rather than Media is the diagnosis.
- [ ] **The session says when the volume is off.** With the volume all the way
      down, begin a session on the speaker: "The volume is off." sits above the
      status line and goes within a couple of seconds of turning it up. Two
      steps up from the bottom it reads "The volume is very low.", and not at
      all in headphones. On Android try it on aloud cloud speech too, where the
      slider that counts is Call. On iOS, check the reading follows the buttons
      at all: the plugin reads the app's own audio session while the WebView's
      audio runs outside it (`output-volume.ts`, `OutputVolumePlugin`). Never
      run on a device as of 2026-11-16.
- [ ] **A dropped connection doesn't eat a turn.** On aloud cloud, switch on
      airplane mode just as an utterance submits and off again within ~20s:
      the turn still lands and gets a reply (`[stt] final pass retry` in the
      bug report's log). Again while the dots show (`[cloud-llm] stream lost
      before any text`): the status line says "Connection lost - trying
      again" until the reply comes. Held
      off past the budget (`net-retry.ts`; ~30s for speech and for the reply),
      expect "Your words didn't get through…", not "Mic error: Load failed".
- [ ] **A session survives being killed.** Developer options → "Don't keep
      activities", background mid-session, return: the resume banner offers the
      sit back (`meditation-pal-v73p`).
- [ ] **Signed-out noting works.** Clear app data. Setup → noting → Begin with
      the default circle (one sound participant). Expect **no sign-in modal**, a
      full circle, and a saved session with no cloud call. Then add an AI
      participant and confirm the modal **does** appear (`meditation-pal-vr3w`). This is the
      claim the store reviewer note rests on.
- [ ] **Noting takes "mute" and "end the session".** In a signed-out circle,
      on your turn: "mute" pauses it like the mic button; "end the session"
      asks, "no" carries on, and asking again then "yes" ends it. Neither
      shows up as a note. Scripted headless only so far
      (`ts/scripts/voice-loop-check.mjs`); on the phone, check the question's
      echo isn't heard as the answer.
- [ ] **Sign-in survives a restart.** Sign in, force-stop, reopen - still signed
      in. Then sign out, force-stop, reopen - still signed **out**
      (`meditation-pal-7n22`).
- [ ] **Begin stays above the keyboard.** On setup, tap the intention box and
      type a line. Begin must sit on top of the keys with the bottom nav gone,
      the box must sit between it and the wordmark and orb (Special
      requests too, which starts lower down), and scrolling the page with
      the keys up must not snap back. Put the keyboard away: the nav returns
      and Begin drops back onto it. Then pinch-zoom the page with a field
      focused: nothing moves. Check the iOS app, the Android app and a phone
      browser, which each put the keyboard up differently (`keyboardInset` in
      `keyboard-inset.ts`). Measured on the Android app only (OnePlus 13,
      2026-11-13); on the other two only its arithmetic has run, against a
      stand-in viewport.
- [ ] **A mail link leaves the app cleanly.** About → "Kind words" opens the
      mail composer, and back in the app taps still work. Through the in-app
      browser tab it left an invisible activity over the app until Back; the
      fix (`openExternal` in `external-links.ts`) was read from the plugin
      source, never run on a device.

## 4. If you changed billing or the cloud

- [ ] A metered turn debits, and the balance in the account panel moves.
- [ ] Running out mid-session gives the graceful canned turn plus an inline
      top-up, and does not write the apology into history.

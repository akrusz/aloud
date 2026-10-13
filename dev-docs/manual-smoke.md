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

## 0. Before you start

```bash
npm run typecheck && npm test && npm run ui:build && npm run test:server
npm run soak:web          # needs the BlackHole device; see soak-harness.md
```

If any of those fail, stop and fix those first.

## 1. Desktop app (Tauri) - the path no test touches

`npm run tauri:dev`. This is the highest-value section: local Whisper, Piper, and
the WebAudio playback path exist only here.

- [ ] **First Begin asks for the mic**, and granting it starts a session. (Revoke
      in System Settings → Privacy → Microphone beforehand to get a real prompt.)
- [ ] **Whisper transcribes.** Say a full sentence, pause, and watch it come through as
      one turn - not two, not truncated mid-clause.
- [ ] **The facilitator speaks, audibly.** Not "a bubble appeared" - listen. A
      played-but-silent turn is a real failure mode (`meditation-pal-ypjj`) and
      nothing automated catches it.
- [ ] **The opening and closing sounds play whole.** At Begin the sound has no
      drop-out in it, the facilitator's first words come after it, and it never
      shows up as a user turn or flashes in the live preview. At End the close
      rings out with no hole in it. Each of those failed on MacBook speakers
      before it was fixed ([voice-barge-in.md](voice-barge-in.md) → "The
      opening and closing sounds"), and no test hears them.
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
- [ ] **The opening and closing sounds, on the phone's speaker.** Both play
      whole, at a level that sits with the voice, and the opening is not
      transcribed as a turn. They shipped after 2.15.0, so no store build has
      carried them yet.
- [ ] **Backgrounding doesn't kill the mic.** Mid-session, switch apps or lock
      the screen ~30s, come back, and speak - it must transcribe. Debug log:
      `stt restarted after foreground` (`meditation-pal-wudm`). **Then repeat the
      same check inside a noting circle**, which is deliberately not covered by
      that fix. **Listen to the reply's loudness too** (seen quiet after a lock on
      2026-09-04, `meditation-pal-wxj5`): if it's soft, press a volume key while
      it speaks - a slider labelled Call rather than Media is the diagnosis.
- [ ] **A session survives being killed.** Developer options → "Don't keep
      activities", background mid-session, return: the resume banner offers the
      sit back (`meditation-pal-v73p`).
- [ ] **Signed-out noting works.** Clear app data. Setup → noting → Begin with
      the default circle (one sound participant). Expect **no sign-in modal**, a
      full circle, and a saved session with no cloud call. Then add an AI
      participant and confirm the modal **does** appear (`meditation-pal-vr3w`). This is the
      claim the store reviewer note rests on.
- [ ] **Sign-in survives a restart.** Sign in, force-stop, reopen - still signed
      in. Then sign out, force-stop, reopen - still signed **out**
      (`meditation-pal-7n22`).
- [ ] **A mail link leaves the app cleanly.** About → "Kind words" opens the
      mail composer, and back in the app taps still work. Through the in-app
      browser tab it left an invisible activity over the app until Back; the
      fix (`openExternal` in `external-links.ts`) was read from the plugin
      source, never run on a device.

## 4. If you changed billing or the cloud

- [ ] A metered turn debits, and the balance in the account panel moves.
- [ ] Running out mid-session gives the graceful canned turn plus an inline
      top-up, and does not write the apology into history.

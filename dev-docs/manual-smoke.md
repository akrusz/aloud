# Manual smoke list

The five to ten minutes of by-hand checks worth running before a release, in
priority order. Nothing here is automated, and that's the point: every walk-back
in the mic path so far passed typecheck, the full vitest run, and `ui:build`,
and was caught by a human talking into a laptop.

Automation covers more than it did when this list was filed. `npm run soak`
drives the engine on a fake clock, and `npm run soak:web` drives real Chrome over
a virtual audio device (see [soak-harness.md](soak-harness.md)). Run those first
- they're cheaper than you are. What's left below is what they structurally
cannot reach: the desktop Tauri shell, permission refusals, real speakers and
real microphones, and phones.

Related: [pre-release-checklist.md](pre-release-checklist.md) is docs/copy drift,
not behaviour. [mobile-device-validation.md](mobile-device-validation.md) is the
per-device STT/TTS quality matrix.

---

## 0. Before you start

```bash
npm run typecheck && npm test && npm run ui:build && npm run test:server
npm run soak:web          # needs the BlackHole device; see soak-harness.md
```

If any of those fail, stop - nothing below is worth your breath yet.

## 1. Desktop app (Tauri) - the path no test touches

`npm run tauri:dev`. This is the highest-value section: local Whisper, Piper, and
the WebAudio playback path exist only here.

- [ ] **First Begin asks for the mic**, and granting it starts a session. (Revoke
      in System Settings → Privacy → Microphone beforehand to get a real prompt.)
- [ ] **Whisper transcribes.** Say a full sentence, pause, and watch it land as
      one turn - not two, not truncated mid-clause.
- [ ] **The facilitator speaks, audibly.** Not "a bubble appeared" - listen. A
      played-but-silent turn is a real failure mode (`meditation-pal-ypjj`) and
      nothing automated catches it.
- [ ] **Barge-in**: talk over the facilitator mid-sentence. It should stop and
      take your turn, and its own voice must not land as a user turn.
- [ ] **Voice preview on the setup page, then again in-session** from the voice
      panel. Both must be audible. (Setup-only was working when all in-session
      playback had gone dead, so check both.)
- [ ] **Say "mute"** as a whole utterance. The mic goes off; only the button
      brings it back.
- [ ] **Silence mode round trip**: get a `[HOLD]` bid, say yes, sit quiet, think
      out loud once (it should NOT bring the facilitator back), then clearly ask
      to resume.
- [ ] **End the session** and confirm it appears in History with a summary.

Failure states, in a dev build, via `?nomic=` (see `ui/src/mic-check.ts`):

- [ ] `?nomic=denied` → setup shows the no-mic banner and **Begin is disabled**.
- [ ] `?nomic=none` → same, with the no-device wording.

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
      must stay ONE turn. Logcat: `[stt-native] final … N segment(s)`, N > 1 means
      the stitching did its job (`meditation-pal-cddo`).
- [ ] **Cloud STT gets the mic.** Switch STT to aloud cloud and start a session;
      no permission error (`meditation-pal-t25n`).
- [ ] **The facilitator doesn't interrupt itself.** Multi-sentence replies play
      through on the loudspeaker, and its voice never appears as a user turn
      (`meditation-pal-oxmt`).
- [ ] **Backgrounding doesn't kill the mic.** Mid-session, switch apps or lock
      the screen ~30s, come back, and speak - it must transcribe. Debug log:
      `stt restarted after foreground` (`meditation-pal-wudm`). **Then repeat the
      same check inside a noting circle**, which is deliberately not covered by
      that fix.
- [ ] **A session survives being killed.** Developer options → "Don't keep
      activities", background mid-session, return: the resume banner offers the
      sit back (`meditation-pal-v73p`).
- [ ] **Signed-out noting works.** Clear app data. Setup → noting → remove the
      default AI participant → Begin. Expect **no sign-in modal**, a full circle,
      and a saved session with no cloud call. Then add an AI participant back and
      confirm the modal **does** appear (`meditation-pal-vr3w`). This is the
      claim the store reviewer note rests on.
- [ ] **Sign-in survives a restart.** Sign in, force-stop, reopen - still signed
      in. Then sign out, force-stop, reopen - still signed **out**
      (`meditation-pal-7n22`).

## 4. If you changed billing or the cloud

- [ ] A metered turn debits, and the balance in the account panel moves.
- [ ] Running out mid-session gives the graceful canned turn plus an inline
      top-up, and does not write the apology into history.

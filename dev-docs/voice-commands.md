# Voice input and spoken commands

There is no text mode: voice is the only input, so a session can't start
without a mic, and anything the meditator wants from the app has to be sayable.
The judge these commands run on is described in
[silence-mode.md](silence-mode.md#the-judge-jev).

## Mic pre-flight

`ui/src/mic-check.ts` pre-flights both start paths. A silent `probeMic()`
paints the setup notice and disables Begin when it's certain; `acquireMicOnce()`
runs first inside the Begin handler, before any await, so the permission prompt
keeps the click's user gesture.

Setup holds Begin the same way while local Whisper's model is still downloading
or loading (`ui/src/whisper-ready.ts` polls the shell's `/stt/whisper/warm`,
optimistic on any probe failure), so a first-launch session can't start deaf.

## Bare "mute"

`isMuteCommand` (`mute-command.ts`): a bare "mute" outranks every dispatch
route, since it's the one thing you say when you want the app to stop hearing
you. It is judge-free, so it works on every provider. Deliberately strict -
losing the mic mid-sentence beats reaching for the button - so the whole
utterance must be the command. Unmuting is button-only.

## Spoken commands (judge sessions)

Defined in `voice-command.ts`, with the asks in `voice-command-specs.ts`:

- **End session.** Plain follows `saveSessionLogs`; "end without saving" and
  "end and save" override it for that sit. Ending is only ever a bid: the app
  asks, and `classifyEndConfirm` judges the reply inside a 45s window.
- **Speak slower / faster.**
- **Set / extend / cancel the timer, time check.** Jev says *that* a timer was
  asked for; `parseTimerRequest` pulls the minutes.
- **Repeat the last line.**
- **Reply sooner / wait longer.** One rung on `PAUSE_LADDER`, applied live
  through the optional `SttEngine.setPauseWindow` and saved to
  `silenceBaseMs` / `silenceMaxMs`.
- **Mic mute**, naturally phrased (the bare word still takes the
  `isMuteCommand` path first), and **speaker mute / unmute** as a separate pair.
- **On-screen extras**: show/hide the clock readout (the timer keeps running),
  show/hide the orb, embers on/off, dark/light/switch theme. These use a lower
  threshold (`VISUAL_THRESHOLD`): Jev scores them softer, and a misfire is only
  a flicker.
- **Help** ("what can I say?").

Each command speaks a canned acknowledgment (`COMMAND_LINES`).

## How an utterance is checked

1. The bare-mute check (`isMuteCommand`).
2. **Gate.** Short utterances (`mightBeCommand`) first get one cheap ask
   (`command-gate`, ~600 tokens: "an instruction to the app at all?", bar 0.2,
   fails open). The full command set costs ~4,200 tokens whatever the answer,
   and nearly everything said is meditation.
3. **Commands.** A maybe goes to Jev as one request with an atomic yes/no ask
   per command. This runs right after the mute check and ahead of
   `routeUtterance`, so commands work inside a hold without ending it
   (`restoreHoldAfterNotice`).
4. **Resolve.** The asks are independent, so one utterance can clear several
   ("talk slower and show me the orb"). `resolveCommands` drops the weaker of
   two opposites and orders the rest (speaker mute, then mic mute, then the end
   question last), and the app speaks one joined acknowledgment.

Around that:

- **Prefetch.** `CommandPrefetch` asks the judge on a settled partial
  transcript while the recognizer is still waiting out the pause, so the
  verdict is usually ready at submit. It only makes the answer early and never
  acts before a matching final.
- **Retry.** A failed command check is retried once: a timeout is not a no, the
  first call through a freshly started server runs ~1s (at its timeout's edge),
  and there is no LLM twin behind it. `CloudJudge.warm()` and the server's
  boot-time call spend that cold call early.
- **Misses.** A request that misses the judge reaches the model as an ordinary
  turn, so `appControlsFragment` (`prompts.ts`) tells it that it cannot work
  the app and must never say it did.
- **No judge** (not opted in, signed out, outage) means no commands, only the
  bare "mute".

## Opt-in and discovery

The opt-in is one checkbox under Settings → Advanced (locked on for aloud
cloud), and can also be turned on mid-sit from the info panel's Voice commands
row, which swaps the judge in live.

Discovery (`ui/src/voice-command-hints.ts`) is all on the status line rather
than toasts: the first few judge sessions read
`Listening… or ask "what can I say?"`; using the speed slider, timer picker or
mute button by hand shows a one-time `You can just say "..."`; and the session
info panel's Voice commands row opens the list.

## Changing a command

`npm run jev:commands` scores every ask (through the gate) against a labelled
corpus and prints the thinnest margins. The asks share one request, so rerun it
after touching any of them, and keep them lean: each costs ~170 tokens a call.
Everything else a command change touches (acknowledgment lines in both
languages, hints, README / site / store copy) is listed in
[pre-release-checklist.md](pre-release-checklist.md) Part B.

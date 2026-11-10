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

## The two that need no judge

Recognized outright, so they work on every provider, signed out, offline, and
when the judge is down. They cost nothing.

**Bare "mute".** `isMuteCommand` (`mute-command.ts`): a bare "mute" outranks
every dispatch route, since it's the one thing you say when you want the app to
stop hearing you. Deliberately strict - losing the mic mid-sentence beats
reaching for the button - so the whole utterance must be the command. Unmuting
is button-only.

**"End the session", and the yes or no after it.** `isEndCommand` and
`endConfirmReply` (`end-command.ts`). A sit that can be started by voice has to
be leavable by voice, and before this a BYOK or local sit that hadn't opted in
could only be ended by hand. The request is a verb (end, stop, finish, close,
quit) plus what is being ended (session, sit, meditation) and nothing else but
the words that politely surround a request, so "can we end the session" and
"I'd like to stop the meditation now" match and "I don't want this session to
end" does not. Looser than mute, because the failure is cheaper: ending is only
ever a bid, and a wrong match gets asked "Would you like to end the session?".
The answer is a small vocabulary where any no-word wins and one unknown word
makes it an ordinary turn ("yes, I think my leg is asleep").

Where there is a judge it still hears everything first. These run after it:
`isEndCommand` when the judge named no command (down, timed out, or missed),
`endConfirmReply` when its answer to the open question was `other`. The
save/discard variants ("end without saving") and every other command stay
judge-only.

## Starting by voice (opt-in)

Settings → Advanced → **Start by voice (experimental)**
(`AppSettings.voiceStart`, off by default). On the setup screen the mic
listens for "begin" (`isBeginCommand`, `begin-command.ts`: begin or start,
optionally the session, and the words people wrap around it) and starts the
session the Begin button would. With the judge-free "end the session" this
makes a sitting hands-free after the first touch: begin, speak, end, begin
again.

A mic open before a session exists is held to narrower rules than one inside
it (`ui/src/voice-start.ts`, `voiceStartBlocker`):

- **Free recognizers only**: the browser's, the phone's, local Whisper. A
  session set to hosted STT gets no listening before Begin, since a room with
  a television in it would be billed for the television. The word is matched
  on the device, not by the judge, so the lobby costs nothing on any account.
- **Never prompts.** It runs only when the mic is already granted
  (`micAlreadyGranted`; unknown counts as no, which rules out Safari).
- **Two minutes**, then the mic closes (`VOICE_START_WINDOW_MS`) and the
  status line offers to listen again. It also closes the moment the setup
  screen goes away.
- **One touch first.** A page nobody has interacted with can't play sound, so
  a session begun there would be silent (`pageTouched`). This is the one thing
  between here and a start with no hands at all, and it is the platform's rule
  on the web; whether the desktop and mobile shells need it is untested.

Opt-in until it has been through real devices: the Android recognizer's
start/stop chime, what local Whisper costs in CPU while idle, and WebKit's
activation rules in the Tauri and Capacitor webviews
([manual-smoke.md](manual-smoke.md)).

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

1. The bare-mute check (`isMuteCommand`). If the end question is open, the
   reply goes to `handleEndConfirm` instead of the steps below.
2. **Gate.** Short utterances (`mightBeCommand`) first get one cheap ask
   (`command-gate`, ~600 tokens: "an instruction to the app at all?", bar 0.2,
   fails open). The full command set costs ~4,200 tokens whatever the answer,
   and nearly everything said is meditation.
3. **Commands.** A maybe goes to Jev as one request with an atomic yes/no ask
   per command. This runs right after the mute check and ahead of
   `routeUtterance`, so commands work inside a hold without ending it
   (`restoreHoldAfterNotice`).
4. **Second look.** A request can point back at something just said: "Can you
   actually do that?" right after the facilitator's "when you're ready, you can
   end the session". That clears the gate and then names no command, so it used
   to reach the model, which can only say it can't work the app. When step 3
   finds nothing, `secondLook` asks the same set again beside what was said
   just before (`saidJustBefore`: the facilitator's last line, the meditator's
   last turn), one side per request, the higher score counting. Shown together
   the two sides dilute each other, and the first look never gets context at
   all, because it moves the scores of commands that name themselves. The
   facilitator's line only goes along on aloud cloud (`judgeContextFor`): an
   opt-in or own-key session was promised that only what the meditator says
   reaches the judge, so there it is the meditator's side alone.
5. **Resolve.** The asks are independent, so one utterance can clear several
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
  and there is no LLM twin behind it. `RemoteJudge.warm()` and the server's
  boot-time call spend that cold call early.
- **Misses.** A request that misses the judge reaches the model as an ordinary
  turn, so `appControlsFragment` (`prompts.ts`) tells it that it cannot work
  the app and must never say it did.
- **No judge** (not opted in, signed out, outage) means only the two above:
  the bare "mute" and the plain "end the session". The info panel's Voice
  commands row says so rather than "Off".

## Opt-in and discovery

The opt-in is one checkbox under Settings → Advanced (locked on for aloud
cloud), and can also be turned on mid-sit from the info panel's Voice commands
row, which swaps the judge in live. On desktop the same spot takes a TypeSafe
API key, which turns commands on by itself for BYOK/local sits (the box shows
checked and locked); see [silence-mode.md](silence-mode.md#the-judge-jev).

Discovery (`ui/src/voice-command-hints.ts`) is all on the status line rather
than toasts: the first few judge sessions read
`Listening… or ask "what can I say?"`; using the speed slider, timer picker or
mute button by hand shows a one-time `You can just say "..."`; and the session
info panel's Voice commands row opens the list.

## Changing a command

`npm run jev:commands` scores every ask (through the gate) against a labelled
corpus and prints the thinnest margins, then runs the pointing-back cases
(`POINTING_BACK`) through `detectVoiceCommand` itself. The asks share one
request, so rerun it after touching any of them, and keep them lean: each costs
~170 tokens a call.
Everything else a command change touches (acknowledgment lines in both
languages, hints, README / site / store copy) is listed in
[pre-release-checklist.md](pre-release-checklist.md) Part B.

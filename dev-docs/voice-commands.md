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

A noting circle has its own listen loop (`views/noting-session.ts`) and no
judge at all, so these two are its whole command set: on the meditator's turn
"mute" pauses the circle as the mic button does, and "end the session" asks,
listens once (past the echo window, since the question was just spoken), and
ends on a yes. A reply that is neither yes nor no is taken as the note it most
likely is.

Where there is a judge it still hears everything first. These run after it:
`isEndCommand` when the judge named no command (down, timed out, or missed),
`endConfirmReply` when its answer to the open question was `other`. The
save/discard variants ("end without saving") and every other command stay
judge-only.

## Voice on the setup screen

Settings → Language & Speech Recognition → **Voice control on the setup
screen** (`AppSettings.setupVoice`, on by default). The mic on the setup screen
hears two kinds of request, and they are held to different standards.

**"Begin"** starts the session the Begin button would (`parseBeginRequest`,
`begin-command.ts`: begin or start, optionally the session, and the words
people wrap around it). It can name a mode and a length, as in "begin a twenty
minute felt sense session". The match is strict and on the device, and nothing
looser ever reaches it: a wrong Begin is the one costly thing to mishear.

**Changes to the setup** are read by `parseSetupCommand` (`setup-command.ts`)
into a list of `SetupAction`s:

- a mode by the name on its tab ("noting", "switch to felt sense");
- a length ("twenty minutes", "half an hour", "no timer");
- focuses and vibes: a name adds it, "no" / "remove" / "off" takes it away,
  "change the vibe to" / "only" replaces the set, "clear the vibes" empties it;
- guidance, by step ("more guidance", "guide me less") or by stop
  ("balanced", "somewhat directing");
- response length ("shorter responses", "keep your replies brief");
- the intention ("my intention is to rest", "clear my intention"), kept in the
  meditator's own words and case;
- check-ins on or off (felt sense);
- "stop listening" / "mute" (closes the mic until tapped), and "what can I
  say?".

Several can ride one utterance ("felt sense and twenty minutes"). A comma or a
full stop parts a request as "and" does, and so does a "no" between two things
("effortless no check-ins"), which is said of the one after it. A "no" said
ahead carries to more of the same ("remove playful and loving" removes both)
and not to something else ("no check-ins and spacious" adds spacious). Voice,
model, provider and speech recognition stay button-only.

The whole utterance has to be the request, as with "begin": one word this
doesn't know and it is the room talking. Inside that rule the value words are
matched in three grades:

1. A name the setup screen shows ("Playful.", "Noting.") is a request by
   itself.
2. Another form of one ("playfulness", "emotional") counts only beside a word
   that asks (`ASKING`: add, set, more, no, pick, a target like "vibe" or
   "mode"). Alone it is what a room says. The everyday words that also mean
   one ("light", "kind", "space", "love") are not in the vocabulary at all:
   "turn on the light" is said in rooms. The judge tier reads those.
3. A word that only *sounds* like one (`nearestWord`: the same `soundKey` and
   a small edit distance, so "living" for "loving", "nothing" for "noting")
   also needs a word that asks. Mishearings a recognizer has actually been
   seen to write go in `HEARD_AS`, which counts as the phrase itself
   ("light-hearted", "auspicious", "Noding"); `RESPELLED` is the same for a
   word written as two or two as one ("Talkless"), and "Hell.", "Health." and
   "Held." are what local Whisper wrote for "help" in 16 clips of 18.

Around that, the things people say to each other in this vocabulary are
turned away on purpose (`tests/setup-command.test.ts` lists them): a length
needs the company of a request ("in twenty minutes" and "give me five
minutes" are not), nothing under two minutes is a session, check-ins need a
direction ("just checking in" is not), a denial outranks an "on" in the same
breath ("don't check in on me"), and an intention needs its "is".

zh is exact-match, in simplified characters, with the handful of sound-alikes
local Whisper was seen to write for its own words (记时器 for 计时器, 此爱 for
慈爱). Traditional characters are converted first (`zh-script.ts`); an
intention keeps the script it was said in.

### What happens to a request

`views/setup.ts` hands the actions to `applySetupActions`
(`ui/src/setup-actions.ts`), the same layer the form's own click handlers go
through (`SetupForm`). A mode goes first wherever it was said, so "playful
exploration" under Noting lands the vibe in the mode being switched to. Each
action returns a `SetupOutcome`: what the form now says, after clamping and
stepping. A setting said under a mode that has no
such thing (a vibe on the felt sense tab) is not applied, and the outcome says
whose it is.

`setupOutcomeLines` (`setup-lines.ts`) turns the outcomes into the lines said
back, and the same words show above Begin for six seconds
(`#voice-start-note`): the answer for anyone with the sound off, and where a
mishearing shows. A clear that only made room is not announced; more than
three lines become one "Okay, all set."

### The judge tier

What the parser can't place goes to Jev, where this setup may ask it at all
(`createSetupJudge`, `ui/src/setup-judge.ts`): the same consent as a session's
voice commands (aloud cloud as the provider, an own TypeSafe key on desktop
through the shell relay, or the opt-in with an account), and only with a token
already stored, so the setup screen never raises a sign-in. Signed out, or
local with no opt-in, nothing is sent anywhere and the parser is the whole
feature. A server from before the ids answers 4xx and is not asked again
until the page reloads.

Two ids in `setup-command-specs.ts` (`judgeSetupCommand`):

- `setup-gate`: one ask, "is this phrased as a request to the app?" (~760
  tokens, about $0.00003). A cost filter, not the safeguard.
- `setup-command`: 24 asks (~4,700 tokens, about $0.0002): one per mode, vibe
  and focus, `remove` and `replace` as modifiers, guidance up and down,
  shorter and longer responses, a length (the minutes come from
  `parseTimerRequest`), no timer, check-ins, stop listening, help, and
  `begin` as a veto that empties everything. `resolveSetupAnswers` turns the
  answers into the same `SetupAction`s.

`mightBeSetupRequest` keeps the hopeless off the wire: a lone word (sound is
all the judge would have), more than 16 words, and anything containing begin
or start, which never comes through this tier.

What it is good for, measured with `npm run jev:setup` (2026-11-14, synthetic
voices and written lines, no real rooms): natural phrasing the parser misses
("could you make it a bit more spacious", "I'd rather you led less"), 47 of 51
and 21 of 23 held out, with 0 false positives on 276 room and television
lines. It is **not** a mishearing fixer: of 150 lines local Whisper wrote that
the parser still misses (`scripts/setup-voice/misheard.ts`), it recovered 4,
and the scores of recovered mishearings sit where television lines with a
value word in them sit ("Effortless style." 0.86), so the bars keep the room
out and most mishearings with it. A mishearing a recognizer really makes
belongs in `HEARD_AS`. One begin-like line gets through as settings and never
as a begin: "Look in ten minutes of exploration." (Whisper's "begin ten
minutes of exploration") sets the mode and the length. Every threshold is
marked provisional: they wait on transcripts of real voices in real rooms
([manual-smoke.md](manual-smoke.md)).

Not billed. Usage rows carry `purpose: 'setup'` and stay out of the session
numbers; the calls spend the same `judgeDailyCap` / `judgeGlobalCap`
allowance as a session's (a noisy window is about 60 calls against 5,000).

### Who speaks

`ui/src/setup-speech.ts`. Nothing on this screen is synthesized per user on a
hosted voice:

- **A local session voice** (Piper, `say`, the browser's) says the line
  itself, exact minutes included. Free, and already the voice of someone
  signed out.
- **A hosted session voice** is answered with a pre-rendered clip in a *house
  voice*: the session voice itself when it is one, else the one picked in the
  tour (`AppSettings.houseVoice`), else the language's default (the female
  one). House voices are the catalog entries flagged `house`
  (`server/src/providers/voice-catalog.ts`): Harper and Ethan for English,
  Serena and Yunfan for Chinese.
- Where neither can speak (no clip, a browser tab that won't play without a
  gesture), the caption is the answer.

Clips are static files under `ui/public/voice-clips/`, listed in
`ui/src/voice-clips.json` with the text each was rendered from. A line edited
in `setup-lines.ts` without a re-render is simply not played (`clipFor`
compares the text), and the hash in the file name makes a re-rendered line a
new URL. `npm run clips:render` (`server/scripts/render-voice-clips.ts`)
renders what changed, prices the run first, and checks each clip for the two
faults these voices have (a short line said twice, a first word cut),
re-rendering up to four times; `-- --check` lists what is missing or stale.
Clips play at the speed setting by playback rate with pitch kept, except on a
styled voice, which ignores the speed setting in a session too.

### The mic

The mic beside the Begin button is the indicator and the switch
(`#voice-start-mic`, the session's mic icon): lit while it listens, slashed
when it doesn't, a tap toggles. It hangs off Begin's left edge out of flow, so
the bar keeps its height. Hidden when the setting is off or Begin itself
can't run.

A mic open before a session exists is held to narrower rules than one inside
it (`ui/src/voice-start.ts`, `voiceStartBlocker`, `listenOnSetup`):

- **Never prompts by itself.** `micPermission` reads what is already decided:
  `granted` listens at once, `ask` (unknown, or never asked) shows the slashed
  mic and waits for a tap, which is the one place it may raise the prompt
  (`acquireMicOnce`, inside the gesture), `denied` shows it inert with the
  reason in its title. Three sources, in order:
  - a capture that already succeeded on this page (`micOpenedThisPage`), which
    is what makes "begin again" hands-free in browsers with no answer to give;
  - on desktop, the shell's `GET /app/v1/mic-permission` (`mic_authorization`
    in `src-tauri/src/server.rs`: AVFoundation's authorization status on
    macOS, `unknown` elsewhere). The webview can't be asked there: WKWebView
    says `prompt` until the page has captured once in this launch, whatever
    System Settings says (measured 2026-11-13; it does flip to `granted`
    after a capture);
  - the browser's Permissions API. Safari throwing on the descriptor is `ask`.
- **Two minutes with nothing asked**, then the mic closes
  (`VOICE_START_WINDOW_MS`) and stays closed until tapped. Each request it
  understands starts the two minutes over, up to ten minutes since it opened
  (`VOICE_START_MAX_OPEN_MS`): nothing a television says keeps a microphone
  open past that. It also closes the moment the setup screen goes away.
- **It does not hear the app.** A request is answered with the recognizer
  stopped (`onHeard` runs between turns), and a line nobody asked for, like a
  step of the tour, stops it first (`hold`). Listening resumes
  `SPEECH_TAIL_MS` after the line. As a backstop, something heard within a few
  seconds of a line that is nothing but that line's last few words is dropped
  (`looksLikeSpokenTail`, asked through `isEcho` before anything else, "begin"
  included). No spoken line ends on a request, "begin" least of all
  (`setup-lines.ts`): a tail is what a slow speaker leaves in the room.
- **Not where the recognizer would need a sign-in.** A hosted speech
  recognition pick with nobody signed in would refuse the first thing heard,
  and nothing on this screen may raise a sign-in, so there is no mic then
  (`sttNeedsAccount` in `views/setup.ts`).
- **The session's own recognizer, tuned for a few words** (`LOBBY_STT`): the
  turn ends on a 0.7-1.5s pause instead of a session's 3s+, no utterance runs
  past 10s, and there are no speculative passes.
- **Told what to expect** (`setupListening` in `LOBBY_STT`, read by
  `stt-picker.ts`; the words are `setupVocabulary` in `setup-command.ts`).
  Local Whisper gets them as an initial prompt (the shell's
  `/app/v1/stt/whisper` takes `prompt`, one decoder state per request so it
  can't carry over). The phone recognizers get them as phrases
  (`biasPhrases`: `contextualStrings` on iOS, `EXTRA_BIASING_STRINGS` on
  Android 13+, in the patched plugin; both compile, neither has run on a
  phone). Hosted recognition gets a flag and the server builds the prompt
  itself, below. Chrome's browser recognizer gets nothing: its phrase biasing
  is on-device only and makes a cloud recognizer fail at start. "Begin" is in
  none of it, since a prompted word is the one a recognizer writes over
  noise. A session sends none of it.
- **zh has phrases and no prompt.** Measured (below), the zh prompt wrote its
  own words over unclear speech: 开始 came out 开阔 and 跟随 came out 均衡. About
  one request in 25 changed the wrong thing against none without it, and 开始
  itself was heard less often. So `setupVocabulary('zh').prompt` is null, for
  local Whisper and for hosted recognition alike (hosted zh was not measured;
  it follows the cautious side). What the prompt was mostly buying was the
  script: unprompted, Whisper's base model writes traditional characters for
  most Mandarin. `zh-script.ts` (`toSimplified`, `trimHeardZh`) does that for
  begin, the setup parser and the tour's words instead, and a recognizer set
  to zh-TW needs it anyway.

### Measured on synthetic speech

`scripts/setup-voice/run.ts` says every phrase in `phrases.ts` (143 English
and 46 Chinese requests, 52 things a room says, 8 paragraphs of prose) with
macOS voices, in three rooms (clean, noise at 12 dB, a far microphone), and
puts each clip through the shell's own Whisper settings
(`src-tauri/examples/whisper_batch.rs` mirrors `transcribe` in `server.rs`)
with the prompt off and on. `results/summary.txt` is the report and
`results/cache.json` the transcripts, so `npx tsx scripts/setup-voice/run.ts
--summary-only` rescores them against the parser as it now stands in seconds,
with no audio and no Whisper. Run it after touching `setup-command.ts`.

As of 2026-11-14, base models, 1,673 clips each transcribed twice:

- **No false "begin" and no false setting**, from 350 room and television
  lines, 32 clips of noise and 57 pieces of prose under noise, in either
  language, prompt on or off.
- **English, prompt on (what ships):** 90% of requests read exactly, 0.2%
  read as something else, the rest missed (96% / 88% / 58% exact in the clean,
  noisy and far rooms). The prompt is worth 4 points and costs nothing.
- **Chinese, no prompt (what ships):** 48% exact, none wrong. Whisper's base
  model is weak on short Mandarin from these voices (one of the two core
  voices reads 74%, the other 24%).

It is synthetic voices through one recognizer: good for what a recognizer
systematically writes and for what the prompt does, not a measure of a real
voice in a real room. What Whisper wrote and the parser still misses is
regenerated into `misheard.ts`, which `npm run jev:setup` scores the judge
tier on.
- **Hosted listening here is not billed, inside an allowance.**
  `POST /cloud/v1/stt?setup=1` (`server/src/routes/stt.ts`) costs nothing
  while the clip is short (`SETUP_MAX_CLIP_SECONDS`, 15) and the account has
  setup seconds left that day (`SETUP_STT_SECONDS_PER_DAY`, 600, in
  `server/src/deps.ts`, with an all-accounts ceiling beside it). Past either
  it is metered like any session audio, so the flag can't make a session's
  recognition free; the bound is the server's, not the client's. An account at
  zero can still say "begin". Usage is recorded with `purpose: 'setup'` and
  has its own row in the admin panel's cost split ("STT setup listening"),
  kept out of the session numbers. A server that predates this ignores the
  flag and bills as before.
- **A touch only where sound needs one.** A browser tab nobody has interacted
  with can't play sound, so a session begun there would be silent; the mic
  shows slashed until any touch (`pageTouched`). The webviews don't have the
  rule (`canPlayUntouched` asks the platform by playing a silent clip:
  untouched Chrome refuses it, an untouched macOS WKWebView plays it), so the
  desktop app listens from launch with no touch at all.

The listener belongs to one mount of the setup screen and one begin attempt.
The view has no teardown, so its probe callbacks keep firing after it is
replaced (`setupMounts` / `isLiveMount` in `views/setup.ts`), and a begin that
is under way holds the mic closed until it has become a session or been
turned back (`beginning`). Both were found the hard way: a second listener on
the next setup screen, and one that reopened for half a second under a
starting session. A listener rebuilt mid-line (a mode with its own recognizer
pick) waits for the line to finish (`speaking`).

### The tour, spoken

The setup tour (`ui/src/tour/index-guide.ts`) is also the voiced onboarding.
The setup view hands it a `TourVoice`; with one, each step is read out as it
goes up, a step offers the two house voices (each introduces itself; the pick
becomes the voice everywhere, the session's included), a step offers to turn
the microphone on where a tap could, and with it on the tour answers to
"next", "back", "repeat", "skip", "mute" and a voice's name or place
(`parseTourCommand`, `tour-command.ts`, the same whole-utterance rule). Every
one of those is also a button. The speaker on each card stops the reading and
is remembered. The voice step is skipped for someone whose session voice is a
local one: the pick is between hosted voices and would move them off it.

### Not verified on a device

Everything above has run through the real UI with a scripted recognizer
(`voice-loop-check.mjs`) and never with a microphone and a speaker in a room.
What that leaves is in [manual-smoke.md](manual-smoke.md): that a spoken
answer is audible and not heard back, the phone recognizers with the phrase
lists, how a clip sounds on Android once the mic has opened (call stream),
and what a television does over five minutes.

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

The judge-free matchers have unit tests (`tests/mute-command.test.ts`,
`end-command.test.ts`, `begin-command.test.ts`, `setup-command.test.ts`,
`tour-command.test.ts`), and
`node ts/scripts/voice-loop-check.mjs` runs a whole sitting through the real
web UI with a scripted recognizer and a mocked model (`npm run web:dev` up; no
mic, no keys), the setup screen's voice controls included. It is the only
thing short of a real session that exercises the listen loop's dispatch in
`views/session.ts`.

`npm run jev:commands` scores every ask (through the gate) against a labelled
corpus and prints the thinnest margins, then runs the pointing-back cases
(`POINTING_BACK`) through `detectVoiceCommand` itself. The asks share one
request, so rerun it after touching any of them, and keep them lean: each costs
~170 tokens a call.
Everything else a command change touches (acknowledgment lines in both
languages, hints, README / site / store copy) is listed in
[pre-release-checklist.md](pre-release-checklist.md) Part B.

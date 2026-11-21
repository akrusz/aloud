# Voice input and spoken commands

There is no text mode: voice is the only input, so a session can't start
without a mic, and anything the meditator wants from the app has to be sayable.
The judge these commands run on is described in
[silence-mode.md](silence-mode.md#the-judge-jev).

## Mic pre-flight

`ui/src/mic-check.ts` pre-flights both start paths. A silent `probeMic()`
paints the setup notice and disables Begin when it's certain; `acquireMicOnce()`
runs first inside the Begin handler, before any await, so the permission prompt
keeps the click's user gesture. Begin goes through `micForBegin`, which opens
that probe stream only until a mic has opened on the page: each open and close
of an echo-cancelled stream rebuilds the audio output on macOS, under the
opening sound (meditation-pal-uz8t), and switches call mode on Android. A
capture stream of ours that is live or was within `RECENT_CAPTURE_MS` (the
setup screen's listener, held by the same Begin; `whisper-pcm-stt.ts` reports
its streams) is the answer. After an older one the silent `probeMic()` asks
instead, which can see a mic unplugged or blocked since (the device list is no
longer hidden), so a lost mic is still caught on setup and not inside the
session, where noting would never say why.

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
ever a bid, and a wrong match gets asked "Would you like to end the session now?".
The answer is a small vocabulary where any no-word wins and one unknown word
makes it an ordinary turn ("yes, I think my leg is asleep").

**Hearing the answer.** On the Whisper engines (local Whisper, aloud cloud)
the turn after the question is taken as its answer (`listenForAnswer` in
`views/session.ts`, `expectAnswer` in `whisper-pcm-stt.ts`) for the
question's 45 seconds, until something with words is heard, or until another
line starts (`noteVoicePlayback`): a check-in or a timer notice can ask a
question of its own, and plays at the full bar. The end question's window
closes there too (`endConfirmUntil`, cleared in `ttsPlaybackStarted`). Two
things differ from a meditation turn, both after a "yes" on an Android phone
was lost once and then waited 3.1s to be acted on (meditation-pal-cs6y):

- It ends sooner than a turn, which waits out the session's pause (3s and
  up), once a speculative pass reads it with nothing said since
  (`answerPace` in `end-command.ts`): a plain no at that pass (0.75s of
  quiet plus the pass), a plain yes after 2s of quiet
  (`ANSWER_YES_PAUSE_MS`) on the pass's own text. Ended at its pass,
  "yes... no, not yet" was a yes and ended the sit; words said inside the
  2s join the turn and are read with it. Anything else ("hmm, yes"), and a
  bare 嗯, as often thinking as a yes, waits the full pause, so a hesitant
  reply is not cut in two. The pass runs even with speculative passes off,
  and past two seconds of speech it is a turn and turn rules apply
  (`ANSWER_MAX_SPEECH_MS`).
- For a second after the question ends the mic holds the echo gate up
  (`TTS_ACTIVE_HANGOVER_MS`), and a word had to clear the bar for speech over
  the facilitator. Over that tail the bar is now set by how loud the question
  itself was at the mic ([voice-barge-in.md](voice-barge-in.md#detection)), so
  a soft "yes" said the moment the question ends opens the turn. While any
  line plays the bar is as before: the facilitator's voice can't answer.

A hold bid ("shall I be quiet?") is listened to the same way. The browser's
and the phones' own recognizers end their turns themselves and get neither. A
cough transcribed as only a marker leaves the question open. Each answer
leaves `[vad] answer ...` lines (where it began after the question, or the
loudest sound over the tail that didn't open it) and a `[turn] end-confirm`
line (the verdict, who gave it, how long after the question it was heard).

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
screen** (`AppSettings.setupVoice`). On by default at a desk and off on a
phone (`loadAppSettings`): an open mic there puts Android into call audio,
which drops Bluetooth to call quality and reaches other apps' sound, before
anyone has asked for anything. The button beside Begin is the same switch,
and off means the setup screen neither listens nor speaks ("The mic", below).
The mic on the setup screen hears two kinds of request, and they are held to
different standards.

**"Begin"** starts the session the Begin button would (`parseBeginRequest`,
`begin-command.ts`: begin or start, optionally the session, and the words
people wrap around it; "began" and "begun" count as begin, being what a
recognizer writes for it). It can name a mode and a length, as in "begin a twenty
minute felt sense session". The match is strict and on the device, and nothing
looser ever reaches it: a wrong Begin is the one costly thing to mishear.

**Changes to the setup** are read by `parseSetupCommand` (`setup-command.ts`)
into a list of `SetupAction`s:

- a mode by the name on its tab ("noting", "switch to felt sense");
- a length ("twenty minutes", "half an hour", "no timer");
- the clock readout: "hide the clock" (or "hide the timer") hides it and
  leaves a countdown running, "show the clock" brings it back, "turn off the
  clock" is the readout hidden and the timer off, and "show the time of day" /
  "time in session" pick what it counts;
- focuses and vibes: a name said by itself flips it, on to off and off to on
  ("Playful.", "the body, please"; `toggleByName`, and the answer says which
  way it went), "add" / "more" adds it and "no" / "remove" / "off" takes it
  away whatever it was, two names ("playful and spacious") add both, "change
  the vibe to" / "only" replaces the set, "clear the vibes" empties it;
- guidance, by step ("more guidance", "guide me less"), by stop
  ("balanced", "somewhat directing"), by level ("set the guidance level to
  medium": minimum, low, medium, high and maximum are the five stops) or by
  the number drawn on the stop ("guidance three", "set the guidance level to
  4", 引导三; `guidanceStops`). After "guidance" a recognizer's "for" and "to"
  are the number ("Guidance for.", 2026-11-17); a number without "guidance" is
  not a request;
- response length ("shorter responses", "keep your replies brief", "set
  response length to medium");
- the intention ("my intention is to rest", "clear my intention"), kept in the
  meditator's own words and case. "Set my intention" with nothing after it is
  answered "What is your intention?", and whatever is said in the next thirty
  seconds is the intention, word for word. "Never mind" / "cancel" / 取消
  leaves it, answered "Okay, not changing intention.", and "done" / "that's
  it" / 好了 leaves it with "Okay, all set." (`leavesAsk`); neither is taken as
  the answer. The turn waits out a longer pause for that answer on the
  recognizers that can (`awaitAnswer` in `views/setup.ts`);
- special requests (Exploration's field, `parseSpecialRequest`), the same way:
  "special requests", "add a special request" or "I have a special request"
  opens the field and asks "What's your request?"; "special request: keep it
  slow", "add a special request to keep it slow" or "my special request is
  ..." says it outright; "clear my special requests" empties the field. Each
  request goes on a line of its own after what the field already holds, typed
  or said, so a second one keeps the first. Its old label, "additional
  instructions", still opens it. "Cancel" or "done" as the answer leaves the
  ask as they do the intention's ("Okay, not adding a request." / "Okay, all
  set."), and folds the field shut again if the ask opened it and it is still
  empty. A bare label with words after it and no
  colon or comma ("special request keep it slow") is not read: a sentence can
  open on those words. Folded shut over text, the field's row shows a dot and
  as much of the text as fits (`paintRequestsPreview` in `views/setup.ts`);
- check-ins on or off (felt sense);
- "stop listening" / "mute" (puts the mic to sleep until tapped), and "what
  can I say?".

Several can ride one utterance ("felt sense and twenty minutes"). A comma or a
full stop parts a request as "and" does, and so does a "no" between two things
("effortless no check-ins"), which is said of the one after it. A "no" said
ahead carries to more of the same ("remove playful and loving" removes both)
and not to something else ("no check-ins and spacious" adds spacious).
Provider and speech recognition stay button-only.

**A voice or a model, by name** (`parseSetupPick`, `setup-pick.ts`). These
lists are not known ahead, so the names come in with the utterance
(`pickContext` in `views/setup.ts`: the voices this machine and account have,
the model picker's options as shown) and nothing here goes to the judge, which
scores fixed asks and extracts no names.

- "Open the voice picker" opens it. While it is up, a whole utterance that
  says leave closes it (`closesPicker`): "close" (it, this, the picker, the
  voices, the window), "exit", "go out", "leave", "back", "never mind",
  "cancel", and the "done" answers `leavesAsk` reads, with the same softeners
  around them (`LEAVE_LEAD`, `LEAVE_TAIL`); in zh 关闭 / 关掉 / 关上 / 关了 (and
  what is closed: 窗口, 声音选择), 退出, 出去, 离开, 返回, 回去, 不选了, 不用了,
  算了, 取消, 好了, 完成, 可以了, 就这样, with 吧 / 了 after. Not a bare "no",
  "stop" or "skip": over a playing sample those are about the sample, and
  "skip" is the tour's. The zh close is matched before the rest of the zh
  path trims 好 off the front and 了 off the end, which leaves 好了 as nothing.
  With the picker up the close is read before the tour's words
  (`heardOnSetup` in `views/setup.ts`): the picker sits over the tour card,
  and the tour would take "close", "back", 关闭, 返回 and 退出 as its own,
  ending the tour and leaving the picker open.
- "Set the voice to Ethan" makes it the session's voice and plays its sample as
  the answer. "Preview Ethan" / "let me hear Ethan" plays the sample and
  changes nothing. With the picker up a name alone picks, the way a tap on its
  row would (a noting participant's voice included); with it closed a name
  needs "voice" or a word that asks to hear it, since a name alone is a person
  being called across a room.
- "Set the model to Opus" picks the first option listed whose name has every
  word said. It needs the word "model".
- A name is the whole name, else the first listed that contains what was said
  ("amy" for a Piper voice), else, for one word, the one name that sounds like
  it (`namedIn`).

A recognizer writes "two" for "to" and "four" for "for" ("set the focus two
parts", said in a room on 2026-11-14 and in the synthetic corpus). After a
word that sets something or names a setting they are read as the word, except
where the number can be the length itself (`numberAsWord`).

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
intention keeps the script it was said in. A name alone flips it there too
(身体, 请开阔吧), 加上 / 我要 / 去掉 add and remove, and 开阔的氛围 adds, as "a
spacious vibe" does. Special requests are 特别要求 (or 补充指引, the old
label): 特别要求 / 我有一个特别要求 asks, 特别要求：慢一点 / 我的特别要求是慢一点
says it, 清除特别要求 empties it.

The zh house voices go by Chinese names that local Whisper writes right
(`voice-names.ts`): 大海 (catalog name Dahai, Azure's Yunfan) and 小月
(Xiaoyue, Azure's Xiaoqiu). The catalog name is the pinyin, which storage, the
server and every English screen use. A zh line says the characters
(`spokenVoiceName`, used by `setupLineText`, so the clips render with them),
the zh UI shows them (`displayVoiceName`, `voiceLabel` in
`ui/src/voice-picker.ts`), and `zhSaysName` finds a voice by what a zh
recognizer wrote for its name (`heard`) or by its catalog name in Latin
letters. The names as said are in `setupVocabulary('zh').phrases`. Dahai was
"Yunfan" until 2026-11-17: the catalog keeps that in `formerly`, so
`resolveVoice` still speaks a stored "Yunfan" and the client moves the pick to
the new name (`renamedHostedVoice`, from `CloudVoice.formerly`).

The names are measured (2026-11-17), because the ones before were not: 云帆
needed a table of a dozen spellings (元凡, 缘分, 远方 ...) to pick him in 91%
of takes, and Serena came back as Latin respellings or other words, 49%.
Thirty names of two syllables were said the ways people pick at the voice step
(X, 我选X, X吧, 要X, 选X, 用X, 就X吧, 我要X的声音) by four Mandarin voices of
the server's TTS, two of each sex, clean and under room noise, and transcribed
by the desktop's local Whisper as the setup screen runs it (base, zh, no
prompt: `setupVocabulary('zh').prompt` is null, so `zhVoicePhrases` reaches
only the phone recognizers' phrase lists, never Whisper). Whisper writes the
everyday word it expects, so the homely names won and the poetic ones lost:
大海 came back as written in 62 of 64 takes, 大山 and 小北 in 84% and 83%, 清风
in 51% (青风, 青峰), 晨光 and 浩然 never (成光, 好燃); of the female names
小月 91%, 珍珠 88%, 小雨 70% (小语), 明月 62%. The two winners then went through
eight more of the server's voices. 大海 also comes back as 大孩, and 小月 as
小玉, 小悦 or 晓月; `heard` takes those, and nothing else. Through the matchers
the voice step (`parseTourCommand`) and the open picker (`parseSetupPick`)
pick Dahai from 186 of 192 takes by the twelve voices (95 of 96 clean) and
Xiaoyue from 174 (90 of 96 clean), seven of her 18 misses from one voice
(Xiaohan, whose 小 Whisper hears as 想 or 巧). macOS `say` voices are no guide:
Eddy's 大海 never came back right. Neither name turns up in anything else the
setup screen hears (its zh vocabulary, the tour's words, the zh UI strings and
earlier transcripts, about 3,100 strings). A Whisper prompt of the old names
did not help: it wrote the prompt back on 78 takes ("Serena，云帆。" for
Serena吧), naming both. 女声 / 男声 and 第一个 / 第二个 came through in all 36
takes and pick at the voice step too (`pickedVoice` in `tour-command.ts`);
男的吧 comes back 难得吧.

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
back, and the same words show in a pill for six seconds, then fade over half
a second (`#voice-start-note`): the answer for anyone with the sound off, and
where a mishearing shows. The pill sits in the Begin bar to the left of the
mic when its words fit there in two lines, and floats above the bar when they
don't (`placeVoiceNote` in `views/setup.ts` measures the room each time). While
the voice picker is up it shows inside the picker's own layer, bottom center:
the bar is under the picker's dimming. A clear that only made room is not announced; more than
three lines become one "Okay, all set."

Something heard that came to nothing is shown back the same way, as `Heard
"…"`, so a mishearing reads as one and not as a dead mic: one line, whatever
its length, cut with an ellipsis to the room the pill has
(`.voice-start-note.heard`).

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

- `setup-gate`: one ask, "is this phrased as a request to the app?" (~775
  tokens, about $0.00003). A cost filter, not the safeguard.
- `setup-command`: 28 asks (~5,450 tokens, about $0.00023; an ask is about
  190 tokens whatever its length): one per mode, vibe and focus, `remove` and
  `replace` as modifiers, guidance up and down, shorter and longer responses,
  a length (the minutes come from `parseTimerRequest`), no timer, the clock
  hidden or shown, an intention to come (the app then asks for it), the voice
  picker, check-ins, stop listening, help, and `begin` as a veto that empties
  everything. `resolveSetupAnswers` turns the answers into the same
  `SetupAction`s.

Jev answers one ask at a time and returns a probability and nothing else, so
nothing that has to be read out of the words goes through it: a voice's or a
model's name, the intention's text, a special request, a guidance stop by
name. Those are the parser's alone. Special requests have no ask: a request
the parser misses ("how do I add a special request?") can still come back as
help, since the `help` ask is the nearest it has. An ask for them would cost
about 190 tokens on every `setup-command` call, and on aloud cloud the server
would have to go first: the server builds the asks from its own copy of the
specs, and `resolveSetupAnswers` reads a missing answer as a failed call.

**The scores wobble.** The same request asked twice comes back up to about
0.05 apart, so a line within that of a bar goes either way from call to call:
66 of the 299 corpus lines that reach the full set have an ask that close, and
40 of 604 sit that close to the gate's. `jev:setup` caches one reading per
line, so its tallies carry a few lines of noise either way, and a bar set a
hundredth over one reading of a television line is not over it. Adding asks
does not move the others beyond that noise (measured 2026-11-14, with and
without the last four).

`mightBeSetupRequest` keeps the hopeless off the wire: a lone word (sound is
all the judge would have), more than 16 words, and anything containing begin
or start, which never comes through this tier.

What it is good for, measured with `npm run jev:setup` (2026-11-14, synthetic
voices and written lines, no real rooms): natural phrasing the parser misses
("could you make it a bit more spacious", "I'd rather you led less"), 51 of 59
and 24 of 27 held out, with no setting changed by 287 room and television
lines (two of them close the mic, which is the harmless side). It is **not** a mishearing fixer: of 150 lines local Whisper wrote that
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

### A local model in the judge's place (built, switched off)

Where no judge may be asked and the session is set to Ollama, the request can
go to that model instead (`readSetupLocally`, core `setup-local.ts`;
`createLocalSetupReader`, `ui/src/setup-local-reader.ts`; `setup-judge.ts`
hands over only when voice commands have no route at all). One call, answered
as a short list from a closed set of changes that the provider holds the model
to (`CompletionOptions.format`). It waits 2.5s at most with the mic closed,
sends one at a time, and leaves a model alone on a machine where reads are
slow.

It is off: `READS_SETUP` (the models allowed to do this) is empty, because no
model has earned a place in it. `npm run setup:local` scores a model on the
judge tier's own corpus (`scripts/setup-judge-corpus.ts`), paced for heat.
2026-11-14:

- **qwen3.5:4b**: 62 of 73 natural requests exact at 0.9s a call (Jev: 75 of
  86 with the newer lines), and then a setting changed on 120 of 243 room and
  television lines ("The parts arrived yesterday." adds the parts focus) and
  9 of 27 misheard begins. A filter on the form of the request left 31 false
  changes and cost a third of the real ones. Not usable.
- **gemma4:12b**: not measured. Ollama 0.40.6 answers 501 "structured output
  is unavailable" for it, so it needs the list asked for in the prompt and
  parsed instead.
- The answer's shape decides everything on a small model: asked to fill in a
  form with every setting as a field, qwen filled in all of them (0 of 23).

Next steps are in bead meditation-pal-jhqk.

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
  Xiaoyue and Dahai (小月, 大海) for Chinese.
- Where neither can speak (no clip, a browser tab that won't play without a
  gesture), the caption is the answer.

A voice's sample, the answer to "set the voice to Ethan", plays through the
same speaker (`SetupSpeaker.sample`, which runs voice-picker's
`previewVoice`), so whatever stops a line stops it. Begin stops the speaker,
and its `stop` also empties `speechSynthesis`'s queue: a sample still on its
way at Begin played over the session's opening sound (Chrome, a macOS voice,
2026-11-18). A preview stopped while its engine is still being found never
starts (`previewGeneration` in `voice-picker.ts`).

Clips are static files under `ui/public/voice-clips/`, listed in
`ui/src/voice-clips.json` with the text each was rendered from. A line edited
in `setup-lines.ts` without a re-render is simply not played (`clipFor`
compares the text), and the hash in the file name makes a re-rendered line a
new URL. `npm run clips:render` (`server/scripts/render-voice-clips.ts`)
renders what changed, prices the run first, and checks each clip for the two
faults these voices have (a short line said twice, a first word cut),
re-rendering up to four times. Every clip ends 0.15s after its last sound
(`server/scripts/voice-clips/tail.ts`, `TAIL`): the providers pad a take with
up to 0.9s of silence, and the mic stays shut until the file ends (below).
`-- --check` lists what is missing or stale and any clip ending in more than
0.25s of silence; `-- --trim` cuts those on disk on whole MP3 frames, with no
synthesis.
Clips play at the speed setting by playback rate with pitch kept, except on a
styled voice, which ignores the speed setting in a session too.

### The mic

The button beside Begin (`#voice-start-mic`) stands for **voice mode** on this
screen: the app listening and the app talking back, the tour included. Its
glyph is a mic with sound going out of it (candidate A of three; the session
keeps its plain mic). It hangs off Begin's left edge out of flow, so the bar
keeps its height. Voice mode is in one of three states (`paintVoiceMic` in
`views/setup.ts`):

| State | Looks | Listens | The tour and spoken answers |
|---|---|---|---|
| On | lit, with the level ring | yes | spoken |
| Asleep | unlit, not slashed | no | the tour still spoken |
| Off | slashed | never | silent: captions only |

- **On and off are the one switch**, `AppSettings.setupVoice`, the same one
  Settings has: a tap on a lit mic turns it off, a tap on a slashed one turns
  it on, and either is how the next visit starts.
- **Asleep is never chosen, only fallen into**: the listening window lapsing,
  the unheard limit, a recognizer error, "stop listening" said aloud. It lasts
  for the visit and leaves the setting alone (a television should not be able
  to switch the feature off for good). A tap wakes it, and so does a tour
  starting (`TourVoice.reopen`); nothing else does. Fallen asleep by a
  recognizer error under the tour, every card says so ("The microphone didn't
  respond. You can still continue by tapping.", `tourMicFailed` in
  `tour/index-guide.ts`) until the mic hears again: the tour goes on reading
  itself out, and on a phone the mic beside Begin is hidden under a section's
  card. A passing fault is retried below this, in the engine: the phone's
  recognizer starts again by itself after "Recognition service disconnected"
  (error 11), on the retry budget it gives a busy one
  (`ERR_SERVER_DISCONNECTED` in `adapters/capacitor-stt.ts`).
- **What blocks it keeps its own look.** The permission not yet given and a
  browser tab not yet touched show slashed, titled "Tap to listen" (`ask`),
  with the setting on: a tap clears either and it listens. The permission
  denied shows slashed and inert (`blocked`). Begin unable to run, or hosted
  recognition with nobody signed in, hide it. None of these reads as asleep.

While it listens it wears the ring a session's mic does, swelling with the
voice (`meterVoiceMic`): from the Whisper engine's own level on desktop, from
a small meter stream beside the browser's recognizer, and not on phones. The
ring is held still while the app speaks. Switched on while the app is
speaking, it lights at once and starts hearing when the line is over
(`runVoiceSync` paints it before it waits; `micShows` is what a second tap
reads).

**Waiting to hear is a look of On, not a fourth state.** While the
recognizer can't hear, the mic is grey with a slow breath in place of the
ring (`.waiting`; a dashed rim under reduced motion), the look the session's
mic has while it opens after an unmute, since words said then are lost
(`listenOnSetup` `onHearing`, `micHearing` in `views/setup.ts`). That is the
mic opening, which on macOS sends digital silence for a second or more, and
the recognizer stopped for a line and its tail, an answer, or between turns.
A Whisper engine hears at its first frame with sound in it (`whenHearing`);
the browser's and the phones' recognizers count as hearing once the turn
starts, all they can say. A turn waits at most `HEARING_WAIT_MAX_MS`. Opening
also says so in the button's label (`Opening the mic…`) and, on the visits
that show the first-visits hint, in its pill after `MIC_OPENING_NOTE_AFTER_MS`;
the hint itself waits until the mic hears. The pause around a line keeps the
listening label.

It works under the tour's cards too (`data-tour-live`, kept live by
`holdPage` in `tour/index-guide.ts`): a tap switches it and leaves the tour
where it is. Held with the rest of the page, the tap fell through to the
overlay and closed the tour.

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
- **It falls asleep by itself, by what listening costs**
  (`setupListeningLimits`). It also closes the moment the setup screen goes
  away.
  - On a phone, whatever the recognizer: two minutes with nothing asked
    (`VOICE_START_WINDOW_MS`), then asleep until tapped. Each request it
    understands starts the two minutes over, up to ten minutes since it opened
    (`VOICE_START_MAX_OPEN_MS`). A room that keeps talking closes it sooner:
    `VOICE_START_SENT_UNHEARD` things heard in a row that were not requests.
  - At a desktop there is no clock on any recognizer. (A browser is taken to
    be a desktop one; phones use the app.) Speech is found on the device and
    only speech is sent, so a quiet room costs nothing and the mic stays open
    as long as the screen is up. What costs is a room that keeps talking, and
    that is counted:
    - Local Whisper and the browser's recognizer (Whisper transcribing a
      television, and each line the parser can't place going to the judge
      where there is one, against the daily allowance a session's voice
      commands share): `VOICE_START_LOCAL_UNHEARD` things heard in a row that
      were not requests, about five minutes of unbroken talk.
    - Hosted recognition, where each of those is a clip paid for:
      `VOICE_START_SENT_UNHEARD`, and once two minutes have gone by with
      nothing asked each one counts for five
      (`VOICE_START_LATE_UNHEARD_COST`), so a television is closed on within
      a few lines of the two-minute mark and four lines after it. It was on
      the phone's clock until 2026-11-18: a quiet two minutes on the setup
      screen put the mic to sleep.

    A request understood starts the count, and the two minutes, over.
- **It does not hear the app.** A request is answered with the recognizer
  stopped (`onHeard` runs between turns), and a line nobody asked for, like a
  step of the tour, stops it first (`hold`; hosted recognition, except on
  an iPhone, hears through a tour line instead, for the tour's own words
  only: The tour, spoken, below).
  Listening resumes
  `SPEECH_TAIL_MS` after the line ends, and a clip's file ends 0.15s after its
  last sound, so the mic hears again about 0.4s after the voice stops. Until
  2026-11-18 the files carried up to 0.9s of the provider's silence on top,
  and a request said at a natural pace after an answer lost its first word
  ("Change focus to body" arrived as "Focus to body", which adds instead of
  replacing). As a backstop, something heard within a few
  seconds of a line that is nothing but that line's last few words is dropped
  (`looksLikeSpokenTail`, asked through `isEcho` before anything else, "begin"
  included). No spoken line ends on a request, "begin" least of all
  (`setup-lines.ts`): a tail is what a slow speaker leaves in the room.
- **Stopped is not let go.** An engine with its own capture stream (local
  Whisper, hosted recognition) keeps it while the recognizer is stopped,
  until listening is over (`stopBetweenTurns` in `listenOnSetup`,
  `keepMicUntil`), and takes the same stream back at the next turn. On macOS,
  letting an echo-cancelled mic go rebuilds the audio output a second or two
  later, as at a session's close ([voice-barge-in.md](voice-barge-in.md)):
  released as a line began, it cut half a second out of Harper's
  introduction, the picked line and the attention-focus card, a second or two
  in (desktop app, 2026-11-16; the fix has not been heard yet,
  manual-smoke.md). Chrome played the same lines whole: its echo canceller is
  its own, not the OS's. A listener replaced because the mode has another
  recognizer (noting keeps its own pick; not under the tour, which keeps one
  recognizer throughout) is stopped the same way and holds its
  stream through the card's line until the new listener can hear
  (`createMicHandover`, its first `onHearing` of `hearing`; a first frame is
  too soon, being the silence a fresh capture sends while the OS sets it up),
  so the last echo-cancelled capture never closes under a line. One tab
  switch sets off several syncs, and the newest takes the handover over; one
  that builds nothing with no newer sync behind it lets the mic go, as does
  the mic being closed. Begin (the button or "begin") keeps it until the
  session's own capture hears, then lets it go (`holdCaptureForSession` in
  `mic-check.ts`; [audio-output.md](audio-output.md#the-mic-around-a-sessions-sounds)).
  "Stop listening" keeps the stream through
  its own answer ("Okay, the mic is off.") and lets it go when the line is
  over (`act` and `closeVoiceStart` in `views/setup.ts`).
- **It waits out a session's close.** The screen comes up as a session ends,
  under its closing sound, and the listener opens only once the close is
  over; the session's capture is held past it until the listener hears
  (`waitForClose` in `signature-sound.ts`, put in `createMicHandover`). So a
  "begin" said during the close is not heard. On Android a capture opened
  under the close dropped its level
  ([audio-output.md](audio-output.md#the-mic-around-a-sessions-sounds)).
- **Except on an iPhone, hosted recognition is not stopped at all between
  turns** (`continuous` in `listenOnSetup`, wired in `views/setup.ts` for
  `WhisperPcmSttEngine` on a hosted pick where `setupCaptureRunsOn` in
  `voice-start.ts` allows it). A stop closes the engine's audio graph
  as well as pausing it, and on Android that graph is a 48 kHz call-stream
  player of its own: both lines Alex heard lose their first words (Harper's
  felt sense card, "partway into the f", and Ethan's methods line, about
  1.4s) began within a second of the graph being closed, and its next turn
  started a new one, while the felt sense line played whole on the way back,
  with no hosted capture left to close (2026-11-19; read from the code's
  timing against the log, not measured). So a turn ends and the capture
  idles, unheard, as a session's does between replies; an answer plays while
  it idles, and the next turn opens on only the last `SPEECH_TAIL_MS` it held
  (`keepOnsetTail`), not on the answer. The engine is told the answer plays,
  as for a tour line (`say` in `voice-start.ts`, from `sayLines`): its echo is
  logged as a `[vad] tts window` and spends the capture's echo warm-up, and
  its bar is down again as the next turn opens, as after a line heard
  through. The graph starts once per listener
  (Chromium stops its silent player after about 30s) and closes when the
  listener ends: at Begin, before the opening, its stream held as above. A
  listener that a room talks shut, or that fails, while a line is heard
  through ends once the line is over, not under it (`linesOver`). A
  tour line in a house voice is heard through (below); a voice's sample, or a
  line in a local voice the OS may speak past the canceller, still stops the
  recognizer. The clips already open on 0.24 to 0.62s of the provider's
  silence (median 0.36s), so leading silence long enough to cover 1.4s would
  have added a second to every line on every platform. On desktop and an
  iPhone hosted recognition stops between turns and for every line, as the
  other recognizers do: the problem is Android's, an iPhone's canceller let
  the facilitator through (meditation-pal-hi6f), and on desktop this would
  rest on an echo path nobody has listened to. One tour heard on MacBook
  speakers with diag on, reading each line's `[vad] tts window` overGate,
  would lift it there.
- **A line waits for a mic opened cold.** Opening an echo-cancelled capture
  with no other capture of ours open starts voice processing on macOS, which
  rebuilds the audio output, and switches a Bluetooth headset from music to
  call audio. A line started then begins a fraction in and quiet, rising to
  full over a couple of seconds: Harper's introduction 137 ms after a cold
  open, on a Bluetooth headset (desktop app, 2026-11-18); with the mic
  already open the same line was fine. So a line the screen speaks unasked
  (`hold`, through `sayHeld` in `views/setup.ts`: the tour's lines) waits
  for that capture's first frame with sound in it (`coldOpening` in
  `whisper-pcm-stt.ts`), with the turn still listening, since its frames
  are how the engine sees that sound. The wait
  is once per open and ends at most `COLD_OPEN_SETTLE_MAX_MS` (3.5s) after
  the mic was asked for: the built-in mic sent silence for about 2s after
  one, and a Bluetooth call link takes 1 to 3s to come up. Nothing else
  waits: a mic already hearing, one opened beside another capture of ours
  (`captureLive` in `mic-check.ts`: a replaced listener's held mic, or a
  session's held through its close), which changes nothing in the output,
  and the browser's and the phones' recognizers, which have no capture of
  ours. A turn stopped for a line before it has asked for the mic opens
  none (`start` in `whisper-pcm-stt.ts`), so the line plays at once and the
  mic opens after it; until 2026-11-18 it opened anyway, under the line.
  Where the capture runs on (`continuous`) the turn is not stopped and opens
  the mic under the line, so `coldOpening` can still be null as the line is
  asked for: Harper's introduction, started 46 ms after the mic was asked
  for, ran 4.59s for its 3.65s (desktop app, 2026-11-20). A line heard
  through waits instead until the listener has first heard (`firstHeard` in
  `listenOnSetup`, the first turn's `whenHearing`), at most
  `HEARING_WAIT_MAX_MS`.
  Answers to a request need none of this: the capture has heard the request.
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
  itself, below; only GPT takes it, so Parakeet (the English default) and
  Grok hear this screen unprompted, and `tour-command.ts` matches their near
  misses of the tour's words. Chrome's browser recognizer gets nothing: its
  phrase biasing is on-device only and makes a cloud recognizer fail at
  start. "Begin" is in none of it, since a prompted word is the one a
  recognizer writes over noise. A session sends none of it.
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

### Measured on synthetic speech

`scripts/setup-voice/run.ts` says every phrase in `phrases.ts` (149 English
and 50 Chinese requests, 52 things a room says, 8 paragraphs of prose) with
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

### The tour, spoken

The setup tour (`ui/src/tour/index-guide.ts`) is also the voiced onboarding.
The setup view hands it a `TourVoice`; with one, each step is read out as it
goes up, a step offers the two house voices (each introduces itself; the pick
becomes the voice everywhere, the session's included), a step offers to turn
the microphone on where a tap could, and with it on the tour answers to
"next", "back", "repeat", "skip", "mute" and a voice's name or place
(`parseTourCommand`, `tour-command.ts`, the same whole-utterance rule). Every
one of those is also a button. Once a tour, the Exploration card's line is
framed (`speakSection`): `tour-methods` ahead of it says the three cards are
ways to meditate, not something to do now, and behind it, only with the mic
on, `tour-voice-control` says what the tour answers to. The last card is the close and, where the mic
is on offer, the tip that all of this can be said ("twenty minutes", "add
playful", "begin"); a request said there is taken as anywhere on the screen,
and "next" is its "Got it" (知道了 in zh, matched after the same trimming of
了 the utterance gets). Its line (`tour-done`) ends on "give it a try",
not on the "begin" it asks for: a reopening mic can catch a line's tail, and
only a tail is dropped as the app's own (`looksLikeSpokenTail`). The speaker
on each card stops the reading and is remembered. The voice step is skipped
for someone whose session voice is a local one: the pick is between hosted
voices and would move them off it.

- **A tap acts at once.** Next, Back, a voice, "Turn on the microphone", Got
  it and closing all cut the line playing. "Turn on the microphone" has to: the
  mic only opens once the app has stopped speaking (`turnMicOn`). A stop that
  lands before a held line has begun still stops it (`tourLines` in
  `views/setup.ts`): the line waits for the recognizer to stop first, and
  for a mic opened cold to settle, which can be a few seconds (The mic,
  above). A tap on the setup mic meanwhile switches voice mode off for the
  held line too.
- **A word over a line, on hosted recognition except on an iPhone.** Its
  echo-cancelled capture goes on hearing while a tour line plays (`hold` with
  `overLine` in `voice-start.ts`, `continuous` in `views/setup.ts`), its speech
  bar raised above the line's echo as in a session (`setTtsActive`,
  [voice-barge-in.md](voice-barge-in.md)). A turn said over a line, or begun
  over one and ended after it (`startedDuringTts`), goes to the tour alone
  (`heardOverTourLine`): its commands act and cut the line as a tap would.
  Such a turn ends on a 0.45s pause (`overLineSilenceMs`), not the 0.7s and
  up of `LOBBY_STT`'s: "Next." said over the noting line cut it 2s later,
  0.77s of that the pause (2026-11-20). A word said after it, while the turn
  is being transcribed, still joins it, as "back" after "go".
  Anything else is dropped, so nothing said over a line begins a session or
  changes the setup (the lines name "begin" and settings), and so is anything
  that could be the line itself come back past the canceller
  (`looksLikePartOfLine`), or the line before it if that ended in the last 4s
  (`linesInTheRoom` in `setup-speech.ts`: a "Harper." begun in her
  introduction can land during Ethan's): "next" said over the line that
  teaches it, near the word, is let go. Of a clip still playing only the
  stretch near where it has got to counts (`partOfLineNear`, read from the
  element's clock by `playingAt`): clips have no word timings, so each word
  is taken to fill an equal share of the clip, and the stretch runs 4s
  behind and 1.5s ahead, since the transcript is read 1.4 to 2s after the
  words end. Checked against the whole line, "Back." said 12.5s into the
  focus card's line, which opens "Back to Exploration", was let go
  (2026-11-20). A line said in a local voice, and the line before, are
  checked whole. The check is skipped for a turn the engine measured as too
  loud to be echo (`lastTurnClearOfEcho` in `whisper-pcm-stt.ts`: five times
  the loudest any line has been at the mic with nobody speaking over it): on
  a phone whose canceller left 0.0001, "Ethan" said at 0.065 over Ethan's
  own introduction was being let go as his (2026-11-20). Where the canceller
  leaks (0.02 over a MacBook's first line) the words are still checked. The bar is lower than a session's, and so is the
  minimum (`overLineBar` 0.02 RMS and `overLineMinSpeechMs` 0 in `LOBBY_STT`,
  read by `speechBar` and `start` in `whisper-pcm-stt.ts` for a turn begun
  while a line plays), since a miss here costs one short transcription and
  the line plays on, where a session's false barge-in cuts the facilitator
  off. A frame under the bar still counts for 0.4s after one over
  it when Silero calls it speech (`overLineLatchMs`): Silero's verdict
  trails a word's loudest part, and a "next" that peaked at 0.055 on a phone
  opened no turn without it (2026-11-20). At a session's bar (`BARGE_IN_THRESHOLD`, 0.03) and 200ms minimum,
  seven of ten commands said over lines on MacBook speakers (2026-11-20)
  were dropped as coughs: only frames over the bar count as speech while a
  line plays, so a one-syllable word measured 0 to 171ms. The phone's
  commands (2026-11-19) peaked at 0.022 to 0.050, many under 0.03. Lines
  nobody spoke over peaked at 0.006 at the MacBook's mic and 0.0017 at the
  phone's (`[vad] tts window`); 0.02 leaves twice the 0.01 a louder volume
  setting might bring on the MacBook. The bar still rises with the echo
  gate, and is 0.1 through the first line after a capture opens
  (`ECHO_WARMUP_GATE`). The meditator's own speech over a line raises the
  echo floor (to 0.0146 in that tour), and with it the bar, to about 0.03
  for a second or so after: every command said on the MacBook still cleared
  it, a quiet second try on a phone may not. Not on an iPhone (`setupCaptureRunsOn`,
  above), and not for a tour read in a local voice, which the OS may speak
  past the canceller.
- **Elsewhere a word waits for the line.** The phone's recognizer and Chrome's
  hear the speaker, and local Whisper and hosted recognition on an iPhone were
  left as they were: the recognizer is
  stopped while a line plays, so a word said over it is not heard at all. It
  listens again `SPEECH_TAIL_MS` after the line, and a word said then is acted
  on when the recognizer ends the turn (`LOBBY_STT`'s 0.7 to 1.5s pause) and
  has written it down.
- **It speaks by voice mode, not by the listener.** On or asleep, every card
  is read (`TourVoice.mic()` is `on` for both). Off, the tour is silent
  (`TourVoice.speaks`): no lines, no speaker on the cards, and the voice step
  is passed by, since its voices would introduce themselves to nobody. The
  mic step ("Turn on the microphone") is the way in, and turns voice mode on
  for the rest of the tour. The last card's line, which says what to say, is
  read only where the mic is on (with the permission still to be asked, the
  other cards are read and that one is not).
- **What a phone shows instead.** In the phone apps a section's `?` panel
  opens only on a card not read aloud (voice mode off, or the card's speaker
  switched off: `speaking()` in `tour/index-guide.ts`, read as each card goes
  up, so a card muted or unmuted keeps the layout it was shown with). Read
  aloud, the panel said what the line says and pushed the section's controls
  off the screen; the methods cards' panel has nothing after it to push, so
  it opens read aloud too. A panel that runs the section on under the docked card
  gets a chevron above the card until the page has been scrolled a few lines
  ([style.md](style.md#tour-popup-styling), `addMoreBelow` in
  `tour/index-guide.ts`). Desktop and the web open every panel, as before.
- **A tour starting wakes a mic that is asleep** (`TourVoice.reopen`), where
  nothing else keeps it shut (permission, a page not yet touched, hosted
  recognition signed out), and then offers no card to turn it on. With voice
  mode off it stays off, and the tour offers it.
- **One recognizer the whole way.** The tour walks every mode's tab, and
  noting keeps its own speech recognition pick (the phone's recognizer, on a
  phone). While the tour is up the screen listens with the recognizer it
  started with (`tourChoice` in `views/setup.ts`, set by `TourVoice.listen`),
  and a swap the tab asks for waits until the tour is over. Swapped at the
  noting card, the hosted capture let go as the card's line began, which on
  Android ends call mode under the line (it came in late), and the phone's
  recognizer, stopped for that line before it had reported ready, failed at its next
  start with "Recognition service disconnected", which put the mic to sleep
  for the rest of the tour (Android, 2026-11-19).

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
- **Repeat the last line.** `repeatLastLine` (`views/session.ts`) replays the
  facilitator's latest line, off the record, so the ask takes only a plain
  "say that again". A request for an earlier line or one part of a line ("the
  line before that", "how did that end?") goes to the model, which has the log.
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
  acts before a matching final. It asks once the words have sat unchanged for
  350ms, and a final often lands within half a second of the last preview, so
  the verdict can still be out; the turn then waits for it with its preview
  bubble on screen ([voice-barge-in.md](voice-barge-in.md#transcript-echo-guard-last-line-of-defense)).
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

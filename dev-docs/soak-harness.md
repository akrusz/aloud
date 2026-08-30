# Soak harness

An LLM plays the meditator against the real engine, whole sits run unattended,
and every run leaves a scorecard. Kick it off, take a walk, read `report.md`.

**Two tiers.** Tier 1 (`npm run soak`) is text-level on a fake clock: fast,
parallel, cheap enough to run often. Tier 2 (`npm run soak:web`) speaks out loud
into a virtual mic so the real UI answers through its actual audio path - STT,
TTS, VAD, echo guard, barge-in, mute.

Not in CI - real API calls, real money. Run it before a release, or after
touching anything in `ts/src/facilitation/`.

## Run it

```bash
npm run soak -- --battery=pre-release            # the release check
npm run soak -- --battery=smoke --baseline=last  # quick, vs the last run
npm run soak -- --battery=models                 # facilitator comparison
npm run soak -- --list-batteries                 # what the presets do
npm run soak -- --list                           # what's in the matrix
npm run soak -- --scenarios=silence,timer-hold   # a slice
npm run soak -- --facilitator=ollama:qwen3 --no-judge

npm run web:dev                                  # tier 2 needs this first,
npm run soak:web                                 #   in another terminal
npm run soak:web -- --scenarios=silence,mute
npm run soak:web -- --voice=openai:sage          # realer prosody, costs money
```

Keys come from the environment or `ts/server/.env` (`soak/env.ts`). Output lands
in `ts/soak-runs/<timestamp>/` (gitignored): `report.md` (read this one),
`run.json`, and one JSON per session with the full transcript + event log. Exit
code 1 when any deterministic check fails, so a release script can gate on it.

## Before you run: two things that bite

**`soak:web` owns the machine's audio in and out.** BlackHole becomes both the
default output and the default input for the run's duration. Don't play anything
else, don't take a call. Devices are restored on exit, Ctrl-C included. Pass
`--no-audio-routing` to leave them alone (for debugging the driver, not the audio
path).

**The driver only exists during a run.** A loaded BlackHole plug-in is a
permanent candidate default input, and CoreAudio reaches for it whenever the real
mic goes away (sleep, unplugged headphones) - which is how it ends up being the
microphone your next video call picks up. So a run loads the driver on the way in
and parks it on the way out, and only puts back what it moved: start a run with
BlackHole already loaded and it stays loaded. See `scripts/blackhole-driver.sh`
below.

**Judge scores are noisier than they look.** Two `smoke` runs of *identical code*
moved a scenario a full point. That is what `JUDGE_DELTA_MIN` (1.5, in
`soak/baseline.ts`) is calibrated against, not a guess. Use `--sessions=2`+ before
believing any score movement. **Check failures are the trustworthy signal.**

## Reading a run

`report.md` is ordered worst-news-first for a two-minute read: verdict line →
what changed since the baseline → scoreboard → failures grouped by check → the
judge's verbatim wince quotes. Transcripts and per-session bookkeeping come last
and collapsed.

| Signal | How much to trust it |
|---|---|
| **Check fails** | Mechanical and trustworthy. Either an engine bug or a harness bug; both worth fixing. Grouped **by check id, not session** - one broken thing in four sessions is one problem. |
| **Judge scores** | Directional only. Compare against the same judge model's earlier scores, never across judge models. |
| **Wince quotes** | The useful half of the judge. Each is a candidate regression case for the classifier probe harness (`meditation-pal-sfdk`) or a prompt edit. |
| **`role-leak-raw`** | How often the model *tried* to write the meditator's turn (the engine strips them before speech). A rising count after a prompt change is the early warning. |

Tier 2 adds an **Audio round trip** table per session: what the sim said, what the
recognizer heard, WER per utterance. Read it first when a session looks like a bad
facilitator - a facilitator answering a garbled sentence sensibly is still a
session a user would call broken, and the transcript alone can't tell you which
happened. `stt-accuracy` reports the **median** WER: one mangled utterance is
speech, a shifted median is a broken capture path. Numbers only compare within one
`(voice, recognizer)` pair.

### Baselines

`--baseline=<dir>` (or `--baseline=last`) leads the report with what *changed*:
newly-failing checks, newly-passing checks, judge scores that moved. Sessions match
by scenario + facilitator model and average over that cell's repeats, so
`--sessions=2` compares like with like.

The comparison is deliberately asymmetric: a newly failing check is stated flatly;
a judge move under `JUDGE_DELTA_MIN` is hidden as noise, and even a shown move is
labelled a place to look, not a verdict.

`--baseline=last` only picks a run from the **same tier**. An explicit cross-tier
`--baseline` is stamped with a warning - the two matrices share scenario ids
(`baseline`, `silence`) while measuring different things, so a cross-tier diff
looks plausible and means nothing.

## Batteries

A battery (`soak/batteries.ts`) is a whole pre-release check as one word: which
scenarios, how many sessions, who plays which role. The decision gets made once and
reviewed once instead of re-improvised at the prompt. Individual flags override
anything a battery sets.

| Battery | What it is |
|---|---|
| `smoke` | Two scenarios, one session. "Did I break the engine?" in a couple of minutes. |
| `pre-release` | Full matrix, two sessions per scenario. The one to run before cutting a release. |
| `models` | Facilitator comparison across three families, judged by a fourth that isn't in the contest. |

Tier 2 is deliberately not in a battery: it runs in real time and owns the
machine's audio, so it stays an explicit `npm run soak:web`.

## Casting: who plays which role

A run casts four roles - **facilitator** (under test), **meditator** (the sim
user), **classifiers** (the cheap utility model), **judge**. Two pairings
invalidate the result:

- **Judge = facilitator.** LLM judges prefer their own generations. In a
  `--facilitator=a,b,c` comparison the bias lands on ONE contestant, which is worse
  than applying to all of them: the ranking becomes partly an artifact of who the
  judge is. This used to be the shipped default, which is why the default judge is
  now a different family.
- **Meditator = facilitator.** Both halves of the conversation stop being
  independent.

**Classifiers sharing the facilitator's model is not a collision** - that's what
the shipped app does (`buildUtilityProvider` runs Haiku next to whatever is
facilitating), so matching it is realism.

Defaults and every battery are held to "no collisions" by `tests/soak-roles.test.ts`
- a preset is what gets run without thinking, so a preset must never be the thing
that contaminates a scoreboard. An explicit override may still collide: the run
proceeds, warns on the way in, and the report stamps the caveat above the scores.
Every report names all four models, because a scoreboard without its judge named
can't be read.

Defaults: facilitator + judge on different families (Anthropic / OpenAI), sim user
+ classifiers on Haiku.

## How it works

### Tier 1 (`ts/soak/`)

| File | Role |
|---|---|
| `orchestrator.ts` | Headless session engine: the real core (PromptBuilder, SessionManager, PacingController, `parseTurnSignals`, `routeUtterance` + silence classifiers, smart check-ins, `StagedModeController`, timer events) wired the way `ui/src/views/session.ts` wires them, minus DOM/audio/streaming, on `createFakeClock`. A 30-minute sit takes as long as its LLM calls. |
| `sim-user.ts` | The meditator: persona-prompted LLM answering `WAIT: <seconds>` + an optional spoken line (or `END`). Stateless per call with a stable transcript prefix, so prompt caching applies. |
| `scenarios.ts` | The matrix. Each scenario aims a persona at one slice of the engine: `baseline`, `silence`, `quiet`, `felt-sense`, `timer-hold` (a timer completing *inside* a hold), `overwhelmed` (trailing off must not trigger `[HOLD]`). |
| `checks.ts` | Deterministic post-run checks. `fail` = engine bug or broken invariant; `warn` = worth a look; `info` = context. |
| `judge.ts` | LLM judge for what only a reader can see: responsiveness, tone, brevity, silence respect, meta leaks, timer landing, plus verbatim wince moments. Strict JSON out, parsed leniently. |
| `batteries.ts`, `roles.ts`, `baseline.ts` | Presets, collision rules, run-to-run diffing. |
| `report.ts`, `run.ts` | Report writer and CLI (concurrency pool, provider specs, exit code). |

The orchestrator deliberately **mirrors** `views/session.ts` rather than sharing
code with it - the view's orchestration is entangled with DOM and audio. The tax:
when the view's wiring changes, `soak/orchestrator.ts` has to follow.
`tests/soak.test.ts` runs the whole engine offline against scripted providers and
pins the flows that drift would break; `soak/tsconfig.json` is part of
`npm run typecheck`, so drift in shared types breaks the build.

### Tier 2 (`ts/soak/browser/`)

Same personas, same judge, but the meditator speaks out loud into a virtual device
the real web UI has selected as its microphone.

| File | Role |
|---|---|
| `driver.ts` | Playwright over real Chrome. Seeds `preview:setup` / `app:settings` / `apikey:*` into localStorage before boot, resolves the loopback device's per-origin `deviceId` in-page, clicks Begin (a real gesture, for the mic permission), then reads the tap. |
| `orchestrator.ts` | The session loop: wait for a turn boundary, play one sim utterance, watch for the recognizer's final. All engine state comes back from the page. |
| `voice.ts` | The meditator's mouth. `say` by default (free, offline, transcribes well); `openai:<voice>` runs the same gpt-4o-mini-tts the hosted voices use. |
| `audio.ts` | Points both default devices at BlackHole and restores them afterwards. |
| `scenarios.ts` | The tier-2 matrix (`baseline`, `silence`, `barge-in`, `mute`, `timer`, `felt-sense`) plus the scenario → localStorage mapping. |
| `checks.ts`, `wer.ts` | Audio-path checks (miss rate, WER, echo-guard false positives, barge-in, mute command) and word-error scoring normalized for case, punctuation, contractions. |
| `run.ts` | CLI. Sessions run one at a time, in real time - there's one pair of default devices. |

**Setup (one time):**

```bash
brew install --cask blackhole-2ch    # then RESTART the Mac: CoreAudio doesn't
brew install switchaudio-osx         # list the driver until you do
```

**Parking the driver.** `scripts/blackhole-driver.sh {status|park|unpark}` moves
the HAL plug-in in and out of `/Library/Audio/Plug-Ins/HAL` and restarts
`coreaudiod`; the install stays put either way. `soak:web` calls it, and
`npm run soak:audio -- park` is the by-hand version for when a run dies hard
enough to skip its own cleanup.

The moves need root, so expect a password prompt at the start of a run and
another at the end. The end one comes **after** the reports are written, so a run
you walked away from still leaves its results on disk; if it goes unanswered, or
the run crashed, or you Ctrl-C'd it, the driver just stays loaded and the harness
tells you how to park it.

Don't hand this script a `NOPASSWD` sudoers rule. It lives in a repo you can
write to, and sudo matches on path rather than contents, so the rule would turn
"can write one file in this checkout" - a dependency's postinstall, a stray agent,
a tampered branch - into silent root. If a run is long enough that two prompts
genuinely grate, `sudo install -o root -g wheel -m 755 scripts/blackhole-driver.sh
/usr/local/libexec/aloud-blackhole-driver` and point the rule at *that* copy
instead; the harness tries `sudo -n` first, so it picks that up with no further
changes.

Google Chrome must be installed. The harness drives **real Chrome**, not
Playwright's bundled Chromium, because the Web Speech API only works in a build
carrying Google's speech keys - `channel: 'chrome'` is load-bearing. Headed for the
same reason; `--headless` exists but headless Chrome's media stack is a different
animal, and a run that transcribes nothing looks exactly like a facilitator that
never answers.

**Why it's a loopback.** Chrome's `--use-file-for-fake-audio-capture` replays one
fixed WAV, so a virtual device is the only workable route. That means the app also
hears **its own TTS**, since that plays out of the same default output. Deliberate:
it's the real acoustic situation a speaker-and-mic user is in, and it puts the echo
guard and barge-in under test rather than around them. When the echo guard drops a
*meditator* utterance, that's `echo-guard-false-positive`, a `fail` - the topology
exists to make that visible.

**Instrumentation** is `ui/src/soak-tap.ts`: a structured event tap gated on
`import.meta.env.DEV` **and** `?soak=1`, emitting exactly tier 1's `TurnRecord` /
`SoakEvent` / `LlmCallStat` shapes - which is why `runChecks`, `judgeSession`, and
the report writer take a browser session unchanged. Scraping the DOM instead would
show clean text and nothing about holds, classifier verdicts, timer events, or raw
pre-parse output, and most of `checks.ts` would go dark. Vite tree-shakes the tap
out of a release bundle entirely; it also means tier 2 exercises the **dev** build.

**What tier 2 deliberately doesn't test:** there's no fake clock, so sits are short
(5-9 real minutes) and each persona's `WAIT` is clamped (`maxWaitSec`). Relative
pacing survives; absolute scale doesn't. **Long-silence pacing - the 8-20 minute
smart waits - stays tier 1's job**, where the fake clock makes it honest.

`tests/soak-web.test.ts` covers the loop, WER scoring, the scenario → settings
mapping, and the audio checks offline against a fake driver and a silent voice.

**Measured baselines** (first real run, 2026-08-20, six sessions, `say` into
BlackHole, Chrome Web Speech) - the numbers to compare later runs against:

- **WER: 0% median** in five of six sessions (8% in the sixth). Web Speech on `say`
  output is close to perfect, so a WER regression is a signal about the capture
  path, not about speech being hard.
- **Recognizer latency: 4.5-5.6s median** from end of playback to the final. That's
  Web Speech's endpointing, and it sets the floor on how fast a turn can start -
  worth remembering before optimizing anything upstream.
- Barge-in fired, the spoken mute command muted, and the echo guard never mistook
  the meditator for the facilitator even with the app's own TTS on the loopback.

## Relation to `ts/evals/`

`evals/protocol-eval.ts` asks "can model X emit the control tokens reliably?" in
isolated probes - cheap, per-model, disqualifying. Soak asks "does a whole session
hold together?" Run evals when choosing a model; run soak when changing the engine
or prompts. `--facilitator=<a,b,c>` bridges them: the same scenarios under each
model, scored by one judge that never sees the model's name. Use `--sessions=3`+
for a decision. The judge rubric here and `evals/rubric.md` should converge.

## What it has caught

- **`meditation-pal-9era`** (fixed, f2699f6) - a reply of nothing but control
  tokens (`[WAIT:8m]`, a bare `[HOLD]`) scrubbed to empty, so the app recorded a
  blank turn and spoke silence at the meditator with no error. The bare `[HOLD]`
  was worse: it armed the confirm handshake for a question never asked. Found live
  in a tier-1 run, 2026-08-21; the `empty-spoken-turn` check now guards it.

## Tier 3: hostile lifecycle, not "tier 2 on a phone"

`meditation-pal-eldj.3`, open. The naive version - point BlackHole at a simulator
and re-run the tier-2 matrix - would mostly re-confirm things tier 2 already
proves. The valuable version tests what only a phone can break: **backgrounding
mid-utterance, an incoming call, screen lock during a `[HOLD]`, network death
mid-turn.**

That's not a preference, it's where the bugs are: `wudm` (mic dead after
backgrounding), `oxmt` (TTS self-interrupt), `j8k1` (Safari's Web Speech lie) are
lifecycle and platform-lies bugs, not transcription bugs - and all three currently
sit with their **code landed and unverified**, waiting on a device session. A
lifecycle harness is the thing that unblocks them.

**Android emulator first**: `adb` gives real lifecycle control (`am broadcast`,
`input keyevent KEYCODE_POWER`, `svc data disable`) and host audio injection works.
The iOS Simulator's audio input is unreliable and needs a spike before committing.
See the bead for the current scoping.

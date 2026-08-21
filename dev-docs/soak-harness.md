# Soak harness

Automated end-to-end sessions: an LLM plays the meditator against the real
engine, whole sits run unattended on a fake clock, and every run leaves a
scorecard. The pre-release workflow this exists for: kick it off, take a walk,
come back to `report.md`.

Not wired into CI - real API calls, real money. Run it by hand before a
release, or after touching anything in `ts/src/facilitation/`.

```bash
npm run soak -- --battery=pre-release               # the walk-away check
npm run soak -- --battery=smoke --baseline=last     # quick, vs the last run
npm run soak -- --battery=models                    # facilitator comparison
npm run soak -- --list-batteries                    # what the presets do
npm run soak -- --list                              # what's in the matrix
npm run soak -- --scenarios=silence,timer-hold      # a slice
npm run soak -- --facilitator=ollama:qwen3 --no-judge
```

## Batteries

A battery (`soak/batteries.ts`) is a whole pre-release check as one word: which
scenarios, how many sessions, and who plays which role. The point is that the
decision gets made once and reviewed once, instead of being re-improvised at the
prompt each release. Individual flags override anything a battery sets.

| Battery | What it is |
|---|---|
| `smoke` | Two scenarios, one session. "Did I break the engine?" in a couple of minutes. |
| `pre-release` | The full matrix, two sessions per scenario. The one to run before cutting a release. |
| `models` | Facilitator comparison across three families, judged by a fourth that isn't in the contest. |

Tier 2 is deliberately not part of a battery: it runs in real time and owns the
machine's audio, so it stays an explicit `npm run soak:web`.

## Casting: who plays which role

A run casts four roles - **facilitator** (under test), **meditator** (the sim
user), **classifiers** (the cheap utility model), **judge** - and two pairings
invalidate the result:

- **Judge = facilitator.** LLM judges prefer their own generations, so a
  same-model judge inflates one row. In a `--facilitator=a,b,c` comparison the
  bias lands on ONE contestant, which is worse than applying to all of them: the
  ranking becomes partly an artifact of who the judge is. This used to be the
  shipped default (facilitator and judge both `anthropic`), which is why the
  default judge is now a different family.
- **Meditator = facilitator.** Both halves of the conversation stop being
  independent.

**Classifiers sharing the facilitator's model is not a collision.** That's what
the shipped app does (`buildUtilityProvider` runs Haiku next to whatever is
facilitating), so matching it is realism.

The defaults and every battery are held to "no collisions" by
`tests/soak-roles.test.ts` - a preset is what gets run without thinking, so a
preset must never be the thing that contaminates a scoreboard. An explicit
override may still collide: the run proceeds, warns on the way in, and the report
stamps the caveat directly above the scores. Every report names all four models
in its header, because a scoreboard without its judge named can't be read.

Keys come from the environment or `ts/server/.env` (`soak/env.ts`). Defaults:
facilitator + judge on the Anthropic default model, sim user + classifiers on
Haiku. Exit code 1 when any deterministic check fails, so a release script can
gate on it. Output lands in `ts/soak-runs/<timestamp>/` (gitignored):
`report.md` (read this one), `run.json`, and one JSON per session with the full
transcript + event log.

## How it works (`ts/soak/`)

| File | Role |
|---|---|
| `orchestrator.ts` | Headless session engine: the real core (PromptBuilder, SessionManager, PacingController, `parseTurnSignals`, `routeUtterance` + silence classifiers, smart check-ins, `StagedModeController`, timer events) wired the way `ui/src/views/session.ts` wires them, minus DOM/audio/streaming, on `createFakeClock`. A 30-minute sit takes as long as its LLM calls. |
| `sim-user.ts` | The meditator: persona-prompted LLM answering `WAIT: <seconds>` + an optional spoken line (or `END`). Stateless per call with a stable transcript prefix, so prompt caching applies. |
| `scenarios.ts` | The matrix. Each scenario aims a persona at one slice of the engine: baseline chat, the silence-mode round trip, check-in streak/pass caps, the felt-sense staged arc, a timer completing *inside* a hold, and an overwhelmed sharer whose trailing-off must not trigger `[HOLD]`. |
| `checks.ts` | Deterministic post-run checks. `fail` = engine bug or broken invariant (control token spoken, timer completion missing, session aborted); `warn` = worth a look (role leaks in raw output, possible hold trap, fallback-heavy check-ins); `info` = context (latency percentiles, hold activity). |
| `judge.ts` | LLM judge for what only a reader can see: responsiveness, tone, brevity, silence respect, meta leaks, timer landing - plus verbatim "wince moments". Strict JSON out, parsed leniently. |
| `report.ts`, `run.ts` | Report writer and CLI (concurrency pool, provider specs, exit code). |

The orchestrator deliberately **mirrors** `views/session.ts` rather than
sharing code with it - the view's orchestration is entangled with DOM and
audio. The tax: when the view's wiring changes, `soak/orchestrator.ts` has to
follow. `tests/soak.test.ts` runs the whole engine offline against scripted
providers and pins the flows that drift would break (hold round trip, timer
completion inside a hold restoring the hold, check-in caps), and
`soak/tsconfig.json` is part of `npm run typecheck`, so drift that changes
shared types breaks the build.

## Reading a run

`report.md` is ordered for a two-minute read, worst news first: verdict line →
what changed since the baseline → scoreboard → every failure grouped by check →
the judge's verbatim wince quotes. Transcripts and per-session bookkeeping come
last and collapsed; they're where you go once something above has told you where
to look.

- **Check fails** are the "did something break" signal - they are mechanical
  and trustworthy. A fail is either an engine bug or a harness bug; both are
  worth fixing. Failures are grouped **by check id, not by session**: one broken
  thing seen in four sessions is one problem, not four.
- **Judge scores** are directional, not gospel: compare against the same
  judge model's scores on earlier runs, not across judge models. The wince
  quotes are the useful part - each one is a candidate regression case for
  the classifier probe harness (meditation-pal-sfdk) or a prompt edit.
- **Role leaks** (`role-leak-raw`) count how often the model *tried* to write
  the meditator's turn; the engine strips them before speech. Rising counts
  after a prompt change are the early warning.

### Comparing against a baseline

`--baseline=<dir>` (or `--baseline=last` for the most recent run) leads the
report with what *changed*: checks that newly fail, checks that stopped failing,
and judge scores that moved. Sessions are matched by scenario + facilitator model
and averaged over that cell's repeats, so `--sessions=2` compares like with like.

`JUDGE_DELTA_MIN` (1.5) is calibrated against the harness, not guessed: two
`smoke` runs of identical code moved a scenario a full point at one session
each. Anything under that is hidden rather than reported as a regression.

`--baseline=last` only ever picks a run from the **same tier**, and an explicit
cross-tier `--baseline` is stamped with a warning in the report. The two matrices
share scenario ids (`baseline`, `silence`) while measuring different things, so a
cross-tier diff looks perfectly plausible and means nothing.

The comparison is deliberately asymmetric about how much it trusts each signal. A
newly failing check is mechanical and gets stated flatly. A judge score is one
sample of a stochastic model, so movement under `JUDGE_DELTA_MIN` (1.0) is hidden
as noise, and even a shown move is labelled a place to look rather than a verdict.
Use `--sessions=2`+ before reading anything into a score change.

## Relation to `ts/evals/`

`evals/protocol-eval.ts` asks "can model X emit the control tokens reliably?"
in isolated probes - cheap, per-model, disqualifying. The soak harness asks
"does a whole session hold together?" with one model in the facilitator seat.
Run evals when choosing a model; run soak when changing the engine or prompts.
`--facilitator=<a,b,c>` bridges the two: the same scenarios under each model,
scored by the same judge (which never sees the model's name), aggregated into
a per-model comparison table - effectively evals phase 2 with whole sessions
instead of isolated probes. Caveats: judge scores compare within a run, not
across judge models, and single sessions are noisy - use `--sessions=3`+ for a
decision. The judge rubric here and `evals/rubric.md` should converge over
time.

## Tier 2: the real UI over a virtual microphone

Tier 1 is text-level: STT, TTS, VAD, the echo guard, barge-in, and the mute
command are all out of scope by construction. Tier 2 puts them under test. The
same personas and the same judge, but the simulated meditator now **speaks out
loud** into a virtual audio device that the real web UI has selected as its
microphone.

```bash
npm run web:dev                                   # in another terminal, first
npm run soak:web                                  # the whole matrix
npm run soak:web -- --list
npm run soak:web -- --scenarios=silence,mute
npm run soak:web -- --voice=openai:sage           # a realer voice, costs money
npm run soak:web -- --scenarios=baseline --no-judge --keep-open
```

### Setup (one time)

```bash
brew install --cask blackhole-2ch    # then RESTART the Mac: CoreAudio doesn't
brew install switchaudio-osx         # list the driver until you do
```

Google Chrome must be installed. The harness drives **real Chrome**, not
Playwright's bundled Chromium, because the Web Speech API only works in a build
carrying Google's speech keys - `channel: 'chrome'` is load-bearing. Headed for
the same reason; `--headless` exists but headless Chrome's media stack is a
different animal and a run that transcribes nothing looks exactly like a
facilitator that never answers.

### The audio topology, and why it's a loopback

Chrome's `--use-file-for-fake-audio-capture` replays one fixed WAV, so a virtual
device is the only workable route. BlackHole becomes both the default **output**
(where the sim voice plays) and the default **input** (what Chrome captures).

The app therefore also hears **its own TTS**, because that plays out of the same
default output. That is deliberate: it's the real acoustic situation a
speaker-and-mic user is in, and it puts the echo guard and barge-in under test
rather than around them. Two consequences worth knowing before you start a run:

- A run **owns the machine's audio in and out** for its duration. Don't play
  anything else; don't take a call. The harness restores the previous defaults
  on exit, including on Ctrl-C.
- When the echo guard drops a *meditator* utterance, that's the
  `echo-guard-false-positive` check, and it's a `fail` - the topology exists to
  make that visible.

Pass `--no-audio-routing` to leave the system devices alone (for debugging the
driver without the audio path).

### How it works (`ts/soak/browser/`)

| File | Role |
|---|---|
| `driver.ts` | Playwright over real Chrome. Seeds `preview:setup` / `app:settings` / `apikey:*` into localStorage before boot, resolves the loopback device's per-origin `deviceId` in-page, and clicks Begin (a real gesture, for the mic permission). Then it just reads the tap. |
| `orchestrator.ts` | The session loop. Waits for a turn boundary, plays one sim utterance, and watches for the recognizer's final. All engine state comes back from the page. |
| `voice.ts` | The meditator's mouth. `say` by default (free, offline, transcribes well); `openai:<voice>` runs the same gpt-4o-mini-tts the app's hosted voices use, for realistic prosody at a price. |
| `audio.ts` | Points both default devices at BlackHole and restores them afterwards. |
| `scenarios.ts` | The tier-2 matrix, plus the scenario → localStorage mapping. |
| `checks.ts` | Audio-path checks, run alongside tier 1's `runChecks`: miss rate, word error rate, echo-guard false positives, barge-in, the mute command. |
| `wer.ts` | Word error rate, normalized for case, punctuation, and contractions. |
| `run.ts` | CLI. Sessions run one at a time, in real time - there's one pair of default devices. |

The instrumentation on the app side is `ui/src/soak-tap.ts`: a structured event
tap gated on `import.meta.env.DEV` **and** `?soak=1`, emitting exactly tier 1's
`TurnRecord` / `SoakEvent` / `LlmCallStat` shapes. That's why `runChecks`,
`judgeSession`, and the report writer take a browser session unchanged. Scraping
the DOM instead would show clean text and nothing about holds, classifier
verdicts, timer events, or raw pre-parse output - most of `checks.ts` would go
dark. Vite tree-shakes the tap out of a release bundle entirely (there is no
`__aloudSoak` in `ui/dist`); it also means tier 2 exercises the **dev** build.

### Reading a tier-2 run

Everything from "Reading a run" above still applies, plus an **Audio round trip**
table per session: what the sim said, what the recognizer heard, and the WER for
each utterance. Read it first when a session looks like a bad facilitator - a
facilitator answering a garbled sentence sensibly is still a session a user would
call broken, and the transcript alone can't tell you which happened.

`stt-accuracy` reports the **median** WER, not the mean: one mangled utterance in
a clean run is speech, a shifted median is a broken capture path. Numbers are
only comparable within one `(voice, recognizer)` pair - a `say` run and an
`openai` run are different experiments, which is why both are printed in the
finding.

### What tier 2 deliberately does not test

There is no fake clock, so sits are short (5-9 real minutes) and each persona's
`WAIT` is clamped (`maxWaitSec`). The relative pacing survives; the absolute
scale doesn't. **Long-silence pacing - the 8-20 minute smart waits - stays tier
1's job**, where the fake clock makes it honest. Reproducing it here would mean a
soak run that takes an afternoon and still samples one session of it.

`tests/soak-web.test.ts` covers the loop, the WER scoring, the scenario →
settings mapping, and the audio checks offline against a fake driver and a silent
voice, so drift in the tier-2 wiring breaks the build rather than the next run.

### Measured baselines (first real run, 2026-08-20)

Six sessions, `say` into BlackHole, Chrome Web Speech. Useful as the numbers to
compare a later run against:

- **Word error rate: 0% median** in five of six sessions (8% in the sixth).
  Web Speech on `say` output is close to perfect, so a WER regression is a
  signal about the capture path, not about speech being hard.
- **Recognizer latency: 4.5-5.6s median** from end of playback to the final.
  That is Web Speech's endpointing, and it sets the floor on how fast a turn can
  possibly start - worth remembering before optimizing anything upstream.
- Barge-in fired, the spoken mute command muted, and the echo guard never once
  mistook the meditator for the facilitator even with the app's own TTS on the
  same loopback.

## Tier 3 (beads meditation-pal-eldj.3)

Tier 3 extends tier 2 to the iOS Simulator / Android emulator (both take host
audio input) and to real devices via a speaker. Personas, checks, and the judge
carry over again.

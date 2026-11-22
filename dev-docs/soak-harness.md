# Soak harness

An LLM plays the meditator against the real engine, whole sits run unattended,
and every run leaves a scorecard. Start it, then read `report.md` when it finishes.

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
npm run soak -- --facilitator=opus-5.5,gpt-6-sol # eval roster ids work too
npm run soak -- --judge=openai:gpt-6-sol,anthropic:claude-opus-5-5 --judge-repeats=3

npm run web:dev                                  # tier 2 needs this first,
npm run soak:web                                 #   in another terminal
npm run soak:web -- --scenarios=silence,mute
npm run soak:web -- --voice=openai:sage          # realer prosody, costs money
```

Keys come from the environment or `ts/server/.env` (`soak/env.ts`). The
`anthropic` spec is the exception: it runs on your own Claude subscription
through the `claude` CLI (`scriptClaude` in `soak/providers.ts`), close to the
API's behaviour but not the same request. `ALOUD_CLAUDE_VIA=api`, or the
`anthropic_api` spec for one role, puts it on `ANTHROPIC_API_KEY`; do that
for a run whose facilitator verdicts or latencies you will act on. Output is written
to `ts/soak-runs/<timestamp>/` (gitignored): `report.md` (read this one),
`run.json`, and one JSON per session with the full transcript + event log. Exit
code 1 when any deterministic check fails, so a release script can gate on it.

What `run.json` carries beyond the transcripts, for anything that reads it:
`meta.gitSha` and `meta.gitDirty` (the commit, and whether the tree had
changes on top, untracked files included); on every call `calls[].model` and,
when the provider reported them, `inputTokens` (fresh), `outputTokens`,
`cacheReadTokens`, `cacheCreationTokens` (absent means not reported, never
zero); on every session `judgeRuns`, one `{ judgeModel, verdict }` per judge
call, beside the older `judge` (first judge, first verdict).

## Before you run: four things that bite

**`soak:web` owns the machine's audio in and out.** BlackHole becomes both the
default output and the default input for the run's duration. Don't play anything
else, don't take a call. Devices are restored on exit, Ctrl-C included. Pass
`--no-audio-routing` to leave them alone (for debugging the driver, not the audio
path).

**A speaking facilitator needs the default recognizer.** The loopback feeds the
facilitator's voice into the mic at digital full scale, which no room does. A
mic-capturing `--stt` (anything but `web-speech`) reads that as barge-in, and the
facilitator answers its own words for the rest of the sit. So `run.ts` refuses
that pairing: speaking scenarios run on `web-speech`, the mic-capturing
recognizers on the silent-facilitator `pauses*` scenarios
(`WebScenario.silentFacilitator`). `--allow-self-echo` overrides it.

**The driver only exists during a run.** A loaded BlackHole plug-in is a
permanent candidate default input, and CoreAudio reaches for it whenever the real
mic goes away (sleep, unplugged headphones) - which is how it ends up being the
microphone your next video call picks up. So a run loads the driver on the way in
and parks it on the way out, and only puts back what it moved: start a run with
BlackHole already loaded and it stays loaded. See `scripts/blackhole-driver.sh`
below.

**Judge scores are noisier than they look.** Two `smoke` runs of *identical code*
moved a scenario a full point. That is what `JUDGE_DELTA_MIN` (1.5, in
`soak/baseline.ts`) is calibrated against, not a guess. Two things move it: the
session (a different transcript each run) and the judge (re-reading the same
one). `--judge-repeats=3` measures the second: `gpt-5.5` scored one unchanged
transcript 8/8/8 and another 8/8/7 (2026-11-22), and once gave a timer score
to a sit with no timer. So most of that point is the session: use
`--sessions=2`+ before believing any score movement. **Check failures are the
trustworthy signal.**

## Reading a run

`report.md` is ordered worst-news-first for a two-minute read: verdict line →
what changed since the baseline → scoreboard → failures grouped by check → the
judge's verbatim wince quotes → how far the judges move → tokens and cost.
Transcripts and per-session bookkeeping come last and collapsed.

| Signal | How much to trust it |
|---|---|
| **Check fails** | Mechanical and trustworthy. Either an engine bug or a harness bug; both worth fixing. Grouped **by check id, not session** - one broken thing in four sessions is one problem. |
| **`scenario-setup-missed`** | The session never produced what its scenario is aimed at (no frightened line inside a hold, no "I'm back", no cut turn answered). A pass there tested nothing; rerun before reading it as good news. |
| **Judge scores** | Directional only. Each judge has its own column, never averaged with another's; compare against the same judge model's earlier scores. `†` marks a judge scoring its own family's facilitator. |
| **Judge spread** | With `--judge-repeats`, how far one judge moves on an unchanged transcript; with two judges, how far apart they sit. A movement inside that is noise. |
| **Wince quotes** | The useful half of the judge. Each is a candidate regression case for the classifier probe harness (`meditation-pal-sfdk`) or a prompt edit. |
| **`role-leak-raw`** | How often the model *tried* to write the meditator's turn (the engine strips them before speech). A rising count after a prompt change is the early warning. |
| **Tokens and cost** | Per facilitator model: fresh input, cache read and write, output, the share of the prompt read from cache, dollars at the hosted list price (`server/src/pricing/providers.ts`). The fake clock never lets a cache entry lapse, so cache reads are an upper bound on a real sit's. Subscription calls (`‡`) carry the CLI's own preamble and caching, so their dollars price a different request. A run is the cheap place to see whether the append-only log (`tests/cache-prefix.test.ts`) reads from cache per provider; use `ALOUD_CLAUDE_VIA=api` for Claude's real numbers. |

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
| `models` | Every facilitator aloud ships (`SHIPPED_FACILITATORS`: the eval roster's `shipped` models the hosted price table puts on the picker, read at load), scored by GPT-6 Sol and Opus 5.5 so each contestant has a judge outside its family. Ten models × the matrix × two sessions: a long, few-dollar run. GPT-6.2 Astra, at about four times GPT-6 Sol a turn, is most of what it spends on keys (the Claudes run on the subscription). |

Tier 2 is deliberately not in a battery: it runs in real time and owns the
machine's audio, so it stays an explicit `npm run soak:web`.

## Casting: who plays which role

A run casts four roles - **facilitator** (under test), **meditator** (the sim
user), **classifiers** (the cheap utility model), **judge** (one or more). Two
pairings invalidate the result:

- **Only judged by its own family.** LLM judges prefer writing like their own,
  and the lab is what that follows (`modelFamily` in `soak/roles.ts`). In a
  `--facilitator=a,b,c` comparison the bias favors ONE contestant, which is worse
  than applying to all of them: the ranking becomes partly an artifact of who the
  judge is. A facilitator is fairly judged when at least one judge is from
  another family; the same-family judge's cells are then marked, not forbidden.
- **Meditator = facilitator.** Both halves of the conversation stop being
  independent.

**Classifiers sharing the facilitator's model is not a collision** - that's what
the shipped app does (`buildUtilityProvider` runs Haiku next to whatever is
facilitating), so matching it is realism.

Defaults and every battery are held to "no collisions" by `tests/soak-roles.test.ts`
- a preset is what gets run without thinking, so a preset must never be the thing
that contaminates a scoreboard. An explicit override may still collide: the run
proceeds, warns on the way in, and the report stamps the caveat above the scores.
Every report names all four models, because a scoreboard is only comparable when
it names its judge.

Defaults: facilitator + judge on different families (Anthropic / OpenAI), sim user
+ classifiers on Haiku.

## How it works

### Tier 1 (`ts/soak/`)

| File | Role |
|---|---|
| `orchestrator.ts` | Headless session engine: the real core (PromptBuilder, SessionManager, PacingController, `parseTurnSignals`, `routeUtterance` + silence classifiers, the trouble check, smart check-ins, `StagedModeController`, timer events, the language setting) wired the way `ui/src/views/session.ts` wires them, minus DOM/audio/streaming, on `createFakeClock`. A 30-minute sit takes as long as its LLM calls. |
| `sim-user.ts` | The meditator: persona-prompted LLM answering `WAIT: <seconds>` + an optional spoken line (or `END`), in Chinese for a zh scenario. Stateless per call with a stable transcript prefix, so prompt caching applies. |
| `transform.ts` | What a recognizer does to the sim's lines before the engine sees them (`Scenario.transform`): Chrome Web Speech's unpunctuated finals, or chosen turns cut to their last few words (seeded, the same every run). The transcript keeps both: `text` is what the engine got, `said` what the sim said. |
| `scenarios.ts` | The matrix. Each scenario aims a persona at one slice of the engine: `baseline`, `silence`, `quiet`, `felt-sense`, `timer-hold` (a timer completing *inside* a hold), `overwhelmed` (trailing off must not trigger `[HOLD]`), `destabilizing` (fright mid-session must break the frame; the judge scores it as `stepping_out`; [stepping-out.md](stepping-out.md)), `guided` (guidance 5, Directing, on inner parts), `zh` (a 中文 sit), and three aimed at open bugs, each with a mechanical check: `fright-in-hold` (frightened inside a hold without asking for help, meditation-pal-59eg), `back-in-hold` ("I'm back" and a report in one unpunctuated breath, kbec), `fragment` (a turn cut to "anymore." must not draw `[HOLD]`, rlgm). |
| `checks.ts` | Deterministic post-run checks. `fail` = engine bug or broken invariant; `warn` = worth a look; `info` = context. Among them: `fright-in-hold` and `back-in-hold` (the hold must end there), `fragment-hold-bid`, `reasoning-aloud` (a spoken line the engine should have withheld as the model's reasoning, `isReasoningAloud` in core `reasoning.ts`, meditation-pal-dqti) and `reasoning-withheld` (how many replies were withheld that way, counted), `wrong-language` and `token-translated` (zh), `empty-reply` (blank completions, counted; a reply of only signals is a legitimate turn, as in the view). |
| `judge.ts` | LLM judge for what only a reader can see: responsiveness, tone, brevity, silence respect, meta leaks, timer delivery, stepping out for a meditator in trouble, plus verbatim wince moments. Strict JSON out, parsed leniently. `runJudges` has every judge score every session `--judge-repeats` times. |
| `batteries.ts`, `roles.ts`, `baseline.ts` | Presets, collision rules, run-to-run diffing (the first judge, its repeats averaged). |
| `usage.ts`, `prices.ts` | Token totals per call group, and the hosted price table, loaded at run time: its type imports reach `server/src/contract.ts`, whose `@aloud/core/*` imports only the server's tsconfig paths resolve. |
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
| `voice.ts` | Synthesizes the meditator's lines. `say` by default (free, offline, transcribes well); `openai:<voice>` runs gpt-4o-mini-tts (paid; no hosted voice uses it any more). |
| `audio.ts` | Points both default devices at BlackHole and restores them afterwards. |
| `scenarios.ts` | The tier-2 matrix (`baseline`, `silence`, `barge-in`, `mute`, `timer`, `felt-sense`) plus the scenario → localStorage mapping. Also the opt-in endpointing experiments `pauses` / `pauses-nospec` / `pauses-full`: scripted lines with `say` `[[slnc]]` pauses after dangling words, speculation on vs off, and `pauses-full` as `pauses` with every pass sending the whole turn instead of an incremental piece (`sttFullPasses`, which seeds `isSttFullPassesDebug` in `dev-mode.ts` through `rawKv`). The facilitator's voice is muted (`silentFacilitator`) so the loopback can't feed it back. Run with `--stt=aloud-gpt-transcribe`; the report carries finals per line and the client's billed STT seconds by pass kind. |
| `checks.ts`, `wer.ts` | Audio-path checks (miss rate, WER, echo-guard false positives, phantom turns, barge-in, mute command) and word-error scoring normalized for case, punctuation, contractions. `phantom-turn` (`findPhantomTurns`) fails a meditator turn no spoken line accounts for, which is what the app answering its own voice looks like; finals are given to lines as the orchestrator gave them, plus a split line's late tail and a missed line's late final. |
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
same reason; `--headless` exists but headless Chrome's media stack behaves
differently, and a run that transcribes nothing looks exactly like a facilitator
that never answers.

**Why it's a loopback.** Chrome's `--use-file-for-fake-audio-capture` replays one
fixed WAV, so a virtual device is the only workable route. That means the app also
hears **its own TTS**, since that plays out of the same default output. Deliberate:
it's the real acoustic situation a speaker-and-mic user is in, and it means the echo
guard and barge-in are tested, not bypassed. When the echo guard drops a
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
pacing survives; absolute scale doesn't. **Long-silence pacing - the many-minute
smart waits - stays tier 1's job**, where the fake clock can run real-length silences.

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

## Tier 3: lifecycle on a phone

`meditation-pal-eldj.3`, open. The naive version - point BlackHole at a simulator
and re-run the tier-2 matrix - would mostly re-confirm things tier 2 already
proves. The valuable version tests what only a phone can break: **backgrounding
mid-utterance, an incoming call, screen lock during a `[HOLD]`, network death
mid-turn.**

The bugs so far have been lifecycle bugs: `wudm` (mic dead after
backgrounding), `oxmt` (TTS self-interrupt), `j8k1` (Safari's unusable Web Speech) are
lifecycle and platform bugs, not transcription bugs - and all three currently
have their **code merged but unverified**, waiting on a device session. A
lifecycle harness is the thing that unblocks them.

**Android emulator first**: `adb` gives real lifecycle control (`am broadcast`,
`input keyevent KEYCODE_POWER`, `svc data disable`) and host audio injection works.
The iOS Simulator's audio input is unreliable and needs a spike before committing.
See the bead for the current scoping.

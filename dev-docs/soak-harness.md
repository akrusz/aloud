# Soak harness

Automated end-to-end sessions: an LLM plays the meditator against the real
engine, whole sits run unattended on a fake clock, and every run leaves a
scorecard. The pre-release workflow this exists for: kick it off, take a walk,
come back to `report.md`.

Not wired into CI - real API calls, real money. Run it by hand before a
release, or after touching anything in `ts/src/facilitation/`.

```bash
npm run soak                                        # all scenarios, defaults
npm run soak -- --list                              # what's in the matrix
npm run soak -- --scenarios=silence,timer-hold      # a slice
npm run soak -- --sessions=3 --concurrency=3        # more samples per scenario
npm run soak -- --facilitator=ollama:qwen3 --no-judge
```

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

- **Check fails** are the "did something break" signal - they are mechanical
  and trustworthy. A fail is either an engine bug or a harness bug; both are
  worth fixing.
- **Judge scores** are directional, not gospel: compare against the same
  judge model's scores on earlier runs, not across judge models. The wince
  quotes are the useful part - each one is a candidate regression case for
  the classifier probe harness (meditation-pal-sfdk) or a prompt edit.
- **Role leaks** (`role-leak-raw`) count how often the model *tried* to write
  the meditator's turn; the engine strips them before speech. Rising counts
  after a prompt change are the early warning.

## Relation to `ts/evals/`

`evals/protocol-eval.ts` asks "can model X emit the control tokens reliably?"
in isolated probes - cheap, per-model, disqualifying. The soak harness asks
"does a whole session hold together?" with one model in the facilitator seat.
Run evals when choosing a model; run soak when changing the engine or prompts.
The judge rubric here and `evals/rubric.md` should converge over time.

## Tiers 2 and 3 (beads meditation-pal-eldj.2 / .3)

This is tier 1 of the epic (meditation-pal-eldj): text-level, so STT/TTS/VAD/
echo-guard/barge-in are out of scope by design. Tier 2 drives the real web UI
with synthesized speech through a virtual audio device (BlackHole); tier 3
extends that to the iOS Simulator / Android emulator (both take host audio
input) and to real devices via a speaker. Personas, checks, and the judge are
built to be reused by those tiers.

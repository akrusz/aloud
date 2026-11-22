# Model evals

Answering "which LLM is best for aloud" with measurement instead of vibes.

Public benchmarks are close to useless here. Nothing measures restraint,
non-interpretation, or the discipline to say eleven words when the model wants to
say sixty - and coding/reasoning leaderboards may be *anti*-correlated with what
this app needs, since models tuned to be thorough and helpful are exactly wrong
in a meditation. So the answer has to come from a domain eval.

Not wired into CI: these hit live APIs and cost money. Run them by hand.

## Two phases

**Phase 1 - protocol compliance** (`protocol-eval.ts`). Mechanical and cheap.
Can the model emit `[HOLD]` / `[NEXT]` / `[BACK]` / `[WAIT:Nm]` reliably, stay
brief, avoid leaking reasoning traces, and answer fast enough for a spoken turn
loop? Pass/fail per check, graded automatically. A model that fails here is
disqualified regardless of prose quality - every near-miss on a control token
gets *read aloud mid-meditation*.

```bash
npx tsx evals/protocol-eval.ts                              # shipped models, 3 runs
npx tsx evals/protocol-eval.ts --all --runs 5               # incl. candidates
npx tsx evals/protocol-eval.ts --models opus-5.5,sonnet-5.5 # a specific pair
npx tsx evals/protocol-eval.ts --fixtures felt-sense/,hold/ # only these fixture id prefixes
npx tsx evals/protocol-eval.ts --all --label roster         # -> results/<date>-roster/
npx tsx evals/protocol-eval.ts --all --label roster --resume  # only the cells not done yet
npx tsx evals/protocol-eval.ts --all --out evals/out/1.json # one file instead of a sweep
npm run evals:report                                        # -> evals/out/report.html
```

Keys from the environment or `ts/server/.env` (`soak/env.ts`): `OPENAI_API_KEY`,
`GOOGLE_API_KEY` or `GEMINI_API_KEY`, `OPENROUTER_API_KEY`. Models whose key is
missing are skipped, not failed. Models run four at a time (`--concurrency`),
except Ollama models, which share the GPU and run one after another.

**Claude runs on your subscription by default**, through the `claude` CLI
(`scriptClaude` in `soak/providers.ts`; the soak specs and `npm run jev:ab` go
through it too). `ALOUD_CLAUDE_VIA=api` switches every one of them to
`ANTHROPIC_API_KEY`. The subscription path is the desktop app's "Anthropic
Subscription" request, not aloud cloud's: the conversation goes in as one
prompt, the CLI adds an identity line and an environment block, and its startup
lands in every latency. On the check-in probe it matched the API's verdict in 9
cells of 10. So explore on the subscription, and run with the key before
trusting a latency, or a verdict that will decide a prompt change or a model's
place in the allowlist.

**Phase 2 - facilitation quality** (`rubric.md`). The expensive one, and the one
that actually answers the question. Blind-judge the transcripts Phase 1 wrote
against the rubric. Not yet automated - the rubric needs editing first, because
a rubric that doesn't match your taste measures the wrong thing.

## Files

| File | What it is |
|---|---|
| `models.ts` | Candidate roster: shipped models plus landscape candidates, each with the hypothesis it tests |
| `fixtures.ts` | Seed meditator turns, deliberately adversarial where the protocol is easy to get wrong |
| `protocol-eval.ts` | Phase 1 runner |
| `prompt.ts`, `grade.ts` | What a fixture sends (and its `promptHash`), and the Phase 1 checks |
| `records.ts` | The results store: record shapes and the sweep reader |
| `report.ts` | The page: `aggregate.ts` (models), `soak-summary.ts` (soak runs), `report-client.ts` + `report-page.css` (inlined) |
| `rubric.md` | Phase 2 scoring instrument - **skeleton, needs your edits** |

## Results and the report

A run writes a sweep directory, `results/<date>-<label>/` (`--sweep <name>` to
reuse one), with one `RunEnvelope` per model (`records.ts`): run metadata (start,
git sha and dirty flag, `claudeVia`, runs, label) and the trials. A trial keeps the
reply, the checks, latency, time to first text where the provider streams, token
usage, `finishReason`, cost at list price for API calls
(`server/src/pricing/providers.ts`), and a `promptHash` of what was sent.
Rerunning a model replaces its file; `--resume` keeps every cell whose
`promptHash` still matches and runs the rest. Older bare `Trial[]` files (the
Ollama trial) still read. A committed sweep is a record: keep the ones a decision
rests on.

`npm run evals:report` reads every sweep and every `soak-runs/*/run.json` into one
page with no network requests. Per model it uses the latest sweep that ran each
fixture and summarises older ones. It re-runs `grade.ts` over the stored replies,
so old sweeps are judged by today's checks; a reply whose `promptHash` differs from
today's prompt is marked stale (no hash: unknown). Verdict rules are `RULES` in
`aggregate.ts` and are stated on the page. Beside them, a count to read and never
a rule: replies per 100 with a stock phrase (`STOCK_PHRASES` in `stock-phrases.ts`,
yours to cut), the share ending in a question, and the most repeated opening,
all without the acute stepping-out turns.

**Phase 2 output**: a judge writes `judge-<name>.json` into the sweep it judged, a
`JudgeFile` (`records.ts`): `meta.judgeModel` (never mixed with another judge's
tallies), and per fixture the models compared, the blind letters, the winner (or
`tie`), the model ranked last in a three-way, the margin, the rationale, the models
that broke a hard rule, optional rubric `scores` per model, and the `promptHashes`
of the trials it read. The hand-made `verdict-*.json` + `key-*.json` pairs in the
Ollama trial read as judge files, their judge named by the sweep's
`blind-judge.json` (`{ "judgeModel": ... }`).

## Design notes

**Prompts come from the real builder.** `systemPromptFor()` goes through
`PromptBuilder` + `StagedModeController` from `@aloud/core`, not a fixture-local
copy. An eval whose prompt drifts from the shipped prompt measures nothing.

**Multiple runs per fixture by default.** Variance is a finding, not noise: a
model that emits `[HOLD]` on two of three identical inputs is not usable, and a
single run hides that.

**Fixtures test both failure directions.** `felt-sense/hold-in-story` catches
models that rush the arc; `felt-sense/legitimate-advance` catches models too timid
to ever move. Only grading one direction rewards a model that never advances.
The `stepping-out/` family does the same for a meditator in trouble: five acute
turns that must break the frame, four ordinary-intensity ones (tears, anger, a
strange sensation, pleasant dissolving) that must not. Its marker lists are
crude, so read the transcripts before trusting a fail. `qwen3.5-4b`, the
smallest desktop tier, is in the roster for this: it is the model that follows
a prompt to the letter.

## Adding a model

Add an entry to `ROSTER` in `models.ts` with the hypothesis it tests, make sure
`buildProvider()` handles its provider, and run Phase 1. Promote to the cloud
allowlist (`server/src/pricing/providers.ts`) only after Phase 2 - and follow the
checklist in that file's header comment, which covers pricing, the picker name,
and the allowlist test.

Phase 1 includes the `stepping-out/` fixtures, and a new model has to be read
against them (`--fixtures stepping-out/ --out ...`, then the transcripts). One
that keeps facilitating through more than about one acute turn in ten goes in
`CHECKED_MODELS` (`src/facilitation/stepping-out.ts`) so its turns get the
trouble check; a local Ollama model gets the check whatever it scores, but run
it anyway and add its row to `dev-docs/stepping-out.md`. One that still misses
with the check's note, as GPT-5 nano did, should not be offered as a
facilitator at all.

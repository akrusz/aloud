# Model evals

Answering "which LLM is best for aloud" with measurement instead of vibes.

Public benchmarks are close to useless here. Nothing measures restraint,
non-interpretation, or the discipline to say eleven words when the model wants to
say sixty — and coding/reasoning leaderboards may be *anti*-correlated with what
this app needs, since models tuned to be thorough and helpful are exactly wrong
in a meditation. So the answer has to come from a domain eval.

Not wired into CI: these hit live APIs and cost money. Run them by hand.

## Two phases

**Phase 1 — protocol compliance** (`protocol-eval.ts`). Mechanical and cheap.
Can the model emit `[HOLD]` / `[NEXT]` / `[BACK]` / `[WAIT:Nm]` reliably, stay
brief, avoid leaking reasoning traces, and answer fast enough for a spoken turn
loop? Pass/fail per check, graded automatically. A model that fails here is
disqualified regardless of prose quality — every near-miss on a control token
gets *read aloud mid-meditation*.

```bash
npx tsx evals/protocol-eval.ts                              # shipped models, 3 runs
npx tsx evals/protocol-eval.ts --all --runs 5               # incl. candidates
npx tsx evals/protocol-eval.ts --models opus-5,sonnet-5     # a specific pair
npx tsx evals/protocol-eval.ts --all --out evals/out/1.json # save transcripts
```

Keys from the environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GOOGLE_API_KEY`, `OPENROUTER_API_KEY`. Models whose key is missing are skipped,
not failed.

**Phase 2 — facilitation quality** (`rubric.md`). The expensive one, and the one
that actually answers the question. Blind-judge the transcripts Phase 1 wrote
against the rubric. Not yet automated — the rubric needs editing first, because
a rubric that doesn't match your taste measures the wrong thing.

## Files

| File | What it is |
|---|---|
| `models.ts` | Candidate roster: shipped models plus landscape candidates, each with the hypothesis it tests |
| `fixtures.ts` | Seed meditator turns, deliberately adversarial where the protocol is easy to get wrong |
| `protocol-eval.ts` | Phase 1 runner |
| `rubric.md` | Phase 2 scoring instrument — **skeleton, needs your edits** |

## Design notes

**Prompts come from the real builder.** `systemPromptFor()` goes through
`PromptBuilder` + `StagedModeController` from `@aloud/core`, not a fixture-local
copy. An eval whose prompt drifts from the shipped prompt measures nothing.

**Multiple runs per fixture by default.** Variance is a finding, not noise: a
model that emits `[HOLD]` on two of three identical inputs is not usable, and a
single run hides that.

**Fixtures test both failure directions.** `felt-sense/hold-position` catches
models that rush the arc; `felt-sense/legitimate-advance` catches models too timid
to ever move. Only grading one direction rewards a model that never advances.

## Adding a model

Add an entry to `ROSTER` in `models.ts` with the hypothesis it tests, make sure
`buildProvider()` handles its provider, and run Phase 1. Promote to the cloud
allowlist (`server/src/pricing/providers.ts`) only after Phase 2 — and follow the
checklist in that file's header comment, which covers pricing, the picker name,
and the allowlist test.

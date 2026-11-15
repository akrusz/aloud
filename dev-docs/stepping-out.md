# Stepping out

What the facilitator does when a meditator is not okay: frightened by what is
happening, panicking, unable to tell where they are, re-living something, or
talking about not wanting to live. Everything else in the prompt says to follow,
stay brief and ask about the sensation, which is the wrong reply there.

Two layers. The first is prompt text and covers most models. The second is a
check that runs per utterance and covers the models the text does not reach.

## Layer 1: the prompt section

`STEPPING_OUT_FRAGMENT` (`prompts.ts`), pushed by
`PromptBuilder.buildSystemPrompt` after the dimension sections in every mode. It
sits late on purpose: it has to outrank response length and the guidance level,
and a small model obeys whichever section came last. It names floating,
numbness and far-away feelings as ordinary, because without that line GPT-5.6
Terra grounded someone who was only "floating a little".

Measured with the `stepping-out/` fixtures (`evals/fixtures.ts`): five acute
turns that must break the frame, six ordinary ones that must not. Acute turns
stepped out, of 15, without the section and with it (2026-11-14):

| model | without | with |
|---|---|---|
| Opus 5.5, GPT-6 Sol | 15 | 15 |
| Sonnet 5.5 / Haiku 5.5 | 11 / 12 | 15 |
| GPT-6 Luna / GPT-5.6 Terra | 11 / 9 | 15 |
| Gemini 3.5 Flash Lite | 0 | 15 |
| Kimi K2 | 1 | 13 |
| gemma4:26b | 4 | 13 |
| gemma4:12b | not run | 10 |
| qwen3.5:4b | 0 | 3 |
| GPT-5 nano | 0 | 1 |

(gemma4:12b's row is from the tier trial that gave it the 16GB slot,
`evals/results/ollama-tiers-2026-11-14`.) Ordinary turns were left alone 18 of
18 everywhere but one qwen miss. The
markers are crude; read transcripts before trusting a fail.

GPT-5 nano is off the facilitator picker on this result (`utilityOnly` in
`server/src/pricing/providers.ts`; it stays the recap engine). A new model gets
the same read before it ships: `ts/evals/README.md`, "Adding a model".

## Layer 2: the trouble check

For the models at the bottom of that table, a rule in the system prompt is not
enough, but the same models answer one focused question well and obey a note
placed at the turn. So: one judgment per utterance, and on a yes
`STEPPING_OUT_NOTE` goes into the log right behind the meditator's words
(`SessionManager.appendSystemNote`, kind `trouble`). With the note, qwen3.5:4b,
gemma4:12b, gemma4:26b and Kimi K2 stepped out on 15 of 15; GPT-5 nano on 10.

**Who answers** (`classifyTrouble`, `resume-intent.ts`): Jev where the session
has a judge, through the `trouble` questions in `utterance-judge.ts` (two asks,
`frightened` and `danger`, a yes on either); otherwise the session's utility
model with `TROUBLE_SYSTEM_PROMPT`, which on a local session is the facilitator
itself. `npm run jev:ab -- trouble` scores Jev and Haiku against 66 labelled
lines: of 29 in trouble and 37 ordinary, Jev missed 1 and flagged 0, Haiku
missed 2 and flagged 1, and qwen3.5:4b as its own classifier missed 4 and
flagged 2. A failed check is a no.

**Where it runs** (`views/session.ts`, mirrored in `soak/orchestrator.ts`):

- **Ordinary turns, gated models only.** `wantsTroubleCheck`
  (`stepping-out.ts`): every Ollama model, plus Kimi K2 and GPT-5 nano (for
  the builds that can still pick it). The models at 15 of 15 never run it.
- **Held silence, every session.** The resume classifiers hear a frightened line
  as thinking out loud (Jev said "stay" to 15 of 16), so the check runs beside
  them in `handleSilenceUtterance`, and a yes ends the hold and carries the note
  into the reply.

**Latency.** The check never stands in front of a reply for long, on any
machine.

1. It is asked during the recognizer's pause, on the settled partial
   (`UtterancePrefetch`, the same mechanism as `CommandPrefetch`), so the
   verdict is usually in before the turn is submitted. A yes then puts the note
   in ahead of the reply. Someone who pauses mid-sentence starts one ask per
   pause; each is called off when the words move on, and only the last counts.
2. If the verdict is still out at submit and the check runs somewhere other
   than the facilitator's model (Jev, Haiku, a BYOK API), the reply is requested
   anyway and the check runs beside it. `speakGate` (`streaming-tts.ts`) holds
   the first words for at most `TROUBLE_GRACE_MS` after they are ready; a yes in
   that window stops the reply and asks again with the note. Past it the reply
   goes out unchecked, and a late yes is only logged (`stepping-out` /
   `too-late`).
3. On a local session the check runs on the facilitator's own model, and Ollama
   takes the two calls one after the other (measured: first words at 270ms
   alone, 1000ms behind a 700ms check). So a check still out at submit is time
   in front of the reply, and it is allowed only when it fits
   `TROUBLE_LOCAL_BUDGET_MS` (`localCheckFits`): the session keeps what the
   check has been taking on this machine, timed once while the greeting plays.
   One that would not fit is called off and the reply goes out on the prompt
   section alone (`stepping-out` / `skipped-slow`).

What the check costs locally, qwen3.5:4b, 2026-11-14: about 280ms on an
M-series GPU, about 1.2s on the same Mac with the GPU off. gemma4:12b on the
GPU: 190ms at the median and 360ms at the 90th percentile, and as its own
classifier it read all 29 lines of the probe set right three times over. So a fast machine is
checked on every turn, and a slow one or a large model only on the turns where
the check finished inside the pause. That is the trade: coverage thins before
replies slow. `TROUBLE_SYSTEM_PROMPT` carries no examples for the same reason.

A held silence has no budget: leaving a hold is not a moment where a second
matters, and the resume classifier is already being waited on.

The two requests matched on the device ("mute", "end the session") are not
screened: they never become a turn, and on a meditator's own key each ask is
theirs to pay for.

**In the soak harness** the `destabilizing` scenario exercises both layers, and
the judge scores them as `stepping_out`.

**Through the real UI**, `node ts/scripts/voice-loop-check.mjs` has a scenario
for the turn loop itself, on a model that gets the check (its stand-in answers
the screening prompt YES for a frightened line): the note is in what the model
was sent, one request and not two when the verdict came in during the pause,
and the turn after is an ordinary one. The gate and the replaced reply (rule
2) are not reached there, since its recognizer always leaves time for the
verdict.

## Not covered

- Noting circles: no facilitator turn to step out of (meditation-pal-h2nw).
- A slow build across several calm-sounding lines: the check reads one
  utterance.
- zh is covered by the Jev examples and two corpus lines, no more.

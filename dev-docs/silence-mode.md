# Silence mode (`[HOLD]`) and the utterance judge

How the facilitator goes quiet on request and how the app decides when it comes
back. The spoken commands ride the same judge: [voice-commands.md](voice-commands.md).

## The signal

The LLM prefixes `[HOLD]` to a reply to ask for silence mode. It is parsed with
the other turn signals (`parseTurnSignals`, `modes.ts`) and stripped, after
`parseTurnSignals` truncates role leaks (`findRoleLeak` / `stripRoleLeak`). This
path feeds history, so a model that starts writing the meditator's turn never
reaches the transcript.

With silence mode off in settings, `HOLD_SIGNAL_FRAGMENT` leaves the system
prompt, so the facilitator can't promise a silence the app won't deliver.

## A bid, not the entry

Small models emit `[HOLD]` far too eagerly, so the token only makes the
facilitator ask "shall I be quiet?", and the app judges the reply. Three
one-utterance, no-history classifiers in `resume-intent.ts` gate the silence:

| Classifier | Runs on | Notes |
|---|---|---|
| `classifyHoldConfirm` | the reply to "shall I be quiet?" | the way in |
| `classifyResumeIntent` | each buffered utterance while held | biased hard toward staying: thinking out loud is not a call back |
| `classifyHoldRequest` | utterances in the minute after a hold ends | takes "no, stay quiet" back under with a canned line (`HOLD_REENTRY_LINES`) instead of a facilitation turn |

`routeUtterance` (`silence-dispatch.ts`) owns the precedence between them.

The one thing that speaks inside a hold is the session timer's completion
notice, which puts the hold back afterwards: [pacing.md](pacing.md#session-timer).

## The judge (Jev)

Judge sessions put TypeSafe's Jev in front of the three classifiers, via
`/cloud/v1/judge` (`utterance-judge.ts`; the route is in
[ts-server.md](ts-server.md#routes)).

- **Where it runs.** Always on aloud cloud (dev override
  `getJevClassifierMode`, `dev-mode.ts`: `on` / `shadow` / `off`, see the
  cheatsheet's Developer mode). On BYOK/local it sits only behind the
  `voiceCommandsViaCloud` opt-in plus a signed-in account, since those sessions
  otherwise never touch our server (`ui/src/voice-commands.ts`,
  `voiceCommandsAccess`). The call is free, so no balance is involved.
- **Shape.** Each classifier is one or more atomic yes/no asks answered as
  probabilities in a single request. A yes on any ask, each against its own
  measured threshold (`judgeVerdict`), is a yes. `resume` asks "addressed to
  the facilitator?" and "done with the silence?" separately, and alone gets the
  hold's earlier utterances as context (`JudgeContext.earlier`), so "I guess
  I'm ready" can mean the session or the thing they were just talking about.
  The LLM classifiers stay history-free.
- **Failure.** Any judge failure falls through to the LLM classifiers.
  `CloudJudge` (`ui/src/adapters/cloud-judge.ts`) backs off (30s doubling to
  5m) after two failures in a row, so an outage is not one wasted round trip
  per utterance.
- **Scoring.** `npm run jev:ab` scores Jev against the LLM classifiers on a
  labelled corpus (real TypeSafe calls, a few cents). Rerun it after touching
  a question or threshold.

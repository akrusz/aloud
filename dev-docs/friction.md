# Friction log

Things that cost time while working in this repo - layout, tooling, setup. Each
entry says what it cost and what would fix it, so this reads as an inbox rather
than a diary.

Claude: append here when something slows you down and the fix isn't yours to
make in passing. One entry per annoyance, with a proposed fix - if you can't
name a fix, it's probably an observation, not friction. Keep it to the project
and its tooling.

Triage: promote real items to beads (`bd create`) and delete them from here once
filed. Length should mean unresolved friction, not history.

---

## npm has to run from `ts/`, and the shell cwd resets

**Cost:** four failed commands in one session, each an ENOENT plus a retry.
Every `npm` script lives in `ts/package.json`, so a bare `npm test` from the
repo root fails, and a `cd ts` in one tool call doesn't survive to the next.

**Fix:** `npm --prefix ts run typecheck` (and `test`, `ui:dev`, …) works from
the root - now noted in CLAUDE.md's Commands block. A root `package.json` that
delegated the common scripts would remove the question entirely.

*2026-08-05*

## Classifier prompt tuning has no harness

**Cost:** five throwaway probe scripts in a scratch dir to measure the
silence-mode classifiers against Haiku. The measurements that justified the
prompts (5/15 false-resume before the tv9u rewrite, 0/23 after, 22/22 on the
hold-request prompt) are unreproducible - the scripts are gone and the cases
only exist in a chat transcript.

**Fix:** a committed probe script plus a cases file, so the claims are
re-runnable by a human and the case set grows instead of being re-invented.
Filed as meditation-pal-sfdk.

*2026-08-05*

## `views/session.ts` is ~2600 lines

**Cost:** three or four greps to find the right seam before any edit, on every
session that touches the session view.

**Fix:** no single move; the state machine around silence mode came out cleanly
into `facilitation/silence-dispatch.ts`, and the same is probably true of the
check-in and timer paths. Worth doing opportunistically rather than as a
project.

*2026-08-05*

## `bd create` doesn't surface the new issue ID

**Cost:** a second `bd list | grep` after each create to get the ID back for
linking or closing. Twice in one session.

**Fix:** none in this repo - it's a bd behavior. Noted so it isn't
re-discovered; `bd create ... | tail -3` shows priority and status but not the
ID, so grep the title instead.

*2026-08-05*

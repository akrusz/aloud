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

## `views/session.ts` is ~2600 lines

**Cost:** three or four greps to find the right seam before any edit, on every
session that touches the session view.

**Fix:** no single move; the state machine around silence mode came out cleanly
into `facilitation/silence-dispatch.ts`, and the same is probably true of the
check-in and timer paths. Worth doing opportunistically rather than as a
project.

*2026-08-05*

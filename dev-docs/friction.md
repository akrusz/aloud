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

## Phone dev over `chrome://inspect` fails like a product bug

**Cost:** most of an evening's first hour. Port forwarding drops silently - the
mapping still shows in the UI - and every `/cloud/v1` call then fails with
"Failed to fetch". Voice preview and Google sign-in broke together, which reads
exactly like a real auth/network bug, and got debugged as one.

**Fix:** a "phone dev" section in the cheatsheet: the forwarding steps, that
`localhost` (not the LAN IP) is what makes `getUserMedia` work, and the tell -
everything cloud-shaped failing at once means the tunnel, not the app. Cheapest
check is loading `/cloud/v1/tts/preview?voice=Leda` on the phone directly.

*2026-08-05*

## Nothing catches a behavioral regression in the mic path

**Cost:** three walk-backs in one evening (web-speech interim join, mic cooldown
on desktop, and the same class narrowly avoided in the barge-in wrapper). Every
one passed typecheck, 640 tests, and `ui:build`, and was caught by the dev
talking into a laptop.

**Fix:** commit the manual smoke list as `dev-docs/manual-smoke.md` - the five
minutes of desktop-app + browser checks worth running before a release, in
priority order. Doesn't automate anything, but it stops the list being
re-derived from scratch each time, and it names the paths no test covers.

*2026-08-05*

## Recognizer event shapes are guessed, not captured

**Cost:** one shipped regression. The Web Speech fix was tested against a fake
recognizer built from my model of desktop Chrome, and the model was wrong -
desktop emits several interim entries, not one that grows. The test passed and
the live bubble broke.

**Fix:** capture real `event.results` sequences from each browser once (a scratch
page that logs them) and commit them as fixtures. Same argument as the
classifier probe harness (meditation-pal-sfdk): a claim about what a black box
does should be re-runnable, not remembered.

*2026-08-05*

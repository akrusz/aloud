# Pacing: check-ins and the session timer

The pacing state machine runs IDLE → LISTENING → PROCESSING → RESPONDING →
SILENT_HOLD; a check-in fires after a silence interval and the timer resets.
This doc covers what a check-in says, when it fires, and the meditation timer
that rides the same path. Silence holds themselves: [silence-mode.md](silence-mode.md).

## Check-ins

Content and timing are separate settings (`checkinContent`, `checkinTiming`).

**Content** is a canned (non-LLM) phrase, or "smart" (`smart-checkin.ts`): the
LLM gets the session plus a bracketed silence-event turn and offers one short
line in context, or replies `[PASS]` to keep quiet. Unusable replies fall back
to the canned pool.

**Timing** is a fixed interval, or "smart": the LLM prefixes `[WAIT:Nm]`
(parsed with the other turn signals) to set how long the next silence stays
protected, clamped and held by `PacingController.setCheckinInterval`. The
default wait is biased by the guidance slider (`waitBiasFragment` /
`defaultWaitSeconds`: 20m / 8m / 5m / 90s / 30s across the five stops), so high
guidance means short waits and substantive check-ins.

Two guards on the smart path (`views/session.ts`):

- After `SMART_CHECKIN_MAX_PASSES` (2) consecutive `[PASS]`es, the next due
  check-in speaks a canned line instead of giving the model another chance to
  stay quiet.
- The streak cap (`SMART_CHECKIN_MAX_STREAK`) remains the walk-away backstop.

`?debug=checkin` shows all of this live (see the cheatsheet's dev URL params).

### Modes that own their check-ins

A `checkinPaceSlider` mode (felt sense) has its own toggle and pace slider in
the setup panel (`SessionSetup.feltSenseCheckins`, default on). `views/session.ts`
derives timing from those (`smart` / `none`) and forces content to `smart`,
ignoring the app-level `checkinTiming` / `checkinContent`. The pace step also
stands in for directiveness in those modes, since the guidance slider is hidden.

## Session timer

`session-timer.ts`, with the UI clock in `ui/src/session-clock.ts`. The
countdown is UI; what makes it a *meditation* timer is that the facilitator
lands it in voice.

Two synthetic `[Timer: …]` event turns ride the smart-check-in path (event turn
→ one short reply → canned fallback):

- **Approach notice.** Its lead (`timerApproachLeadSec`) scales with the sit
  and with the running average turn length, so it can't fall inside a silence.
  The model may `[PASS]` here.
- **Completion notice.** Never `[PASS]`. The one thing that fires **inside
  `[HOLD]`**, and it puts the hold back afterwards (`restoreHoldAfterNotice`),
  since a timer that silence mode can suppress isn't one.

Both wait for a turn boundary rather than barging in. A notice takes an LLM call
to compose, so `SessionClock.armGeneration` lets the view drop one whose timer
was cancelled or extended meanwhile, and `requeue` hands back one the meditator
talked over, so it is said at the next turn boundary instead of lost.

A spoken event enters the session log as an `'event'` control entry
(`SessionManager.addControlMessage`); `spokenExchanges` keeps it out of
transcripts (`isSyntheticEventTurn` still catches ones saved before `kind`). A
`[PASS]`ed event is never logged.
`parseSmartCheckinReply` / `runSmartCheckin` take a `maxChars` so a closing word
can run longer than a check-in.

Settings: `sessionClockMode`, `sessionTimerMin`, `showSessionClock`,
`endSessionOnTimer`. Hiding the readout never disarms the timer, and
`endSessionOnTimer` (default off) ends the sit only *after* the closing word
has been spoken.

# Pacing: check-ins and the session timer

`PacingController` (`ts/src/facilitation/pacing.ts`) times the turn from three
timestamps (last speech, last response, hold start): respond once the response
delay has passed, check in after a silence interval, stay quiet in a hold.
This doc covers what a check-in says, when it fires, and the meditation timer
that uses the same path. Silence holds themselves: [silence-mode.md](silence-mode.md).
The requests the app sends while a sit is quiet to keep the prompt cache warm,
which nobody hears: [ts-server.md](ts-server.md#prompt-cache-keep-alive).

## Check-ins

Content and timing are separate settings (`checkinContent`, `checkinTiming`).

**Content** is a canned (non-LLM) phrase, or "smart" (`smart-checkin.ts`): the
LLM gets the session plus a bracketed silence-event turn and offers one short
line in context, or replies `[PASS]` to keep quiet. Unusable replies fall back
to the canned pool. How much the line may steer follows the guidance slider
(`CheckinSuggestion`): presence only at Following; from Somewhat following
through Somewhat directing the model's call, presence or a suggestion (the way
in for someone who doesn't know what to do; check-ins are minutes apart, so
it isn't overbearing); at Directing a suggestion or observation is expected.
The canned pool is presence only at every level.

**Timing** is a fixed interval, or "smart": the LLM prefixes `[WAIT:Nm]`
(parsed with the other turn signals) to set how long the next silence stays
protected, clamped and held by `PacingController.setCheckinInterval`. The
default wait is biased by the guidance slider (`waitBiasFragment` /
`defaultWaitSeconds`: 12m / 5m / 3m / 90s / 30s across guidance levels 1 to 5),
so high guidance means short waits. The default only seeds
the model's `[WAIT]`s: the model scales its own off it and usually sets a
longer one when it passes.

Two guards on the smart path (`views/session.ts`):

- After `SMART_CHECKIN_MAX_PASSES` (2) consecutive `[PASS]`es, the next due
  check-in speaks a canned line instead of giving the model another chance to
  stay quiet.
- The streak cap (`SMART_CHECKIN_MAX_STREAK`) remains the walk-away backstop.

A pass leaves no trace in the conversation, so the event turn is all the model
knows about the stretch, and it has to be true. A pass restarts the wait but not
the silence clock (`PacingController.onCheckinDeferred`), so the next event
reports the whole quiet; and its "checked in N times already with no reply"
counts spoken check-ins only. Counting a pass there turned a spoken line into a
pass with a long `[WAIT]` every time (measured on the default model,
`meditation-pal-v85a`).

The event also says when the model passed at the last one, and then holds a
second pass to a higher bar: "Stay quiet again only if they asked for silence
or for space" (`passedSecAgo`). Without it the model reads the same transcript
and passes again every time, so the choice was two passes or none; with it, a
meditator who simply trailed off gets one pass and then a short line.

`?debug=checkin` shows all of this live (see the cheatsheet's dev URL params).

### Modes that own their check-ins

A `checkinPaceSlider` mode (felt sense) has its own toggle and pace slider in
the setup panel (`SessionSetup.feltSenseCheckins`, default on). `views/session.ts`
derives timing from those (`smart` / `none`) and forces content to `smart`,
ignoring the app-level `checkinTiming` / `checkinContent`. The pace
(`SessionSetup.feltSensePace`, 1 to 5 like the guidance level) also stands in
for directiveness in those modes, since the guidance slider is hidden.

## Session timer

`session-timer.ts`, with the UI clock in `ui/src/session-clock.ts`. The
countdown is UI; what makes it a *meditation* timer is that the facilitator
speaks it naturally.

Two synthetic `[Timer: …]` event turns go through the smart-check-in path (event turn
→ one short reply → canned fallback):

- **Approach notice.** Its lead (`timerApproachLeadSec`) scales with the sit
  and with the running average turn length (at least 1.3 turns, at most a
  third of the sit), so it is not still waiting for a turn to end when the
  completion notice overtakes it (`SessionClock.timerDue` drops an approach
  not yet said when the time is up). The model may `[PASS]` here.
- **Completion notice.** Never `[PASS]`.

Both fire **inside `[HOLD]`**: the timer's poll is deliberately not gated on
silence mode (`timerPoll` in `views/session.ts`), and either notice puts the
hold back afterwards (`restoreHoldAfterNotice`), since silence mode must not be
able to suppress the timer. In a hold the approach notice can still `[PASS]`;
the completion notice always speaks.

Both wait for a turn boundary rather than barging in. Pacing only sees finished
turns, so a check-in or notice also holds while the recognizer reports the
meditator mid-turn (`SttEngine.userSpeechActive`: live speech on the PCM
engines, local Whisper and aloud cloud; unsubmitted text on Web Speech and the
native recognizer, plus an Android `started` alone for
`STARTED_WITHOUT_TEXT_MS`). A notice takes an LLM call
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

## First sit

"Try right now" on the first-run welcome card (`tour/index-guide.ts`) starts a
one-off exploration session built by `firstSitSetup` (`ui/src/first-sit.ts`).
It bends three of the rules above for that session only, and saves none of it:

- The opener explains the format before the invitation
  (`buildOpenerPrompt`'s `firstSit`).
- The default smart wait is `FIRST_SIT_CHECKIN_WAIT_SEC`, not the guidance
  level's (`PromptConfig.checkinWaitSec`; `PromptBuilder.checkinWaitSeconds`
  feeds both the bias fragment and the pacing seed).
- The clock is seeded with a `FIRST_SIT_TIMER_MIN` timer. `views/session.ts`
  keeps it out of the saved settings until the meditator picks a mode or
  length of their own.

The sit queues a one-time "Shape your next session" card for the next visit to
setup (`markSessionStarted`), which is where the tour gets offered again.

## Noting

A noting circle has no check-ins. Its pace is how long each participant waits
before noting (`participantTurn` in `ui/src/views/noting-session.ts`): its own
seconds on Fixed timing, or on Adaptive the mean of the meditator's last five
turns, each timed from "Your turn" to the transcript (`userCadences`,
`adaptiveDelay`). The first round has only the meditator's first turn to go
on, and that one carries their settling in after the opener, so it waits
`FIRST_ROUND_HEAD_START_MS` (3s) less, never under `MIN_ADAPTIVE_DELAY_MS`
(1s, the shortest Fixed timing).

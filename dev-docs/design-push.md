# Design push before the mobile release

A one-day push, planned for just before Android goes to production (see
[store-submission-checklist.md](store-submission-checklist.md)), to be worked
together: Claude proposes and builds, the dev decides anything that's taste. It
came out of extracting aloud's design system from the code (2026-10-12, at
`3fe0a15`), which left a short list of fixes and five ideas. Ideas 1 and 2
have landed since; 3 to 5 are open.

The design system lives as a Claude artifact, private to the dev:
https://claude.ai/artifact/27SpopimjEKrgy4ANwjiXc. It holds the brand book, all
33 color tokens in both themes, the type scale, Knewave and the ☁ font, the app
icons and screenshots, and 18 components previewed with the app's own CSS.
[style.md](style.md) is still the source of truth; the artifact is the
consumable copy, and needs a re-sync when the tokens or components move.

## The one idea underneath

aloud is sound and silence, and nearly everything a potential user sees of it
is visual. The site sold a voice app with screenshots of a transcript until the
video went in, and the design system came out all eye too. Ideas 1 and 2 are
that gap; 3 and 4 are the threshold of a sit; 5 is copy.

## 1. Let people hear it first (done)

Landed as the whole promo video under the hero, not a 20-30 second clip:
`#film` in `docs/index.html`, loaded from YouTube on click. It is staying, so
nothing is left here for the day.

## 2. Give the ear a brand

Landed (2026-10-12, meditation-pal-lwkb) as five pairs to choose from rather
than one signature: an opening and a close for every session, picked in
Settings under Look and Feel (`AppSettings.signatureSound`, presets in
`ui/src/signature-sound.ts`). The opening starts once the session's mic is open (an
echo-cancelled mic opening mid-sound makes macOS drop the audio out for a
moment; `playOpening`) and
the facilitator's first words wait for it to end (`tts.speak` in
`views/session.ts`, the opener in `views/noting-session.ts`); the close plays
from each view's `endSession`. The nav orb gives the website orb's three pink
ripples with each (`ui/src/orb-pulse.ts`). None of them reads as a bowl or bell, so the
session frame and noting's turn cues don't blur. The default is `bloom`; two
friends preferred the ripples, so it may change. The candidates, the generator
and how each preset was arrived at are in `assets/promo/signature-candidates/`
(open `audition.html` there).

- Still open: the promo video opens and closes on `bowl-deep-long`.
- Bigger and optional: treat pacing as design tokens. The response delay, the
  silence before a check-in, the hold: documented and tuned with the care the
  colors get, maybe as a "Timing" family in the design system.

## 3. Setup that's quick for returning users

The brand is loud at the edges (wordmark, orb, the yellow-shadowed Begin) and
the middle of setup is a well-made preferences screen: about a dozen decisions
before a sit. First-timers get "Try right now" (`first-sit.ts`); returning users
see the whole screen every time.

- Lead with one line of last time's setup ("Exploration · body, emotions ·
  feeling good · 20 min · Leda") and Begin; the form opens behind "Change".
- The phone layout already half does this: `.customize-toggle` collapses focus
  and vibe behind a summary (`updateCustomizeSummary` in `views/setup.ts`).
- Assumption to check with the dev: most people sit the same way most days.

## 4. The price on the Begin button

"Begin Session (≈8☁/hr)" puts a running meter at the start of a meditation
(`updateSessionEstimate` in `views/setup.ts`). It's there for a good reason:
people should know the cost before they spend.

- Alternative: show the balance as time ("about 4 hours of sitting left",
  balance over the session's estimated rate), keep rates in the pickers where a
  choice changes the cost, and leave Begin plain unless the balance is low.
- Unresolved: a surprise bill is worse than a number on a button. Decide
  together; maybe try both on a phone.

## 5. Say the philosophy on the landing page

The most distinctive idea in the repo is in `src/facilitation/prompts.ts`
("Less effort, not more"): never tell anyone to focus harder or come back to
the breath; get curious about the wandering. Most guided meditation does the
opposite. The site's pitch ("a meditation facilitator that listens and
responds") says how it works, not what it believes. A line near the top that
says the stance. Copy changes run through the
[pre-release-checklist.md](pre-release-checklist.md) Part A.

## Keep: the hot pink

Hot pink and Knewave look odd for eyes-closed practice until you see where
they sit: loudest where the user isn't meditating yet (site, setup), nearly
gone where they are (a dimmed session, the orb). They promise play and feeling
good, which is what aloud is for. If anything, make that deliberate: let the
screen's chrome fade as a sit goes deeper (`kasina.ts` and `screen-dim.ts` are
the pieces that exist).

## For Claude, picking this up

- **This is a together day.** The dev asked to work these through with you, not
  to come back to them done. Bring each idea as something to look at (a clip to
  hear, a screenshot of a setup variant, two Begin buttons side by side) and let
  him call taste. Ideas 3 and 4 are the ones with real uncertainty; don't build
  either fully before he's seen a sketch.
- **A sensible order:** 5 is site-only; what is left of 2 is the video's
  sound; 3 and 4 change the setup screen and want a phone in hand, which
  fits a mobile release day. The small fixes found along the way are beads
  now (label `ui`: ceuv, roq6, 2khw, x81q, 53uq, g5qb); clear them first if
  they're still open.
- **What was a guess:** that returning users repeat their setup (idea 3), and
  that the price on Begin costs more calm than it buys trust (idea 4). Ask.
- **How the design system was built,** if it needs a re-sync after the push:
  tokens from the two token blocks at the top of `ts/ui/src/app-base.css` (dark
  is `:root` and goes first); `components/bundle.css` is `app-base.css` below
  those blocks plus `style.css` without its `@import`, with one change - the
  phone layout's `(max-height: 500px)` half is gated on `(hover: none)` so short
  preview frames render desktop. Previews are static copies of the views'
  markup, checked by rendering each in both themes with Playwright (Chromium is
  at `/opt/pw-browsers/chromium` in cloud sessions). The artifact type's own
  instructions (`artifact-type/reference/from-code.md` on the artifact) cover
  a re-sync: read what's there first, since the dev may have edited it on the
  page.

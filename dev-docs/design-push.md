# Design push before the mobile release

A one-day push, planned for just before Android goes to production (see
[store-submission-checklist.md](store-submission-checklist.md)), to be worked
together: Claude proposes and builds, the dev decides anything that's taste. It
came out of extracting aloud's design system from the code (2026-10-12, at
`3fe0a15`), which left a short list of fixes and five ideas. Idea 1 has
landed since; 2 to 5 are open.

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

The orb is the visual identity; nothing plays that role for the ear. Sounds
exist only in noting (`views/noting-session.ts`, `ts/ui/public/audio/`).
Exploration and felt sense start and end without one.

- One bowl strike to open a sit and one to close it, from
  `assets/promo/bowl-candidates/synth_bowls.py`. Probably a new pair rather
  than noting's `bowl.mp3`/`rin.mp3`, so the turn cue and the session frame
  don't blur.
- Hook points to check: session start after the mic pre-flight and before the
  opener's TTS; session end and the timer's completion notice
  ([pacing.md](pacing.md)). `audio-unlock.ts` primes the AudioContext on the
  Begin click, which a start sound needs.
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

## Fixes found along the way

Low priority, measured or traced in the code. File them as beads if they
aren't yet, then delete this section:

```sh
bd create "History: facilitator role label never gets its pink" --type bug --priority 3 --labels ui --description "views/history.ts renderTranscript() writes class=\"transcript-role \${ex.role}\", and a facilitator turn's role is 'assistant'. app-base.css only styles .transcript-role.facilitator (accent-text) and .transcript-role.user (warm-text), so in History 'You' is gold but 'Facilitator' falls back to plain text. Fix either side: map assistant -> facilitator in the template, or rename the selector to .transcript-role.assistant."

bd create "Settings Display preview never shows the theme you pick" --type bug --priority 3 --labels ui --description "views/settings.ts paintPreviewTheme() sets data-preview-theme on #text-scale-preview, but no CSS reads that attribute, so choosing 'Always light' from dark (or the reverse) leaves the style preview in the current theme. Setting data-theme instead should fix it with no new CSS: the token blocks are [data-theme=\"light\"] / [data-theme=\"dark\"] attribute selectors, so they re-declare every --bg/--text token for the preview's subtree. Check the .text-scale-preview background (--bg-primary) follows."

bd create "Contrast: four token pairs under WCAG AA" --type task --priority 3 --labels ui --description "Measured from the token values (WCAG 2 ratios): light --warm-text #b88114 is 2.5-3.4:1 on the grounds (it's used for the small 'You' label in History); dark --danger #c0503e is 3.2-4.1:1 as .btn-danger text (e.g. 'Delete' on --bg-secondary 3.9:1); light --success #4a8e5f is 2.9-3.9:1 ('Saved', update status); light --text-muted #756058 on --bg-card/--bg-dialog is 4.3:1 (hints inside peach modals). Everything else that carries text clears 4.5:1 in both themes. Smallest lightness-only moves (same HLS hue and saturation) that clear 4.5:1 on every ground including the peach card: light warm-text #815a0e (min 4.55), dark danger #cd7364 (4.51, reads a bit salmon - a more saturated red may suit better), light success #396c49 (4.54), light text-muted #715c55 (4.61, barely visible change)."

bd create "app-base.css: accent-ink contrast comment says 8.6:1, it's 6.4:1" --type task --priority 4 --labels ui --description "The comment on --accent-ink claims 8.6:1 on the dark fill (#a81050). Measured #ffeaf4 on #a81050 = 6.42:1 (and 5.21:1 on #c01560, which the comment has right). Still AA; just fix the number so nobody leans on the wrong margin."

bd create "style.css: .session-info-panel reads an undefined --bg-elevated" --type task --priority 4 --labels ui --description "style.css .session-info-panel background is var(--bg-elevated, var(--bg-secondary, #fff)); --bg-elevated is never defined, so it always lands on --bg-secondary. Either define the token (if a distinct raised surface was intended) or write var(--bg-secondary) directly."

bd create "CSS sweep: rules for markup the app no longer renders" --type task --priority 4 --labels ui --description "Selectors with no matching markup in the TS UI: .settings-welcome (+ h1), .setup-header h1, .setup-subtitle, .message.historical, .continuation-separator, .kasina-active .typing-indicator, .toggle-label, the fixed (non-.inline) .no-voices-banner with .toast-close; in style.css .transcript, #mic.listening, #text-form, .btn-end, .session-footer. Also JS toggles classes nothing styles: .modifier-toggle.selected (visual comes from :has(input:checked)), #begin-btn.btn-disabled, #voice-btn.disabled. Worth a grep-and-delete pass; confirm each against index.html and the views first."
```

## For Claude, picking this up

- **This is a together day.** The dev asked to work these through with you, not
  to come back to them done. Bring each idea as something to look at (a clip to
  hear, a screenshot of a setup variant, two Begin buttons side by side) and let
  him call taste. Ideas 3 and 4 are the ones with real uncertainty; don't build
  either fully before he's seen a sketch.
- **A sensible order:** 5 is site-only; 2 is a small code change and a sound
  to choose; 3 and 4 change the setup screen and want a phone in hand, which
  fits a mobile release day. Clear the fixes above first if they're still
  open; they're each small.
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
- **bd wasn't available in the cloud session** that wrote this (see
  [friction.md](friction.md)), which is why the fixes are commands here
  rather than beads.

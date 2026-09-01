# Pre-release checklist

Run this before cutting a release - or any time, by asking Claude to "run the
pre-release check". The goal: catch documentation and copy that's drifted out of
sync with code changes, plus other downstream consequences of a change.

Claude: work through both parts below against the current diff / recent changes.
Report what's stale and propose fixes; don't assume - grep and read the actual files.

## Part A - surface inventory (everywhere the product is described)

When the product's features, providers, platforms, branding, or behavior change,
check each of these still reflects reality:

- **`docs/index.html`** - hero copy, the modes section, provider list, the
  hero tagline/pun, **OG/Twitter metadata** (title, description, image - the
  meta description carries its own tagline, so it drifts from the hero), and the
  mobile-status platform line ("iOS and Android are in closed beta").
- **`docs/privacy/index.html`** - data-flow descriptions, provider examples,
  on-device claims, "last updated" date.
- **`docs/terms/index.html`** - anything the product now does with money or
  accounts: refunds, credit expiry, what deletion forfeits, "last updated" date.
- **`docs/delete-account/index.html`** - the account-deletion instructions Play
  requires (a public URL, reachable without the app). Must match what
  `identity.ts` actually does on delete, including the credit balance.
- **`docs/js/shots.js`** - the landing carousel's captions and image `alt` text.
  It describes the app screen by screen ("the session setup screen", "an
  exploration session"), so a renamed or restructured screen lands here too.
- **`docs/assets/aloud-screen-{light,dark}.webp`** + `aloud-session-{light,dark}.webp` -
  the four landing screenshots. **Generated**, not hand-made: re-run
  `node scripts/site-screenshots.mjs` (with `cd ts && npm run web:dev` up)
  whenever the setup or session UI changes, or the site shows a version of the
  app that no longer exists.
- **`docs/assets/aloud-share.png`** + `assets/share-card.svg` - the share-card
  tagline if the positioning/tagline changed. The PNGs are **generated**:
  `scripts/generate-share-cards.sh` re-renders the share card, the Play feature
  graphic and both video cards from their SVGs (needs Knewave installed).
- **`README.md`** - product description, modes, provider list, platform notes,
  tips, install instructions, screenshot reference. The **download links are
  expected to name the last published release**, not the one being cut - they're
  bumped after the release ships and its assets exist. A version behind is
  correct here; don't report it.
- **App Store / Play listings** - name, subtitle, description, keywords; especially
  the provider/feature claims and the mobile-provider caveat. The **draft copy is
  tracked** in `dev-docs/store-descriptions.md`; the live listings are in the
  consoles (App Store Connect / Play Console), so a change here means editing
  both - the file is the source, the console is the deploy.
- **Promo video** - `assets/store/video-title-card.*` / `video-end-card.*`
  (tagline + card copy) and `scripts/build-promo-video.sh`; rebuilt output must
  match current branding and claims.
- **`dev-docs/style.md`** - visual identity (orb gradient, color tokens, fonts) if
  branding changed.
- **`dev-docs/dev-cheatsheet.md`, `desktop.md`, `voice-barge-in.md`** - dev/build/feature docs.
  The cheatsheet's **dev URL params** table and **Developer mode** section drift
  fastest: a new `?param` or Settings → Developer switch belongs in both.
- **`CLAUDE.md`** - the architecture section (commands, modules, data flow,
  pacing/check-in behavior) and any conventions. It's the only agent-instruction
  file; if `bd` regenerates an `AGENTS.md`, that's tool scaffolding, not a
  surface to keep in sync.
- **App UI text** - settings labels and hints, the tour/onboarding wizard,
  check-in prompts, welcome/empty-state copy.
- **`ts/ui/src/i18n/zh.ts`** - the Chinese UI catalog. It is keyed on the
  **English string verbatim**, so *any* edit to an English `t()` string orphans
  its translation and silently reverts that string to English. Nothing in CI
  catches it: `t()` falls back by design and `tests/i18n.test.ts` only checks
  placeholder hygiene. After a copy change, grep the old English string in
  `zh.ts` and re-key it.
- **`ts/src/facilitation/language.ts`** - the zh twins of every canned pool
  (check-ins, openers, timer lines, felt-sense/noting pools) and the
  respond-in-Chinese prompt fragment. Same rule as the catalog: a new or
  reworded English pool entry needs its zh counterpart, in the same position
  (`localizePool` pairs by array identity, `pickTimerFallback` indexes by
  position). The zh strings are an unreviewed draft flagged for a native pass.
- **`ts/server/.env.example`** - comments describing config keys and defaults.
- **`THIRD-PARTY-NOTICES.md`** - if a vendored asset or bundled third-party
  component was added, removed, or upgraded.
- **Icons / assets** - `assets/app-icon*.svg` (each has a `-small` sibling; keep
  the pair in sync) and every raster off them. The rasters are **generated**:
  `cd ts && npx tauri icon ../assets/app-icon.svg`, then
  `scripts/generate-app-icons.sh` (`.icns`/`.ico`/`.png`, the Play + iOS store
  icons, the Android launcher set, and the sub-512px Tauri renders).
  **Four favicon copies are NOT covered by that script and are hand-copied**:
  `ts/ui/public/aloud.png` + `ts/ui/public/favicon.ico` (the app's favicon /
  apple-touch icon) and `docs/assets/aloud.png` + `docs/favicon.ico` (the
  site's). Check their dates against `assets/aloud.png` after any icon change.

## Part B - change → consequence matrix

- **Added/removed/renamed an LLM provider** → settings dropdown + provider routes,
  README provider list, site provider pills, privacy-policy examples, store-listing
  provider claims.
- **Added/removed a feature or mode** → README, site, store listings, CLAUDE.md
  architecture, and privacy policy *if it changes a data flow*.
- **Added/removed a hosted STT or TTS provider** → `.env.example` + the
  `ts-server.md` env table and audition table, `pricing/providers.ttsRateFor`
  and the estimate labels, and the **privacy policy's subprocessor list**
  (it names the voice/speech vendors, not just the LLM ones).
- **Edited any user-facing English string** → see `zh.ts` in Part A. The
  translation is keyed on the English text; changing the text un-translates it.
- **Changed platform support** (e.g. mobile ships) → the "coming soon" lines on the
  site, README platform notes, store listings, the desktop-vs-mobile provider caveats.
- **Rebrand / rename** → sweep every surface in Part A (name, repo URL, bundle id).
- **Changed visual identity** (orb gradient, colors, font) → `dev-docs/style.md`,
  the site CSS + app CSS (kept in sync), all icon/share-image sources, regenerate
  rasters.
- **Changed a default or config option** → the relevant defaults in `ts/src`
  (or `ts/server/.env.example` for server config), the settings UI, and any doc
  that quotes the value.
- **Changed data handling** (new network call, new stored data, new third-party
  service) → privacy policy + the App Store / Play data-safety answers.
- **Changed a pricing/estimate assumption** (`pricing/estimate.ts` profile, a
  model's rates, a new metered leg) → the ☁️ badges and the setup footer's
  session pill, the "what are ☁️?" explainer (`ui/src/clouds-explainer.ts`),
  the rate caveats in `ui/src/credit-rate.ts`, and any doc or site copy quoting
  a per-hour figure.

## Part C - keep this list current

- Did this change introduce a **new place** that describes the product (a new page,
  a new doc, a new marketing surface)? **Add it to Part A.**
- Did it introduce a new **class of ripple effect**? Add it to Part B.
- If a surface listed here was removed, delete its entry.

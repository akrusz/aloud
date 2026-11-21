# Pre-release checklist

Run this before cutting a release - or any time, by asking Claude to "run the
pre-release check". The goal: catch documentation and copy that's drifted out of
sync with code changes, plus other downstream consequences of a change.

Claude: work through the parts below against the current diff / recent changes.
Report what's stale and propose fixes; don't assume - grep and read the actual files.
Part D is a decision rather than drift: whether this release raises the oldest
app version aloud cloud serves.

## Part A - surface inventory (everywhere the product is described)

When the product's features, providers, platforms, branding, or behavior change,
check each of these still reflects reality:

- **`docs/index.html`** - hero copy, the modes section, provider list, the
  hero tagline/pun, **OG/Twitter metadata** (title, description, image - the
  meta description carries its own tagline, so it drifts from the hero), and the
  mobile-status platform line ("iOS and Android are in closed beta").
- **`docs/privacy/index.html`** - data-flow descriptions, provider examples,
  on-device claims, "last updated" date. "Who runs each aloud cloud model" is a
  table of every hosted facilitator, speech model and voice by who runs it,
  plus the background models, so a catalog change usually lands there. It
  says when the setup screen's mic closes by itself, and names what the **site** itself
  loads from a third party (today the YouTube video, on play only), so a new
  embed on a `docs/` page needs an entry here.
- **`docs/terms/index.html`** - anything the product now does with money or
  accounts: refunds, credit expiry, what deletion forfeits, "last updated" date.
- **`docs/delete-account/index.html`** - the account-deletion instructions Play
  requires (a public URL, reachable without the app). Must match what
  `identity.ts` actually does on delete, including the credit balance.
- **`docs/account/index.html`** - a redirect to the web app's Account page. The
  Android app names its address in plain text (`topUpHint` in
  `ts/ui/src/purchase-channel.ts`), so the page and that string move together.
- **`docs/support/index.html`** - the App Store support URL: contact, the mic
  (and iOS Speech Recognition) permission paths per platform, account links.
- **`docs/mobile-beta/index.html`** - how to join the Play closed test and
  TestFlight, the early-tester bonus, which modes need an account, the
  permissions, and the known gaps (a gap fixed, or narrowed to some setups,
  means an edit).
- **`docs/js/shots.js`** - the landing carousel's captions and image `alt` text.
  It describes the app screen by screen ("the session setup screen", "an
  exploration session"), so a renamed or restructured screen means updating this too.
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
  expected to name the last published release**, not the one being cut:
  `scripts/release.sh` rewrites them in its version-bump commit (stable
  releases only). A version behind is correct here; don't report it.
- **App Store / Play listings** - name, subtitle, description, keywords; especially
  the provider/feature claims and the mobile-provider caveat. The **draft copy is
  tracked** in `dev-docs/store-descriptions.md`; the live listings are in the
  consoles (App Store Connect / Play Console), so a change here means editing
  both - the file is the source, the console is the deploy. The same file holds
  the **TestFlight** texts (What to Test, Beta App Review notes), which name
  the sign-in methods, the modes and the Begin button.
- **Store screenshots** - **generated** by `node scripts/store-screenshots.mjs`
  (with `web:dev` up) into the gitignored `assets/store/screenshots/`, each
  with a captioned copy whose headline and line are `SHOTS[].caption` in that
  script. A setup, session or noting UI change, or a caption that no longer holds,
  means a re-run and a fresh upload to both consoles.
- **Promo video** - `assets/store/video-title-card.*` / `video-end-card.*`
  (tagline + card copy) and `scripts/build-promo-video.sh`; rebuilt output must
  match current branding and claims. The Play Store video's script lives in
  `assets/promo/play-video/script.md` (its lines are app voice and features on
  screen, so a renamed mode or changed flow means a script edit as well). The
  voices video has its own, `assets/promo/voice-video/script.md`, which names
  Harper and Ethan and quotes the picker's per-hour costs. The video is
  **built** from that script and films the real UI at phone size
  (`assets/promo/play-video/tools/`, steps in `assets/promo/README.md` →
  "Building the video"), so a script edit, a reworded opener it quotes, or a
  setup/session UI change means a rebuild and a fresh upload. The **site plays
  the same upload** (`#film` in `docs/index.html`), and a fresh upload is a new
  YouTube id: it is written there twice, beside the running time (the play
  link's `aria-label` and the caption), over a poster cut from the video
  (`docs/assets/aloud-film-poster.webp`).
- **`dev-docs/style.md`** - visual identity (orb gradient, color tokens, fonts) if
  branding changed.
- **`dev-docs/`** - dev/build/feature docs (index: `dev-docs/README.md`).
  The cheatsheet's **dev URL params** table and **Developer mode** section drift
  fastest: a new `?param` or Settings → Developer switch belongs in both.
  The build status in `store-submission-checklist.md` → "Where we are" (the
  Play versionCode, the TestFlight build) is **expected to trail** the release
  being cut: the mobile builds come after it (`release.sh` offers them at the
  end) and the dev uploads them, then updates the status. Leave it alone and
  don't report it.
- **`CLAUDE.md`** - the architecture section (commands, modules, data flow,
  pacing/check-in behavior) and any conventions. It's the only agent-instruction
  file; if `bd` regenerates an `AGENTS.md`, that's tool scaffolding, not a
  surface to keep in sync.
- **App UI text** - settings labels and hints, the tour/onboarding wizard,
  check-in prompts, welcome/empty-state copy.
- **`ts/ui/src/i18n/zh.ts`** and **`ts/src/facilitation/language.ts`** - the
  Chinese UI catalog and the zh twins of every canned pool. The catalog is
  keyed on the English string, so rewording English reverts it to English
  until re-keyed (`tests/i18n.test.ts` fails on the orphan). Pools pair by
  position, so a reworded English entry keeps its old translation and a new one
  needs its twin in the same slot (`tests/language.test.ts` checks lengths
  only). Detail in [language.md](language.md).
- **`ts/src/facilitation/voice-command.ts`** - `COMMAND_LINES`, what the app
  says back after a spoken command. These carry their **zh inline** (`zhOr`),
  not through `registerZhPool`, because most of them take a number; a new
  command's acknowledgment needs both languages written here. Its `help` line
  is a *sample* of the commands, and the full list lives in the session info
  panel - keep the two honest about what actually exists.
- **`ts/src/facilitation/setup-lines.ts`** - `SETUP_LINES`, what the setup
  screen says out loud, en and zh inline: the answers to spoken requests, the
  `help` line, and the spoken tour, which describes each mode and the commands
  it takes. A renamed mode, a changed tab order or a new command can make a
  tour line wrong. Each line is also a **generated** clip per house voice
  (`ts/ui/public/voice-clips/`, manifest `ts/ui/src/voice-clips.json`); see
  "Edited a spoken setup line" below.
- **`ts/ui/src/voice-command-hints.ts`** - the one-time status-line nudges that
  teach the commands ("You can just say …"). A command that loses its by-hand
  control, or a reworded command, goes here too.
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
- **Opening and closing sounds** - `ts/ui/public/audio/signature/`, one
  `<preset>-open.mp3` and `<preset>-close.mp3` per pair in Settings → Look and
  Feel. **Copies**, not sources: each is a render out of
  `assets/promo/signature-candidates/` (`synth_signature.py`), and that
  directory's README → "Chosen" says which candidate each preset is. A
  re-render reaches the app only when its file is copied over.
- **`LICENSE-EXCEPTION.md`** → "Trademarks" - names what is withheld as a
  brand (the name, the wordmark, the orb, the app icons, the signature sounds).
  The terms page's "License and open source" section says the same in a
  sentence, so a new brand asset belongs in both.

## Part B - change → consequence matrix

- **Added/removed/renamed an LLM provider** → settings dropdown + provider routes,
  README provider list, site provider pills, privacy-policy examples, store-listing
  provider claims.
- **Added/removed a feature or mode** → README, site, store listings, CLAUDE.md
  architecture, and privacy policy *if it changes a data flow*. A new mode also
  joins an STT pick (`ModeSpec.sparseSpeech`), which sets its mobile default
  recognizer and so whether it needs an account (`docs/mobile-beta/`, the store
  review notes).
- **Added/removed a hosted STT or TTS provider** → `.env.example` + the
  `ts-server.md` env table and audition table, `pricing/providers.ttsRateFor`
  and the estimate labels, and the **privacy policy's "Who runs each aloud
  cloud model" table** (it names the voice/speech vendors, not just the LLM
  ones). A hosted STT model reaches the picker only through `HOSTED_STT` in
  `ui/src/adapters/stt-picker.ts` (its label, the languages it is offered in,
  a seed rate).
- **Added/removed/renamed a hosted voice** (`voice-catalog.ts`) → the privacy
  policy's model table names every hosted voice under its provider, so any
  voice in or out means an edit there. A `house` voice says its name in the
  tour, so renaming one also touches `formerly` on its entry (saved picks and
  older clients), `voice-names.ts` for a zh voice (what it is called, shown
  and heard as), the setup lines that carry the name and their clips, and
  `voice-commands.md`.
- **Added/removed/renamed an opening and closing sound** (`SIGNATURE_SOUNDS` in
  `ui/src/signature-sound.ts`) → its two files (the id names them; `PRESETS` in
  `assets/promo/signature-candidates/app_copies.py` writes them), the label's
  zh entry, the "Chosen" table in `assets/promo/signature-candidates/README.md`,
  and `design-push.md` where it names the default. A retired id needs no
  migration: `resolveSignatureSound` falls to the default.
- **Changed where barge-in works** (an STT backend, a platform, the iPhone's
  headphones check in `bargesInOnOwnStream`, a voice echo cancellation can't
  remove in `voiceEchoCancelled`) → the setup STT notes
  (`setup-stt-quality-note`, `setup-stt-iphone-note` in `ui/src/views/setup.ts`)
  and their zh, the known issue on `docs/mobile-beta/`, "Known and accepted"
  in `store-submission-checklist.md`, and `voice-barge-in.md`.
- **Added/removed/reworded a spoken command** → its ask in
  `voice-command-specs.ts` and a rerun of `npm run jev:commands` (the asks share
  one request, so any edit rescores all of them), `COMMAND_LINES` (English *and*
  the inline zh), the `help` sample, the session info panel's list, the
  `voice-command-hints.ts` nudge if it has a by-hand twin, and the command
  examples quoted in README, the site FAQ and the store description.
- **Added/changed a judge-free command** (`mute-command.ts`, `end-command.ts`,
  `begin-command.ts`: matched on the device, no judge) → its zh pattern in the
  same file, the info panel's no-judge Voice commands row (`views/session.ts`)
  and its zh, the noting circle's listen loop (`views/noting-session.ts`, which
  takes only these), README's "work everywhere" tip, `voice-commands.md`, and a
  rerun of `node ts/scripts/voice-loop-check.mjs`.
- **Added/changed something sayable on the setup screen** (`setup-command.ts`:
  a `SetupAction`, a phrase, a `HEARD_AS` entry; or the tour's words in
  `tour-command.ts`) → its zh pattern in the same file, `setupVocabulary`
  (what the recognizers are told to expect; never "begin"), the action in
  `ui/src/setup-actions.ts` and its outcome's line in `setup-lines.ts`, the
  Jev asks in `setup-command-specs.ts` and a rerun of `npm run jev:setup`,
  `npx tsx scripts/setup-voice/run.ts --summary-only` from `ts/` (local and
  free; commit the `misheard.ts` and `results/summary.txt` it rewrites, which
  `jev:setup` scores against), the read-aloud sheet in `manual-smoke.md`,
  and a rerun of `node ts/scripts/voice-loop-check.mjs`.
- **Edited a spoken setup line** (`SETUP_LINES` in `setup-lines.ts`, en or zh)
  → `npm run clips:render` (it renders only what changed and prices the run
  first; a line edited without it is silently not played on hosted voices),
  listen to anything it lists as suspect, commit the new clips with the
  manifest, and `npm run clips:check` before a release. The same
  after changing which voices are flagged `house` in `voice-catalog.ts`, or a
  house voice's `gainDb` (the render re-levels its clips from their files,
  free; until it runs and the server deploys, the setup screen and the
  session play that voice at different levels).
- **Changed when the mic listens** (e.g. voice control opening it on setup,
  before a session) → the iOS mic purpose string in `ios/App/App/Info.plist`
  (`NSMicrophoneUsageDescription`, today "to hear what you say", with no
  "when"; quoted in `mobile.md`; the desktop twin is `src-tauri/Info.plist`) and
  the privacy policy's "Where your data goes". **Changed how the setup mic
  closes by itself** (`setupListeningLimits` in `ui/src/voice-start.ts`) → that
  section's setup-screen paragraph and the Settings hint under "Voice control on
  the setup screen" (`views/settings.ts`) and its zh: both say when it sleeps.
- **Added or demoted a hosted model** (`pricing/providers.ts` `MODELS`) → the
  housekeeping list in that file's header. A curated model of the same line
  as a demoted or delisted one takes over its saved picks (`lineSuccessor` in
  `ui/src/model-picker.ts`), so decide `noAutoUpgrade`; any site or store copy
  naming models; the privacy policy's model table when a family, a background
  model or who hosts one changes; `evals/models.ts`.
- **Edited any user-facing English string** → see `zh.ts` in Part A. The
  translation is keyed on the English text; changing the text un-translates it.
- **Changed platform support** (e.g. mobile ships) → the "coming soon" lines on the
  site, README platform notes, store listings, the desktop-vs-mobile provider caveats.
- **Rebrand / rename** → sweep every surface in Part A (name, repo URL, bundle id).
- **Changed visual identity** (orb gradient, colors, font) → `dev-docs/style.md`,
  the site CSS + app CSS (kept in sync), all icon/share-image sources, regenerate
  rasters. The ☁ credit glyph carries the logo's colors baked into its font
  (`ts/ui/src/assets/aloud-cloud.woff2`): change them in
  `scripts/cloud-glyph-font.py` and rerun it.
- **Changed a default or config option** → the relevant defaults in `ts/src`
  (or `ts/server/.env.example` for server config), the settings UI, and any doc
  that quotes the value. The smart check-in waits (`defaultWaitSeconds`) are
  also quoted to users, as minutes of silence at the low and high ends: the
  guidance info panel (`info-guidance` in `ui/src/views/setup.ts`) and its zh
  twin.
- **Changed where ☁ are sold** (`purchaseChannel()` in
  `ui/src/purchase-channel.ts`, a new payment method, store billing) → every
  string that tells someone to buy, shown or spoken, on a build that can't
  (`billing-messages.ts` and its server twin `CANNED_MESSAGES`,
  `describeCloudError`, the out-of-clouds dialogs), `topUpHint` +
  `docs/account/`, the terms' payment paragraph, the "Buying ☁" section of
  `store-submission-checklist.md`, and the Play "App access" text.
- **Changed data handling** (new network call, new stored data, new third-party
  service) → privacy policy + the App Store / Play data-safety answers.
- **Added/changed a free grant** (the connect grant, the beta bonus) → the
  thank-you dialog (`ui/src/sign-in-thanks.ts`) and its zh, the store
  description's free-credit sentence, and, if it records new grant keys
  (`grant_keys`, kept after deletion), the privacy policy's "Abuse prevention"
  and retention lines and `docs/delete-account/`.
- **Changed what a judge request carries** (`judgeState`, `JudgeContext`) → the
  privacy policy's "Voice commands and background functionality" says exactly what the check
  is shown, separately for aloud cloud and for opt-in / own-key sessions, and
  so does the in-app consent line (`VOICE_COMMANDS_CONSENT`).
- **Changed which store age tiers block, or what the age range is used for**
  (`tierFromReading`, `isBlockingTier` in `ui/src/age-tier.ts`) → the privacy
  policy's "Children" paragraph, the block screen's copy (`views/age-block.ts`)
  and its zh, `age-tier.md`, the terms' age paragraph, and the consoles'
  rating and target audience.
- **Added a stored pick, a setup field or a one-time flag** → its area in
  `ui/src/settings-reset.ts`, or the list of what a reset keeps, and
  `tests/settings-reset.test.ts`, which checks named keys only, so a new flag
  slips past it.
- **Changed a pricing/estimate assumption** (`pricing/estimate.ts` profile, a
  model's rates, a new metered leg) → the ☁ badges and the setup footer's
  session pill, the "what are ☁?" explainer (`ui/src/clouds-explainer.ts`),
  the rate caveats in `ui/src/credit-rate.ts`, and any doc or site copy quoting
  a per-hour figure.

## Part C - keep this list current

- Did this change introduce a **new place** that describes the product (a new page,
  a new doc, a new marketing surface)? **Add it to Part A.**
- Did it introduce a new **class of ripple effect**? Add it to Part B.
- If a surface listed here was removed, delete its entry.

## Part D - minimum client version

`MIN_CLIENT_VERSION` in `ts/server/src/min-client-version.ts` holds the oldest
app version aloud cloud still serves, per platform (desktop, Android, iOS;
`0.0.0` is none). A build below its platform's minimum gets a blocking "Time to
update" screen at load and at Begin (`ts/ui/src/update-gate.ts`). The web app
has none: it is always the last release. A raise ships with this release's
server deploy. `scripts/release.sh` asks the pre-release check for a
recommendation and applies it once the developer confirms; this part is what
the recommendation rests on.

**Default: no change.** Raise a platform only for one of these, and say which:

- **A breaking change**: the server in this release no longer serves older
  builds correctly (a field, route or behavior they depend on is gone or
  reshaped). The contract is meant to stay backward-compatible, so this is
  rare and usually a mistake to fix instead.
- **A cost saving older builds miss**: a client fix that cuts what a session
  bills by a meaningful share, about a fifth or more for the people it
  affects, or that stops a build paying for work it repeats. The builds from
  before 2026-09-22 re-sent growing audio and billed desktop users for speech
  recognition several times over: that is the bar.
- **A judgment call**: anything else that makes an old build harmful to keep
  running (a privacy, safety or data-loss fix). Spell out why.

**Which version, per platform.** The oldest version that has the fix (or
speaks the new server), not simply the newest one:

- **Desktop** may go as far as the version being released. A desktop build
  blocks only once the updater offers a version at or above the minimum, so
  the minutes before the release's bundles exist strand nobody.
- **Android and iOS** may go only to a version already live in that store
  (Play's track, TestFlight, later the App Store: "Where we are" in
  [store-submission-checklist.md](store-submission-checklist.md)), never to
  the version being released, which no phone can install yet. Phones trail.
  Each release also asks whether a phone can now catch up to a cutoff desktop
  got earlier. When a phone raise has to wait for a build to go live, file a
  bead for it (the platform, the version, the reason).
- Never lower a minimum, and leave it alone on a prerelease: the script
  refuses the first and skips the step for the second.

**The reply ends with** a line `Minimum versions:`, two to four plain lines of
reasoning, and a last line `MINVERSION: none`, or `MINVERSION:` with only the
platforms to raise (`MINVERSION: desktop=2.21.0 android=2.17.0`). Don't edit
the file: the script shows the reasoning and the change, asks (Enter is yes),
then writes and commits it ahead of the version bump
(`scripts/lib/min-version.sh`).

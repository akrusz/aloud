# Development Cheatsheet

The commands you need to run, test, build, and release aloud - a TypeScript +
Rust stack under `ts/`. **Command quick-reference only.** For the architecture
(the two TS/Rust stacks, the `/app/v1` vs `/cloud/v1` split, data flow) see
[CLAUDE.md](../CLAUDE.md); for build/signing detail, [desktop.md](desktop.md);
for the iOS/Android (Capacitor) build, [mobile.md](mobile.md); for the hosted
server, [ts-server.md](ts-server.md).

## Running

All `npm` commands run from `ts/`. The root `package.json` delegates the common
ones, so `npm test`, `npm run typecheck`, `npm run ui:dev`, `npm run web:dev`,
`npm run tauri:dev`, and `npm run test:server` also work from the repo root.

### Desktop app (Tauri) - the primary dev target

```bash
cd ts && npm run tauri:dev       # desktop shell only
cd ts && npm run desktop:dev     # desktop shell + Hono server (:8787) together
```

`tauri:dev` starts Vite (UI on **:4649**) + compiles and runs the Rust shell. The
shell's embedded backend serves `/app/v1/*` on a loopback port.
For hosted features (accounts/credits/hosted voices) the Hono server must also be
running; without it, `/cloud/v1/*` calls fail with `ECONNREFUSED` and the UI
degrades to "hosted unavailable" (expected, harmless). `desktop:dev` is the
Tauri analog of `web:dev`: it runs the shell + Hono in one terminal so hosted
features resolve. Both combined launchers go through `scripts/dev.mjs`: a single
Ctrl-C stops everything, and if either side exits on its own (e.g. you close the
Tauri window) the other is torn down too.

### Web UI in a browser (Vite)

```bash
cd ts && npm run web:dev         # UI (:4649) + Hono server (:8787) together
cd ts && npm run ui:dev          # UI only (:4649) - needs the Hono server too (below)
```

`web:dev` runs both in one terminal (one Ctrl-C, or either side exiting, stops
both - see `scripts/dev.mjs`); use it for browser preview so
STT/voices/providers/billing resolve.

The Vite proxy (`ui/vite.config.ts`) forwards:
- `/app/v1/*` → **Hono** on :8787 (the app-backend surface; no rewrite - Hono
  speaks `/app/v1` natively).
- `/cloud/v1/*` → **Hono** on :8787 (same server; hosted accounts/credits/proxy).
- `/ollama/*` → local Ollama daemon on :11434.

So with `ui:dev` alone, start Hono separately (`npm run server:dev`) and load
:4649.

### Phone dev over USB (chrome://inspect port forwarding)

To run the browser preview on a real phone (the mobile *web* path, not the
Capacitor app): `npm run web:dev` on the laptop, plug the phone in, open
`chrome://inspect#devices` in desktop Chrome, and add a port-forward rule
`4649 → localhost:4649`. Then load **`http://localhost:4649`** on the phone.

- **Use `localhost`, not the LAN IP.** `getUserMedia` (and SpeechRecognition)
  only works on a secure origin; `localhost` counts, `192.168.x.x` over plain
  http does not, so the LAN URL gives you an app with no mic.
- One rule is enough: the phone hits Vite, and the Vite proxy carries `/app/v1`
  and `/cloud/v1` to Hono on :8787 on the laptop.
- **The tell that the tunnel dropped**: everything cloud-shaped fails at once
  (voice preview *and* sign-in *and* the catalog) with `Failed to fetch`, while
  the chrome://inspect UI still shows the mapping as active. That is the
  forward, not the app - re-plug or toggle the rule, don't debug auth.
  Cheapest check: load `/cloud/v1/tts/preview?voice=Leda` on the phone
  directly - audio means the tunnel is up.
- The same chrome://inspect page gives you DevTools on the phone's tab
  (console, network) for either the browser preview or the Capacitor WebView.

### Dev URL params

Boot-time overrides, all read off `:4649/?…`. Every one is **dev-only** - gated
on `import.meta.env.DEV`, so `vite build` dead-code-eliminates them and a
deployed visitor can't use them (e.g. to unlock Ollama/BYOK on the hosted site).

| Param | Effect | Read in |
|---|---|---|
| `?mode=web` | Force **web** mode: the hosted demo - Ollama/claude-proxy hidden, BYOK behind a settings checkbox, aloud cloud the default. | `app-mode.ts` |
| `?mode=local` | Force **local** mode: every provider (Ollama + claude-proxy + BYOK + aloud cloud). | `app-mode.ts` |
| `?mode=auto` | Clear the override, back to the build default. (Overrides persist in sessionStorage, so they survive navigation until cleared.) | `app-mode.ts` |
| `?slowboot=<ms>` | Hold the boot orb on screen `<ms>` *before* the first view mounts, so you can eyeball the real loading state (static nav + orb, empty content). On localhost boot is otherwise a blink. | `bootApp` in `app.ts` |
| `?nomic=<status>` | Simulate a broken mic - `denied`, `no-device`, `no-api`, or `error`. Sticky for the tab; `?nomic=off` clears it. Same switch as Settings → Developer → **Simulate failures → Microphone**. | `mic-check.ts` |
| `?sim=<fault>` | The rest of the simulated failures: a cloud error code (`insufficient_credits`, `unauthenticated`, `email_unverified`, `quota_exceeded`), a recognizer fault (`service-not-allowed`, `network`, `not-allowed`, `whisper-503`), or `no-voices`. `?sim=off` clears all four (mic included). | `dev-sim.ts` |
| `?soak=1` | Arm the tier-2 soak tap: the session view publishes structured turn/event/LLM records for the Playwright driver to read (holds, classifier routes, echo drops, timer events - none of which the DOM shows). Set by `npm run soak:web`, not usually by hand. See [soak-harness.md](soak-harness.md). | `soak-tap.ts` |

The mode build-default keys off the *environment*, **not** whether a cloud URL
was baked in - aloud cloud ships in every build, so its presence can't signal
"web". Desktop shell + dev server are `local`; a production browser build
(website / mobile webview) is `web`. `?mode=` lets you keep both open in two
tabs with no rebuild.

To see the **failure-to-load** state (orb pulses forever) there's no param:
block the JS bundle in DevTools → Network → Block request URL, or set Network
to Offline, before reloading.

**Preview the "update available" flow** - `?previewUpdate`, or (handy inside the
Tauri webview, where there's no URL bar) Settings → Developer → **Preview update
banner**. Either forces the whole update path without a real release: the brand
lights up the nav "Update" pill + mobile More entry, and the About box renders
the install button - a simulated, non-relaunching download in the desktop shell,
the releases link in a browser. A bare flag pretends one patch above the running
build; `?previewUpdate=2.0.0` sets the version verbatim. Unlike the params above
this one is **not** DEV-gated - deliberately, so you can preview inside a bundled
desktop debug build (`scripts/dev-bundle.sh`), which is the only place the real
updater button runs.

The URL param persists in **sessionStorage** (a plain reload keeps it; close
the tab to clear it), the settings field in **localStorage**
`aloud:previewUpdate` until you empty the field. Read in `about.ts`
(`previewUpdateVersion`).

**Check-in / [WAIT] debug HUD** - `?debug=checkin` (also `1`, `pacing`) mounts a
fixed monospace readout in the session view: active timing/content modes, the
effective check-in interval (+ override marker), a countdown, and a rolling log
of `[WAIT]` signals and check-in outcomes. Not DEV-gated (like `previewUpdate`),
so it works in bundled builds too. Read in `dev-mode.ts` (`isCheckinDebugOn`).

### Developer mode (hidden settings section)

The desktop webview has no URL bar, so the params above get a settings home:
tap the **version line in the About box 7 times** to toggle developer mode
(`dev-mode.ts`, persisted in `localStorage aloud:devMode`; the version line
grows a `· dev` marker). Settings then shows a **Developer** section: the
check-in debug HUD toggle and the update-preview banner everywhere, plus - in
dev builds only, same compile-time gate as the params - the `?mode=` override
and the `?dev` cloud sign-in bypass. Invisible to anyone who just installed
the app.

Two experiment switches also live there with no URL twin:

- **Cloud mic without echo cancellation** (`isAecOffDebug`, `dev-mode.ts`,
  localStorage `aloud:debugAecOff`) opens the next session's PCM capture with
  `echoCancellation: false` - the Android call-stream measurement; judge it by
  the `[vad] tts window` lines.
- **Jev silence classifiers** (`getJevClassifierMode`, `dev-mode.ts`,
  localStorage `aloud:jevClassifiers`), aloud cloud sessions only, read at
  session start: `on` (default) lets Jev decide with the LLM classifier as
  fallback, `shadow` runs both and acts on the LLM - for measuring a question
  change - and `off` is the LLM alone. Every call prints a `[judge]` line.
  `off` drops the judge for the whole session, so it takes the spoken
  commands with it (they have no LLM twin); `shadow` keeps them. The override
  is the hosted rollout only - a BYOK/local sit that opted in gets the judge
  regardless. See [silence-mode.md](silence-mode.md).

Dev mode is also what turns the diagnostic console lines on in a release build
(`diag()`, `ui/src/diag.ts`): `[vad]`, `[stt-cost]`, `[stt-native]`, `[judge]`,
`[command]`. Dev builds always print them. They carry character counts, never
transcript text. Failures stay on `console.warn`/`error`, which is what the
bug-report block records.

#### Simulate failures (dev builds)

The same section carries four switches for states that are painful to reach on
purpose - a broken **microphone** (`mic-check.ts`, also `?nomic=`), a
**speech recognizer** that only errors, an **aloud cloud** that fails the LLM
and TTS legs (including `insufficient_credits`, which drives the spoken apology
and buy prompt), and an **empty voice catalog**. Each is injected at the real
seam (`dev-sim.ts`, wired in `stt-picker.ts` / `tts-picker.ts` / `voices.ts` /
`buildProvider`), so the handling under test is the shipping handling. All four
live in sessionStorage, reset when the tab closes, and raise a banner while any
is on.

### Hosted server (Hono)

```bash
cd ts/server && npm run dev      # :8787, watch mode
```

Boots with in-memory stores + stubs in dev (no secrets required). Config comes
from `ts/server/.env` - copy `ts/server/.env.example` and fill what you need.
Deeper operational notes: [ts-server.md](ts-server.md).

#### Granting yourself credits (dev)

The dev server has its own ledger (`ALOUD_DB_PATH` in `ts/server/.env`,
`.data/aloud-dev.db`) - balances there are separate from production. To top up
an account, use the admin panel at <http://localhost:8787/cloud/v1/admin>
(paste `ALOUD_ADMIN_TOKEN` from `ts/server/.env`, then the "Grant credits"
form), or curl the same endpoint. If the panel 404s, the token is unset in
`.env` - admin is disabled without one. Generate (`openssl rand -hex 32`),
fill it in, restart the server.

```bash
curl -X POST http://localhost:8787/cloud/v1/admin/grant \
  -H "Authorization: Bearer $ALOUD_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "credits": 100}'
```

Works against production too - swap in the fly.dev origin and its token. Full
admin surface: [ts-server.md](ts-server.md).

### Ports at a glance

| Port | Who |
|------|-----|
| 4649 | Vite UI - both `tauri:dev` and `ui:dev` |
| 8787 | Hono server - both `/cloud/v1` and `/app/v1` (the `ui:dev` `/app` + `/cloud` proxy target) |
| 11434 | Ollama daemon |

## Tests & checks

```bash
# Everything CI gates, from the repo root
npm run typecheck                     # core + UI *and* the server (see below)
npm test && npm run ui:build && npm run test:server

# TS core + UI (vitest) and typecheck
cd ts && npm test
cd ts && npm run typecheck            # tsc over src/ + ui/ ONLY - not the server

# Hosted server
cd ts/server && npm test
cd ts/server && npx tsc --noEmit -p tsconfig.json

# Rust shell
cargo check --manifest-path ts/src-tauri/Cargo.toml
cargo test  --manifest-path ts/src-tauri/Cargo.toml     # network round-trips are #[ignore]
(cd ts/src-tauri && cargo deny check)                   # supply-chain gate (CI enforces)

# Model evals (by hand, NOT in CI - real API calls; see ts/evals/README.md)
cd ts && npx tsx evals/protocol-eval.ts

# Jev scoring (by hand, NOT in CI - real TypeSafe calls, a few cents). Rerun
# after touching a judge question, example or threshold.
cd ts && npm run jev:ab                # silence classifiers vs the Haiku prompts
cd ts && npm run jev:commands          # every spoken-command ask, through the gate

# Soak harness (by hand, NOT in CI - an LLM plays the meditator through whole
# sessions; see dev-docs/soak-harness.md). Run before a release.
npm run soak -- --battery=pre-release  # the release check; report in ts/soak-runs/
npm run soak -- --battery=smoke --baseline=last   # quick, vs the previous run
npm run soak:web                      # tier 2: real UI, real audio (needs
                                      # `npm run web:dev` + BlackHole + Chrome)
```

Then the by-hand pass: **[manual-smoke.md](manual-smoke.md)** - the desktop
shell, permission refusals, real speakers, and phones, none of which the soak
tiers can reach.

**Dependency PRs mostly merge themselves.** Dependabot groups minor+patch into
one weekly PR per ecosystem (`.github/dependabot.yml`), and
`.github/workflows/dependabot-automerge.yml` squash-merges a Dependabot PR once
every check that actually ran is green. Majors stay ungrouped and wait for you -
as does anything red or still pending. Nothing ships from a merge: deploys are
release-gated.

## Building & releasing

```bash
cd ts && npm run tauri:build          # signed/notarized desktop bundle (DMG / MSI+NSIS / AppImage+deb)
```

**Iterating on bundle-only behavior** (the minimal GUI PATH, the app icon, DMG
art - anything `tauri:dev` can't reproduce because it inherits your terminal's
PATH/env): don't round-trip through a GitHub release. Build a debug bundle
locally and launch it through LaunchServices, which gives the app the same
minimal environment as double-clicking the installed app:

```bash
scripts/dev-bundle.sh                 # debug .app build + `open` (reads ~/.tauri key, prompts once)
```

Most work doesn't need this - `tauri:dev` runs the real Rust backend + UI with
hot reload, so providers/modes/About/voices/STT all iterate instantly there.
Reach for `dev-bundle.sh` only for bundle-launch-specific bugs, and GitHub RCs
only as the final "does the signed, shipped artifact work" gate.

Landing-page screenshots are generated, not hand-taken - so they're the same
size and framing every time and cheap to redo when the UI changes. Four files:
the setup screen (`aloud-screen-{light,dark}.webp`) and an exploration session
(`aloud-session-{light,dark}.webp`), shown as a carousel by `docs/js/shots.js`.

```bash
cd ts && npm run web:dev                       # must be up: the shot needs /app/v1
node scripts/site-screenshots.mjs              # all four; --width 1000 by default
node scripts/site-screenshots.mjs --only session
```

It drives headless Chrome over CDP (no npm deps), tells the web UI to dress as
the desktop shell, and draws the macOS window chrome with ImageMagick. The
session shot's transcript is sample copy written into the DOM (`SAMPLE_TURNS`) -
a real exchange needs a mic, an LLM and a person; everything around it is the
live view. Change `--width` and update the `width`/`height` attributes on the
`<img>` in `docs/index.html` to match what it prints.

Release (bumps version, lints both stacks, tags, pushes, creates the GitHub
release that triggers CI):

```bash
scripts/release.sh                    # patch (default)
scripts/release.sh minor|major|1.2.3
scripts/release.sh rc                 # patch bump, marked --prerelease (RC / test build)
scripts/release.sh same               # re-release current version (moves tag)
scripts/release.sh redo               # re-release, same title (quick fix cycle)
```

`rc` builds are **prereleases**, so they stay off `/releases/latest` - the
updater endpoint - and never auto-update existing installs. Promote to a real
release (the non-prerelease that becomes `latest`) only once an RC checks out.

It bumps `ts/src-tauri/tauri.conf.json` (the version source of truth) +
`ts/package.json` in lockstep, lints TS (`typecheck`) + Rust (`cargo check` +
`cargo deny`), and offers the pre-release doc check
([pre-release-checklist.md](pre-release-checklist.md)). **Prerequisites:** clean
tree, `gh` authenticated.

Before the name prompt it drafts release notes from the commits since the last
tag (Claude reads the log + diffstat, not the whole tree). The suggested name is
the default at the prompt (`-` for no name), and the bullets become the release
body unless you pick `e` to edit them or `n` to write your own in gh's editor.
`same`/`redo` carry the published notes forward instead, since deleting and
re-creating the release would otherwise drop them.

The pre-release check fixes conservative drift itself and commits it as
`docs: pre-release sync` - dev-docs, README, CLAUDE.md, code/config comments,
perfunctory legal pages. Anything user-facing (app UI copy, marketing site
pages, LLM prompts) it only reports; at the gate, `f` opens an interactive
claude session in the same terminal with the punch list preloaded - fix and
commit together, then exit to resume the release. The script refuses to
proceed over an unclean tree, so a bailed-out fix can't ship half-done.

**CI**: publishing the release runs `tauri-release.yml` (desktop bundles for all
three platforms, signed updater artifacts) and `deploy-release.yml` (server,
then web app). Build/signing detail: [desktop.md](desktop.md); the deploy side:
[deploy.md](deploy.md).

### Mobile (Capacitor - iOS / Android)

```bash
cd ts
npm run cap:android:run  # ui:build + cap sync + Gradle build + install/launch on
                         # the connected device - no Android Studio. THE way to
                         # run the current code on a phone.
npm run cap:sync       # ui:build + cap sync (both platforms)
npm run cap:ios        # + open Xcode
npm run cap:android    # + open Android Studio
```

Rebuilding from *inside* Android Studio repackages whatever `cap sync` last
copied into `android/` - it never rebuilds `ui/dist` - so web-side changes only
reach the device through the `cap:*` scripts above.

**Play Store release bundle** (`cap:android:run` installs a debug APK; Play
uploads need the signed `.aab`):

```bash
scripts/android-aab.sh   # bump versionCode + sync versionName from package.json,
                         # ui:build + cap sync + gradlew bundleRelease
# → ts/android/app/build/outputs/bundle/release/app-release.aab
```

Pass `--no-bump` to rebuild the current version. Signing comes from the
gitignored `android/keystore.properties`; the script commits the `build.gradle`
version bump itself once the bundle builds (pathspec commit - a failed build
leaves it uncommitted), and prints the latest stable release's notes for Play's
"What's new" box. Full keystore/Play App Signing detail:
[mobile-signing.md](mobile-signing.md).

The mobile app wraps `ui/dist` in the OS WebView, runs in **web mode**, and
talks to aloud cloud (`VITE_ALOUD_CLOUD_URL` from the committed
`ts/ui/.env.production`). Adapters, native config and the patched speech plugin:
**[mobile.md](mobile.md)**.

## Config & environment

- **Hosted server**: `ts/server/.env` (see `.env.example`) - provider keys
  (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`,
  `GEMINI_API_KEY`; `OPENAI_API_KEY` also drives server STT by default, or the
  `STT_*` overrides), `GOOGLE_TTS_API_KEY`, `ALOUD_SESSION_SECRET`,
  `GOOGLE_CLIENT_IDS`, Stripe keys,
  `ALOUD_ADMIN_TOKEN`, and `ALOUD_UI_DIR` (serve `ui/dist` from the same process - the single-box self-host story).
- **UI build**: `VITE_ALOUD_CLOUD_URL` - the hosted origin baked into a
  static/desktop/mobile build so `/app/v1` + `/cloud/v1` resolve off-origin.
  Committed default in `ts/ui/.env.production` (production builds only; dev
  uses the Vite proxy); an env var / CI repo var overrides it.
- **Vite dev overrides**: `ALOUD_CLOUD_URL` (Hono - both `/app` and `/cloud`
  proxy targets), `OLLAMA_URL`.
- **BYOK keys** entered in the UI live in the device's localStorage; sessions
  call the provider directly. Only the model-list lookup relays one
  (`x-provider-key` to `/app/v1/models`), and nothing is persisted server-side.

## Adding a hosted model

The checklist lives as the comment above the `MODELS` table in
`ts/server/src/pricing/providers.ts` - read it before adding an entry. The
short version: check the endpoint's **caching policy first** (cacheRead drives
$/hr, not list price), run the rates through `estimate.ts`, list the real
OpenRouter endpoints and update the privacy policy's provider list, confirm
reasoning can be disabled, and ear-test the control tokens in a real session.

## Sessions

Web/mobile builds store session state in the browser (localStorage) via
`ts/src/platform/storage.ts`. The desktop shell instead writes one JSON file per
session under `<app-data>/sessions/`, through `/app/v1/sessions` and
`ui/src/adapters/backend-session-store.ts` (`BackendSessionStore`, wired in
`state.ts` only when `isTauri()`).

## Dev gotchas

- **UI strings are localized**: any user-visible literal in `ts/ui/src` goes
  through `t()` with a matching entry in `ui/src/i18n/zh.ts`; rewording English
  orphans the zh entry and `tests/i18n.test.ts` fails until it's re-keyed. See
  [language.md](language.md).
- **`/cloud/v1/*` `ECONNREFUSED` in `tauri:dev`** → the Hono server isn't
  running. Start `cd ts/server && npm run dev`, or ignore it for local-only work.
- **whisper.cpp's `whisper_model_load:` dump** is silenced
  (`whisper_rs::install_logging_hooks()` in `server.rs`); enable whisper-rs's
  `log_backend` feature to see those internals again.
- **`/app/v1` path differs by build**: desktop hits the Rust loopback directly
  (injected base); `ui:dev` proxies it to the Hono server on :8787. So a UI
  fetch that works in the browser preview but not in `tauri:dev` (or vice-versa)
  usually means the wrong backend is the one running.
- **No mic in a browser at :4649?** Whisper STT is **desktop-only** (the Rust
  loopback backend; Hono has no whisper route), so the picker only offers
  "Whisper (local)" under Tauri (`isTauri()` gate in `stt-picker.ts`).
  In a browser, STT falls to **web-speech** (Chrome/Edge only) or **aloud cloud**
  (needs the Hono server + sign-in). So a Chrome tab works out of the box;
  Firefox needs the Hono server running + a signed-in cloud session. Not iOS
  either: WebKit exposes `webkitSpeechRecognition` but can't drive the listen
  loop with it, so `isWebSpeechSupported` reports false there
  (`isIosWeb`, `is-desktop.ts`) and every iOS browser lands on aloud cloud.

## Licensing & third-party code

aloud is AGPL-3.0 (`LICENSE`) with an App Store distribution exception
(`LICENSE-EXCEPTION.md`). Anything **vendored** into the repo and shipped in the
bundles - currently the Silero VAD model at
`ts/ui/src/assets/silero_vad_op18_ifless.onnx` (MIT; provenance + upgrade notes
in `ts/ui/src/assets/README.md`) - needs an entry in `THIRD-PARTY-NOTICES.md`.
Declared npm/Cargo dependencies don't; the manifests cover those.

## Landing site

Static site in `docs/` (hand-written). Published to GitHub Pages as an
**artifact** by `.github/workflows/deploy-web.yml` (Pages source = "GitHub
Actions" - the old "serve `/docs` from a branch" mode is retired), which uploads
the whole `docs/` tree: marketing pages plus the built app at `docs/app/`.
Download buttons hit the GitHub `releases/latest` API at load, so no redeploy
per release.

**The two halves are on different clocks.** Marketing pages publish on every
push to `main` that touches `docs/`; the app is built from the **latest
published release**, and only a release (`deploy-release.yml`) moves it - after
the server deploy succeeds, so client and API ship together. See
[deploy.md](deploy.md#release-deploys-one-tag-ships-everything).

```bash
npx serve docs                        # serves docs/ on a printed localhost port
```

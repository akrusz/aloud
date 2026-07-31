# Development Cheatsheet

The commands you need to run, test, build, and release aloud - a TypeScript +
Rust stack under `ts/`. **Command quick-reference only.** For the architecture
(the two TS/Rust stacks, the `/app/v1` vs `/cloud/v1` split, data flow) see
[CLAUDE.md](../CLAUDE.md); for build/signing detail, [desktop.md](desktop.md);
for the iOS/Android (Capacitor) build, [mobile.md](mobile.md); for the hosted
server, [ts-server.md](ts-server.md).

## Running

All `npm` commands run from `ts/`.

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

So browser preview needs only the Hono server running (next section). Run
`cd ts/server && npm run dev` and load :4649.

### Dev URL params

Boot-time overrides, all read off `:4649/?…`. Every one is **dev-only** - gated on `import.meta.env.DEV`, so `vite build` dead-code-eliminates them and a
deployed visitor can't use them (e.g. to unlock Ollama/BYOK on the hosted site).

| Param | Effect | Read in |
|---|---|---|
| `?mode=web` | Force **web** mode: the hosted demo - Ollama/claude-proxy hidden, BYOK behind a settings checkbox, aloud cloud the default. | `app-mode.ts` |
| `?mode=local` | Force **local** mode: every provider (Ollama + claude-proxy + BYOK + aloud cloud). | `app-mode.ts` |
| `?mode=auto` | Clear the override, back to the build default. (Overrides persist in sessionStorage, so they survive navigation until cleared.) | `app-mode.ts` |
| `?slowboot=<ms>` | Hold the boot orb on screen `<ms>` *before* the first view mounts, so you can eyeball the real loading state (static nav + orb, empty content). On localhost boot is otherwise a blink. | `bootApp` in `app.ts` |

The mode build-default keys off the *environment*, **not** whether a cloud URL
was baked in - aloud cloud ships in every build, so its presence can't signal
"web". Desktop shell + dev server are `local`; a production browser build
(website / mobile webview) is `web`. `?mode=` lets you keep both open in two
tabs with no rebuild.

To see the **failure-to-load** state (orb pulses forever) there's no param:
block the JS bundle in DevTools → Network → Block request URL, or set Network
to Offline, before reloading.

**Preview the "update available" flow** - `?previewUpdate` (or, handy inside the
Tauri webview, a `localStorage` `aloud:previewUpdate` key) forces the whole
update path without a real release: the brand lights up the nav "Update" pill +
mobile More entry, and the About box renders the install button - a simulated,
non-relaunching download in the desktop shell, the releases link in a browser. A
bare flag pretends one patch above the running build; `?previewUpdate=2.0.0`
sets the version verbatim. Unlike the params above this one is **not** DEV-gated - deliberately, so you can preview inside a bundled desktop debug build
(`scripts/dev-bundle.sh`), which is the only place the real updater button runs.
Clear it by dropping the param or `localStorage.removeItem('aloud:previewUpdate')`.
Read in `about.ts` (`previewUpdateVersion`).

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
# TS core + UI (vitest) and typecheck
cd ts && npm test
cd ts && npm run typecheck            # tsc over src/ + ui/

# Hosted server
cd ts/server && npm test
cd ts/server && npx tsc --noEmit -p tsconfig.json

# Rust shell
cargo check --manifest-path ts/src-tauri/Cargo.toml
cargo test  --manifest-path ts/src-tauri/Cargo.toml     # network round-trips are #[ignore]
(cd ts/src-tauri && cargo deny check)                   # supply-chain gate (CI enforces)

# Model evals (by hand, NOT in CI - real API calls; see ts/evals/README.md)
cd ts && npx tsx evals/protocol-eval.ts
```

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

**CI**: `tauri-release.yml` runs on `release: created` and builds the Tauri
bundles for all three platforms via `tauri-action`, which also signs the
self-updater artifacts and uploads a merged `latest.json`. macOS signs +
notarizes via the `APPLE_*` / `MACOS_*` secrets; updater signing uses
`TAURI_SIGNING_PRIVATE_KEY` (+ password); the desktop UI build bakes
`VITE_ALOUD_CLOUD_URL` from the repo var `ALOUD_CLOUD_URL`.

Full build/signing detail: [desktop.md](desktop.md) (Tauri - endpoint list,
prereqs, release + cutover).

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
cd ts && npm run ui:build && npx cap sync android
cd android && ./gradlew bundleRelease
# → ts/android/app/build/outputs/bundle/release/app-release.aab
```

Bump `versionCode`/`versionName` in `android/app/build.gradle` before each
upload; signing comes from the gitignored `android/keystore.properties`. Full
keystore/Play App Signing detail: [mobile-signing.md](mobile-signing.md).

`VITE_ALOUD_CLOUD_URL` defaults from the committed `ts/ui/.env.production`
(build-only; an env var overrides it), and the `cap:*` scripts refuse to run if
neither supplies it (a mobile build without it has no backend). The mobile app wraps `ui/dist` in the OS WebView,
runs in **web mode**, and talks to aloud cloud. Native adapters (storage, STT,
keep-awake, in-app browser, sign-in) swap on `isCapacitor()`. `ts/ios/` and
`ts/android/` are committed (hand-edited native config); the permission strings,
icons, and full adapter map are documented in **[mobile.md](mobile.md)**.

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
- **BYOK keys** entered in the UI live in the browser's localStorage and are
  forwarded per-request (`x-provider-key` for model lists; `x-api-key` for the
  Anthropic proxy) - never persisted server-side.

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
  "Whisper (on this device)" under Tauri (`isTauri()` gate in `stt-picker.ts`).
  In a browser, STT falls to **web-speech** (Chrome/Edge only) or **aloud cloud**
  (needs the Hono server + sign-in). So a Chrome tab works out of the box;
  Firefox needs the Hono server running + a signed-in cloud session.

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

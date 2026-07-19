# Desktop shell (Tauri 2)

The desktop build wraps the TS UI (`ts/ui`) in a Tauri 2 native window.
Scaffolded 2026-05-27; lives in `ts/src-tauri/`.

## Run it

```bash
cd ts
npm run tauri:dev      # builds the Rust shell, starts Vite, opens the window
npm run tauri:build    # production .app/.dmg (macOS) — see caveat below
```

**Build prerequisites:** the Rust toolchain (rustup), and **cmake** (`brew install
cmake`) plus a C compiler — `whisper-rs` compiles whisper.cpp and `piper-rs`
(via espeak-rs) compiles espeak-ng, both from source. `piper-rs`'s `ort`
backend downloads the matching ONNX Runtime binary at build time, so the same
toolchain works on macOS/Windows/Linux. On first run the app
downloads the Whisper model (base.en GGML, ~142 MB) to
`<app-data>/models/` (`~/Library/Application Support/app.aloud.meditation/models`
on macOS); STT returns 503 until that finishes loading.

`tauri:dev` runs `beforeDevCommand` (`npm run ui:dev -- --port 4649
--strictPort`) and points the webview at `http://localhost:4649` (`devUrl`). The
port is **pinned** on purpose: Tauri's `devUrl` is a fixed string, so if Vite
were allowed to drift to another port the window would silently load the wrong
server. 4649 is aloud's dev port (see `ui/vite.config.ts`).

## Dev vs. production backend

The app's own backend (`/app/v1/*` — STT/TTS/providers/shell escapes) is served
by the **Rust shell** in both dev and production. The
shell starts an embedded `axum` server on an ephemeral loopback port and injects
its base as `window.__ALOUD_API_BASE__`, which `appUrl()` reads — so `/app/v1/*`
calls hit Rust whether the webview is the Vite dev server (`tauri:dev`) or the
bundled static UI (`tauri:build`). Hosted features (`/cloud/v1/*` — accounts,
credits, hosted voices) always go to the aloud cloud, baked in at build time
via `VITE_ALOUD_CLOUD_URL`.

(The browser-only dev path — `npm run ui:dev` without Tauri — has no Rust shell;
there the Vite proxy forwards both `/app/v1` and `/cloud/v1` to the Hono server
on :8787. See `dev-cheatsheet.md`.)

## App backend (`/app/v1/*`, native Rust)

Decision (see `meditation-pal-nn1`): desktop uses **native Rust in Tauri** for
local inference — `whisper-rs` (whisper.cpp) for STT, Piper (ONNX) for TTS —
plus trivial command/HTTP shims for providers, the `claude` CLI subprocess, and
the config-folder shell escapes. The web target does **not** share this: web
users get cloud forwarding (`ts/server`) or browser-native STT/TTS, so the two
targets split cleanly and the Rust choice doesn't force a parallel Node
inference backend.

The UI abstracts the local backend base via `ui/src/app-base.ts` (`appUrl()`),
mirroring `cloud-base.ts` (`cloudUrl()`) for the hosted `/cloud/v1/*` server. In a
Tauri build the Rust shell starts an embedded `axum` server (`src-tauri/server.rs`)
on an ephemeral loopback port and injects `window.__ALOUD_API_BASE__` via an
`initialization_script`; `appUrl()` reads it (empty → relative paths in dev/web).

Endpoints (served at `/app/v1/*`):

- ✅ `/app/v1/system-info` — platform + tool availability (`which`).
- ✅ `/app/v1/stt/whisper` — local Whisper via `whisper-rs` (whisper.cpp).
- ✅ `/app/v1/voices` + `/app/v1/voices/preview` — Piper (ONNX via `piper-rs`:
  `ort` + espeak-ng) cross-platform, plus macOS `say` as a Darwin-only local
  engine. See `src-tauri/src/tts.rs`.
- ✅ `/app/v1/tts/download-model` + `/app/v1/tts/uninstall-model` — Piper models are
  downloaded **explicitly** via the picker's Download button (streamed NDJSON
  progress), never on demand: a
  session must not stall on a 100 MB fetch mid-synthesis, and the explicit
  install/uninstall UX is preserved. Multi-speaker voices share one `.onnx`, so
  downloading/uninstalling any speaker affects the whole family; the picker
  re-reads `/app/v1/voices` afterward and all sharing speakers flip state together
  (the `downloaded` flag is per model file). The TS button is wired in
  `views/setup.ts` and `views/settings.ts` via `downloadVoiceModel()` /
  `uninstallVoiceModel()` in `voice-picker.ts`.
- ✅ `/app/v1/providers` + `/app/v1/models/<provider>` — `src-tauri/src/providers.rs`.
  Includes the elaborate Ollama recommendation system (total RAM via `sysinfo`,
  fast-GPU detection, curated tier catalog from `DEFAULT_OLLAMA_TIERS`, per-tier
  `fits`/`installed` annotations, `other_installed`, version + outdated against
  `MIN_OLLAMA_VERSION`). The TS settings page renders this via
  `ui/src/settings-ollama.ts` (visible only when provider = ollama).
  `/app/v1/models/<provider>` returns the provider's live model list: the UI
  forwards the BYOK key as `x-provider-key` (loopback only) and `providers.rs`
  queries each provider's models API (openai/anthropic/openrouter/venice/groq +
  static claude_proxy), shaping `[{value,label}]`. Empty → the picker's
  free-form text input.
- ✅ `/app/v1/ollama/pull` (streamed NDJSON progress) + `/app/v1/ollama/delete` —
  `src-tauri/src/ollama.rs`. Proxies the local Ollama daemon's HTTP API; UI
  drives per-model progress bars + Remove buttons.
- ✅ `/app/v1/ollama/restart` + `/app/v1/ollama/upgrade` + `/app/v1/install/{tool}`
  — `src-tauri/src/ollama_tools.rs`. Manage the daemon itself (vs its models):
  restart detects how Ollama runs and brings it back; upgrade/install use brew
  (macOS) or install.sh (Linux), 400 + download URL where there's no automatic
  path. All stream NDJSON; the settings controls bar drives them.
- ✅ `/app/v1/llm/anthropic/messages` — relays an Anthropic Messages request
  upstream (the webview can't reach Anthropic — no CORS). The UI forwards the
  BYOK key as `x-api-key`; env `ANTHROPIC_API_KEY` is the dev fallback. See
  `src-tauri/src/llm.rs::anthropic_proxy`.
- ✅ `/app/v1/llm/claude_proxy/complete` — spawns the local `claude` CLI via
  `tokio::process` with the provider's flags, prompt encoding, JSON parsing, and
  90 s timeout. See `src-tauri/src/llm.rs`.
- ✅ `/app/v1/sessions` (+ `/sessions/{id}`) — desktop session persistence: one
  JSON file per session under `<app-data>/sessions/`, so saved sessions are
  durable, openable files rather than webview localStorage. `{id}` is charset-
  restricted (`safe_session_id`) so an untrusted client can't escape the dir. The
  UI side is `ui/src/adapters/backend-session-store.ts` (`BackendSessionStore`),
  swapped in by `state.ts` only under `isTauri()`.
- ✅ `/app/v1/google-oauth` — desktop Google sign-in via the loopback PKCE flow
  (the webview can't run the web GIS popup); hands the result to aloud cloud's
  `/cloud/v1/auth/google/desktop`.
- ✅ `/app/v1/open-config-folder`, `/app/v1/open-sessions-folder`,
  `/app/v1/open-session-file/{id}`, `/app/v1/open-voice-settings` — cross-platform
  `reveal_path()` helper reveals the app data dir, the sessions dir, or one
  session's JSON; voice-settings opens macOS System Settings → Spoken Content on
  Darwin, 400s elsewhere.
- ⬜ `/app/v1/tts-engines` — listed in the bead but has no fetch site in the TS UI
  (only mentioned in code comments as a future option), so deferred until a
  consumer actually needs it.

## Config notes

- `tauri.conf.json`: identifier `app.aloud.meditation` (matches the Capacitor
  bundle ID); window 1000×820, min 480×600.
- **Bundle art**: the app icon set (`src-tauri/icons/`) is generated from
  `assets/app-icon.svg` via `npx tauri icon` (dark `#110d08` rounded tile so it
  doesn't render as a "fried egg" on a transparent fill). The DMG uses Tauri's
  default window layout (light background, readable labels). A custom wordmark
  background is parked in `assets/dmg-background.svg` (regen command in its header)
  but **not currently wired** — a dark bundle background made the Finder icon
  labels unreadable, so it's deferred until the layout/label contrast is sorted.
- `Cargo.toml`: crate name is `app` / lib `app_lib` (Tauri default; left as-is to
  avoid churn).
- `src-tauri/target/` and `src-tauri/gen/schemas` are gitignored.

## Release (CI)

`.github/workflows/tauri-release.yml` is **the** desktop release workflow — on
`release: created` it builds the Tauri app for macOS / Windows / Linux via the
official **`tauri-apps/tauri-action`**, which also signs the updater artifacts
and uploads a merged `latest.json` for the in-app self-updater (see **Auto-update**
below).

- **macOS**: signed + notarized via Tauri's bundler env (`APPLE_CERTIFICATE` =
  the existing `MACOS_CERTIFICATE` secret, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_TEAM_ID`). Bundles `app,dmg` (the `app` target so the
  updater `.app.tar.gz` is emitted). arm64 (macos-latest).
- **Windows**: NSIS + MSI, unsigned (Authenticode). NSIS is the updater target.
- **Linux**: AppImage + .deb. AppImage is the only self-updatable target (deb is
  download-only). Needs the WebKitGTK 4.1 / GTK / appindicator / rsvg stack +
  CMake/build-essential (whisper-rs, espeak-rs) + libfuse2.
- The desktop UI build bakes `VITE_ALOUD_CLOUD_URL` (repo var `ALOUD_CLOUD_URL`)
  so the app reaches the hosted `/cloud/v1` service for accounts + credits;
  local providers work without it.

**Artifact names** are now tauri's standard `aloud_<version>_<arch>.{dmg,AppImage}`
/ `aloud_<version>_<arch>-setup.exe` (not the old `aloud-<version>-macOS.dmg`
form). The website's `docs/js/download.js` matches these names — keep the two in
sync if bundle naming changes.

`scripts/release.sh` reads the version from `tauri.conf.json` (the source of
truth), bumps it + `ts/package.json` in lockstep, and lints the TS/Rust stack
(typecheck + `cargo check` + `cargo deny`).

## Auto-update (Tauri updater plugin)

The in-app **Update** button lives in the About box — the single update surface
(Settings → Updates just opens About). It's the `tauri-plugin-updater` flow,
gated to the desktop shell (`isTauri()`):
`ui/src/desktop-updater.ts` calls `check()` → if the signed `latest.json` lists a
newer version, the user clicks Update → it downloads that platform's bundle over
Rust (so no webview CSP entry is needed), verifies a **minisign** signature
against the pubkey in `tauri.conf.json`, installs, and relaunches via
`tauri-plugin-process`. In a browser the button never appears — the page just
reloads to pick up a new deploy; the browser path instead shows an
informational GitHub-releases check (`ui/src/update-check.ts`).

Platform reality: macOS swaps the `.app` (already signed/notarized), Windows runs
the NSIS installer, Linux replaces the AppImage. **`.deb` and `.msi` can't
self-update** — those users reinstall.

### Signing keys (one-time)

The updater requires a minisign keypair — the public half verifies downloads, the
private half signs them in CI.

```bash
cd ts && npm run tauri signer generate -- -w ~/.tauri/aloud.key
```

- Put the **public** key in `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`.
- Add the **private** key + its password as repo secrets
  `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Keep the
  private key out of the repo — it's the sole thing preventing a forged update.

> **Local-build caveat:** `bundle.createUpdaterArtifacts` is `true`, so a full
> `npm run tauri:build` now requires `TAURI_SIGNING_PRIVATE_KEY` (+ password) in
> the environment, or it fails at the signing step. `npm run tauri:dev` is
> unaffected (it doesn't bundle). To bundle locally without the key, export a
> throwaway key or temporarily flip `createUpdaterArtifacts` off.

### The update manifest

The endpoint `…/releases/latest/download/latest.json` resolves to GitHub's
**latest non-prerelease** release, so the updater only ever moves users to stable
builds — a user on a pre-release ahead of the latest stable reads as up to date.
`tauri-action` generates and uploads `latest.json` per release; each platform job
appends its own signed entry.

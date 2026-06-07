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
server. 4649 is aloud's dev port (the retired Flask port, reused — see
`ui/vite.config.ts`).

## Dev vs. production backend

The app's own backend (`/app/v1/*` — STT/TTS/providers/shell escapes) is served
by the **Rust shell** in both dev and production; **no Flask** is involved. The
shell starts an embedded `axum` server on an ephemeral loopback port and injects
its base as `window.__ALOUD_API_BASE__`, which `appUrl()` reads — so `/app/v1/*`
calls hit Rust whether the webview is the Vite dev server (`tauri:dev`) or the
bundled static UI (`tauri:build`). Hosted features (`/cloud/v1/*` — accounts,
credits, hosted voices) always go to the aloud cloud, baked in at build time
via `VITE_ALOUD_CLOUD_URL`.

(The browser-only dev path — `npm run ui:dev` without Tauri — has no Rust shell;
there the Vite proxy forwards both `/app/v1` and `/cloud/v1` to the Hono server
on :8787, also Flask-free. See `dev-cheatsheet.md`.)

A production desktop build is functional for local features — the `/app/v1/*`
endpoints below are implemented in Rust. End-to-end release validation (signed
artifacts launching with their embedded backend) is still pending; see the
Release note at the bottom.

## Backend plan (Flask removal, desktop)

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

Endpoint progress (replacing Flask `/api/*`, now served at `/app/v1/*`):

- ✅ `/app/v1/system-info` — platform + tool availability (`which`).
- ✅ `/app/v1/stt/whisper` — local Whisper via `whisper-rs` (whisper.cpp).
- ✅ `/app/v1/voices` + `/app/v1/voices/preview` — Piper (ONNX via `piper-rs`:
  `ort` + espeak-ng) cross-platform, plus macOS `say` as a Darwin-only local
  engine. See `src-tauri/src/tts.rs`.
- ✅ `/app/v1/tts/download-model` + `/app/v1/tts/uninstall-model` — Piper models are
  downloaded **explicitly** via the picker's Download button (streamed NDJSON
  progress, wire-compatible with the old Flask routes), never on demand: a
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
  `tokio::process` and mirrors the Python provider's flags, prompt encoding,
  JSON parsing, and 90 s timeout. See `src-tauri/src/llm.rs`.
- ✅ `/app/v1/open-config-folder`, `/app/v1/open-sessions-folder`,
  `/app/v1/open-voice-settings` — cross-platform `reveal_path()` helper opens the
  app data dir for the two folder buttons (desktop sessions live in webview
  storage, not on disk, so the data dir is the closest meaningful target for
  now); voice-settings opens macOS System Settings → Spoken Content on Darwin,
  400s elsewhere.
- ⬜ `/app/v1/tts-engines` — listed in the bead but has no fetch site in the TS UI
  (only mentioned in code comments as a future option), so deferred until a
  consumer actually needs it.

## Config notes

- `tauri.conf.json`: identifier `app.aloud.meditation` (matches the Capacitor
  bundle ID); window 1000×820, min 480×600.
- `Cargo.toml`: crate name is `app` / lib `app_lib` (Tauri default; left as-is to
  avoid churn).
- `src-tauri/target/` and `src-tauri/gen/schemas` are gitignored.

## Release (CI) — meditation-pal-9vh

`.github/workflows/tauri-release.yml` is **the** desktop release workflow — it
builds the Tauri app for macOS / Windows / Linux on `release: created`. (It
replaced the PyInstaller `build.yml` at the meditation-pal-9vh cutover, validated
green on v1.0.4; Python was removed in meditation-pal-sk8.) Artifacts use the
canonical names — no `-tauri` suffix.

- **macOS**: signed + notarized via Tauri's bundler env (`APPLE_CERTIFICATE` =
  the existing `MACOS_CERTIFICATE` secret, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
  `APPLE_PASSWORD`, `APPLE_TEAM_ID`). Produces `aloud-X.Y.Z-macOS.dmg`.
- **Windows**: MSI + NSIS, unsigned. Produces `aloud-X.Y.Z-Windows.msi` / `.exe`.
- **Linux**: AppImage + .deb. Needs the WebKitGTK 4.1 / GTK / appindicator /
  rsvg stack + CMake/build-essential (whisper-rs, espeak-rs). Produces
  `aloud-X.Y.Z-Linux.AppImage` / `.deb`.
- The desktop UI build bakes `VITE_ALOUD_CLOUD_URL` (repo var `ALOUD_CLOUD_URL`)
  so the app reaches the hosted `/cloud/v1` service for accounts + credits;
  local providers work without it.

`scripts/release.sh` reads the version from `tauri.conf.json` (the source of
truth), bumps it + `ts/package.json` in lockstep, and lints the TS/Rust stack
(typecheck + `cargo check` + `cargo deny`).

> Untested end-to-end until a real release runs the workflow — validate the
> three signed/notarized-where-applicable artifacts launch and their embedded
> backend serves `/app/v1/*`.

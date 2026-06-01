# Development Cheatsheet

Quick reference for the current structure and how to run, test, and release
aloud. The codebase is mid-migration from Python/Flask to a TypeScript + Rust
stack; both ship this cycle, so both are covered. See
[ts-migration-status.md](ts-migration-status.md) for where the port stands.

## Structure

Two stacks live side by side:

| Path | Stack | Role |
|------|-------|------|
| `src/`, `tests/` | **Python / Flask** (legacy) | The original app + dev-preview backend. Still ships via PyInstaller this cycle; being removed (meditation-pal-sk8). |
| `ts/src/` | TS — `@aloud/core` | Shared engine: pacing, prompts, session, noting, LLM providers, platform adapters. |
| `ts/ui/` | TS — Vite, vanilla ES modules | The web UI (`ui/src/`, builds to `ui/dist/`). No framework, no build step beyond Vite. |
| `ts/server/` | TS — Hono | **aloud cloud**: Google auth, credit ledger, metered LLM/STT/TTS forwarding, billing. |
| `ts/src-tauri/` | Rust — Tauri 2 | The **desktop shell**: an embedded `axum` backend (native Whisper/Piper/Ollama/claude-CLI) + the webview that loads `ui/`. |

### Two backend namespaces

The UI talks to two backends, named by role (see `ui/src/app-base.ts` /
`cloud-base.ts`):

- **`/app/v1/*`** — the app's *own* backend (provider/voice/model catalogs,
  system-info, and on desktop: STT, TTS, Ollama, claude-proxy, shell escapes).
  Served by the **Rust shell** on desktop, by **Hono** on web.
- **`/cloud/v1/*`** — the **hosted** signed-in, billed service (auth, account,
  billing, metered forwarding). Always the **Hono** server.

On desktop the Rust shell injects `window.__ALOUD_API_BASE__` (its loopback
port) so `/app/v1` resolves locally; `/cloud/v1` points at the aloud cloud
(baked in at build time via `VITE_ALOUD_CLOUD_URL`).

## Running

All `npm` commands run from `ts/`. Use `uv` for Python.

### Desktop app (Tauri) — the primary dev target

```bash
cd ts && npm run tauri:dev
```

Starts Vite (UI on **:4649**) + compiles and runs the Rust shell. The shell's
embedded backend serves `/app/v1/*` on a loopback port — **no Flask needed**.
For hosted features (accounts/credits/hosted voices) also start the Hono
server (below); without it, `/cloud/v1/*` calls fail with `ECONNREFUSED` and the
UI degrades to "hosted unavailable" (expected, harmless).

### Web UI in a browser (Vite)

```bash
cd ts && npm run ui:dev          # UI on :4649
```

The Vite proxy (`ui/vite.config.ts`) forwards:
- `/app/v1/*` → **Hono** on :8787 (the app-backend surface; no Flask, no
  rewrite — Hono speaks `/app/v1` natively). meditation-pal-5d9.
- `/cloud/v1/*` → **Hono** on :8787 (same server; hosted accounts/credits/proxy).
- `/ollama/*` → local Ollama daemon on :11434.

So browser preview needs only the Hono server running (next section) — **no
Flask**. Run `cd ts/server && npm run dev` and load :4649.

**Local vs web mode (dev override).** The app runs in `local` mode (all
providers: Ollama + every BYOK API) or `web` mode (the hosted demo: Ollama
hidden, BYOK off behind a settings checkbox). The build default keys off
`isCloudBuild()` (whether `VITE_ALOUD_CLOUD_URL` was baked in). In **dev** you
can force either with a URL param — no rebuild, no settings change — so you can
keep both open in two tabs:
- `:4649/?mode=web` — force web mode
- `:4649/?mode=local` — force local mode
- `:4649/?mode=auto` — clear the override (back to the build default)

The override is **dev-only**: `vite build` hard-disables it (`app-mode.ts`),
so a deployed visitor can't force local mode to unlock Ollama/BYOK.

**Inspect the loading state (`?slowboot`).** First paint shows the boot orb — a
large, centered, magenta-rippling rainbow orb (the kasina-mode form) that
cross-fades into the small nav orb once the first view mounts. On localhost
it's a blink. `:4649/?slowboot=5000` holds it on screen for 5000 ms *before*
the view mounts, so you see the real loading state (static nav + orb, empty
content). Dev-only (`bootApp` in `app.ts`), gated on `import.meta.env.DEV` so
it's dead-code-eliminated from `vite build`. To see the **failure-to-load**
state (orb pulses forever), block the JS bundle in DevTools → Network → Block
request URL, or set Network to Offline before reloading.

### Hosted server (Hono)

```bash
cd ts/server && npm run dev      # :8787, watch mode
```

Boots with in-memory stores + stubs in dev (no secrets required). Config comes
from `ts/server/.env` — copy `ts/server/.env.example` and fill what you need.
Deeper operational notes: [ts-server.md](ts-server.md).

### Legacy Python / Flask

```bash
uv run python -m src.web                       # native window (pywebview), :4649
uv run python -m src.web --browser             # system browser, no native window
uv run python -m src.web --host 0.0.0.0 --port 8080
uv run python -m src.web --debug               # verbose src.* logging
```

### Ports at a glance

| Port | Who |
|------|-----|
| 4649 | Vite UI — both `tauri:dev` and `ui:dev` (reuses the retired Flask port) |
| 8787 | Hono server — both `/cloud/v1` and `/app/v1` (the `ui:dev` `/app` + `/cloud` proxy target) |
| 11434 | Ollama daemon |

(Legacy Flask, if you still run it, is also :4649 — but it's native-window only
now and no longer a dev proxy target, so it won't collide with `ui:dev` unless
you run both at once.)

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

# Legacy Python
uv run pytest tests/ -v
uv run pytest tests/test_pacing.py::TestStateTransitions::test_initial_state_is_idle -v
```

## Building & releasing

```bash
cd ts && npm run tauri:build          # signed/notarized desktop bundle (DMG / MSI+NSIS / AppImage+deb)
```

Release (bumps version, lints both stacks, tags, pushes, creates the GitHub
release that triggers CI):

```bash
scripts/release.sh                    # patch (default)
scripts/release.sh minor|major|1.2.3
scripts/release.sh same               # re-release current version (moves tag)
```

It bumps `src/__init__.py` **and** `ts/src-tauri/tauri.conf.json` +
`ts/package.json` in lockstep, lints TS (`typecheck`) + Rust (`cargo check` +
`cargo deny`) alongside ruff, and offers the pre-release doc check
([pre-release-checklist.md](pre-release-checklist.md)). **Prerequisites:** clean
tree, `gh` authenticated.

**CI** runs two workflows on `release: created`, in parallel for one validation
cycle:
- `build.yml` — the legacy PyInstaller DMG/EXE/AppImage.
- `tauri-release.yml` — the Tauri bundles (artifacts carry a `-tauri` suffix so
  they don't collide). macOS signs + notarizes via the existing `APPLE_*` /
  `MACOS_*` secrets; the desktop UI build bakes `VITE_ALOUD_CLOUD_URL` from the
  repo var `ALOUD_CLOUD_URL`.

Full build/signing detail: [building.md](building.md) (PyInstaller) and
[desktop.md](desktop.md) (Tauri — endpoint list, prereqs, release + cutover).

## Config & environment

- **Hosted server**: `ts/server/.env` (see `.env.example`) — provider keys
  (`ANTHROPIC_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`),
  `FIREWORKS_API_KEY` (server STT default; or the `STT_*` overrides),
  `GOOGLE_TTS_API_KEY`, `ALOUD_SESSION_SECRET`, `GOOGLE_CLIENT_IDS`, Stripe keys,
  `ALOUD_ADMIN_TOKEN`, and `ALOUD_UI_DIR` (serve `ui/dist` from the same process
  — the single-box self-host story).
- **UI build**: `VITE_ALOUD_CLOUD_URL` — the hosted origin baked into a
  static/desktop build so `/app/v1` + `/cloud/v1` resolve off-origin (unset in
  dev; the Vite proxy handles it).
- **Vite dev overrides**: `ALOUD_CLOUD_URL` (Hono — both `/app` and `/cloud`
  proxy targets), `OLLAMA_URL`. (`ALOUD_BACKEND_URL`/Flask is gone since the
  `/app` cutover, meditation-pal-5d9.)
- **BYOK keys** entered in the UI live in the browser's localStorage and are
  forwarded per-request (`x-provider-key` for model lists; `x-api-key` for the
  Anthropic proxy) — never persisted server-side.
- **Legacy Python**: `~/.config/aloud/config.yaml` (created on first settings
  save); defaults + all options in `config/default.yaml` (supports `${ENV_VAR}`).

## Legacy Flask debug flags

Still valid for `uv run python -m src.web` (the browser dev-preview backend):

| Flag | What it does |
|------|-------------|
| `--fresh` | First-run settings UI; clears localStorage (voice prefs, embers, quality prompt) |
| `--hide-premium` | Drops Premium/Enhanced voices from the voice list |
| `--no-voices` | Voices endpoint returns `[]` — tests the empty-voices state |
| `--reset-piper` | Hides Piper from the engine dropdown, quality modal, and hints |
| `--no-providers` | All LLM providers report unavailable — tests zero-provider setup |
| `--no-ollama` | Ollama appears not installed — tests the install flow |
| `--debug` | DEBUG level for all `src.*` loggers |
| `--browser` | System browser instead of the pywebview window |

Combine freely, e.g. `uv run python -m src.web --browser --fresh --hide-premium`.

## Sessions

Legacy Flask saves sessions as `<id>.json`/`.txt` under `session.save_directory`
(default `sessions/`), viewable at `/history`. The TS UI stores session state in
the browser (localStorage) via `ts/src/platform/storage.ts`.

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

## Landing site

Static site in `docs/` (hand-written, served by GitHub Pages from `/docs` on
main; download buttons hit the GitHub `releases/latest` API at load, so no
redeploy per release).

```bash
python3 -m http.server -d docs 8000   # http://localhost:8000
```

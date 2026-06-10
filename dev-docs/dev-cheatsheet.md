# Development Cheatsheet

Quick reference for the current structure and how to run, test, and release
aloud — a TypeScript + Rust stack under `ts/` (migrated off the original
Python/Flask app, removed in meditation-pal-sk8).

## Structure

The stack lives under `ts/`:

| Path | Stack | Role |
|------|-------|------|
| `ts/src/` | TS — `@aloud/core` | Shared engine: pacing, prompts, modes (exploration / noting / felt sense), session, LLM providers, platform adapters. |
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

All `npm` commands run from `ts/`.

### Desktop app (Tauri) — the primary dev target

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
cd ts && npm run ui:dev          # UI only (:4649) — needs the Hono server too (below)
```

`web:dev` runs both in one terminal (one Ctrl-C, or either side exiting, stops
both — see `scripts/dev.mjs`); use it for browser preview so
STT/voices/providers/billing resolve.

The Vite proxy (`ui/vite.config.ts`) forwards:
- `/app/v1/*` → **Hono** on :8787 (the app-backend surface; no rewrite — Hono
  speaks `/app/v1` natively).
- `/cloud/v1/*` → **Hono** on :8787 (same server; hosted accounts/credits/proxy).
- `/ollama/*` → local Ollama daemon on :11434.

So browser preview needs only the Hono server running (next section). Run
`cd ts/server && npm run dev` and load :4649.

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

### Ports at a glance

| Port | Who |
|------|-----|
| 4649 | Vite UI — both `tauri:dev` and `ui:dev` |
| 8787 | Hono server — both `/cloud/v1` and `/app/v1` (the `ui:dev` `/app` + `/cloud` proxy target) |
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

It bumps `ts/src-tauri/tauri.conf.json` (the version source of truth) +
`ts/package.json` in lockstep, lints TS (`typecheck`) + Rust (`cargo check` +
`cargo deny`), and offers the pre-release doc check
([pre-release-checklist.md](pre-release-checklist.md)). **Prerequisites:** clean
tree, `gh` authenticated.

**CI**: `tauri-release.yml` runs on `release: created` and builds the Tauri
bundles for all three platforms. macOS signs + notarizes via the `APPLE_*` /
`MACOS_*` secrets; the desktop UI build bakes `VITE_ALOUD_CLOUD_URL` from the
repo var `ALOUD_CLOUD_URL`.

Full build/signing detail: [desktop.md](desktop.md) (Tauri — endpoint list,
prereqs, release + cutover).

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
  proxy targets), `OLLAMA_URL`.
- **BYOK keys** entered in the UI live in the browser's localStorage and are
  forwarded per-request (`x-provider-key` for model lists; `x-api-key` for the
  Anthropic proxy) — never persisted server-side.

## Sessions

The UI stores session state in the browser (localStorage) via
`ts/src/platform/storage.ts`.

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
Actions" — the old "serve `/docs` from a branch" mode is retired), which uploads
the whole `docs/` tree: marketing pages plus the freshly built app at
`docs/app/`. Download buttons hit the GitHub `releases/latest` API at load, so
no redeploy per release.

```bash
python3 -m http.server -d docs 8000   # http://localhost:8000
```

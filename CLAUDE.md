# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

aloud is a voice-based meditation facilitator. Users speak into a microphone, speech is transcribed (Whisper), an LLM generates facilitation responses, and TTS speaks them back.

It ships three ways:
- **Hosted web app** at `aloud.rest/app` — no install; the launch centerpiece. Runs on **aloud cloud** (below).
- **Desktop app** — a Tauri (Rust) shell, distributed as DMG / MSI / AppImage.
- **(Coming) mobile** — a Capacitor wrapper around the same web UI.

The codebase is **mid-migration from Python/Flask to a TypeScript + Rust stack**. The TS/Rust stack under `ts/` is the active one; the Python app (`src/`, `tests/`) is legacy, still shipped via PyInstaller this cycle, and being deleted (meditation-pal-sk8). **Default to working in `ts/`** — don't grep `src/web` expecting the live code.

## Source of truth

**`dev-docs/dev-cheatsheet.md`** is the authoritative, maintained reference for structure, running, testing, and releasing. Read it first. This file is orientation + the rules that override defaults; the cheatsheet has the detail.

## Architecture (the short version)

Two stacks live side by side under `ts/`:

| Path | Stack | Role |
|------|-------|------|
| `ts/src/` | TS — `@aloud/core` | Shared engine: pacing, prompts, session, noting, LLM providers, platform adapters. |
| `ts/ui/` | TS — Vite, vanilla ES modules | The web UI (`ui/src/` → `ui/dist/`). No framework. |
| `ts/server/` | TS — Hono | **aloud cloud**: Google/Apple/email auth, accounts, credit ledger, Stripe + x402 billing, metered LLM/STT/TTS forwarding. |
| `ts/src-tauri/` | Rust — Tauri 2 | Desktop shell: an embedded `axum` backend (native Whisper/Piper/Ollama/claude-CLI) + the webview that loads `ui/`. |
| `src/`, `tests/` | Python / Flask (legacy) | Original app; being removed (sk8). |

**Two backend namespaces** (see `ui/src/app-base.ts` / `cloud-base.ts`):
- **`/app/v1/*`** — the app's *own* backend (provider/voice/model catalogs, system-info; on desktop also STT/TTS/Ollama/claude-proxy/shell). Served by the **Rust shell** on desktop, by **Hono** on web.
- **`/cloud/v1/*`** — the **hosted, signed-in, billed** service (auth, account, billing, metered forwarding). Always **Hono** (aloud cloud).

Data flow (a turn): mic PCM → STT (`/app/v1` Whisper on desktop, `/cloud/v1` Fireworks when hosted, or browser SpeechRecognition) → core builds the prompt → LLM (BYOK direct, local Ollama/claude-CLI, or metered via `/cloud/v1`) → parse `[HOLD]` → TTS (Piper/`say` on desktop, Google via `/cloud/v1` hosted, or browser speechSynthesis).

## Commands

All `npm` commands run from `ts/`. Full list + ports in the cheatsheet.

```bash
cd ts && npm run tauri:dev     # desktop shell + Vite UI on :4649 (primary dev target)
cd ts && npm run ui:dev        # web UI in a browser on :4649 (needs the Hono server)
cd ts/server && npm run dev    # aloud cloud (Hono) on :8787
cd ts && npm test              # core + UI vitest
cd ts && npm run typecheck
cd ts/server && npm test       # hosted server vitest
cargo check --manifest-path ts/src-tauri/Cargo.toml   # Rust shell
```

CI (`.github/workflows/ci.yml`) is the TS gate (typecheck + vitest + ui:build + server tests). Legacy Python: `uv run python -m src.web`, `uv run pytest tests/`.

## Key patterns (the core engine, now in `ts/src/`)

- **Protocol/adapter-based providers**: LLM and TTS providers implement a shared interface; add one by implementing it and registering in the factory.
- **Composable prompts**: system prompts are assembled from orthogonal dimensions — focuses (body, emotions, parts, open awareness), qualities (playful, compassionate, spacious, …), directiveness, verbosity.
- **`[HOLD]` signal**: the LLM can prefix a response with `[HOLD]` to enter silence mode; it's stripped on parse and exited when the user speaks again.
- **Pacing state machine**: IDLE → LISTENING → PROCESSING → RESPONDING → SILENT_HOLD; a canned (non-LLM) check-in fires after a silence interval and the timer resets.
- **Context strategies**: `full` (all history) or `rolling` (last N exchanges) context windows.

## Configuration

- **aloud cloud**: `ts/server/.env` (copy `.env.example`) — provider keys, `ALOUD_SESSION_SECRET`, `GOOGLE_CLIENT_IDS` / `GOOGLE_DESKTOP_CLIENT_ID(+SECRET)`, Stripe keys, etc.
- **UI build**: `VITE_ALOUD_CLOUD_URL` bakes the hosted origin into a static/desktop build (unset in dev; the Vite proxy handles it). Repo var `ALOUD_CLOUD_URL` feeds it in CI.
- **BYOK keys** entered in the UI live in browser localStorage and are forwarded per-request (`x-provider-key` / `x-api-key`); never persisted server-side.
- **Legacy Python**: `config/default.yaml` + `~/.config/aloud/config.yaml`.

## Workflow notes

- **Working dir**: TS work runs from `ts/` via `npm`. Use `uv` (`uv run`, `uv pip`) for the legacy Python only — never `.venv/bin/python` directly.
- **No git push access** — Claude Code is not configured to push. End sessions with `git commit` only; the user pushes.
- **Pre-release check** — when asked, or before a release, work through `dev-docs/pre-release-checklist.md`: verify docs/copy still match the code and flag downstream consequences.
- **Docs reference code by file + symbol, not line numbers** — line numbers rot; a `file.ts` path plus a function/constant name stays greppable.

## Issue tracking

This project uses **Beads** (`.beads/`). Use `bd create`, `bd list`, `bd update`, `bd close`, `bd sync`.

## Interacting with the developer

Feel free to be creative or playful when talking with the developer, and to take occasional breaks to write for fun. recess.md is another space you can use for this when running on his machine.

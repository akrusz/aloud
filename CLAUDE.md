# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

aloud is a voice-based meditation facilitator. Users speak into a microphone, speech is transcribed (Whisper), an LLM generates facilitation responses, and TTS speaks them back.

It ships three ways:
- **Hosted web app** at `aloud.rest/app` — no install; the launch centerpiece. Runs on **aloud cloud** (below).
- **Desktop app** — a Tauri (Rust) shell, distributed as DMG / MSI / AppImage.
- **(Coming) mobile** — a Capacitor wrapper around the same web UI.

The codebase is a **TypeScript + Rust stack** under `ts/`. (It was migrated from a Python/Flask app, removed in meditation-pal-sk8 — if old docs or commits reference `src/web` or `uv run python -m src.web`, that code is gone.) **All work happens in `ts/`.**

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

**Two backend namespaces** (see `ui/src/app-base.ts` / `cloud-base.ts`):
- **`/app/v1/*`** — the app's *own* backend (provider/voice/model catalogs, system-info; on desktop also STT/TTS/Ollama/claude-proxy/shell). Served by the **Rust shell** on desktop, by **Hono** on web.
- **`/cloud/v1/*`** — the **hosted, signed-in, billed** service (auth, account, billing, metered forwarding). Always **Hono** (aloud cloud).

Data flow (a turn): mic PCM → STT (`/app/v1` Whisper on desktop, `/cloud/v1` Fireworks when hosted, or browser SpeechRecognition) → core builds the prompt → LLM (BYOK direct, local Ollama/claude-CLI, or metered via `/cloud/v1`) → parse `[HOLD]` → TTS (Piper/`say` on desktop, Google via `/cloud/v1` hosted, or browser speechSynthesis).

## Commands

All `npm` commands run from `ts/`. Full list + ports in the cheatsheet.

```bash
cd ts && npm run tauri:dev     # desktop shell + Vite UI on :4649 (primary dev target)
cd ts && npm run web:dev       # browser preview: Vite UI (:4649) + Hono (:8787) together
cd ts && npm run ui:dev        # UI only on :4649 (pair with the Hono server below)
cd ts/server && npm run dev    # aloud cloud (Hono) on :8787
cd ts && npm test              # core + UI vitest
cd ts && npm run typecheck
cd ts/server && npm test       # hosted server vitest
cargo check --manifest-path ts/src-tauri/Cargo.toml   # Rust shell
```

CI (`.github/workflows/ci.yml`) is the TS gate (typecheck + vitest + ui:build + server tests).

## Key patterns (the core engine, now in `ts/src/`)

- **Protocol/adapter-based providers**: LLM and TTS providers implement a shared interface; add one by implementing it and registering in the factory.
- **Composable prompts**: system prompts are assembled from orthogonal dimensions — focuses (body, emotions, parts, open awareness), qualities (playful, compassionate, spacious, …), directiveness, verbosity.
- **ModeSpec registry** (`modes.ts`): meditation modes are data, not forks — base prompt, which user dimensions compose, opener/check-in pools, and (for staged modes like felt sense, `felt-sense.ts`) an ordered phase arc. The active phase rides on the system prompt; the LLM signals movement with `[NEXT]`/`[BACK]`, parsed like `[HOLD]` (`parseTurnSignals`), clamped + persisted by `StagedModeController` and `SessionState.modePhase`.
- **`[HOLD]` signal**: the LLM can prefix a response with `[HOLD]` to enter silence mode; it's stripped on parse. While holding, speech doesn't auto-resume — each utterance is buffered and a lightweight resume-intent classifier (`resume-intent.ts`) decides whether the user means to continue, then submits the buffered turn.
- **Pacing state machine**: IDLE → LISTENING → PROCESSING → RESPONDING → SILENT_HOLD; a canned (non-LLM) check-in fires after a silence interval and the timer resets.
- **Context strategies**: `full` (all history) or `rolling` (last N exchanges) context windows.

## Configuration

- **aloud cloud**: `ts/server/.env` (copy `.env.example`) — provider keys, `ALOUD_SESSION_SECRET`, `GOOGLE_CLIENT_IDS` / `GOOGLE_DESKTOP_CLIENT_ID(+SECRET)`, Stripe keys, etc.
- **UI build**: `VITE_ALOUD_CLOUD_URL` bakes the hosted origin into a static/desktop build (unset in dev; the Vite proxy handles it). Repo var `ALOUD_CLOUD_URL` feeds it in CI.
- **BYOK keys** entered in the UI live in browser localStorage and are forwarded per-request (`x-provider-key` / `x-api-key`); never persisted server-side.

## Workflow notes

- **Working dir**: all work runs from `ts/` via `npm` (core/UI) plus `cargo` for the Rust shell.
- **No git push access** — Claude Code is not configured to push. End sessions with `git commit` only; the user pushes.
- **Pre-release check** — when asked, or before a release, work through `dev-docs/pre-release-checklist.md`: verify docs/copy still match the code and flag downstream consequences.
- **Docs reference code by file + symbol, not line numbers** — line numbers rot; a `file.ts` path plus a function/constant name stays greppable.

## Issue tracking

This project uses **Beads** (`.beads/`). Use `bd create`, `bd list`, `bd update`, `bd close`, `bd sync`.

## Interacting with the developer

Feel free to be creative or playful when talking with the developer, and to take occasional breaks to write for fun. recess.md is another space you can use for this when running on his machine.

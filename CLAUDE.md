# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

aloud is a voice-based meditation facilitator. Users speak into a microphone, speech is transcribed, an LLM generates facilitation responses, and TTS speaks them back.

It ships three ways:
- **Hosted web app** at `aloud.rest/app`: no install, the launch centerpiece. Runs on **aloud cloud** (below).
- **Desktop app**: a Tauri (Rust) shell, distributed as DMG / MSI / AppImage.
- **Mobile (beta)**: a Capacitor wrapper around the same web UI. `ts/ios/` and `ts/android/` are committed native projects (icons, signing, native STT/sign-in adapters). Android is on Play internal testing; iOS is parked. See `dev-docs/mobile.md` + `dev-docs/store-submission-checklist.md`.

The codebase is a **TypeScript + Rust stack** under `ts/`, and **all work happens there**. The Python/Flask original is gone (meditation-pal-sk8), so old references to `src/web` or `uv run python -m src.web` are dead.

## Source of truth

**`dev-docs/dev-cheatsheet.md`** is the maintained reference for structure, running, testing, and releasing - read it first. **`dev-docs/README.md`** indexes the rest of `dev-docs/` (one line per doc, grouped). This file is orientation plus the rules that override defaults.

## Architecture (the short version)

Two stacks live side by side under `ts/`:

| Path | Stack | Role |
|------|-------|------|
| `ts/src/` | TS - `@aloud/core` | Shared engine: pacing, prompts, session, noting, LLM providers, platform adapters. |
| `ts/ui/` | TS - Vite, vanilla ES modules | The web UI (`ui/src/` → `ui/dist/`). No framework. |
| `ts/server/` | TS - Hono | **aloud cloud**: Google/Apple/email auth, accounts, credit ledger, Stripe + x402 billing, metered LLM/STT/TTS forwarding. |
| `ts/src-tauri/` | Rust - Tauri 2 | Desktop shell: an embedded `axum` backend (native Whisper/Piper/Ollama/claude-CLI) + the webview that loads `ui/`. |

**Two backend namespaces** (see `ui/src/app-base.ts` / `cloud-base.ts`):
- **`/app/v1/*`**: the app's *own* backend (provider/voice/model catalogs, system-info; on desktop also STT/TTS/Ollama/claude-proxy/shell). Served by the **Rust shell** on desktop, by **Hono** on web.
- **`/cloud/v1/*`**: the **hosted, signed-in, billed** service (auth, account, billing, metered forwarding). Always **Hono** (aloud cloud).

Data flow (a turn): mic PCM → STT (`/app/v1` Whisper on desktop, the platform recognizer on mobile, browser SpeechRecognition, or metered hosted STT via `/cloud/v1`) → core builds the prompt → LLM (BYOK direct, local Ollama/claude-CLI, or metered via `/cloud/v1`) → parse `[HOLD]` and the other turn signals → TTS (Piper/`say` on desktop, Azure/Google/OpenAI via `/cloud/v1` hosted, or browser speechSynthesis).

## Commands

The real scripts live in `ts/package.json`; the root `package.json` delegates the common ones, so the block below runs from the repo root and survives a reset shell cwd. Anything not delegated is `npm --prefix ts <script>`. Full list + ports in the cheatsheet.

```bash
npm run tauri:dev     # desktop shell + Vite UI on :4649 (primary dev target)
npm run web:dev       # browser preview: Vite UI (:4649) + Hono (:8787) together
npm run ui:dev        # UI only on :4649 (pair with the Hono server below)
npm run server:dev    # aloud cloud (Hono) on :8787
npm test              # core + UI vitest
npm run typecheck
npm run test:server   # hosted server vitest
cargo check --manifest-path ts/src-tauri/Cargo.toml   # Rust shell
```

CI (`.github/workflows/ci.yml`) is the TS gate (typecheck + vitest + ui:build + server tests).

## Key patterns (core engine, `ts/src/`)

- **Protocol/adapter-based providers**: LLM and TTS providers implement a shared interface; add one by implementing it and registering in the factory.
- **Composable prompts**: system prompts are assembled from orthogonal dimensions - focuses (body, emotions, parts, open awareness), qualities (playful, compassionate, spacious, …), directiveness, verbosity. A hosted voice can append a rule about the text it will read (`CuratedVoice.promptNote` → `PromptConfig.voiceNote`, last); it's empty for every other voice, so the prompt-cache prefix holds.
- **ModeSpec registry** (`modes.ts`): meditation modes are data, not forks - base prompt, which user dimensions compose, opener/check-in pools, and (for staged modes like felt sense, `felt-sense.ts`) an ordered phase arc. The active phase rides on the system prompt; the LLM moves phases with `[NEXT]`/`[BACK]`, clamped + persisted by `StagedModeController` and `SessionState.modePhase`.
- **Turn signals**: `[HOLD]`, `[NEXT]`/`[BACK]`, `[WAIT:Nm]`, `[PASS]` are control tokens the LLM emits and `parseTurnSignals` strips, after truncating role leaks so a model writing the meditator's turn never reaches history.
- **Silence mode**: `[HOLD]` is a *bid*, not the entry - the facilitator asks "shall I be quiet?" and one-utterance classifiers (`resume-intent.ts`, precedence in `routeUtterance`) decide going quiet and coming back, with TypeSafe's Jev judge in front of them on judge sessions. Detail: `dev-docs/silence-mode.md`.
- **Pacing**: IDLE → LISTENING → PROCESSING → RESPONDING → SILENT_HOLD; a check-in fires after a silence interval. Check-in content and timing can each be canned/fixed or "smart" (LLM-chosen line or `[PASS]`; LLM-set `[WAIT:Nm]`). The session timer lands its approach and completion notices in voice, the completion one even inside a hold. Detail: `dev-docs/pacing.md`.
- **Context strategies**: `full` (all history) or `rolling` (last N exchanges) context windows.
- **Language is one setting** (`AppSettings.language`): English or `中文` (beta), driving the prompt + canned pools, the STT locale, and the UI (`t()` keyed on the English string, so rewording English orphans its zh entry). Detail: `dev-docs/language.md`.
- **Voice is the only input**: no text mode, so a session can't start without a mic (`mic-check.ts` pre-flights Begin). A bare "mute" always works (`isMuteCommand`); judge sessions also take natural-language commands (timer, speed, end session, …) via Jev. Detail: `dev-docs/voice-commands.md`.

## Configuration

- **aloud cloud**: `ts/server/.env` (copy `.env.example`) - provider keys, `ALOUD_SESSION_SECRET`, `GOOGLE_CLIENT_IDS` / `GOOGLE_DESKTOP_CLIENT_ID(+SECRET)`, Stripe keys, etc.
- **UI build**: `VITE_ALOUD_CLOUD_URL` bakes the hosted origin into a static/desktop/mobile build. The committed default lives in `ts/ui/.env.production` (build-only; dev uses the Vite proxy); repo var `ALOUD_CLOUD_URL` overrides it in CI.
- **BYOK keys** entered in the UI stay in the device's localStorage, and sessions call the provider directly. Only the model-list lookup relays a key (`x-provider-key` to `/app/v1/models`); nothing is persisted server-side.

## Workflow notes

- **Working dir**: all work runs from `ts/` via `npm` (core/UI) plus `cargo` for the Rust shell.
- **No git push access**: Claude Code is not configured to push. End sessions with `git commit` only; the user pushes.
- **Pre-release check**: when asked, or before a release, work through `dev-docs/pre-release-checklist.md`: verify docs/copy still match the code and flag downstream consequences.
- **Docs reference code by file + symbol, not line numbers**: line numbers rot; a `file.ts` path plus a function/constant name stays greppable.
- **Friction log**: `dev-docs/friction.md` collects repo/tooling friction worth fixing. Append when something slows you down and the fix isn't yours to make in passing; promote real items to beads and delete them from the file.

## Issue tracking

This project uses **Beads** (`.beads/`). Use `bd create`, `bd list`, `bd update`, `bd close`, `bd sync`.

`bd create` prints no ID; `bd --json create ...` does (the flag goes *before* the subcommand), so use that whenever you need the ID back to link or close.

For a **readable backlog** (the CLI is rough for browsing): `python3 scripts/bd-board.py`
writes a self-contained, filterable HTML board of all tickets - open it in a browser.

## Interacting with the developer

Feel free to be creative or playful when talking with the developer, and to take occasional breaks to write for fun. recess.md is another space you can use for this when running on his machine.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:6cd5cc61 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Agent Context Profiles

The managed Beads block is task-tracking guidance, not permission to override repository, user, or orchestrator instructions.

- **Conservative (default)**: Use `bd` for task tracking. Do not run git commits, git pushes, or Dolt remote sync unless explicitly asked. At handoff, report changed files, validation, and suggested next commands.
- **Minimal**: Keep tool instruction files as pointers to `bd prime`; use the same conservative git policy unless active instructions say otherwise.
- **Team-maintainer**: Only when the repository explicitly opts in, agents may close beads, run quality gates, commit, and push as part of session close. A current "do not commit" or "do not push" instruction still wins.

## Session Completion

This protocol applies when ending a Beads implementation workflow. It is subordinate to explicit user, repository, and orchestrator instructions.

1. **File issues for remaining work** - Create beads for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **Handle git/sync by active profile**:
   ```bash
   # Conservative/minimal/default: report status and proposed commands; wait for approval.
   git status

   # Team-maintainer opt-in only, unless current instructions forbid it:
   git pull --rebase
   git push
   git status
   ```
5. **Hand off** - Summarize changes, validation, issue status, and any blocked sync/commit/push step

**Critical rules:**
- Explicit user or orchestrator instructions override this Beads block.
- Do not commit or push without clear authority from the active profile or the current user request.
- If a required sync or push is blocked, stop and report the exact command and error.
<!-- END BEADS INTEGRATION -->

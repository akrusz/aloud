# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

aloud is a voice-based meditation facilitator. Users speak into a microphone, speech is transcribed (Whisper), an LLM generates facilitation responses, and TTS speaks them back.

It ships three ways:
- **Hosted web app** at `aloud.rest/app` — no install; the launch centerpiece. Runs on **aloud cloud** (below).
- **Desktop app** — a Tauri (Rust) shell, distributed as DMG / MSI / AppImage.
- **Mobile (beta)** — a Capacitor wrapper around the same web UI. `ts/ios/` and `ts/android/` are committed native projects (icons, signing, native STT/sign-in adapters); Android is headed for Play internal testing. See `dev-docs/mobile.md` + `dev-docs/store-submission-checklist.md`.

The codebase is a **TypeScript + Rust stack** under `ts/`, and **all work happens there**. The Python/Flask original is gone (meditation-pal-sk8), so old references to `src/web` or `uv run python -m src.web` are dead.

## Source of truth

**`dev-docs/dev-cheatsheet.md`** is the maintained reference for structure, running, testing, and releasing — read it first. **`dev-docs/README.md`** indexes the rest of `dev-docs/` (one line per doc, grouped). This file is orientation plus the rules that override defaults.

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

Data flow (a turn): mic PCM → STT (`/app/v1` Whisper on desktop, the platform recognizer on mobile, browser SpeechRecognition, or metered hosted STT via `/cloud/v1`) → core builds the prompt → LLM (BYOK direct, local Ollama/claude-CLI, or metered via `/cloud/v1`) → parse `[HOLD]` → TTS (Piper/`say` on desktop, Azure/Google/OpenAI via `/cloud/v1` hosted, or browser speechSynthesis).

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
- **Composable prompts**: system prompts are assembled from orthogonal dimensions — focuses (body, emotions, parts, open awareness), qualities (playful, compassionate, spacious, …), directiveness, verbosity. A hosted voice can add a rule about the text it will read (`CuratedVoice.promptNote` on the server → `PromptConfig.voiceNote`, appended last); it's empty for every voice without one, so the prompt-cache prefix holds.
- **ModeSpec registry** (`modes.ts`): meditation modes are data, not forks — base prompt, which user dimensions compose, opener/check-in pools, and (for staged modes like felt sense, `felt-sense.ts`) an ordered phase arc. The active phase rides on the system prompt; the LLM signals movement with `[NEXT]`/`[BACK]`, parsed like `[HOLD]` (`parseTurnSignals`), clamped + persisted by `StagedModeController` and `SessionState.modePhase`.
- **`[HOLD]` signal**: the LLM prefixes `[HOLD]` to ask for silence mode; it's stripped on parse, after `parseTurnSignals` truncates role leaks (`findRoleLeak`/`stripRoleLeak`, `modes.ts`) — since this path feeds history, a model that starts writing the meditator's turn never reaches the transcript. The token is a *bid*, not the entry: small models emit it far too eagerly, so the facilitator asks "shall I be quiet?" and the app judges the reply. Three one-utterance, no-history classifiers in `resume-intent.ts` gate the silence — `classifyHoldConfirm` on the way in, `classifyResumeIntent` on each buffered utterance while held (biased hard toward staying: thinking out loud is not a call back), and `classifyHoldRequest` for the minute after one ends, which takes "no, stay quiet" back under with a canned line (`HOLD_REENTRY_LINES`) instead of a facilitation turn. `routeUtterance` (`silence-dispatch.ts`) owns the precedence between them. Judge sessions put TypeSafe's Jev in front of the three: always on aloud cloud (dev override `getJevClassifierMode`, `dev-mode.ts`: on/shadow/off), and on BYOK/local sits only behind the `voiceCommandsViaCloud` opt-in plus a signed-in account, since those sessions otherwise never touch our server (`ui/src/voice-commands.ts`, `voiceCommandsAccess`; the call is free, so no balance is involved) via `/cloud/v1/judge` (`utterance-judge.ts`). Each classifier is one or more atomic yes/no asks answered as probabilities in a single request, a yes on any ask (each with its own measured threshold, `judgeVerdict`) being a yes; `resume` asks "addressed to the facilitator?" and "done with the silence?" separately, and alone gets the hold's earlier utterances as context (`JudgeContext.earlier`), so "I guess I'm ready" can mean the session or the thing they were just talking about. The LLM classifiers stay history-free, and any judge failure falls through to them, with `CloudJudge` backing off (30s doubling to 5m) after two in a row so an outage is not one wasted round trip per utterance. `npm run jev:ab` scores the two against a labelled corpus - rerun it after touching a question or threshold. With silence mode off, `HOLD_SIGNAL_FRAGMENT` leaves the system prompt, so the facilitator can't promise a silence the app won't deliver.
- **Pacing state machine**: IDLE → LISTENING → PROCESSING → RESPONDING → SILENT_HOLD; a check-in fires after a silence interval and the timer resets. Check-in content and timing are settings: content is a canned (non-LLM) phrase or "smart" (`smart-checkin.ts`) — the LLM gets the session plus a bracketed silence-event turn and offers one short line in context or replies `[PASS]` to keep quiet, unusable replies falling back to the canned pool; timing is a fixed interval or "smart" — the LLM prefixes `[WAIT:Nm]` (parsed with the other turn signals) to set how long the next silence stays protected, clamped and held by `PacingController.setCheckinInterval`, with the default wait biased by the guidance slider (`waitBiasFragment`/`defaultWaitSeconds`: 20m/8m/5m/90s/30s across the five stops, high guidance = short waits and substantive check-ins). Two guards on the smart path: after `SMART_CHECKIN_MAX_PASSES` (2) consecutive `[PASS]`es the next due check-in speaks a canned line instead of giving the model another chance to stay quiet, and the streak cap (`SMART_CHECKIN_MAX_STREAK`) remains the walk-away backstop.
- **Modes can own their check-ins**: a `checkinPaceSlider` mode (felt sense) has its own toggle + pace slider in the setup panel (`SessionSetup.feltSenseCheckins`, default on), so `views/session.ts` derives timing from those (`smart` / `none`) and forces content to `smart`, ignoring the app-level `checkinTiming`/`checkinContent`. The pace step also stands in for directiveness in those modes, since the guidance slider is hidden.
- **Session timer** (`session-timer.ts`, UI clock in `ui/src/session-clock.ts`): the countdown is UI; what makes it a *meditation* timer is that the facilitator lands it in voice. Two synthetic `[Timer: …]` event turns ride the smart-check-in path (event turn → one short reply → canned fallback): an approach notice, whose lead (`timerApproachLeadSec`) scales with the sit and with the running average turn length so it can't fall inside a silence, and a completion notice. The model may `[PASS]` on approach, never on completion. A notice takes an LLM call to compose, so `SessionClock.armGeneration` lets the view drop one whose timer was cancelled or extended meanwhile, and `requeue` hands back one the meditator talked over, so it is said at the next turn boundary instead of lost. The completion notice is the one thing that fires **inside `[HOLD]`** — and puts the hold back afterwards (`restoreHoldAfterNotice`), since a timer that silence mode can suppress isn't one. Both wait for a turn boundary rather than barging in. `isSyntheticEventTurn` keeps event turns out of transcripts; `parseSmartCheckinReply`/`runSmartCheckin` take a `maxChars` so a closing word can run longer than a check-in. Settings: `sessionClockMode` / `sessionTimerMin` / `showSessionClock` / `endSessionOnTimer` — hiding the readout never disarms the timer, and `endSessionOnTimer` (default off) ends the sit only *after* the closing word has been spoken.
- **Context strategies**: `full` (all history) or `rolling` (last N exchanges) context windows.
- **Language is one setting** (`AppSettings.language`, Settings only - no per-session pick): English or `中文` (beta). It drives three layers at once. The **facilitation** layer (`facilitation/language.ts`) appends a respond-in-Chinese fragment to the system prompt that keeps the control tokens (`[HOLD]`/`[NEXT]`/`[BACK]`/`[WAIT:Nm]`/`[PASS]`) verbatim in English so `parseTurnSignals` still works, and swaps every canned pool for its zh twin — pool owners register their own pairing (`registerZhPool`) rather than this module importing them, which would close an import cycle. The **STT** layer gets the locale on every path (browser `SpeechRecognition.lang`, Whisper `language`, native recognizer, hosted hint). The **UI** layer (`ui/src/i18n.ts`, catalog `ui/src/i18n/zh.ts`) is a `t()` lookup keyed on the English string, so a missing entry degrades to English, never to a bare key; `localizeChrome()` handles the static `index.html` via `data-i18n`, and views remount on `LANGUAGE_CHANGED_EVENT`. Voices declare whether they can speak the session language, and the picker dims the ones that can't.
- **Voice is the only input**: there is no text mode, so a session can't start without a mic. `ui/src/mic-check.ts` pre-flights both start paths — a silent `probeMic()` paints the setup notice and disables Begin when it's certain, and `acquireMicOnce()` runs first inside the Begin handler (before any await, so the permission prompt keeps the click's user gesture). Setup holds Begin the same way while local Whisper's model is still downloading or loading (`ui/src/whisper-ready.ts` polls the shell's `/stt/whisper/warm`, optimistic on any probe failure), so a first-launch session can't start deaf. The same voice-only rule gives `isMuteCommand` (`mute-command.ts`) its job: a bare "mute" outranks every dispatch route, since it's the one thing you say when you want the app to stop hearing you. Deliberately strict — losing the mic mid-sentence beats reaching for the button — so the whole utterance must be the command. Unmuting is button-only. Judge sessions also take natural-language commands (`voice-command.ts`, asks in `voice-command-specs.ts`): end session (plain follows `saveSessionLogs`; "end without saving" and "end and save" override it for that sit), speak slower/faster, set/extend/cancel the timer, time check, repeat the last line, reply sooner / wait longer (one rung on `PAUSE_LADDER`, applied live through the optional `SttEngine.setPauseWindow` and saved to `silenceBaseMs`/`silenceMaxMs`), natural-phrased mic mute (the bare word still takes the judge-free `isMuteCommand` path first, so it works on every provider), speaker mute/unmute as a separate pair, and the on-screen extras: show/hide the clock readout (the timer keeps running), show/hide the orb, embers on/off, dark/light/switch theme (a lower threshold, `VISUAL_THRESHOLD`: Jev scores them softer and a misfire is a flicker). Short utterances (`mightBeCommand`) first get one cheap gate ask (`command-gate`, ~600 tokens: "an instruction to the app at all?", bar 0.2, fails open), since the full set costs ~4,200 tokens whatever the answer and nearly everything said is meditation. A maybe goes to Jev as one request with an atomic yes/no ask per command, right after the mute check and ahead of `routeUtterance`, so they work inside a hold without ending it (`restoreHoldAfterNotice`). The asks are independent, so one utterance can clear several ("talk slower and show me the orb"): `resolveCommands` drops the weaker of two opposites, orders the rest (speaker mute, then mic mute, then the end question last), and the app speaks one joined acknowledgment. A request that misses the judge reaches the model as an ordinary turn, so `appControlsFragment` (`prompts.ts`) tells it that it cannot work the app and must never say it did. A failed command check is retried once: a timeout is not a no, the first call through a freshly started server runs ~1s (at its timeout's edge) and there is no LLM twin behind it. `CloudJudge.warm()` and the server's boot-time call spend that cold one early. `npm run jev:commands` scores every ask against a labelled corpus and prints the thinnest margins - the asks share one request, so rerun it after touching any of them, and keep them lean (each costs ~170 tokens a call). `CommandPrefetch` asks the judge on a settled partial transcript, while the recognizer is still waiting out the pause, so the verdict is usually ready at submit; it only makes the answer early and never acts before a matching final. Jev says *that* a timer was asked for; `parseTimerRequest` pulls the minutes. Each command speaks a canned acknowledgment (`COMMAND_LINES`), and ending is only ever a bid: the app asks, and `classifyEndConfirm` judges the reply inside a 45s window. No judge (not opted in, signed out, outage) means no commands, only the bare `mute`. The opt-in is one checkbox under Advanced (locked on for aloud cloud) and can also be turned on mid-sit from the info panel's Voice commands row, which swaps the judge in live. Discovery is `ui/src/voice-command-hints.ts`, all on the status line rather than toasts: the first few judge sessions read `Listening… or ask "what can I say?"` (the `help` command), using the speed slider, timer picker or mute button by hand shows a one-time `You can just say "..."`, and the session info panel has a Voice commands row that opens the list.

## Configuration

- **aloud cloud**: `ts/server/.env` (copy `.env.example`) — provider keys, `ALOUD_SESSION_SECRET`, `GOOGLE_CLIENT_IDS` / `GOOGLE_DESKTOP_CLIENT_ID(+SECRET)`, Stripe keys, etc.
- **UI build**: `VITE_ALOUD_CLOUD_URL` bakes the hosted origin into a static/desktop/mobile build. The committed default lives in `ts/ui/.env.production` (build-only; dev uses the Vite proxy); repo var `ALOUD_CLOUD_URL` overrides it in CI.
- **BYOK keys** entered in the UI live in browser localStorage and are forwarded per-request (`x-provider-key` / `x-api-key`); never persisted server-side.

## Workflow notes

- **Working dir**: all work runs from `ts/` via `npm` (core/UI) plus `cargo` for the Rust shell.
- **No git push access** — Claude Code is not configured to push. End sessions with `git commit` only; the user pushes.
- **Pre-release check** — when asked, or before a release, work through `dev-docs/pre-release-checklist.md`: verify docs/copy still match the code and flag downstream consequences.
- **Docs reference code by file + symbol, not line numbers** — line numbers rot; a `file.ts` path plus a function/constant name stays greppable.
- **Friction log** — `dev-docs/friction.md` collects repo/tooling friction worth fixing. Append when something slows you down and the fix isn't yours to make in passing; promote real items to beads and delete them from the file.

## Issue tracking

This project uses **Beads** (`.beads/`). Use `bd create`, `bd list`, `bd update`, `bd close`, `bd sync`.

`bd create` prints no ID; `bd --json create ...` does (the flag goes *before* the subcommand), so use that whenever you need the ID back to link or close.

For a **readable backlog** (the CLI is rough for browsing): `python3 scripts/bd-board.py`
writes a self-contained, filterable HTML board of all tickets — open it in a browser.

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

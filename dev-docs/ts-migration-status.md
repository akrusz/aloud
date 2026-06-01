# TS migration status

Snapshot of where the TS UI sits against Python parity, updated at the
end of each autonomous porting session. The eventual goal is full Python
deprecation; this doc tracks how close we are and what's left.

## Session 2026-05-28c — doc reconciliation (no code change)

Read-through pass to re-sync this doc with `ts-core` HEAD; the entries below had
drifted behind the code. Baseline at the time of reconciliation: core/UI
typecheck clean, 176 tests passing. Corrections:

- **URL routing / back button is DONE** (`7e07da7`, `24d0a87`). `ui/src/app.ts`
  has a full History-API router: `pushState`/`replaceState` per view,
  `popstate` deep-linking, initial-load deep-link from `window.location.pathname`,
  and an Android-hardware-back-aware leave-confirm trap for live sessions (it
  re-arms `/session` and defers to the view's confirm overlay). This was
  "Order of operations #1" and the "Other frontend gaps > URL routing" bullet —
  both struck below.
- **Noting circle UI is DONE** (`39db8c0`). `ui/src/views/noting-session.ts`
  (579 LOC) is the turn-rotation orchestrator; `ui/src/views/setup.ts` carries
  the participant configurator (`#participant-list`, `participantLabel`, voice
  dropdowns). The "biggest remaining frontend port that can't actually run"
  claim is obsolete — struck below.

Still genuinely open (verified against HEAD): `sw.js` version hardcode,
`piperAvailable: true` hardcode, settings-tour `firstRun` signal, and all the
human-supervised backend-deprecation work. Note on the sw.js fix: `ts/package.json`
is a `0.0.1` placeholder, so wiring the SW `VERSION` to it as-is would *regress*
the cache key from the real `0.12.1`; the real version-sync lives in `release.sh`,
so this fix belongs with the release tooling, not a naïve package.json read.

## Session 2026-05-28b — Flask-removal backends (clk / bkg / 9vh) + route rename

Branch: `ts-core`. Closes the backend gaps that were blocking Python deletion
(meditation-pal-sk8). Final state: core/UI typecheck + 176 tests, server
typecheck + 73 tests, `cargo check` — all green.

| Commit | Lands |
|---|---|
| `a8677e7` | **Route rename** to role-versioned `/app/v1/*` (the app's own backend — Rust on desktop, Hono on web) + `/cloud/v1/*` (hosted account/billing/forwarding), replacing the inconsistent `/api` vs `/v1`. UI helpers `appUrl`/`cloudUrl` own the prefix; Vite proxy rewrites `/app/v1`→`/api` so Flask-backed dev still works. |
| `d9b031d` | **clk:** native Anthropic BYOK proxy (`/app/v1/llm/anthropic/messages`) — was a real parity gap (UI pointed at it, no Rust handler). |
| `944abea` | **clk:** Ollama daemon restart/upgrade/install (`ollama_tools.rs`) + a settings controls bar. |
| `45a9591` | **clk:** live model lists via `x-provider-key` forwarding; **fixed** a `/cloud/v1/v1` double-prefix bug the rename introduced (uncaught by typecheck/server tests — added `url-base.test.ts`). |
| `89fd698` | **bkg:** Hono serves `/app/v1/{system-info,providers,models,voices}` for the web build + optional static `ui/dist` (`ALOUD_UI_DIR`). `is-desktop` now keys off a `desktop` flag so the web build keeps desktop features off. |
| `fa92709` | **9vh:** `tauri-release.yml` (mac/win/linux, parallel to PyInstaller; `-tauri`-suffixed artifacts) + `release.sh` version-sync & TS/Rust lint. **Untested** until a real release run. |

**Now unblocked:** meditation-pal-sk8 (delete Python/Flask) — clk + bkg give the
desktop and web targets Flask-free backends. Before deleting, run the manual
verifications noted on each bead (desktop runtime flows; a web build against the
aloud cloud; a real Tauri release).

## Prior session

Branch: `ts-core`. Test baseline held at 117/117 throughout; typecheck
clean.

| Commit | Lands |
|---|---|
| `84f8cea` | **`tour/index-guide.ts`** — lift of `src/web/static/js/index-guide.js`. Welcome card + accordion info-panel delegation for the setup page; wired through `views/setup.ts` (auto-start on first visit, "Take the full tour" link inside the methods info panel, cleanup on view hide). Persistent dismiss state in `sharedKv`, session-scoped remind-later in `sessionStorage`. |
| `dda6909` | **`tour/settings-tour.ts`** — lift of `src/web/static/js/tour.js`. Provider + voice onboarding wizard wired to the new "Setup guide" footer button in `views/settings.ts`. DOM selectors adapted: `#s-{provider}-key` → `#s-key-{provider}`, `#s-model` → `#s-model-slot #model-select`/`#model-input` (TS picker mounts inside a slot and renders either form). |
| `35a236a` | **`views/login.ts`** — lift of `templates/login.html`. View module renders the password form; submits to `/login` via `method="post" action="/login"` so the existing Flask route handles auth when the TS UI is served behind it. Not yet wired into the app router (auth gating is a separate decision). |
| `f0eae02` | **`views/lan-setup.ts`** — lift of `templates/lan_setup.html`. View module renders the HTTPS-upgrade instructions; `{{ https_url }}` becomes a `show()` argument. Not wired into the router. |
| `9cbb229` | **`public/sw.js`** — lift of `templates/sw.js`. Vite serves `public/` as static, so the SW is available at `/sw.js` with root scope. `VERSION` is hardcoded to `"0.12.1"` to match the current release; TODO to wire it to `ts/package.json` or a vite build constant. |
| `db2ad9e` | **`wakelock.ts`** — lift of `src/web/static/js/wakelock.js`. Acquired on `views/session.ts` mount, released on session end, re-acquired on `visibilitychange` while `body[data-session-active]` is set. |

### Lift-first deviations worth knowing

- **`info-btn` delegation in setup**: the existing `wireInfoButtons` in `views/setup.ts` was a per-button toggle that doesn't match Python's accordion semantics and would double-fire with the tour module's delegated handler. Removed in favor of the tour's `document`-level handler (this is how Python works, and is what `index-guide.js` was already designed for).
- **Tour DOM selectors in settings**: the TS settings view uses `s-key-${provider}` and a `#s-model-slot` wrapping `#model-select`/`#model-input`, vs Python's `s-{provider}-key` and bare `#s-model`. The tour port adapts at the selector level rather than renaming TS DOM, since the TS structure is the more programmatic one.
- **Auto-start for settings tour**: Python gates this on a server-rendered `firstRun` flag (Flask template). The TS settings view doesn't have an analogue, so the tour only launches via the "Setup guide" button for now. The dismiss/remind logic still works correctly when the button is used.
- **Piper availability**: the settings tour hard-codes `piperAvailable: true`. Python's signal comes from a Flask template var. TODO recorded in `views/settings.ts` to plumb a real signal (likely via `/api/providers` or a new `/api/tts-engines` endpoint).

## Frontend gaps remaining

Things that were either in this session's brief but skipped, or near-by and worth flagging:

### Skipped from the brief

- **`mobile-quirks.js`** (62 LOC) — handles iOS Safari AudioContext suspension + Socket.IO reconnect. Doesn't have a clean 1:1 in the TS UI: the socket-reconnect half is N/A (TS uses HTTP/fetch + streaming, not Socket.IO), and the AudioContext-resume half depends on a shared `state.audioContext` pattern that TS deliberately moved away from (per-adapter contexts in `BargeInListener` and `ServerWhisperStt`). A useful port would need a small registry pattern so adapters can opt in for visibility-driven resume — recommended as a follow-up.
- **`audio-utils.js`** (53 LOC) — `setAudioPlaying` + `decodeAndPlay`. Superseded by the `HTMLAudioElement`-based `CloudTtsEngine` (which deliberately replaced Web Audio decode for Firefox-suspension reasons) and the streaming-tts pipeline. The `state.serverAudioPlaying` / `state.ttsSpeaking` flags don't have analogues in the TS UI; equivalent state lives inside per-adapter classes. Nothing to port.
- **`noting.js`** (496 LOC) — round-robin noting circle orchestrator. **DONE as of `39db8c0`** (was open when this section was written). The orchestrator is `ui/src/views/noting-session.ts` (579 LOC); the participant configurator is live in `ui/src/views/setup.ts` (`#participant-list` + per-participant voice dropdowns), no longer a disabled placeholder. See the 2026-05-28c reconciliation note at the top.

### Other frontend gaps (not in the session brief, but visible)

- ~~**URL routing / back button**~~ — **DONE** (`7e07da7`, `24d0a87`). Full History-API router in `ui/src/app.ts`; see the 2026-05-28c reconciliation note at the top.
- **Settings tour auto-start signal** — see "Lift-first deviations" above. Needs a `firstRun` analogue.
- **Piper availability signal** — see "Lift-first deviations" above.
- **`sw.js` version source** — hardcoded; should pick from `ts/package.json` or a Vite build constant so cache busts roll over per release.

## Backend work for future sessions

These all need human supervision per the brief's hard guardrails. Rough complexity scores in parens (S/M/L/XL).

### Server-pushed events (socket replacement) — **L**
- Python's session uses Socket.IO for `audio_data`, `user_message`, `facilitator_message`, `noting_label`, etc. TS uses HTTP/fetch for LLM streaming and an STT post-style request.
- For the noting port + check-in loop + mid-session events, TS needs an equivalent. Options: SSE (one-way, simple, fits LLM streaming pattern), WebSocket without Socket.IO framing, or a polling loop. SSE is the cleanest fit given existing streaming infrastructure.

### LLM providers — **M (per provider)**
- `ts/src/llm/*` already implements Anthropic, OpenAI, OpenRouter, Venice, Ollama, Groq, ClaudeProxyHttp.
- Python-only: any cloud-side caching/quota that lives in Flask (e.g., the in-process token bucket). For full TS-only deployments these need replicating server-side.

### Whisper STT — **L**
- TS uses `/api/whisper` (Flask) or browser SpeechRecognition. For a Python-deprecated build, Whisper would need to run either in-shell (whisper.cpp via Tauri/Capacitor plugin, or wasm) or behind a non-Flask service.

### Piper TTS — **M**
- Same model as Whisper: today routed through Flask, future needs a shell-side or service-side runtime. Piper's voice catalog discovery + LRU loading is in Flask.

### Session storage — **S**
- `SessionStore` (`ts/src/platform/storage.ts`) already abstracts over `KvStorage`. The TS UI uses `LocalStorageKv`; Capacitor would swap to `Preferences`-backed. Flask currently persists sessions to disk via Python; the TS layer doesn't talk to those files (it stores in browser localStorage). Decision needed: are server-side session files going away, or do we keep a sync path?

### Flask routes still consumed by TS UI — **M**
- `/api/providers` — provider availability + Ollama recommendation. Needs an in-shell or service equivalent.
- `/api/models/<provider>` — model lists. Currently has hardcoded fallbacks in `model-picker.ts`.
- `/api/voices` + `/api/voices/preview` — voice catalog + preview rendering. The catalog is small enough to ship static; preview rendering needs a Piper/macos backend.
- `/api/whisper` — STT endpoint.
- `/api/open-config-folder`, `/api/open-voice-settings` — desktop-only shell escapes; need shell-API equivalents in Tauri/Capacitor.
- `/api/llm/claude_proxy/complete` — desktop-only subprocess bridge to the `claude` CLI.

## Order of operations

Suggested sequence for finishing the Python deprecation (top-down dependency order):

1. ~~**URL routing in TS UI**~~. **DONE** (`7e07da7`, `24d0a87`) — see 2026-05-28c note.
2. **Server-pushed events**. SSE end-to-end for LLM streaming first (already partly there), then check-in loop and noting events. **← now the top open item.**
3. ~~**Noting circle UI port**~~. **DONE** (`39db8c0`) — orchestrator + participant configurator landed. (Note: it runs without the SSE push originally assumed as a prerequisite; if mid-session server-pushed `noting_label`/`noting_audio` are still wanted, fold that into item #2.)
4. **Mobile-quirks register pattern**. Small AudioContext registry that `BargeInListener` and `ServerWhisperStt` opt into; visibility-driven resume + bfcache resume. Should be done before any mobile-shell spike.
5. **Shell decision** (`meditation-pal-nn1`). Desktop is settled: Tauri 2, unconditional — **scaffolded 2026-05-27** in `ts/src-tauri/` (runs in dev against Flask via the Vite proxy; see `dev-docs/desktop.md`). Mobile is gated on one thing — whether Tauri 2 can do the iOS `playAndRecord` + concurrent-mic audio session without a tar-pit custom plugin. A 3–5 day spike answers it; pass → single Tauri shell everywhere, fail → Capacitor for mobile + Tauri for desktop. The ticket carries the full plugin/library research, the on-device Whisper/Piper findings, and the bundle-size/capability-tiering plan.
6. **Native runtimes for Whisper + Piper + LLM**. Whisper.cpp / llama.cpp / Piper bindings in the chosen shell.
7. **Flask deprecation**. Once the routes above all have shell-side equivalents, the Flask process becomes optional, then removable.

Per the brief: this session does not touch backend deprecation. Everything in this section is for future human-supervised sessions.

## Prior status (pre-session)

Kept here as the "before" snapshot. Stale relative to the work above, but useful for reading the trajectory of the port.

> The TS UI now runs against the Flask backend as a browser preview and matches Python's behavior for the major flows. Tests: 117 passing, typecheck + Vite build clean. Engine — pacing, session, prompts, summary, noting — ported. LLM providers all wired with desktop-only gating for `claude_proxy`. Streaming + sentence-chunked TTS, barge-in, voice picker, model picker, history view, setup page, settings page, session view, chrome — all in place at varying levels of polish (see commit history for details). Known gaps before this session: URL routing, setup-page tab bar info panels, native STT / on-device LLM validation, noting circle UI.

# CLAUDE.md

aloud is a voice meditation facilitator: the user speaks, speech is transcribed, an LLM answers, TTS speaks the answer. It ships as a hosted web app (`aloud.rest/app`, running on **aloud cloud**), a Tauri desktop app, and Capacitor phone apps in beta (`ts/ios/`, `ts/android/`; where they stand is in `dev-docs/store-submission-checklist.md`).

All code is under `ts/` (TypeScript + Rust). The Python/Flask original is gone.

**Read first:** `dev-docs/dev-cheatsheet.md` (structure, running, testing, releasing); `dev-docs/README.md` indexes the rest. This file is orientation plus the rules that override defaults.

## Architecture

| Path | Stack | Role |
|------|-------|------|
| `ts/src/` | TS - `@aloud/core` | Shared engine: pacing, prompts, session, noting, LLM providers, platform adapters. |
| `ts/ui/` | TS - Vite, vanilla ES modules | The web UI. No framework. |
| `ts/server/` | TS - Hono | **aloud cloud**: auth, accounts, credit ledger, Stripe + x402 billing, metered LLM/STT/TTS forwarding. |
| `ts/src-tauri/` | Rust - Tauri 2 | Desktop shell: an embedded `axum` backend (Whisper/Piper/Ollama/claude-CLI) and the webview that loads `ui/`. |

Two backend namespaces (`ui/src/app-base.ts`, `cloud-base.ts`):
- `/app/v1/*`: the app's own backend (catalogs, system info; on desktop also STT/TTS/Ollama). The Rust shell on desktop, Hono on web.
- `/cloud/v1/*`: the hosted, signed-in, billed service. Always Hono.

A turn: mic → STT (desktop Whisper, a phone's or browser's recognizer, or hosted) → core builds the prompt → LLM (own key, local, or hosted) → turn signals parsed → TTS (local, hosted, or the browser's).

## Commands

Scripts live in `ts/package.json`; the root `package.json` delegates these, so they run from the repo root. Anything else is `npm --prefix ts <script>`.

```bash
npm run tauri:dev     # desktop shell + Vite UI on :4649 (primary dev target)
npm run web:dev       # browser preview: Vite UI (:4649) + Hono (:8787)
npm run server:dev    # aloud cloud (Hono) on :8787
npm test              # core + UI vitest
npm run typecheck
npm run test:server   # hosted server vitest
cargo check --manifest-path ts/src-tauri/Cargo.toml
```

CI is typecheck + vitest + ui:build + server tests.

## Key patterns

- **Providers**: LLM and TTS providers implement a shared interface and register in a factory.
- **Prompts** are composed from dimensions (focus, qualities, directiveness, verbosity), then `STEPPING_OUT_FRAGMENT` in every mode. A hosted voice may append `voiceNote` last; it is empty for every other voice, so the prompt-cache prefix holds.
- **Modes are data** (`modes.ts`). A staged mode (felt sense) keeps its whole arc in the system prompt; the active phase travels as a note in the log and moves on `[NEXT]`/`[BACK]`.
- **The session log is append-only** (`SessionState.exchanges`): exactly what the model was sent, so each request extends the last and reads it from prompt cache. The system prompt is frozen for the session; anything later is appended as a control entry or a system note, never edited. The one exception is `cutUnspokenReply`. `tests/cache-prefix.test.ts` pins this.
- **Turn signals** `[HOLD]`, `[NEXT]`/`[BACK]`, `[WAIT:Nm]`, `[PASS]` are emitted by the LLM and stripped by `parseTurnSignals`.
- **Silence mode**: `[HOLD]` is a bid, not the entry. `dev-docs/silence-mode.md`.
- **Stepping out** (a frightened or ungrounded meditator): `dev-docs/stepping-out.md`.
- **Barge-in** has three paths, by who holds the mic: `dev-docs/voice-barge-in.md`.
- **Pacing** (response delay, check-ins, holds, the session timer): `dev-docs/pacing.md`.
- **Language** is one setting, English or 中文. `t()` is keyed on the English string, so rewording English orphans its zh entry. `dev-docs/language.md`.
- **Voice is the only input**, on the setup screen too: `dev-docs/voice-commands.md`.

## Configuration

- **aloud cloud**: `ts/server/.env` (copy `.env.example`).
- **UI build**: `VITE_ALOUD_CLOUD_URL` bakes in the hosted origin; the default is in `ts/ui/.env.production`, and repo var `ALOUD_CLOUD_URL` overrides it in CI.
- **Own keys** stay on the device and sessions call the provider directly. Only the model-list lookup relays a key; nothing is stored server-side.

## Workflow

- **Commit, don't push**, on the dev's machine. In a cloud session (`$CLAUDE_CODE_REMOTE` set, container wiped afterwards) push to a branch other than `main`.
- **Server before clients**: a client build that uses something new on aloud cloud ships only after the server is deployed.
- **Before a release**, or when asked: `dev-docs/pre-release-checklist.md`.
- **Docs name a file and a symbol**, never a line number.
- **Friction** worth fixing that isn't yours to fix in passing goes in `dev-docs/friction.md`.
- **Issues** are in Beads (`bd`); the session hook prints its workflow. `bd create` prints no ID, `bd --json create ...` does. `python3 scripts/bd-board.py` writes a browsable board. Two of the hook's defaults do not hold here: commits follow the line above, and memory is split, with preferences and working agreements in the session memory directory and technical findings about the code or devices in `bd remember`. The block `bd setup claude` writes into this file was removed on purpose, since the hook already says it all.

## Interacting with the developer

Feel free to be creative or playful when talking with the developer, and to take occasional breaks to write for fun. recess.md is another space you can use for this when running on his machine. Keep it to the latest ~5 entries, moving older ones to the end of recess-archive.md, so it stays cheap to read before writing.

**Open reminders** - raise these at the start of a session, and delete each once it's done:
- (2026-11-19) The server is deployed from `main`; the hosted app stays on v2.20.1 until a release is published (`deploy-web.yml` builds `/app` from the last release). The Android phone pass is under way; what is left of it is "This release" in `dev-docs/manual-smoke.md`, the iPhone checks wait until after this release (Alex has no iPhone, someone else will run them), and its findings are beads: `meditation-pal-grfo` (sounds and the mic order: fixed on `main` and installed on his phone as a debug build, waiting on his ears: is the first line whole, is the opening clean in call mode, does the close still waver), `meditation-pal-cs6y` (barge-in, a missed "yes"), `meditation-pal-fz1k` (voice and speech picks per language), `meditation-pal-6ixc` (half of Harper's bill is markup). Left from the pre-release check (`meditation-pal-k8gf`): the closed-test steps on `docs/mobile-beta` and the hero's "closed beta" line when Android goes open. Unseen or unheard by Alex on `main`: the mic's grey breathing look, the noting tab's "Introduction voice" and two-line sound label, a shorter first adaptive round, and the facilitator prompt's sentence about speech recognition (his wording; evaluated the same day: it fixes echoed mishearings on GPT-6 Sol and garbled turns on Haiku, corrects nothing that was right, moves no signal).
- (2026-11-19) Harper and Ethan take a whole reply per request (`CuratedVoice.wholeReply`; "Whole replies" in `dev-docs/ts-server.md`; bead `meditation-pal-6ixc`), about 19% off their bill. On `main`, unheard by Alex, and live only on a server deploy plus a client built after it: an older client keeps sending a sentence at a time and its picker shows the two about 19% low. Azure bills the style tags (checked against its own metric), so the meter is right. Open: Harper's lead check re-rolls about 1 whole reply in 13 on a false alarm (about 4% of her bill); playback position is unverified on a phone. Decided the same day: no GPT previews at every pause (eyes are closed in a session; parked on branch `pending/stt-pause-previews`), GPT stays the default speech-to-text with Parakeet in the picker, and xAI streaming waits until after the release (`meditation-pal-35nr`).
- (2026-11-19) Ethan repeats the end of a line about 1 take in 160, in bursts (bead `meditation-pal-tapb`). Alex's call: he stays as he is for now, no per-utterance check gets built, and Alex will look for a more consistent male voice later.
- (2026-11-16) Never run on a phone: setup voice and stepping out; the volume banner (`output-volume.ts`; on iOS, first check the reading follows the volume buttons); setup lines playing with the mic stream kept open (on an iPhone, listen for a quieter line). See "Phone" and "Voice on the setup screen" in `dev-docs/manual-smoke.md`. The ring on local Whisper is unchecked on desktop too.
- (2026-11-16) Every hosted voice now carries a `gainDb` level trim and the setup clips already play at the new levels; sessions, previews and canned lines follow only when the server deploys, so until then Harper is about 4.5 dB quieter in the tour than in a session.
- (2026-11-16) Harper's softvoice dropped sentence openings at Azure; she now carries a spoken lead (`CuratedVoice.lead`, cut off by `trimLead`), which is committed but unheard by Alex and takes effect only on a server deploy. "That can't change right now." now renders whole behind it. Once he has heard it ("Hm." is the one alternative lead that measured as well), the rest of her setup clips can be re-rendered with `npm run clips:render -- --voice Harper --force --yes`; he is also deciding after a test pass whether Ethan's live mid-clause pauses need a frame-domain pause cap (unbuilt). Grant is refused as a house voice; Luna is the fallback default if Harper ever has to go. Phones start with voice mode off and a silent tour; defaulting them to asleep is the idea on the table.
- (2026-11-18) The Chinese house voices are Dahai 大海 and Xiaoyue 小月; Alex has heard both and they are good. Xiaoyue is the zh default (`zhNative`, Serena's until now) once the server deploys. Dahai is a little quiet, and he will look for a fix or a replacement later (bead `meditation-pal-m0kv`, with the rest of the pass planned for after the mobile release).
- (2026-11-17) Every sound now plays through `<audio>` elements on every platform (da8b85cd, 78341e52; `dev-docs/audio-output.md`), because WebKit's Web Audio output can go silent for good. Measured on desktop, but unheard by Alex anywhere and never run on a phone: echo and barge-in on desktop (the thresholds were tuned on the old path); on Android the close and the chime now follow the Call volume slider; on iPhone a chime under speech, the silent switch, and a cut sound stopping without a fade. What stalled the pipe on 2026-11-17 is still unknown: bead `meditation-pal-wk4u`. Begin's three mic opens are `meditation-pal-uz8t`.

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
- (2026-11-21) The update screen for a build below aloud cloud's minimum ("Minimum client version" in `dev-docs/ts-server.md`; see it with `?sim=outdated-desktop`, `-android`, `-ios`) has Alex's wording and he has seen it in the desktop sim, but it has never run on a device or against a real release. Its iOS button opens TestFlight and must become the App Store URL once that listing is live (`STORE_LISTING` in `ts/ui/src/views/update-block.ts`).
- (2026-11-21) **Alex's ask: once he has run some sessions, look at the costs on the back end and verify the prompt-cache keep-alive is working**, since he would not notice it in a session ("Prompt-cache keep-alive" in `dev-docs/ts-server.md`, `meditation-pal-wb0j`; live on the server and in every 2.21.0 client). The rebadge (Opus 4, GPT speech 1, Harper 2.4; what was measured is in `meditation-pal-bv9p`) he has seen on desktop, not on a phone. One account is still on a build older than v2.11.0 that bills speech-to-text several times over (`meditation-pal-0uw7`); Alex found them and was going to email and refund.
- (2026-11-21) **The Android open beta is one Google review from public.** v2.21.0 is released everywhere else (server, web, desktop on all three platforms). On Play, build 56 was approved onto the open testing track while the track was paused; Alex submitted "Resume track" at about 16:50 and it is in review. Until it lands, the public listing (`https://play.google.com/store/apps/details?id=app.aloud.meditation`) is a 404 for non-testers, while the site already says open beta and links there (`bcfbf712`, pushed). Still to do once the listing is public: Alex tells the closed testers and posts it; then step D of section 1 in `dev-docs/store-submission-checklist.md` (cleanup, on request). If the resume drags on for hours, reverting `bcfbf712` takes the dead link off the site. The repo's Android `versionCode` is 58 though Play has 56 (two re-releases bumped it without a build), which is harmless.
- (2026-11-19) What is left of the Android open beta is section 1 of `dev-docs/store-submission-checklist.md`, written to stand alone; with v2.21.0 out, the iPhone checks and the 中文 pass are next. The night of 2026-11-19 put a stack of mic and audio fixes on `main`, none run on a device, all waiting on his phone and ears: the setup mic waits for the close sound and the Begin prime is 48 kHz (`meditation-pal-grfo`; if the close still wavers, native playback of the sounds is his decision, with two-slider volume and echo cancellation as the costs); a yes/no answer is heard over a question's tail, a no acted on at once and a plain yes after 2 s of quiet, and a preview bubble stays until its own replaces it (`meditation-pal-cs6y`); the tour keeps one recognizer and on a phone opens the ? panels only when silent, with an arrow above the card while there is more below; on hosted recognition, except on an iPhone (`setupCaptureRunsOn` in `voice-start.ts`), the setup capture runs on between turns and a command said over a tour line is heard. Run on his phone on 2026-11-20 (Parakeet) and called basically ready: "next" over a line is taken about 1.2 s later, the first line waits out Android's call-mode mute, and the silent tour's arrow shows and jumps to the controls. Known and accepted: Parakeet takes no vocabulary hints, so it mishears "Harper" ("Happy", "Hopper", "Property") and "back" over a line ("Так"); near misses and that alias are matched in `tour-command.ts`, a tap always works, and someone who never picked a speech model hears the tour on GPT (`setupHostedChoice`, 135aef19; unrun on a phone, and his phone holds a Parakeet pick, so it takes Settings → Advanced → "Reset model and voice picks" to see; in English GPT gets no hint for the tour's words either, `meditation-pal-bpgu`). His fallback if commands over a line prove unreliable for others is stopping the line on any clear speech, costed at about 40 lines more. Still unheard after the same evening's fixes: a session's close and opening on the phone still drop in level (`meditation-pal-grfo` has a lead: the voice's player stops about 7 s into every close; he parked sound quality until after the release). Held by his call until after the release, so open now: the agreed simplifications in the setup voice code (`meditation-pal-abp8`). Still open: `meditation-pal-fz1k` (voice and speech picks per language).
- (2026-11-21) Decided by Alex on 2026-11-21 and on `main`, fine by him on desktop that evening, not run on a phone: the reset buttons in Settings → Advanced (`ts/ui/src/settings-reset.ts`); a setting nobody picked is no longer stored, so it follows later defaults, the voice included ("Stored settings hold only picks" in `dev-docs/dev-cheatsheet.md`; what to look at is in `meditation-pal-72yj`, with the model as the one exception left). Also decided: only the tour listens on GPT for someone who never picked, and the phone pass before the release is waived except the "Yes" check, kept under "Nice to have" in `dev-docs/store-submission-checklist.md`. He does not know whether he tapped the mic at 23:20 (`meditation-pal-dcpx`; the session log now records mutes).
- (2026-11-19) Harper and Ethan take a whole reply per request (`CuratedVoice.wholeReply`; "Whole replies" in `dev-docs/ts-server.md`; bead `meditation-pal-6ixc`), about 19% off their bill. Live on production since the 2026-11-19 deploy and fine by Alex on desktop (2026-11-21); a client older than that deploy's `main` keeps sending a sentence at a time and its picker shows the two about 19% low. Harper's lead check was loosened for whole replies after he heard the takes (6f247120, in v2.21.0). Decided the same day: no GPT previews at every pause (eyes are closed in a session; parked on branch `pending/stt-pause-previews`), Parakeet is the English speech-to-text default from 2026-11-20 (`hostedSttDefault` in `stt-picker.ts`, `meditation-pal-gxk8`; 中文 keeps GPT, and a GPT pick already made stays), and xAI streaming waits until after the release (`meditation-pal-35nr`).
- (2026-11-19) Ethan repeats the end of a line about 1 take in 160, in bursts (bead `meditation-pal-tapb`). Alex's call: he stays as he is for now, no per-utterance check gets built, and Alex will look for a more consistent male voice later.
- (2026-11-16) Never run on a phone: setup voice and stepping out; the volume banner (`output-volume.ts`; on iOS, first check the reading follows the volume buttons); setup lines playing with the mic stream kept open (on an iPhone, listen for a quieter line). See "Phone" and "Voice on the setup screen" in `dev-docs/manual-smoke.md`.
- (2026-11-16) Harper's softvoice dropped sentence openings at Azure; she now carries a spoken lead (`CuratedVoice.lead`, cut off by `trimLead`), which went out in v2.21.0 and is fine by Alex on desktop (2026-11-21). Her setup lines are fine by him too, so no re-render, though she sounds a little too sultry on the first couple. He is researching voice choice: **if he has not brought it up, raise it just before the full store releases** (first item of section 2 in `dev-docs/store-submission-checklist.md`), not every session. He is also deciding after a test pass whether Ethan's live mid-clause pauses need a frame-domain pause cap (unbuilt). Grant is refused as a house voice; Luna is the fallback default if Harper ever has to go. Phones start with voice mode off and a silent tour; defaulting them to asleep is the idea on the table.
- (2026-11-18) The Chinese house voices are Dahai 大海 and Xiaoyue 小月; Alex has heard both and they are good. Xiaoyue is the zh default (`zhNative`) since v2.21.0. Dahai is a little quiet, and he will look for a fix or a replacement later (bead `meditation-pal-m0kv`, with the rest of the pass planned for after the mobile release).
- (2026-11-17) Every sound now plays through `<audio>` elements on every platform (da8b85cd, 78341e52; `dev-docs/audio-output.md`), because WebKit's Web Audio output can go silent for good. Fine by Alex on desktop (2026-11-21; the barge-in misses he heard were the first-voice echo guard, `meditation-pal-u21t`). Never run on a phone: on Android the close and the chime now follow the Call volume slider; on iPhone a chime under speech, the silent switch, and a cut sound stopping without a fade. What stalled the pipe on 2026-11-17 is still unknown: bead `meditation-pal-wk4u`. Begin's three mic opens are `meditation-pal-uz8t`.
- (2026-11-20) The store age check is on `main` and goes out with the next phone build: an account the store says is under 13 gets a blocking screen. Compiled on both platforms, never run on a phone. iOS stays dormant until he turns on the Declared Age Range capability. His console steps (ratings, the capability, the five countries left out, the AI line in the listings) are `meditation-pal-p6ml.1`, due 2027-01-01; the crisis card and the rest of SB 243 come after the Android open beta (`meditation-pal-p6ml`, `dev-docs/age-tier.md`).
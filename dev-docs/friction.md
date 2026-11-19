# Friction log

Things that cost time while working in this repo - layout, tooling, setup. Each
entry says what it cost and what would fix it. Keep it to open items; delete
entries once filed.

Claude: append here when something slows you down and the fix isn't yours to
make in passing. One entry per annoyance, with a proposed fix - if you can't
name a fix, it's probably an observation, not friction. Keep it to the project
and its tooling.

Triage: promote real items to beads (`bd create`) and delete them from here once
filed.

---

*Empty. Last triage 2026-08-21: the manual smoke list shipped as
dev-docs/manual-smoke.md (`meditation-pal-nx1d`, closed). Earlier triage
2026-08-05: session.ts size (`meditation-pal-e89d`), phone-dev cheatsheet section
(`meditation-pal-75p1`), recognizer event fixtures (`meditation-pal-x11x`).*

- **No `bd` in Claude's cloud sessions** (2026-10-12): the container has no bd binary and no Dolt database, so a cloud session can read `.beads/issues.jsonl` but can't create or close beads; findings end up as pasted `bd create` commands (design-push.md). Fix: install bd in the cloud environment's setup script (and pull `refs/dolt/data`), or say in CLAUDE.md that cloud sessions write commands for the dev to run.
- **bd git hook does not stage `.beads/interactions.jsonl`** (bd 1.2.2): the shim's own pre-commit stages nothing at all, so every bd close/update leaves interactions.jsonl dirty. Fixed for this repo on 2026-09-07 by a staging block appended below the managed markers in the tracked `.beads/hooks/pre-commit` - `bd hooks install` preserves it. (The 2026-09-06 patch to `.git/hooks/pre-commit` went dead the moment bd set `core.hooksPath=.beads/hooks`; those orphans are gone.) Upstream beads should stage it.
- **No `cargo check` for the shell in Claude's cloud sessions** (2026-11-10): cargo is installed but the Tauri crate needs webkit2gtk and friends, so a Rust change there can only be compile-checked by copying the touched functions into a scratch crate (done for `format_history` and the init script). Fix: add the Tauri Linux build packages (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libayatana-appindicator3-dev`, `librsvg2-dev`, plus `cmake`/`clang` for whisper-rs) to the cloud environment's setup script, or split the request-free helpers in `ts/src-tauri/src/llm.rs` into a small crate that checks without Tauri.
- **A dev server someone else is running reloads the page under a headless check** (2026-11-14): driving the UI with Playwright against the dev's own Vite while agents edit files in the tree, any save in the module graph is a full reload mid-scenario, which reads as a product bug (the tour "falling back" to its welcome card). The one-time `dev:sw-cleared` reload in `ui/src/main.ts` does the same to every fresh browser context. Fix: have UI check scripts start their own `vite preview` of a build on a spare port, or wait for the second navigation before acting.
- **Nothing typechecks `ts/evals/` or `ts/scripts/`** (2026-11-14): `npm run typecheck` covers core, ui, soak and tests; the server's tsconfig covers `server/`. The eval and script entry points run through tsx, which strips types, so `protocol-eval.ts` has carried a strict-mode error unnoticed (`systemPromptFor` passes `config: fx.config`, possibly undefined, under `exactOptionalPropertyTypes`). Checked by hand with a throwaway tsconfig extending `server/tsconfig.json`. A `scripts` project in the typecheck chain would cover both.
- **The dev's global `bd prime` hook reaches the models under test** (2026-11-19): `scriptClaude` (`ts/soak/providers.ts`) runs `claude -p` from `~/.cache/aloud/claude-cli`, outside the repo, but the SessionStart hook in `~/.claude/settings.json` still fires there and its output lands in the conversation. In a prompt eval Haiku answered "Where should I even start?" with the beads tracker and `bd ready` (2 trials of one arm, 3 of the other), which the eval scored as brevity and open-invitation failures; Opus also read out planning notes ("Garbled transcription; ask briefly.") 3 times per arm on this path and 0 of 6 on the API key. Fix: have the harness start the CLI with hooks and user settings off (whatever the installed CLI offers for that: a settings override with empty hooks, or an isolated config directory), and assert in the soak's own smoke that a one-line prompt comes back without the word "beads".

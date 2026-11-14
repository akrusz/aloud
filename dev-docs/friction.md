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
- **`voice-loop-check.mjs` fails against a dev server that has aloud cloud configured** (2026-11-13): run against `desktop:dev` / `web:dev` with a real `ts/server/.env`, the seeded BYOK session still gets a hosted default voice (the footer shows a ☁ rate), so the first Begin click opens the sign-up modal and "session starts" fails before anything about voice is tested. Fix: seed a browser voice in the script's `preview:setup` (or start its own Hono with no cloud keys), so the pre-release rerun the checklist asks for works on the dev's machine.

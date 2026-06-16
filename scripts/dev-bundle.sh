#!/bin/bash
# Fast local iteration for BUNDLE-SPECIFIC desktop behavior — the things that
# only manifest in a Finder/Launchpad-launched .app and that `npm run tauri:dev`
# can't reproduce: the minimal GUI PATH (which::which on claude/ollama), the app
# icon, DMG art, anything LaunchServices-environment-dependent.
#
# Builds a DEBUG bundle (much faster than a release build, still a real .app) and
# opens it via `open`, which goes through LaunchServices — so the app gets the
# minimal GUI environment, NOT this shell's PATH. That's the faithful repro of
# double-clicking the installed app. (Plain `npm run tauri:dev` inherits your
# terminal PATH, so it can't surface PATH bugs.)
#
# Usage: scripts/dev-bundle.sh
#
# Signing: tauri.conf.json has createUpdaterArtifacts=true, so `tauri build`
# signs the bundle and needs the updater key. We read it from ~/.tauri/aloud.key
# and prompt once for the passphrase (never echoed, never in shell history). To
# build without the key instead, flip createUpdaterArtifacts off temporarily.

set -e

# Run from project root regardless of caller cwd.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

KEY="$HOME/.tauri/aloud.key"
if [ -f "$KEY" ]; then
    export TAURI_SIGNING_PRIVATE_KEY="$(cat "$KEY")"
    if [ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]; then
        printf "  Updater key passphrase: "
        read -rs TAURI_SIGNING_PRIVATE_KEY_PASSWORD
        echo
        export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    fi
else
    echo "  Warning: $KEY not found — the build will fail at signing unless you"
    echo "  flip createUpdaterArtifacts off in tauri.conf.json (see dev-docs/desktop.md)."
fi

echo "  Building debug bundle (app only)…"
(cd ts && npx tauri build --debug --bundles app)

APP="ts/src-tauri/target/debug/bundle/macos/aloud.app"
if [ ! -d "$APP" ]; then
    echo "  Build finished but $APP not found — check the output above." >&2
    exit 1
fi

echo "  Launching via LaunchServices (minimal GUI PATH)…"
open "$APP"

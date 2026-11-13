#!/bin/bash
# Run the desktop app from this checkout: the Tauri shell + Vite UI (:4649)
# with a local aloud cloud (Hono, :8787) beside it, as one process tree
# (ts/scripts/dev.mjs: one Ctrl-C, or closing the window, stops all of it).
# `cd ts && npm run desktop:dev`, runnable from anywhere in the repo, plus two
# things that command leaves to you:
#
#   - installs packages first when the lockfile is newer than node_modules
#     (after a pull that moved it, the old packages would otherwise run);
#   - starts the shell alone when the server can't come up here (no
#     ts/server/.env, or :8787 already taken by a server you are running),
#     instead of letting the server's exit take the app down with it.
#
# Usage: scripts/desktop-dev.sh

set -e

cd "$(dirname "${BASH_SOURCE[0]}")/../ts"

if [ ! -f node_modules/.package-lock.json ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
    echo "  Lockfile is newer than node_modules, installing…"
    # ci, not install: install rewrites the lockfile in this npm's own dialect
    # (11.4 drops the "libc" fields Dependabot's npm writes).
    npm ci
fi

if [ ! -f server/.env ]; then
    echo "  No ts/server/.env: starting the shell without a local aloud cloud."
    exec npm run tauri:dev
fi
if lsof -nP -iTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "  :8787 is already in use: starting the shell against that server."
    exec npm run tauri:dev
fi
exec npm run desktop:dev

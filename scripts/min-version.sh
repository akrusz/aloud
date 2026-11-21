#!/bin/bash
# Show or raise the minimum app version aloud cloud serves per platform
# (ts/server/src/min-client-version.ts), by hand: for when the release's
# pre-release check recommended nothing, was skipped, or the release is being
# finished with 'retry'. When to raise one, and the rule for phones: Part D of
# dev-docs/pre-release-checklist.md.
#
# Usage:
#   scripts/min-version.sh                              show the minimums
#   scripts/min-version.sh desktop=2.21.0 android=2.17.0   raise and commit
#
# A minimum never goes down, and none may be newer than the version being
# released: a release.sh run waiting on 'retry', else the current version. It
# takes effect with the next server deploy, which a release includes.

set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."
. scripts/lib/min-version.sh

case "${1:-}" in
    -h|--help|help) sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

if [ $# -eq 0 ]; then
    for platform in $MIN_VERSION_PLATFORMS; do
        echo "  $platform: $(minver_current "$platform" "$MIN_VERSION_FILE")"
    done
    exit 0
fi

if ! git diff --quiet -- "$MIN_VERSION_FILE" || ! git diff --cached --quiet -- "$MIN_VERSION_FILE"; then
    echo "Error: $MIN_VERSION_FILE has uncommitted changes." >&2
    exit 1
fi

CEILING=$(grep -m1 '"version"' ts/src-tauri/tauri.conf.json | sed -E 's/.*"version": *"([0-9][0-9.]*)".*/\1/')
PENDING="$(git rev-parse --git-dir)/aloud-release-pending/version"
if [ -f "$PENDING" ] && minver_newer "$(cat "$PENDING")" "$CEILING"; then
    CEILING=$(cat "$PENDING")
fi

force_min_versions "$*" "$CEILING"

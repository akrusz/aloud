#!/bin/bash
# Build the web UI and run the app on a connected Android device/emulator.
# Just `cd ts && npm run cap:android:run` (require-cloud-url + ui:build +
# cap sync android + cap run android) runnable from anywhere in the repo.
#
# Usage: scripts/android-run.sh

set -e

cd "$(dirname "${BASH_SOURCE[0]}")/../ts"
npm run cap:android:run

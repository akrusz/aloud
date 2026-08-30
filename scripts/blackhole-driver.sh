#!/usr/bin/env bash
#
# Park / unpark the BlackHole HAL driver.
#
# BlackHole exists on this machine for one reason: the tier-2 soak harness needs
# a loopback device (dev-docs/soak-harness.md). But a loaded HAL driver is a
# permanent candidate default input, and CoreAudio reaches for it whenever the
# real input goes away - after sleep, on unplugging headphones - so between runs
# it quietly becomes the microphone that video calls pick up. Parking moves the
# driver out of the plug-in directory so CoreAudio stops enumerating it; the
# install stays put and unparking is instant.
#
#   scripts/blackhole-driver.sh status | park | unpark
#
# Needs root (it writes to /Library and restarts coreaudiod) and re-execs itself
# under sudo when it doesn't have it. `soak:web` calls it automatically. Don't
# give this path a NOPASSWD sudoers rule - it sits in a writable checkout and
# sudo matches on path, not contents; dev-docs/soak-harness.md has the safe
# variant if the prompts ever get old.

set -euo pipefail

HAL_DIR="/Library/Audio/Plug-Ins/HAL"
PARK_DIR="/Library/Audio/Plug-Ins/HAL-parked"
DRIVER="BlackHole2ch.driver"

usage() {
    echo "usage: $(basename "$0") {status|park|unpark}" >&2
    exit 64
}

[ $# -eq 1 ] || usage
CMD="$1"

status() {
    if [ -d "$HAL_DIR/$DRIVER" ]; then
        echo loaded
    elif [ -d "$PARK_DIR/$DRIVER" ]; then
        echo parked
    else
        echo missing
    fi
}

# status needs no privileges; the moves do.
if [ "$CMD" = "status" ]; then
    status
    exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
    exec sudo "$0" "$CMD"
fi

case "$CMD" in
park)
    case "$(status)" in
    parked) exit 0 ;;
    missing)
        echo "BlackHole isn't installed - nothing to park." >&2
        exit 1
        ;;
    esac
    mkdir -p "$PARK_DIR"
    mv "$HAL_DIR/$DRIVER" "$PARK_DIR/$DRIVER"
    ;;
unpark)
    case "$(status)" in
    loaded) exit 0 ;;
    missing)
        echo "BlackHole isn't installed anywhere this script looks." >&2
        echo "Install it with \`brew install --cask blackhole-2ch\`." >&2
        exit 1
        ;;
    esac
    mv "$PARK_DIR/$DRIVER" "$HAL_DIR/$DRIVER"
    ;;
*)
    usage
    ;;
esac

# coreaudiod enumerates HAL plug-ins at launch and launchd restarts it, so this
# is how a moved driver takes effect. Anything playing audio right now will skip.
killall coreaudiod

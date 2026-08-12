#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Render the committed PNGs from the share/store SVG sources. The SVGs use
# Knewave for the wordmark, so the font must be installed locally
# (assets/fonts or ~/Library/Fonts; the web copy is docs/assets/fonts).
#
# Requires: rsvg-convert (librsvg).
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v rsvg-convert &>/dev/null || { echo "Error: rsvg-convert not found (brew install librsvg)"; exit 1; }

fontcheck() {
    if ! fc-list 2>/dev/null | grep -qi knewave && ! ls ~/Library/Fonts 2>/dev/null | grep -qi knewave; then
        echo "Warning: Knewave not found locally - the wordmark will render in a fallback face."
    fi
}
fontcheck

render() {  # render <svg> <width> <png>
    rsvg-convert -w "$2" "$1" -o "$3"
    echo "→ $3"
}

render "$ROOT/assets/share-card.svg"               1200 "$ROOT/docs/assets/aloud-share.png"
render "$ROOT/assets/store/feature-graphic.svg"    1024 "$ROOT/assets/store/play-feature-graphic-1024x500.png"
render "$ROOT/assets/store/video-title-card.svg"   1080 "$ROOT/assets/store/video-title-card.png"
render "$ROOT/assets/store/video-end-card.svg"     1080 "$ROOT/assets/store/video-end-card.png"

echo "Done."

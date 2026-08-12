#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Generate aloud.app icon from assets/app-icon.svg (the opaque dark rounded-rect
# tile — distinct from the transparent web favicon, ts/ui/public/aloud.png).
# Requires: rsvg-convert (librsvg), iconutil (macOS built-in)
# Install: brew install librsvg
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SVG="$PROJECT_DIR/assets/app-icon.svg"
ICONSET="$PROJECT_DIR/aloud.iconset"
ICNS="$PROJECT_DIR/assets/aloud.icns"

if ! command -v rsvg-convert &>/dev/null; then
    echo "Error: rsvg-convert not found. Install with: brew install librsvg"
    exit 1
fi

mkdir -p "$ICONSET"
mkdir -p "$(dirname "$ICNS")"

# Renders below 512px come from the small sibling (same figure, ring strokes
# +22%) - a hairline ring turns to smudge on the way down. See its header.
SMALL_SVG="$PROJECT_DIR/assets/app-icon-small.svg"

render() {  # render <pixels> <output>
    local src="$SVG"
    [ "$1" -lt 512 ] && src="$SMALL_SVG"
    rsvg-convert -w "$1" -h "$1" "$src" -o "$2"
}

# Generate all required sizes for macOS icon
for size in 16 32 64 128 256 512; do
    render "$size" "$ICONSET/icon_${size}x${size}.png"
done

# Retina variants (e.g., icon_16x16@2x.png is 32px)
for size in 16 32 128 256 512; do
    double=$((size * 2))
    render "$double" "$ICONSET/icon_${size}x${size}@2x.png"
done

iconutil -c icns "$ICONSET" -o "$ICNS"
rm -rf "$ICONSET"

# Also copy to the manual aloud.app bundle if it exists
MANUAL_APP="$PROJECT_DIR/aloud.app/Contents/Resources"
if [ -d "$MANUAL_APP" ]; then
    cp "$ICNS" "$MANUAL_APP/aloud.icns"
    echo "Also copied to: $MANUAL_APP/aloud.icns"
fi

echo "Generated: $ICNS"

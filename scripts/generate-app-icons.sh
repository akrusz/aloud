#!/usr/bin/env bash
set -euo pipefail

# ─────────────────────────────────────────────────
# Regenerate every committed icon raster from the three SVG sources:
#
#   assets/app-icon.svg            rounded dark tile   (desktop / launcher)
#   assets/app-icon-ios.svg        full-bleed opaque   (iOS + store listings)
#   assets/app-icon-android-fg.svg adaptive foreground (transparent)
#
# The Tauri bundle set (ts/src-tauri/icons/) is NOT handled here - it comes from
#   cd ts && npx tauri icon ../assets/app-icon.svg
# Run that too whenever the tile changes.
#
# Requires: rsvg-convert (librsvg), magick (ImageMagick), iconutil (macOS).
# ─────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

TILE="$ROOT/assets/app-icon.svg"
FULL="$ROOT/assets/app-icon-ios.svg"
ANDROID_FG="$ROOT/assets/app-icon-android-fg.svg"

for tool in rsvg-convert magick; do
    command -v "$tool" &>/dev/null || { echo "Error: $tool not found (brew install librsvg imagemagick)"; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ assets/aloud.png, assets/aloud.ico"
rsvg-convert -w 512 -h 512 "$TILE" -o "$ROOT/assets/aloud.png"
for size in 16 32 48 64 128 256; do
    rsvg-convert -w "$size" -h "$size" "$TILE" -o "$TMP/ico_$size.png"
done
magick "$TMP/ico_16.png" "$TMP/ico_32.png" "$TMP/ico_48.png" \
       "$TMP/ico_64.png" "$TMP/ico_128.png" "$TMP/ico_256.png" "$ROOT/assets/aloud.ico"

echo "→ assets/store/play-store-icon-512.png (Play listing; alpha rejected)"
rsvg-convert -w 512 -h 512 "$FULL" -o "$TMP/play.png"
magick "$TMP/play.png" -background '#110d08' -alpha remove -alpha off "$ROOT/assets/store/play-store-icon-512.png"

echo "→ iOS app icon (Capacitor)"
IOS_ICON="$ROOT/ts/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
rsvg-convert -w 1024 -h 1024 "$FULL" -o "$TMP/ios.png"
magick "$TMP/ios.png" -background '#110d08' -alpha remove -alpha off "$IOS_ICON"

echo "→ Android launcher icons (Capacitor)"
RES="$ROOT/ts/android/app/src/main/res"
# foreground layer: 108dp adaptive canvas at each density
declare -a FG_SIZES=("mdpi 108" "hdpi 162" "xhdpi 216" "xxhdpi 324" "xxxhdpi 432")
for entry in "${FG_SIZES[@]}"; do
    set -- $entry
    rsvg-convert -w "$2" -h "$2" "$ANDROID_FG" -o "$RES/mipmap-$1/ic_launcher_foreground.png"
done
# legacy (pre-API-26) launcher icons: the tile, and a circle-masked full-bleed
declare -a LEGACY_SIZES=("mdpi 48" "hdpi 72" "xhdpi 96" "xxhdpi 144" "xxxhdpi 192")
for entry in "${LEGACY_SIZES[@]}"; do
    set -- $entry
    density="$1"; size="$2"; half=$((size / 2))
    rsvg-convert -w "$size" -h "$size" "$TILE" -o "$RES/mipmap-$density/ic_launcher.png"
    rsvg-convert -w "$size" -h "$size" "$FULL" -o "$TMP/round_$size.png"
    magick "$TMP/round_$size.png" \
        \( -size "${size}x${size}" xc:black -fill white -draw "circle $half,$half $half,0" -alpha copy \) \
        -compose CopyOpacity -composite "$RES/mipmap-$density/ic_launcher_round.png"
done

echo "→ macOS .icns"
"$SCRIPT_DIR/generate-icon.sh" >/dev/null

echo "Done. Remember: cd ts && npx tauri icon ../assets/app-icon.svg"

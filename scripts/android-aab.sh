#!/bin/bash
# Build the signed Android release bundle (.aab) for Play Console uploads.
#
# Does the whole dance from dev-docs/mobile-signing.md in one shot:
#   1. syncs versionName in android/app/build.gradle to ts/package.json's
#      version and bumps versionCode by 1 (Play rejects reused versionCodes;
#      pass --no-bump to rebuild the same version, e.g. after a web-only fix
#      you haven't uploaded yet)
#   2. verifies VITE_ALOUD_CLOUD_URL is supplied (env var or ui/.env.production)
#   3. ui:build + cap sync android
#   4. gradlew bundleRelease, signed with android/keystore.properties
#   5. commits the build.gradle version change (only after a successful build,
#      so a failed run leaves nothing durable; only that file, so other
#      in-flight work stays out of it)
#
# Usage: scripts/android-aab.sh [--no-bump]
#
# Output: ts/android/app/build/outputs/bundle/release/app-release.aab

set -e

# Run from project root regardless of caller cwd.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

GRADLE_FILE=ts/android/app/build.gradle
AAB=ts/android/app/build/outputs/bundle/release/app-release.aab

if [ ! -f ts/android/keystore.properties ]; then
    echo "ts/android/keystore.properties not found - bundleRelease would build UNSIGNED" >&2
    echo "and Play would reject it. See dev-docs/mobile-signing.md." >&2
    exit 1
fi

# Capacitor's Gradle modules need JDK 21; Android Studio's bundled JBR is one.
JBR="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
if [ -z "${JAVA_HOME:-}" ] && [ -d "$JBR" ]; then
    export JAVA_HOME="$JBR"
fi

# Version: versionName tracks ts/package.json, versionCode must go up each upload.
VERSION=$(node -p "require('./ts/package.json').version")
CODE=$(sed -n 's/^[[:space:]]*versionCode \([0-9][0-9]*\)$/\1/p' "$GRADLE_FILE")
if [ -z "$CODE" ]; then
    echo "couldn't parse versionCode from $GRADLE_FILE" >&2
    exit 1
fi
if [ "${1:-}" = "--no-bump" ]; then
    echo "keeping versionCode $CODE (--no-bump)"
else
    CODE=$((CODE + 1))
    perl -pi -e "s/^(\s*)versionCode \d+$/\${1}versionCode $CODE/" "$GRADLE_FILE"
    echo "bumped versionCode -> $CODE"
fi
perl -pi -e "s/^(\s*)versionName \".*\"$/\${1}versionName \"$VERSION\"/" "$GRADLE_FILE"
echo "building $VERSION ($CODE)"

(cd ts && npm run cap:require-cloud-url && npm run ui:build && npx cap sync android)
(cd ts/android && ./gradlew bundleRelease)

# Commit the version bump now that there's a bundle worth uploading - a failed
# build leaves it uncommitted, exactly as before. Pathspec commit: only this
# file, so other in-flight work can't get swept in.
if ! git diff --quiet -- "$GRADLE_FILE"; then
    git commit -m "android: versionCode $CODE (v$VERSION)" -- "$GRADLE_FILE"
fi

echo
echo "upload to Play Console -> $AAB"

# Reveal the .aab in Finder, selected, ready to drag into the Play Console.
if command -v open >/dev/null 2>&1 && [ -f "$AAB" ]; then
    open -R "$AAB"
fi

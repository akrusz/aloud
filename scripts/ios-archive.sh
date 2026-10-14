#!/bin/bash
# Build the iOS archive for a TestFlight upload, and (as its own step) upload it.
#
# The CLI path from dev-docs/mobile-signing.md in one shot:
#   0. warns (doesn't block) if HEAD is ahead of the last release tag
#   1. syncs MARKETING_VERSION in the Xcode project to ts/package.json's
#      version (build numbers are assigned at export, so there's nothing else
#      to bump)
#   2. verifies VITE_ALOUD_CLOUD_URL is supplied, then ui:build + cap sync ios
#   3. archives UNSIGNED: with no devices on the team a signed archive fails
#   4. ad-hoc signs the frameworks and the app with App.entitlements, then
#      FAILS unless the archive carries every entitlement in that file. The
#      export signs with what the archive carries and reports success either
#      way, which is how 2.15.0 shipped unable to Sign in with Apple
#   5. commits the version change (only after a good archive; only that file)
#
# Usage: scripts/ios-archive.sh            build and check the archive
#        scripts/ios-archive.sh --upload   sign the archive that's there for
#                                          distribution and send it to App
#                                          Store Connect (needs Xcode signed in)
#
# Output: ts/ios/App/archive/App.xcarchive

set -e

# Run from project root regardless of caller cwd.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

IOS_DIR=ts/ios/App
PBXPROJ=$IOS_DIR/App.xcodeproj/project.pbxproj
ENTITLEMENTS=$IOS_DIR/App/App.entitlements
# Not $IOS_DIR/build: cap sync runs `xcodebuild clean`, which fails on a build/
# the build system didn't create ("Could not delete ... not created by the build
# system"), so every archive after the first broke the next sync.
ARCHIVE=$IOS_DIR/archive/App.xcarchive
APP=$ARCHIVE/Products/Applications/App.app
LOG=$IOS_DIR/archive/archive.log

if ! command -v xcodebuild >/dev/null 2>&1; then
    echo "xcodebuild not found - the iOS archive needs Xcode." >&2
    exit 1
fi

VERSION=$(node -p "require('./ts/package.json').version")

# Every entitlement the app declares has to be in the archive's signature.
check_entitlements() {
    local have missing=0 key
    have=$(codesign -d --entitlements - --xml "$APP" 2>/dev/null || true)
    for key in $(plutil -convert json -o - "$ENTITLEMENTS" \
        | node -p "Object.keys(JSON.parse(require('fs').readFileSync(0, 'utf8'))).join(' ')"); do
        if ! printf '%s' "$have" | grep -q "<key>$key</key>"; then
            echo "the archive is missing the entitlement $key" >&2
            missing=1
        fi
    done
    return $missing
}

if [ "${1:-}" = "--upload" ]; then
    if [ ! -d "$APP" ]; then
        echo "no archive at $ARCHIVE - run scripts/ios-archive.sh first" >&2
        exit 1
    fi
    ARCHIVED=$(/usr/libexec/PlistBuddy -c 'Print :ApplicationProperties:CFBundleShortVersionString' "$ARCHIVE/Info.plist")
    if [ "$ARCHIVED" != "$VERSION" ]; then
        echo "the archive is $ARCHIVED but ts/package.json is $VERSION - rebuild it first" >&2
        exit 1
    fi
    check_entitlements
    echo "uploading $ARCHIVED (archived $(date -r "$ARCHIVE" '+%b %-d %H:%M'))"
    echo "more than a minute or two at 'Preparing to upload' is stuck, not slow:"
    echo "see dev-docs/mobile-signing.md"
    echo
    # -allowProvisioningUpdates mints the distribution cert + profile from the
    # Apple account Xcode is signed in to.
    (cd "$IOS_DIR" && xcodebuild -exportArchive -archivePath archive/App.xcarchive \
        -exportOptionsPlist ExportOptions.plist -exportPath archive/export \
        -allowProvisioningUpdates)
    echo
    echo "uploaded $ARCHIVED - it shows in App Store Connect -> TestFlight once processed"
    exit 0
fi

# iOS ships on its own cadence, so this archive can quietly carry code the
# other platforms' release tag doesn't have. Warn, don't block. The mobile
# scripts' own version commits don't count.
LAST_TAG=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
if [ -n "$LAST_TAG" ]; then
    AHEAD=$(git rev-list --count "$LAST_TAG"..HEAD -- . \
        ":(exclude)$PBXPROJ" ":(exclude)ts/android/app/build.gradle")
    if [ "$AHEAD" -gt 0 ]; then
        echo
        echo "warning: $AHEAD commit(s) since $LAST_TAG - this archive ships code no other"
        echo "platform has released. Cut a release first if they should match."
        echo
    fi
    # release.sh bumps ts/package.json, so archiving before cutting the release
    # stamps the PREVIOUS version on current code.
    if [ "$LAST_TAG" != "v$VERSION" ]; then
        echo "warning: version $VERSION, but the latest release tag is $LAST_TAG."
        echo
    fi
fi

perl -pi -e "s/MARKETING_VERSION = [0-9.]+;/MARKETING_VERSION = $VERSION;/" "$PBXPROJ"
echo "building $VERSION"

(cd ts && npm run cap:require-cloud-url && npm run ui:build && npx cap sync ios)

rm -rf "$ARCHIVE"
mkdir -p "$IOS_DIR/archive"
echo "archiving (a few minutes) - log: $LOG"
if ! (cd "$IOS_DIR" && xcodebuild archive -workspace App.xcworkspace -scheme App \
        -destination "generic/platform=iOS" -archivePath archive/App.xcarchive \
        CODE_SIGNING_ALLOWED=NO) > "$LOG" 2>&1; then
    tail -40 "$LOG" >&2
    echo "archive failed - full log: $LOG" >&2
    exit 1
fi

# An ad-hoc signature is enough to carry the entitlements through; the export
# replaces it with the distribution one. Frameworks first: codesign refuses an
# app whose nested code is unsigned.
codesign -f -s - "$APP"/Frameworks/*.framework
codesign -f -s - --entitlements "$ENTITLEMENTS" "$APP"
check_entitlements

# Commit the version change now that there's an archive worth uploading.
# Pathspec commit: only this file, so other in-flight work can't get swept in.
if ! git diff --quiet -- "$PBXPROJ"; then
    git commit -m "ios: version $VERSION" -- "$PBXPROJ"
fi

echo
echo "archive ready -> $ARCHIVE"
echo "upload to TestFlight: scripts/ios-archive.sh --upload"

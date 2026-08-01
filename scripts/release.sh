#!/bin/bash
# Create a release: bump version, update README links, commit, tag, push,
# and create the GitHub release (which triggers the build workflow).
#
# Usage:
#   scripts/release.sh           # bump patch (default)
#   scripts/release.sh patch     # 0.9.19 → 0.9.20
#   scripts/release.sh minor     # 0.9.19 → 0.10.0
#   scripts/release.sh major     # 0.9.19 → 1.0.0
#   scripts/release.sh rc        # patch bump, marked --prerelease (RC / test build)
#   scripts/release.sh same      # re-release current version
#   scripts/release.sh redo      # re-release with same title (quick fix cycle)
#   scripts/release.sh 1.2.3     # explicit version

set -e

# Run from project root so relative paths (ts/, README.md) resolve
# regardless of the caller's cwd.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Model for the claude CLI calls below (release notes, pre-release check). Pinned
# so a release doesn't depend on whatever the CLI's default happens to be;
# 'opus' is an alias that tracks the latest Opus. Override: ALOUD_RELEASE_MODEL=…
RELEASE_MODEL="${ALOUD_RELEASE_MODEL:-opus}"

# Check for uncommitted changes before prompting for anything
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "Error: uncommitted changes — commit or stash first" >&2
    exit 1
fi

# TS + Rust lint (the Tauri/web stack). The only release gate now that Python is
# gone (meditation-pal-sk8). Guarded so a missing toolchain warns rather than
# blocks.
if [ -f ts/package.json ]; then
    if command -v npm >/dev/null 2>&1; then
        if ! (cd ts && npm run --silent typecheck); then
            echo "Error: TS typecheck failed — fix before releasing" >&2
            exit 1
        fi
    else
        echo "  Warning: npm not found, skipping TS typecheck."
    fi
    if command -v cargo >/dev/null 2>&1; then
        if ! cargo check --manifest-path ts/src-tauri/Cargo.toml --quiet; then
            echo "Error: cargo check failed — fix before releasing" >&2
            exit 1
        fi
        # Supply-chain gate (advisories/bans/licenses/sources); enforced in CI.
        if cargo deny --version >/dev/null 2>&1; then
            if ! (cd ts/src-tauri && cargo deny check); then
                echo "Error: cargo deny found issues — fix before releasing" >&2
                exit 1
            fi
        else
            echo "  Warning: cargo-deny not installed, skipping supply-chain check."
        fi
    else
        echo "  Warning: cargo not found, skipping Rust checks."
    fi
fi

# Read current version from tauri.conf.json (the source of truth)
CURRENT=$(grep -m1 '"version"' ts/src-tauri/tauri.conf.json | sed -E 's/.*"version": *"([0-9][0-9.]*)".*/\1/')
IFS='.' read -r MAJ MIN PAT <<< "$CURRENT"

ARG="${1:-patch}"

REDO=false
PRERELEASE=false
case "$ARG" in
    redo)   VERSION="$CURRENT"; REDO=true ;;
    same)   VERSION="$CURRENT" ;;
    patch)  VERSION="$MAJ.$MIN.$((PAT + 1))" ;;
    rc)     VERSION="$MAJ.$MIN.$((PAT + 1))"; PRERELEASE=true ;;
    minor)  VERSION="$MAJ.$((MIN + 1)).0" ;;
    major)  VERSION="$((MAJ + 1)).0.0" ;;
    *)
        VERSION="${ARG#v}"
        if ! echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$'; then
            echo "Error: version must be same, patch, minor, major, or X.Y.Z" >&2
            exit 1
        fi
        if [ "$VERSION" = "$CURRENT" ]; then
            echo "Error: version is already $CURRENT (use 'same' to re-release)" >&2
            exit 1
        fi
        ;;
esac

BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "main" ]; then
    echo "  Warning: releasing from '$BRANCH', not main"
fi

# Release notes draft, if one gets written below. When set, it's handed to
# `gh release create --notes-file` instead of dropping into gh's editor.
NOTES_FILE=""
cleanup_notes() { [ -n "$NOTES_FILE" ] && rm -f "$NOTES_FILE"; return 0; }
trap cleanup_notes EXIT

if [ "$REDO" = true ]; then
    # Fetch existing release title and age from GitHub
    if command -v gh >/dev/null 2>&1; then
        TITLE=$(gh release view "v${VERSION}" --json name -q .name 2>/dev/null || echo "v${VERSION}")
        # A redo deletes and re-creates the release, which would otherwise drop
        # the notes on the floor. Carry the existing body over.
        OLD_BODY=$(gh release view "v${VERSION}" --json body -q .body 2>/dev/null || echo "")
        if [ -n "$OLD_BODY" ]; then
            NOTES_FILE=$(mktemp -t aloud-relnotes)
            printf '%s\n' "$OLD_BODY" > "$NOTES_FILE"
        fi
        PUBLISHED=$(gh release view "v${VERSION}" --json publishedAt -q .publishedAt 2>/dev/null || echo "")
        if [ -n "$PUBLISHED" ]; then
            PUB_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$PUBLISHED" +%s 2>/dev/null || date -d "$PUBLISHED" +%s 2>/dev/null || echo "0")
            NOW_EPOCH=$(date +%s)
            AGE_MIN=$(( (NOW_EPOCH - PUB_EPOCH) / 60 ))
            if [ "$AGE_MIN" -gt 5 ]; then
                echo ""
                echo "  v${VERSION} was published ${AGE_MIN} minutes ago."
                echo "  Users may have already downloaded it — a patch release is"
                echo "  the right move: scripts/release.sh patch"
                echo ""
                printf "  Redo anyway (not recommended)? [y/N] "
                read -r REPLY
                if [ "$REPLY" != "y" ] && [ "$REPLY" != "Y" ]; then
                    echo "  Aborted."
                    exit 0
                fi
            fi
        fi
    else
        TITLE="v${VERSION}"
    fi
    echo ""
    echo "  Redo v${VERSION}  (on $BRANCH)"
    echo "  Title: $TITLE"
    echo ""
else
    echo ""
    echo "  $CURRENT → $VERSION  (on $BRANCH)"
    echo ""

    # Draft the release notes from what actually landed since the last tag, so
    # the name/notes prompts below aren't a memory exercise. Cheap by
    # construction: the commit log and diffstat go in the prompt, so Claude
    # doesn't have to go spelunking. Skipped silently if anything's missing.
    # (Skipped for RCs - those publish with --generate-notes and never show
    # the drafted body, so it'd be a wasted call.)
    SUGGESTED_NAME=""
    if [ "$PRERELEASE" = false ] && command -v claude >/dev/null 2>&1 && git rev-parse "v${CURRENT}" >/dev/null 2>&1; then
        LOG=$(git log "v${CURRENT}..HEAD" --format='- %s%n%b' 2>/dev/null | head -300)
        STAT=$(git diff --stat "v${CURRENT}..HEAD" 2>/dev/null | tail -40)
        if [ -n "$LOG" ]; then
            echo "  Drafting release notes from ${CURRENT}..HEAD…"
            DRAFT=$(claude --model "$RELEASE_MODEL" -p "Draft release notes for aloud v${VERSION}, covering everything since v${CURRENT}.

Commits:
${LOG}

Diffstat:
${STAT}

Write for users of the app, not for developers: what they can now do or what stopped being broken. Group the user-visible work; drop pure refactors, test-only changes, and dependency bumps unless they change behavior. Read a file only if a commit message is too terse to interpret.

Keep it terse - these are read at a glance. Each bullet is one clause, ideally under 10 words, no trailing explanation of the mechanism. 'Fallback for STT when Silero fails' is the right length; a full sentence is too long.

The title is the release's name, so give it some charm: cute or a little poetic, Title Case, five words at most and ideally two to four. 'Clouds, Explained' and 'The Quiet Part' are good; 'Mic reliability and various model picker improvements' is too long and too flat. Name the release's center of gravity, not every bullet in it.

Output exactly this shape and nothing else:
TITLE: <the name>
then a blank line, then 2-6 lines, each one short bullet starting with '- '.
No headings, no preamble, no closing note. No em-dashes (use ' - ' or a comma). Plain, concrete phrasing." </dev/null 2>/dev/null || echo "")
            SUGGESTED_NAME=$(printf '%s' "$DRAFT" | grep -m1 '^TITLE:' | sed -E 's/^TITLE: *//' || true)
            BULLETS=$(printf '%s' "$DRAFT" | grep '^- ' || true)
            if [ -n "$BULLETS" ]; then
                echo ""
                if [ -n "$SUGGESTED_NAME" ]; then
                    echo "  Suggested name: ${SUGGESTED_NAME}"
                fi
                printf '%s\n' "$BULLETS" | sed 's/^/  /'
                echo ""
                NOTES_FILE=$(mktemp -t aloud-relnotes)
                printf '%s\n' "$BULLETS" > "$NOTES_FILE"
            else
                echo "  (couldn't draft notes - continuing)"
                echo ""
            fi
        fi
    fi

    # 'same' also deletes and re-creates the release. With nothing new to draft
    # from, keep the notes that are already published.
    if [ -z "$NOTES_FILE" ] && [ "$ARG" = "same" ] && command -v gh >/dev/null 2>&1; then
        OLD_BODY=$(gh release view "v${VERSION}" --json body -q .body 2>/dev/null || echo "")
        if [ -n "$OLD_BODY" ]; then
            NOTES_FILE=$(mktemp -t aloud-relnotes)
            printf '%s\n' "$OLD_BODY" > "$NOTES_FILE"
        fi
    fi

    if [ -n "$SUGGESTED_NAME" ]; then
        printf "  Release name [%s] (- for none): " "$SUGGESTED_NAME"
    else
        printf "  Release name (enter for none): "
    fi
    read -r RELEASE_NAME
    if [ -z "$RELEASE_NAME" ]; then
        RELEASE_NAME="$SUGGESTED_NAME"
    elif [ "$RELEASE_NAME" = "-" ]; then
        RELEASE_NAME=""
    fi
    if [ -n "$RELEASE_NAME" ]; then
        TITLE="v${VERSION} - ${RELEASE_NAME}"
    else
        TITLE="v${VERSION}"
    fi

    # The drafted bullets become the release body unless you'd rather write
    # them yourself. "e" opens them in $EDITOR first.
    if [ -n "$NOTES_FILE" ]; then
        printf "  Use these notes? [Y/e=edit/n=write in gh] "
        read -r USE_NOTES
        case "$USE_NOTES" in
            n|N) rm -f "$NOTES_FILE"; NOTES_FILE="" ;;
            e|E) "${EDITOR:-vi}" "$NOTES_FILE"
                 [ -s "$NOTES_FILE" ] || { rm -f "$NOTES_FILE"; NOTES_FILE=""; } ;;
        esac
    fi

    # Pre-release doc/copy check. Default (Enter) runs it via the headless
    # claude CLI (read-only review); "n" skips; "q" bails. If the check finds
    # anything (or is inconclusive), it asks to continue; a clean check proceeds
    # silently. Past that point the script bumps, commits, tags, and pushes.
    printf "  Run the pre-release check? [Y/n/q] "
    read -r PRECHECK
    case "$PRECHECK" in
        q|Q)
            echo "  Aborted."
            exit 0
            ;;
        n|N)
            ;;
        *)
            if command -v claude >/dev/null 2>&1; then
                echo "  Running pre-release check via Claude (changes since v${CURRENT})…"
                echo ""
                CHECK_OUT=$(claude --model "$RELEASE_MODEL" -p "Run the pre-release check. Work through dev-docs/pre-release-checklist.md against the changes since the last release — review the diff and commits in v${CURRENT}..HEAD. Report any documentation or product copy (website, README, privacy policy, store listings, settings UI text, CLAUDE.md, config comments, etc.) that has drifted out of sync with the code, plus downstream consequences. Read the actual files; don't guess. Be concise: a punch list of what needs updating. End your reply with a line that is exactly 'PRERELEASE: CLEAN' if nothing needs updating, or 'PRERELEASE: ISSUES' if anything does." </dev/null)
                printf '%s\n\n' "$CHECK_OUT"
                # Only gate if the check didn't come back explicitly clean
                # (covers found-issues AND any inconclusive/errored output).
                if ! printf '%s' "$CHECK_OUT" | grep -q 'PRERELEASE: CLEAN'; then
                    printf "  Check flagged items above (or was inconclusive). Continue anyway? [y/N] "
                    read -r CONT
                    case "$CONT" in
                        y|Y) ;;
                        *) echo "  Aborted."; exit 0 ;;
                    esac
                fi
            else
                echo "  (claude CLI not found — skipping; review dev-docs/pre-release-checklist.md manually.)"
                echo ""
            fi
            ;;
    esac
fi

# Bump the version across the TS/Rust stack. tauri.conf.json is the source of
# truth (read above); ts/package.json is kept in lockstep so the release
# artifacts carry the same version.
if [ -f ts/src-tauri/tauri.conf.json ]; then
    sed -i.bak "s/\"version\": \"[0-9][0-9.]*\"/\"version\": \"${VERSION}\"/" ts/src-tauri/tauri.conf.json
    rm -f ts/src-tauri/tauri.conf.json.bak
fi
if [ -f ts/package.json ]; then
    # "version" is a unique key here — dependency ranges key on package names
    # ("^x.y.z" values), so a plain substitution hits only the top-level field.
    sed -i.bak "s/\"version\": \"[0-9][0-9.]*\"/\"version\": \"${VERSION}\"/" ts/package.json
    rm -f ts/package.json.bak
fi
# Android (Capacitor) carries its own version pair. Play REJECTS a re-used
# versionCode, so it increments on every run — including 'same'/'redo', which is
# still a fresh upload. See dev-docs/mobile-signing.md.
if [ -f ts/android/app/build.gradle ]; then
    ANDROID_CODE=$(grep -m1 'versionCode ' ts/android/app/build.gradle | sed -E 's/.*versionCode +([0-9]+).*/\1/')
    sed -i.bak -E "s/versionName \"[0-9][0-9.]*\"/versionName \"${VERSION}\"/" ts/android/app/build.gradle
    sed -i.bak -E "s/versionCode +[0-9]+/versionCode $((ANDROID_CODE + 1))/" ts/android/app/build.gradle
    rm -f ts/android/app/build.gradle.bak
    echo "  Android: versionName ${VERSION}, versionCode $((ANDROID_CODE + 1))"
fi
# Update README download links — STABLE releases only, mirroring the updater:
# a prerelease stays off /releases/latest and never force-updates installs, so
# the README likewise keeps pointing at the last stable build (an RC's links
# would otherwise advertise an unfinished build to everyone hitting the repo).
# tauri-action artifact names are aloud_<version>_<arch>.<ext> — replace only
# the version token, keep the arch.
if [ "$PRERELEASE" = false ]; then
    sed -i.bak "s/aloud_[0-9][0-9.]*_/aloud_${VERSION}_/g" README.md
    sed -i.bak "s|download/v[0-9][0-9.]*/|download/v${VERSION}/|g" README.md
    rm -f README.md.bak
    git add README.md
fi
[ -f ts/src-tauri/tauri.conf.json ] && git add ts/src-tauri/tauri.conf.json
[ -f ts/package.json ] && git add ts/package.json
[ -f ts/android/app/build.gradle ] && git add ts/android/app/build.gradle
git diff --cached --quiet || git commit -m "v${VERSION}"

# Re-release: move existing tag to this commit
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
    git tag -d "v${VERSION}"
    git push origin ":refs/tags/v${VERSION}" 2>/dev/null || true
fi
git tag "v${VERSION}"

# Load the SSH key once so the branch + tag pushes don't each re-prompt for
# the passphrase. Reuse the session agent if it already holds a key (the usual
# macOS case — loaded from the keychain, so zero prompts). Only when there's no
# usable agent do we start a throwaway one and load the key a single time:
# --apple-load-keychain pulls a keychain-saved passphrase silently, and
# --apple-use-keychain stores it on first entry so future releases are
# prompt-free. (The Apple flags are macOS-only; the || chain no-ops elsewhere.)
if ! ssh-add -l >/dev/null 2>&1; then
    eval "$(ssh-agent -s)" >/dev/null 2>&1
    trap 'ssh-agent -k >/dev/null 2>&1; cleanup_notes' EXIT
    ssh-add --apple-load-keychain >/dev/null 2>&1 || true
    ssh-add -l >/dev/null 2>&1 || ssh-add --apple-use-keychain 2>/dev/null || ssh-add
fi

echo ""
echo "  Pushing..."

git push
if [ "$ARG" = "same" ] || [ "$REDO" = true ]; then
    git push origin "v${VERSION}" --force
else
    git push origin "v${VERSION}"
fi

# Create GitHub release (triggers build workflow)
if command -v gh >/dev/null 2>&1; then
    echo "  Creating GitHub release..."
    if [ "$ARG" = "same" ] || [ "$REDO" = true ]; then
        gh release delete "v${VERSION}" --yes 2>/dev/null || true
    fi
    if [ "$PRERELEASE" = true ]; then
        # RC: fully non-interactive. --prerelease is set explicitly (no prompt to
        # fat-finger) so it can't land at /releases/latest — the updater endpoint
        # — and force-update existing installs. --generate-notes supplies notes
        # so gh doesn't drop into its interactive flow (which is what kept
        # re-asking the prerelease question even when the flag was passed).
        gh release create "v${VERSION}" --title "$TITLE" --prerelease --generate-notes
    elif [ -n "$NOTES_FILE" ]; then
        gh release create "v${VERSION}" --title "$TITLE" --notes-file "$NOTES_FILE"
    else
        gh release create "v${VERSION}" --title "$TITLE"
    fi
    echo ""
    echo "  Released ${TITLE} — build started ✓"
else
    echo ""
    echo "  Pushed v${VERSION} ✓"
    echo "  Create the release at: https://github.com/akrusz/aloud/releases/new?tag=v${VERSION}"
fi

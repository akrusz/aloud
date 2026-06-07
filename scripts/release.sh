#!/bin/bash
# Create a release: bump version, update README links, commit, tag, push,
# and create the GitHub release (which triggers the build workflow).
#
# Usage:
#   scripts/release.sh           # bump patch (default)
#   scripts/release.sh patch     # 0.9.19 → 0.9.20
#   scripts/release.sh minor     # 0.9.19 → 0.10.0
#   scripts/release.sh major     # 0.9.19 → 1.0.0
#   scripts/release.sh same      # re-release current version
#   scripts/release.sh redo      # re-release with same title (quick fix cycle)
#   scripts/release.sh 1.2.3     # explicit version

set -e

# Run from project root so relative paths (ts/, README.md) resolve
# regardless of the caller's cwd.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

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
case "$ARG" in
    redo)   VERSION="$CURRENT"; REDO=true ;;
    same)   VERSION="$CURRENT" ;;
    patch)  VERSION="$MAJ.$MIN.$((PAT + 1))" ;;
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

if [ "$REDO" = true ]; then
    # Fetch existing release title and age from GitHub
    if command -v gh >/dev/null 2>&1; then
        TITLE=$(gh release view "v${VERSION}" --json name -q .name 2>/dev/null || echo "v${VERSION}")
        PUBLISHED=$(gh release view "v${VERSION}" --json publishedAt -q .publishedAt 2>/dev/null || "")
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
    printf "  Release name (enter for none): "
    read -r RELEASE_NAME
    if [ -n "$RELEASE_NAME" ]; then
        TITLE="v${VERSION} - ${RELEASE_NAME}"
    else
        TITLE="v${VERSION}"
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
                CHECK_OUT=$(claude -p "Run the pre-release check. Work through dev-docs/pre-release-checklist.md against the changes since the last release — review the diff and commits in v${CURRENT}..HEAD. Report any documentation or product copy (website, README, privacy policy, store listings, settings UI text, CLAUDE.md, config comments, etc.) that has drifted out of sync with the code, plus downstream consequences. Read the actual files; don't guess. Be concise: a punch list of what needs updating. End your reply with a line that is exactly 'PRERELEASE: CLEAN' if nothing needs updating, or 'PRERELEASE: ISSUES' if anything does.")
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

# Update README download links
sed -i.bak "s/aloud-[0-9][0-9.]*-/aloud-${VERSION}-/g" README.md
sed -i.bak "s|download/v[0-9][0-9.]*/|download/v${VERSION}/|g" README.md
rm -f README.md.bak

git add README.md
[ -f ts/src-tauri/tauri.conf.json ] && git add ts/src-tauri/tauri.conf.json
[ -f ts/package.json ] && git add ts/package.json
git diff --cached --quiet || git commit -m "v${VERSION}"

# Re-release: move existing tag to this commit
if git rev-parse "v${VERSION}" >/dev/null 2>&1; then
    git tag -d "v${VERSION}"
    git push origin ":refs/tags/v${VERSION}" 2>/dev/null || true
fi
git tag "v${VERSION}"

# Cache SSH passphrase for push/release
eval "$(ssh-agent -s)" > /dev/null 2>&1
ssh-add 2>/dev/null
trap 'ssh-agent -k > /dev/null 2>&1' EXIT

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
    gh release create "v${VERSION}" --title "$TITLE"
    echo ""
    echo "  Released ${TITLE} — build started ✓"
else
    echo ""
    echo "  Pushed v${VERSION} ✓"
    echo "  Create the release at: https://github.com/akrusz/aloud/releases/new?tag=v${VERSION}"
fi

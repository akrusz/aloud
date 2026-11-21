# The minimum app version aloud cloud serves, raised as part of a release
# (Part D of dev-docs/pre-release-checklist.md). The
# pre-release check ends its reply with a recommendation:
#
#   Minimum versions:
#   <a few plain lines of reasoning>
#   MINVERSION: none
#
# or, naming only the platforms to raise, "MINVERSION: desktop=2.21.0
# android=2.17.0". release.sh shows it, asks, and on yes writes the file and
# commits it ahead of the version bump. A minimum never goes down, and only a
# plain X.Y.Z no newer than the release being cut is written.
#
# scripts/min-version.sh raises one by hand (force_min_versions).
#
# Sourced by both from the repo root; ts/tests/release-min-version.test.ts
# exercises it. bash 3.2 (macOS): no associative arrays.

MIN_VERSION_FILE=ts/server/src/min-client-version.ts
MIN_VERSION_PLATFORMS="desktop android ios"

# 0 when $1 is a plain X.Y.Z version.
minver_is_version() {
    printf '%s' "$1" | grep -Eq '^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}$'
}

# 0 when plain version $1 is newer than plain version $2.
minver_newer() {
    local i x y
    for i in 1 2 3; do
        x=$(printf '%s' "$1" | cut -d. -f"$i")
        y=$(printf '%s' "$2" | cut -d. -f"$i")
        x=$((10#$x))
        y=$((10#$y))
        if [ "$x" -gt "$y" ]; then return 0; fi
        if [ "$x" -lt "$y" ]; then return 1; fi
    done
    return 1
}

# The minimum file $2 holds for platform $1, empty when it can't be read. The
# file keeps one platform per line in this exact shape.
minver_current() {
    sed -n "s/^    $1: '\([0-9][0-9.]*\)',\$/\1/p" "$2"
}

# The value of the last "MINVERSION:" line in reply $1, markdown stripped:
# "none", pairs such as "desktop=2.21.0 android=2.17.0", or empty when the
# reply has none.
minver_recommendation() {
    printf '%s\n' "$1" | tr -d '`*' | sed -n 's/^[[:space:]]*MINVERSION:[[:space:]]*//p' | tail -n 1 | sed 's/[[:space:]]*$//'
}

# The reasoning in reply $1: the lines between its last "Minimum versions:"
# line and the MINVERSION line after it.
minver_reasoning() {
    printf '%s\n' "$1" | tr -d '`*' | awk '
        /^[ \t#]*Minimum versions:/ { buf = ""; on = 1; next }
        /^[ \t]*MINVERSION:/ { if (on) out = buf; on = 0; next }
        on && NF { buf = buf $0 "\n" }
        END { printf "%s", out }
    '
}

# Check recommendation $1 against minimum file $2 and release version $3, and
# print one "platform old new" line per minimum it raises. Anything malformed
# (an unknown platform, a version not shaped X.Y.Z, a platform named twice, a
# minimum newer than the release being cut) refuses the whole recommendation:
# status 1, the reason on stderr, nothing printed. A pair at or below the
# current minimum is dropped with a note on stderr.
minver_plan() {
    local rec file=$2 release=$3 pair platform version current seen="" out=""
    rec=$(printf '%s' "$1" | tr 'A-Z,' 'a-z ')
    if [ -z "$rec" ] || [ "$rec" = none ]; then return 0; fi
    if ! minver_is_version "$release"; then
        echo "release version '$release' is not X.Y.Z" >&2
        return 1
    fi
    for pair in $rec; do
        platform=${pair%%=*}
        version=${pair#*=}
        if [ "$platform" = "$pair" ]; then
            echo "'$pair' is not platform=version" >&2
            return 1
        fi
        case " $MIN_VERSION_PLATFORMS " in
            *" $platform "*) ;;
            *) echo "unknown platform '$platform'" >&2; return 1 ;;
        esac
        if ! minver_is_version "$version"; then
            echo "'$version' for $platform is not a version (X.Y.Z)" >&2
            return 1
        fi
        case " $seen " in
            *" $platform "*) echo "$platform is named twice" >&2; return 1 ;;
        esac
        seen="$seen $platform"
        if minver_newer "$version" "$release"; then
            echo "$platform=$version is newer than the release being cut ($release)" >&2
            return 1
        fi
        current=$(minver_current "$platform" "$file")
        if ! minver_is_version "$current"; then
            echo "can't read the $platform minimum in $file" >&2
            return 1
        fi
        if minver_newer "$version" "$current"; then
            out="$out$platform $current $version
"
        else
            echo "  (not lowering $platform: it stays at $current, $version was recommended)" >&2
        fi
    done
    printf '%s' "$out"
}

# Write plan $1 ("platform old new" lines from minver_plan) into file $2, and
# check each line took.
minver_apply() {
    local plan=$1 file=$2 platform old new old_re
    while read -r platform old new; do
        [ -n "$platform" ] || continue
        old_re=$(printf '%s' "$old" | sed 's/\./\\./g')
        sed -i.bak "s/^    $platform: '$old_re',\$/    $platform: '$new',/" "$file"
        rm -f "$file.bak"
        if [ "$(minver_current "$platform" "$file")" != "$new" ]; then
            echo "Error: could not write the $platform minimum into $file" >&2
            return 1
        fi
    done <<EOF
$plan
EOF
}

# The whole step, for release.sh: the check's reply $1, the release version $2.
# Shows the recommendation with its reasoning and asks (Enter is yes); on yes
# writes MIN_VERSION_FILE and commits it. Nothing to raise, or a malformed
# recommendation, changes nothing.
propose_min_versions() {
    local reply=$1 release=$2 rec plan reasoning answer summary
    rec=$(minver_recommendation "$reply")
    if [ -z "$rec" ]; then
        echo "  Minimum versions: the check made no recommendation, so none is raised."
        return 0
    fi
    if ! plan=$(minver_plan "$rec" "$MIN_VERSION_FILE" "$release"); then
        echo "  Minimum versions: ignoring a malformed recommendation (MINVERSION: $rec)."
        return 0
    fi
    if [ -z "$plan" ]; then return 0; fi
    echo ""
    echo "  The pre-release check recommends raising the minimum app version:"
    reasoning=$(minver_reasoning "$reply")
    if [ -n "$reasoning" ]; then printf '%s\n' "$reasoning" | sed 's/^/    /'; fi
    printf '%s\n' "$plan" | awk 'NF { printf "    %s: %s -> %s\n", $1, $2, $3 }'
    printf "  Raise them? [Y/n] "
    read -r answer
    case "$answer" in
        n|N) echo "  Minimum versions left as they are."; return 0 ;;
    esac
    minver_commit "$plan"
}

# Write plan $1 into MIN_VERSION_FILE and commit that file alone.
minver_commit() {
    local plan=$1 summary
    minver_apply "$plan" "$MIN_VERSION_FILE" || return 1
    summary=$(printf '%s\n' "$plan" | awk 'NF { printf "%s%s %s", sep, $1, $3; sep = ", " }')
    git add "$MIN_VERSION_FILE"
    git commit -q -m "min client version: $summary" -- "$MIN_VERSION_FILE"
    echo "  Committed: min client version: $summary"
}

# Raise minimums by hand, whatever the check said: pairs $1 ("desktop=2.21.0
# android=2.17.0"), none newer than version $2. Same rules as a recommended
# raise (minver_plan); a malformed pair is an error here, not ignored.
force_min_versions() {
    local plan
    plan=$(minver_plan "$1" "$MIN_VERSION_FILE" "$2") || return 1
    if [ -z "$plan" ]; then
        echo "  Nothing to raise."
        return 0
    fi
    printf '%s\n' "$plan" | awk 'NF { printf "  %s: %s -> %s\n", $1, $2, $3 }'
    minver_commit "$plan"
}

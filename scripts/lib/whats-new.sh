# Play's upload flow asks for "What's new" and TestFlight's for What to Test:
# print the latest release's notes for copy-paste instead of a scroll back
# through GitHub. Latest STABLE release (gh's default view skips prereleases),
# which is what a store bundle ships. Callers print it last, so it's still on
# screen at the store console.
#
# A bullet that reaches only some platforms starts with a tag naming them:
# "- [iOS] ...", "- [Android] ...", "- [Mobile] ..." (both apps), "- [Desktop]
# ...", "- [Web] ...", or several: "- [iOS, Desktop] ...". GitHub shows every
# bullet, tags and all. Each store's block keeps the untagged bullets and its
# own tagged ones, tag stripped: Apple rejects metadata that names another
# mobile platform (guideline 2.3.10), and Play's users don't need iOS news.
# A tag naming no known platform keeps its bullet out of both stores.

# The release body as one store sees it. $1: ios | android.
notes_for_store() {
    awk -v store="$1" '
        match($0, /^- \[[^]]*\] /) {
            tags = tolower(substr($0, 4, RLENGTH - 5))
            n = split(tags, list, / *, */)
            keep = 0
            for (i = 1; i <= n; i++) {
                if (list[i] == store || list[i] == "mobile") keep = 1
            }
            if (keep) print "- " substr($0, RLENGTH + 1)
            next
        }
        { print }
    '
}

# $@: the stores to print for (ios, android); both when none is given.
print_whats_new() {
    command -v gh >/dev/null 2>&1 || return 0
    local raw tag body store label other block
    raw=$(gh release view --json tagName,body -q '.tagName + "\n" + .body' 2>/dev/null || true)
    [ -n "$raw" ] || return 0
    tag=$(printf '%s\n' "$raw" | head -1)
    body=$(printf '%s\n' "$raw" | tail -n +2)
    [ $# -gt 0 ] || set -- ios android
    for store in "$@"; do
        case "$store" in
            ios) label="App Store / TestFlight"; other='android|google play' ;;
            android) label="Play"; other='iphone|ipad|ios|app store|testflight' ;;
            *) continue ;;
        esac
        block=$(printf '%s\n' "$body" | notes_for_store "$store")
        echo
        echo "what's new for $label ($tag):"
        echo
        printf '%s\n' "$block" | sed 's/^/  /'
        # An untagged bullet that names the other platform got through.
        if printf '%s\n' "$block" | grep -Eiq "\\b($other)\\b"; then
            echo "  (check: a line above names another platform - tag it or reword it)"
        fi
    done
}

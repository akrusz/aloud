# Play's upload flow asks for "What's new": print the latest release's notes
# for copy-paste instead of a scroll back through GitHub. Latest STABLE release
# (gh's default view skips prereleases), which is what a store bundle ships.
# Callers print it last, so it's still on screen at the Play Console.
print_whats_new() {
    command -v gh >/dev/null 2>&1 || return 0
    local notes
    notes=$(gh release view --json tagName,body -q '.tagName + "\n" + .body' 2>/dev/null || true)
    [ -n "$notes" ] || return 0
    echo
    echo "what's new ($(printf '%s\n' "$notes" | head -1)):"
    echo
    printf '%s\n' "$notes" | tail -n +2 | sed 's/^/  /'
}

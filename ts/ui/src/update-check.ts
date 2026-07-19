/**
 * Update check against the public GitHub releases API.
 *
 * Desktop-oriented: the Updates settings section is hidden in web mode
 * (isWebMode), where the app auto-updates on reload. Desktop ships as
 * DMG/MSI/AppImage off GitHub releases, so we fetch the releases list, pick the
 * highest semver tag, and compare to __APP_VERSION__ (baked in from
 * ui/package.json).
 *
 * api.github.com is CORS-enabled and whitelisted in the Tauri CSP connect-src.
 * Public repos need no token; the 60/hr/IP anon limit is ample for a button.
 */

const RELEASES_API = 'https://api.github.com/repos/akrusz/aloud/releases?per_page=20';

/** The human-facing releases page, for the "view release" link. */
export const RELEASES_PAGE = 'https://github.com/akrusz/aloud/releases/latest';

export interface UpdateResult {
    /** 'current' = running the newest (or a newer) release; 'available' = a
     *  newer release exists; 'error' = the check couldn't complete. */
    state: 'current' | 'available' | 'error';
    /** The running version, e.g. "1.0.5". */
    current: string;
    /** The newest release tag found (without a leading "v"), when known. */
    latest?: string | undefined;
}

type Triple = [number, number, number];

/** "v1.2.3" / "1.2.3-rc.1" → [major, minor, patch]. The pre-release suffix is
 *  dropped: full SemVer precedence isn't needed for a release nudge. */
function parseVersion(tag: string): Triple | null {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(tag);
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** True iff a is strictly newer than b. Literal tuple indices (not a loop) so
 *  the element type stays `number` under noUncheckedIndexedAccess. */
function isNewer(a: Triple, b: Triple): boolean {
    if (a[0] !== b[0]) return a[0] > b[0];
    if (a[1] !== b[1]) return a[1] > b[1];
    return a[2] > b[2];
}

export async function checkForUpdate(): Promise<UpdateResult> {
    const current = __APP_VERSION__;
    const cur = parseVersion(current);
    try {
        const resp = await fetch(RELEASES_API, {
            headers: { Accept: 'application/vnd.github+json' },
        });
        if (!resp.ok) return { state: 'error', current };
        const releases = (await resp.json()) as Array<{
            tag_name?: string;
            draft?: boolean;
            prerelease?: boolean;
        }>;
        // Highest semver among stable releases only, so we never recommend a
        // beta/RC. A user on a pre-release ahead of latest stable reads as up
        // to date: we nudge toward stable, never sideways or back.
        let best: Triple | null = null;
        let bestTag: string | undefined;
        for (const r of releases) {
            if (r.draft || r.prerelease || !r.tag_name) continue;
            const v = parseVersion(r.tag_name);
            if (!v) continue;
            if (!best || isNewer(v, best)) {
                best = v;
                bestTag = r.tag_name.replace(/^v/, '');
            }
        }
        // No stable release, or our own version won't parse: nothing to
        // recommend, so report up to date rather than an error.
        if (!best || !cur) return { state: 'current', current, latest: bestTag };
        return { state: isNewer(best, cur) ? 'available' : 'current', current, latest: bestTag };
    } catch {
        return { state: 'error', current };
    }
}

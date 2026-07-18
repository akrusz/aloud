/**
 * Hidden developer mode.
 *
 * Unlocked (and re-locked) by tapping the version line in the About box 7
 * times; persisted in localStorage. Gates the Developer section in Settings
 * and the in-session check-in debug HUD — quality-of-life switches for
 * working on the app that must not be visible to someone who just installed
 * it, so there is deliberately no ordinary settings checkbox for it.
 *
 * SECURITY: dev mode only gates presentation of debug conveniences that are
 * harmless anywhere (a pacing HUD, a fake update banner). The dev-BUILD-only
 * overrides (?mode=, ?dev cloud bypass) keep their compile-time
 * import.meta.env.DEV gate in app-mode.ts — enabling dev mode in a release
 * build cannot reach them; their Developer-section rows simply don't exist
 * in release bundles.
 */

const DEV_MODE_KEY = 'aloud:devMode';
const DEBUG_CHECKIN_KEY = 'aloud:debugCheckin';

/** Taps on the About-box version line needed to toggle dev mode. */
export const DEV_MODE_TAPS = 7;

export function isDevMode(): boolean {
    try {
        return localStorage.getItem(DEV_MODE_KEY) === '1';
    } catch {
        return false;
    }
}

export function setDevMode(on: boolean): void {
    try {
        if (on) localStorage.setItem(DEV_MODE_KEY, '1');
        else localStorage.removeItem(DEV_MODE_KEY);
    } catch {
        /* storage unavailable — dev mode just won't persist */
    }
}

/**
 * Whether the in-session check-in/[WAIT] HUD should mount: the persisted
 * Developer-section toggle, or a `?debug=checkin` (also `1`, `true`,
 * `pacing`) URL param for browser sessions.
 */
export function isCheckinDebugOn(): boolean {
    try {
        const q = new URLSearchParams(location.search).get('debug') ?? '';
        if (/^(1|true|checkin|pacing)$/i.test(q)) return true;
        return localStorage.getItem(DEBUG_CHECKIN_KEY) === '1';
    } catch {
        return false;
    }
}

/** The persisted HUD toggle alone (what the Developer checkbox renders —
 *  a URL param shouldn't show as a checked setting). */
export function getCheckinDebugSetting(): boolean {
    try {
        return localStorage.getItem(DEBUG_CHECKIN_KEY) === '1';
    } catch {
        return false;
    }
}

export function setCheckinDebug(on: boolean): void {
    try {
        if (on) localStorage.setItem(DEBUG_CHECKIN_KEY, '1');
        else localStorage.removeItem(DEBUG_CHECKIN_KEY);
    } catch {
        /* ignore */
    }
}

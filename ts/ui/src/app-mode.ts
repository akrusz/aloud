/**
 * Effective app mode — 'web' (the hosted demo: Ollama and BYOK providers hidden
 * by default, keys behind the "use my own keys" toggle) vs 'local' (desktop /
 * full dev: every provider available, Ollama + APIs on).
 *
 * The build default is whether an aloud cloud URL was baked in
 * (cloud-base.isCloudBuild): a hosted build defaults to 'web', a plain
 * dev/desktop build to 'local'.
 *
 * For DEVELOPMENT you can force either mode at runtime — no rebuild, no settings
 * change — with a `?mode=` query param, remembered for the tab so it survives
 * in-app navigation:
 *   ?mode=web     force web mode
 *   ?mode=local   force local mode
 *   ?mode=auto    clear the override (back to the build default)
 * Open two tabs to run both modes side by side off one dev server.
 *
 * SECURITY: the override is DEV-ONLY. `vite build` sets import.meta.env.DEV to
 * false, so in any deployed build readOverride() short-circuits to null (and the
 * branch tree-shakes away) — a visitor to the hosted site CANNOT force local
 * mode to unlock Ollama or skip the BYOK opt-in. Web mode is locked in by the
 * build default (isCloudBuild) with no runtime way around it. No config to
 * maintain; it's enforced at compile time.
 */

import { isCloudBuild } from './cloud-base.js';

export type AppMode = 'web' | 'local';

const OVERRIDE_KEY = 'dev:appMode';

/** Read the dev override from the URL (?mode=) or its remembered value, and
 *  persist a URL-supplied one for the tab. Returns null when none is active. */
function readOverride(): AppMode | null {
    // Hard-disabled outside development (see SECURITY note above).
    if (!import.meta.env.DEV) return null;
    try {
        const q = new URL(window.location.href).searchParams.get('mode');
        if (q === 'web' || q === 'local') {
            sessionStorage.setItem(OVERRIDE_KEY, q);
            return q;
        }
        if (q === 'auto') sessionStorage.removeItem(OVERRIDE_KEY);
        const stored = sessionStorage.getItem(OVERRIDE_KEY);
        if (stored === 'web' || stored === 'local') return stored;
    } catch {
        /* no window/sessionStorage (e.g. unit tests) — use the build default */
    }
    return null;
}

/**
 * Capture a `?mode=` override into sessionStorage at boot. MUST run before the
 * SPA router normalizes the URL (it replaceState()s the query string away on
 * the initial deep-link), otherwise readOverride() would never see the param.
 * Call once, early, from main.ts.
 */
export function initAppMode(): void {
    readOverride();
}

/** The active mode: a dev override if set, else the build default. */
export function appMode(): AppMode {
    return readOverride() ?? (isCloudBuild() ? 'web' : 'local');
}

export function isWebMode(): boolean {
    return appMode() === 'web';
}

/** True iff a runtime override is forcing the mode — used to surface a small
 *  "dev: web mode" badge so it's obvious you're not seeing the build default. */
export function isModeOverridden(): boolean {
    return readOverride() !== null;
}

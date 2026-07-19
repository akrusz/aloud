/**
 * Effective app mode: 'web' (hosted browser deploy - Ollama hidden, BYOK behind
 * an opt-in toggle) vs 'local' (desktop / dev - every provider available).
 *
 * The build default is the environment, NOT whether a cloud URL is baked in:
 * aloud cloud ships in every build, so its presence can't signal "web".
 *
 * In development, `?mode=web` / `?mode=local` / `?mode=auto` force or clear the
 * mode, remembered for the tab so it survives in-app navigation - two tabs can
 * run both modes off one dev server.
 *
 * SECURITY: the override is DEV-ONLY. `vite build` sets import.meta.env.DEV
 * false, so readOverride() short-circuits to null and tree-shakes away; a
 * hosted visitor cannot force local mode to unlock Ollama or skip the BYOK
 * opt-in. Enforced at compile time, no config to maintain.
 */

import { isTauri } from './is-desktop.js';

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

const BYPASS_KEY = 'dev:cloudBypass';

/**
 * DEV-only cloud sign-in bypass. With `?dev` in the URL (remembered for the tab,
 * like ?mode=), cloud services authenticate through the server's local
 * `/auth/dev` account instead of interactive Google/Apple sign-in - so you can
 * start a hosted session in a browser where the sign-in popup won't work (e.g.
 * Brave) without spending a real account's credits. Clear with `?dev=off`.
 *
 * SECURITY: same compile-time gate as readOverride, so this is false and
 * tree-shaken in any deployed build. `/auth/dev` is itself local-only (404 in
 * production server mode), so even a forced-true couldn't mint a real token.
 */
export function isDevBypass(): boolean {
    if (!import.meta.env.DEV) return false;
    try {
        const q = new URL(window.location.href).searchParams.get('dev');
        if (q === 'off' || q === '0') {
            sessionStorage.removeItem(BYPASS_KEY);
            return false;
        }
        if (q !== null) {
            sessionStorage.setItem(BYPASS_KEY, '1');
            return true;
        }
        return sessionStorage.getItem(BYPASS_KEY) === '1';
    } catch {
        return false;
    }
}

/**
 * DEV-build-only accessors for the Developer settings section: the Tauri dev
 * webview has no URL bar to type `?mode=` / `?dev` into, so the section offers
 * the same overrides as controls. No-ops in release builds, like the URL
 * readers above. Overrides take effect on reload.
 */
export function devGetModeOverride(): AppMode | 'auto' {
    if (!import.meta.env.DEV) return 'auto';
    try {
        const stored = sessionStorage.getItem(OVERRIDE_KEY);
        return stored === 'web' || stored === 'local' ? stored : 'auto';
    } catch {
        return 'auto';
    }
}

export function devSetModeOverride(mode: AppMode | 'auto'): void {
    if (!import.meta.env.DEV) return;
    try {
        if (mode === 'auto') sessionStorage.removeItem(OVERRIDE_KEY);
        else sessionStorage.setItem(OVERRIDE_KEY, mode);
    } catch {
        /* ignore */
    }
}

export function devSetCloudBypass(on: boolean): void {
    if (!import.meta.env.DEV) return;
    try {
        if (on) sessionStorage.setItem(BYPASS_KEY, '1');
        else sessionStorage.removeItem(BYPASS_KEY);
    } catch {
        /* ignore */
    }
}

/**
 * Capture `?mode=` / `?dev` overrides into sessionStorage at boot. MUST run
 * before the SPA router normalizes the URL (it replaceState()s the query string
 * away on the initial deep-link), otherwise the readers would never see the
 * param. Call once, early, from main.ts.
 */
export function initAppMode(): void {
    readOverride();
    if (isDevBypass()) {
        // eslint-disable-next-line no-console
        console.info('[aloud] dev cloud-bypass ON — cloud services use the local /auth/dev account (no sign-in). Clear with ?dev=off.');
    }
}

/** The active mode: a dev override if set, else the build default. */
export function appMode(): AppMode {
    return readOverride() ?? buildDefaultMode();
}

/** Build default, independent of any baked-in cloud URL. The Tauri shell and
 *  the dev server are 'local'; a production browser build is 'web'. */
function buildDefaultMode(): AppMode {
    if (isTauri() || import.meta.env.DEV) return 'local';
    return 'web';
}

export function isWebMode(): boolean {
    return appMode() === 'web';
}

/** True iff a runtime override is forcing the mode; drives the "dev: web mode"
 *  badge so it's obvious you're not seeing the build default. */
export function isModeOverridden(): boolean {
    return readOverride() !== null;
}

/**
 * Effective app mode — 'web' (the hosted demo: Ollama and BYOK providers hidden
 * by default, keys behind the "use my own keys" toggle) vs 'local' (desktop /
 * full dev: every provider available, Ollama + APIs on).
 *
 * The build default is the environment, NOT whether a cloud URL is baked in:
 * aloud cloud is available in EVERY build (web, desktop, mobile), so its
 * presence can't signal "web". Web mode = a hosted browser deployment (the
 * website, a mobile webview). The desktop (Tauri) shell and the dev server are
 * 'local' — they have on-device STT/TTS and local LLM providers, with cloud
 * still available as one provider among many.
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
 * build default with no runtime way around it. No config to maintain; it's
 * enforced at compile time.
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
 * `/auth/dev` account instead of requiring interactive Google/Apple sign-in — so
 * you can start a hosted-STT/LLM/TTS session in a browser where the sign-in
 * popup won't work (e.g. Brave) without spending a real account's credits. Clear
 * it with `?dev=off`.
 *
 * SECURITY: same compile-time gate as readOverride — `vite build` sets
 * import.meta.env.DEV false, so this short-circuits to false (and tree-shakes
 * away) in any deployed build. A hosted visitor can never skip sign-in. The
 * `/auth/dev` route it leans on is itself local-only (404 in production server
 * mode), so even a forced-true couldn't mint a token against real infra.
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
 * DEV-build-only accessors for the Developer settings section — the Tauri dev
 * webview has no URL bar to type `?mode=` / `?dev` into, so the section offers
 * the same overrides as controls. No-ops (and tree-shaken) in release builds,
 * exactly like the URL readers above. Overrides take effect on reload.
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

/** Build default, independent of any baked-in cloud URL (cloud ships in every
 *  build). The desktop shell (Tauri, on-device providers) and the dev server are
 *  'local'; a production browser build (website / mobile webview) is 'web'. */
function buildDefaultMode(): AppMode {
    if (isTauri() || import.meta.env.DEV) return 'local';
    return 'web';
}

export function isWebMode(): boolean {
    return appMode() === 'web';
}

/** True iff a runtime override is forcing the mode — used to surface a small
 *  "dev: web mode" badge so it's obvious you're not seeing the build default. */
export function isModeOverridden(): boolean {
    return readOverride() !== null;
}

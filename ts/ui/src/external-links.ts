/**
 * Route external-link clicks (http/https/mailto) out of the app webview so
 * they land in the system browser / an in-app browser instead of taking over
 * the app window.
 *
 *   - Desktop (Tauri)  → the opener plugin (system browser / mail client).
 *   - Native mobile (Capacitor) → @capacitor/browser (in-app SFSafariViewController
 *     / Chrome Custom Tab), so the user stays in the app and returns when done.
 *
 * Both webviews otherwise swallow these clicks — `<a href="https://…">` does
 * nothing, `target="_blank"` is blocked, and a plain navigation would strand
 * the user on the external page with no way back into the app. Outside those
 * shells (dev/web) this whole module is a no-op and the browser handles the
 * click as usual.
 *
 * Internal links (`href="#…"`, `href="/…"`, `data-nav="…"`, anything
 * without an explicit external scheme) fall through untouched.
 */

import { isTauri, isCapacitor } from './is-desktop.js';

const EXTERNAL_SCHEME = /^(?:https?:|mailto:)/i;

// Lazy-load the opener plugin so non-Tauri builds (web preview, tests)
// don't pull it in. The import is fired on first use — boot stays free of
// one more network/round trip. Shared by the click handler and openExternal.
let openUrl: ((url: string) => Promise<unknown>) | null = null;
let loading: Promise<void> | null = null;
function ensureOpener(): Promise<void> {
    if (openUrl || loading) return loading ?? Promise.resolve();
    loading = import('@tauri-apps/plugin-opener')
        .then((m) => {
            openUrl = m.openUrl;
        })
        .catch(() => {
            /* leave openUrl null; the open will just be a no-op */
        });
    return loading;
}

// Lazy-load @capacitor/browser the same way, only inside the native app.
let capBrowser: typeof import('@capacitor/browser').Browser | null = null;
let capLoading: Promise<void> | null = null;
function ensureCapBrowser(): Promise<void> {
    if (capBrowser || capLoading) return capLoading ?? Promise.resolve();
    capLoading = import('@capacitor/browser')
        .then((m) => {
            capBrowser = m.Browser;
        })
        .catch(() => {
            /* leave capBrowser null; the open will just be a no-op */
        });
    return capLoading;
}

/**
 * Open a URL outside the app webview when running in a shell that would
 * otherwise swallow or be taken over by the navigation (Tauri desktop, or the
 * Capacitor native app). Returns true if it handled the open. Outside those
 * shells this is a no-op and returns false, so callers can fall back to an
 * in-page navigation (`window.location.assign`).
 *
 * On Capacitor a true return is also the signal the buy-credits modal uses to
 * enter its "finish in your browser, we'll poll for the credits" waiting state
 * (mirroring desktop) — Stripe can't redirect back into the app's custom-scheme
 * origin, so fulfilment is detected by polling /me, not by a return URL.
 */
export async function openExternal(url: string): Promise<boolean> {
    if (isCapacitor()) {
        await ensureCapBrowser();
        if (!capBrowser) return false;
        await capBrowser.open({ url });
        return true;
    }
    if (!isTauri()) return false;
    await ensureOpener();
    if (!openUrl) return false;
    await openUrl(url);
    return true;
}

export function initExternalLinks(): void {
    if (!isTauri() && !isCapacitor()) return;

    document.addEventListener(
        'click',
        (e) => {
            const target = e.target as Element | null;
            const a = target?.closest<HTMLAnchorElement>('a[href]');
            if (!a) return;
            const href = a.getAttribute('href') ?? '';
            if (!EXTERNAL_SCHEME.test(href)) return;
            // The webview won't navigate to an external scheme on its own,
            // so we don't need to fight the default — but preventDefault is
            // belt-and-suspenders against any future config that would.
            e.preventDefault();
            void openExternal(href);
        },
        // Bubble phase: the tauri-chrome drag guard runs in capture and may
        // cancel post-drag clicks before us; we want that to keep working.
        false
    );
}

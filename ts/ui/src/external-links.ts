/**
 * Route external-link clicks (http/https/mailto) out of the app webview.
 *
 *   - Desktop (Tauri)  → the opener plugin (system browser / mail client).
 *   - Native mobile (Capacitor) → @capacitor/browser (in-app SFSafariViewController
 *     / Chrome Custom Tab), so the user stays in the app and returns when done.
 *
 * Both webviews otherwise swallow these clicks: `<a href="https://…">` does
 * nothing, `target="_blank"` is blocked, and a plain navigation would strand
 * the user with no way back. No-op outside those shells; internal links fall
 * through untouched.
 */

import { isTauri, isCapacitor } from './is-desktop.js';

const EXTERNAL_SCHEME = /^(?:https?:|mailto:)/i;

// Lazy-load the opener plugin on first use so non-Tauri builds (web preview,
// tests) don't pull it in and boot stays free of the round trip.
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
 * Returns true if it handled the open. False outside Tauri/Capacitor, so
 * callers can fall back to `window.location.assign`.
 *
 * On Capacitor a true return is also the signal the buy-credits modal uses to
 * enter its "finish in your browser, we'll poll for the credits" waiting state:
 * Stripe can't redirect back into the app's custom-scheme origin, so fulfilment
 * is detected by polling /me, not by a return URL.
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
            // The webview won't navigate to an external scheme on its own;
            // preventDefault guards against a future config that would.
            e.preventDefault();
            void openExternal(href);
        },
        // Bubble phase: the tauri-chrome drag guard runs in capture and may
        // cancel post-drag clicks before us; we want that to keep working.
        false
    );
}

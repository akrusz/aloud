/**
 * Route external-link clicks (http/https/mailto) through Tauri's opener
 * plugin so they land in the system browser / mail client.
 *
 * The webview otherwise swallows these clicks — `<a href="https://…">`
 * does nothing, `target="_blank"` is blocked. Outside Tauri (dev/web)
 * this whole module is a no-op and the browser handles the click as
 * usual.
 *
 * Internal links (`href="#…"`, `href="/…"`, `data-nav="…"`, anything
 * without an explicit external scheme) fall through untouched.
 */

import { isTauri } from './is-desktop.js';

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

/**
 * Open a URL in the system browser when running in the Tauri webview, where
 * a normal navigation would either be swallowed or take over the whole app
 * window. Outside Tauri this is a no-op and returns false, so callers can
 * fall back to an in-page navigation (`window.location.assign`).
 */
export async function openExternal(url: string): Promise<boolean> {
    if (!isTauri()) return false;
    await ensureOpener();
    if (!openUrl) return false;
    await openUrl(url);
    return true;
}

export function initExternalLinks(): void {
    if (!isTauri()) return;

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

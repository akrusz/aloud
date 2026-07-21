import './style.css';
import { bootApp } from './app.js';
import { applyTheme, initThemeToggle, resolveTheme, watchSystemTheme } from './theme.js';
import { regenerateEmbers } from './embers.js';
import { initAbout } from './about.js';
import { isTauri, capacitorPlatform } from './is-desktop.js';
import { initTauriWindowDrag } from './tauri-chrome.js';
import { initExternalLinks } from './external-links.js';
import { initAppMode } from './app-mode.js';
import { initAndroidBack } from './android-back.js';

// Capture a dev `?mode=` override (app-mode.ts) NOW, before bootApp's router
// strips the query string off the initial URL.
initAppMode();

// Stamp the native platform on <html> for CSS that differs per OS - e.g.
// Android reserves the full bottom safe-area inset (system nav bar) where
// iOS trims the home-indicator inset (app-base.css --safe-bottom-clear).
const nativePlatform = capacitorPlatform();
if (nativePlatform !== 'web') {
    document.documentElement.dataset.platform = nativePlatform;
}

// Android hardware/gesture back walks in-app history instead of exiting.
initAndroidBack();

// Dev only: the dev server shares port 4649 with the retired app, whose service
// worker may still be registered from a past session - it would shadow Vite
// with stale cached assets (the classic "unstyled page until a hard reload").
// Unregister it, drop its caches, reload once (loop-guarded).
if (import.meta.env.DEV && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.getRegistrations().then(async (regs) => {
        if (regs.length === 0) return;
        await Promise.all(regs.map((r) => r.unregister()));
        if ('caches' in window) {
            const keys = await caches.keys();
            await Promise.all(keys.map((k) => caches.delete(k)));
        }
        if (!sessionStorage.getItem('dev:sw-cleared')) {
            sessionStorage.setItem('dev:sw-cleared', '1');
            location.reload();
        }
    });
}

// Tag the document for the Tauri shell so CSS can apply app-like chrome (block
// text selection, etc.), before first paint to avoid a flash of web chrome.
if (isTauri()) {
    document.documentElement.setAttribute('data-shell', 'tauri');
    // The overlaid title bar (traffic lights over the webview's top-left) is
    // macOS-only - lib.rs gates title_bar_style(Overlay) on Darwin. Only macOS
    // should pad the nav clear of the buttons; Windows/Linux have a native
    // title bar and must not get that left gap.
    if (/Mac|iPhone|iPad/.test(navigator.platform || '')) {
        document.documentElement.setAttribute('data-titlebar', 'overlay');
    }
}

// Apply theme before the app renders so the FOUC is invisible.
applyTheme(resolveTheme());
// Embers are session-only (the session view mounts the container).
// regenerateEmbers is a no-op with no active session, so the theme toggle
// handler below is safe to call it.

/**
 * Measure the floating top chrome's true midline from the brand chip's box and
 * publish it as --top-chrome-mid, overriding the CSS estimate. The estimate
 * can't be exact: the Knewave webfont's metrics (and when it finishes loading)
 * change the chip's height. Fixed top-center chips (setup "?", session phase)
 * center on this so brand, chip, and orb share one midline.
 */
function syncTopChromeMid(): void {
    const brand = document.querySelector<HTMLElement>('.nav-brand');
    if (!brand) return;
    const rect = brand.getBoundingClientRect();
    if (rect.height === 0) return;
    document.documentElement.style.setProperty(
        '--top-chrome-mid',
        `${rect.top + rect.height / 2}px`
    );
}

function setupGlobalChrome(): void {
    const btn = document.querySelector<HTMLElement>('[data-theme-toggle]');
    if (btn) initThemeToggle(btn);
    initAbout();
    initTauriWindowDrag();
    initExternalLinks();
    // Follow OS-level theme flips (e.g. macOS Auto at sunset) without a
    // refresh. The watcher respects Settings/sticky and recent manual toggles.
    watchSystemTheme(() => regenerateEmbers());
    syncTopChromeMid();
    // Re-measure once the brand webfont lands (its metrics move the midline)
    // and on viewport changes (rotation, browser chrome show/hide).
    document.fonts?.ready.then(syncTopChromeMid).catch(() => {});
    window.addEventListener('resize', syncTopChromeMid);
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupGlobalChrome, { once: true });
} else {
    setupGlobalChrome();
}

// The ember palette differs between light/dark, so regenerate on a theme flip
// instead of waiting for the current particles to expire.
document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-theme-toggle]')) {
        // initThemeToggle has already changed the theme.
        regenerateEmbers();
    }
});

bootApp().catch((err) => {
    console.error('App init failed:', err);
    const status = document.getElementById('status');
    if (status) status.textContent = `Init error: ${(err as Error).message}`;
});

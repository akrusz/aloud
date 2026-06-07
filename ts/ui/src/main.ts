import './style.css';
import { bootApp } from './app.js';
import { applyTheme, initThemeToggle, resolveTheme, watchSystemTheme } from './theme.js';
import { regenerateEmbers } from './embers.js';
import { initAbout } from './about.js';
import { isTauri } from './is-desktop.js';
import { initTauriWindowDrag } from './tauri-chrome.js';
import { initExternalLinks } from './external-links.js';
import { initAppMode } from './app-mode.js';

// Capture a dev `?mode=` override (app-mode.ts) NOW, before bootApp's router
// strips the query string off the initial URL.
initAppMode();

// Dev only: clear any service worker controlling this origin. The dev server
// now shares port 4649 with the retired Flask app, whose service worker may
// still be registered in the browser from a past session — it would shadow
// Vite with stale cached assets (the classic "unstyled page until a hard
// reload"). Unregister it + drop its caches, then reload once (loop-guarded)
// so the page is served fresh. No-op once nothing is registered.
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

// Tag the document for the Tauri desktop shell so CSS can apply app-like
// chrome (block text selection, etc.). Set before first paint to avoid a flash
// of selectable web chrome.
if (isTauri()) {
    document.documentElement.setAttribute('data-shell', 'tauri');
    // The overlaid title bar (traffic lights drawn over the top-left of the
    // webview) is macOS-only — lib.rs gates title_bar_style(Overlay) on Darwin.
    // Mark it so only macOS pads the nav clear of the buttons; Windows/Linux
    // have a normal native title bar and must not get that left gap.
    if (/Mac|iPhone|iPad/.test(navigator.platform || '')) {
        document.documentElement.setAttribute('data-titlebar', 'overlay');
    }
}

// Apply theme before the app renders so the FOUC is invisible.
applyTheme(resolveTheme());
// Embers are session-only — the container is mounted by the session
// view on entry (mirrors the original app's session.html-scoped
// ember-container). regenerateEmbers is a no-op when no session is
// active, so the theme toggle click handler is still safe to call it.

// Wire the theme toggle once the DOM is ready. Listening on document
// click and re-running setup is idempotent (initThemeToggle guards).
function setupGlobalChrome(): void {
    const btn = document.querySelector<HTMLElement>('[data-theme-toggle]');
    if (btn) initThemeToggle(btn);
    initAbout();
    initTauriWindowDrag();
    initExternalLinks();
    // Watch for OS-level theme flips (e.g. macOS Auto switching at sunset)
    // so the app follows along without a refresh. The watcher itself
    // respects Settings/sticky and recent manual toggles. Regenerate embers
    // on flip so the palette doesn't stay stuck on the previous theme.
    watchSystemTheme(() => regenerateEmbers());
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupGlobalChrome, { once: true });
} else {
    setupGlobalChrome();
}

// Palette differs between light/dark — regenerate embers whenever the
// theme flips so they switch immediately instead of waiting for the
// current particles to expire naturally.
document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-theme-toggle]')) {
        // initThemeToggle has already changed the theme; just refresh embers.
        regenerateEmbers();
    }
});

bootApp().catch((err) => {
    console.error('App init failed:', err);
    const status = document.getElementById('status');
    if (status) status.textContent = `Init error: ${(err as Error).message}`;
});

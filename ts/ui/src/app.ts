/**
 * Top-level app — routes between Setup, Session, and History.
 *
 * The session lifecycle owns the only persistent state (a running
 * SessionManager); the other two views are stateless reads. We
 * tear down a running session before switching views.
 *
 * Routing uses the History API: each view change pushes a path so
 * the browser back/forward (and Android's hardware back button under
 * Tauri 2 / Capacitor) walk the same in-app history the user just
 * traversed. Initial-load deep-links into the right view based on
 * the URL path.
 */

import { mountSetupView } from './views/setup.js';
import { mountSessionView, type SessionViewHandle } from './views/session.js';
import {
    mountNotingSessionView,
    type NotingSessionViewHandle,
} from './views/noting-session.js';
import { mountHistoryView } from './views/history.js';
import { mountSettingsView } from './views/settings.js';
import type { SessionSetup } from './settings.js';
import type { SessionState } from '../../src/facilitation/session.js';
import { applyChromeSettings, loadAppSettings } from './app-settings.js';
import { detectCapabilities } from './capabilities.js';
import { routePath, appPath } from './route-base.js';

type View = 'setup' | 'session' | 'history' | 'settings';

// Paths carry the deploy base ('/' in dev, '/app/' for the hosted subpath
// build) so pushState + refresh resolve under either — see route-base.ts.
const ROUTE_FOR_VIEW: Record<Exclude<View, 'session'>, string> = {
    setup: routePath('/'),
    history: routePath('/history'),
    settings: routePath('/settings'),
};

function viewFromPath(path: string): Exclude<View, 'session'> {
    const p = appPath(path);
    if (p.startsWith('/history')) return 'history';
    if (p.startsWith('/settings')) return 'settings';
    return 'setup';
}

let currentSession: SessionViewHandle | null = null;
let currentNoting: NotingSessionViewHandle | null = null;
// null until the first routeTo lands — keeps the initial-load
// deep-link from being treated as "already on setup" and skipped.
let currentView: View | null = null;

function $<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el as T;
}

export async function bootApp(): Promise<void> {
    // Apply persisted theme/text-scale before the first view mounts so
    // the user doesn't see a default-style flash.
    const settings = await loadAppSettings();
    applyChromeSettings(settings);

    // Probe the runtime environment (Flask / hosted server / Ollama) so menus
    // and desktop-only controls can gate themselves to what's reachable.
    // Fire-and-forget — views read the cached value at render and tolerate the
    // initial `false`. (detectCapabilities also populates the is-desktop cache.)
    void detectCapabilities();

    wireNav();
    wireMobileMore();
    wirePopstate();
    const root = $('app-root');
    // Deep-link into the right view based on the URL the user landed
    // on. Refreshing /history or /settings stays put instead of
    // bouncing the user back to setup.
    const initial = viewFromPath(window.location.pathname);
    await routeTo(root, initial, { replace: true });
}

function wireNav(): void {
    document.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
        if (!target) return;
        const view = target.dataset['nav'] as View | undefined;
        if (!view || view === 'session') return;
        e.preventDefault();
        // During a live session, route through the session's end-confirm
        // overlay (Cancel / End / End without saving) instead of tearing it
        // down silently — covers the in-session History link and any
        // bottom-nav link that's visible. Mirrors the popstate guard.
        if (currentSession || currentNoting) {
            (currentSession ?? currentNoting)?.requestLeave(view as 'setup' | 'history' | 'settings');
            return;
        }
        const root = $('app-root');
        void routeTo(root, view);
    });
}

/**
 * Mobile "More" sheet (bottom-nav ⋯). Open/close + utility actions. The
 * actions reuse the already-wired top-nav controls so there's a single
 * source of truth: About toggles the same modal as the brand link, and
 * Toggle theme drives the same handler (theme + icon + embers) as the
 * top-nav theme button. Fullscreen / window-close / update are omitted
 * (Tauri-native or not applicable); session-only End/History land with
 * the in-session floating hamburger (separate follow-up).
 */
function wireMobileMore(): void {
    const sheet = document.getElementById('mobileMoreSheet');
    if (!sheet) return;
    const open = (): void => sheet.classList.remove('hidden');
    const close = (): void => sheet.classList.add('hidden');
    document.addEventListener('click', (e) => {
        const t = e.target as HTMLElement;
        if (t.closest('[data-mobile-more-open]')) {
            open();
        } else if (t.closest('[data-mobile-more-close]')) {
            close();
        } else if (t.closest('#moreEnd')) {
            // Session-only: route through the session's end-confirm overlay
            // (Cancel / End / End without saving), same as the End link.
            close();
            (currentSession ?? currentNoting)?.requestLeave('setup');
        } else if (t.closest('#moreHistory')) {
            close();
            (currentSession ?? currentNoting)?.requestLeave('history');
        } else if (t.closest('#moreAbout')) {
            close();
            document.getElementById('aboutLink')?.click();
        } else if (t.closest('#moreTheme')) {
            close();
            document.querySelector<HTMLElement>('.nav-links [data-theme-toggle]')?.click();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !sheet.classList.contains('hidden')) close();
    });
}

/**
 * Listen for browser back/forward (and Android hardware back) so
 * users can walk the in-app history. We don't re-push the URL on
 * popstate — the browser already did. We just remount the matching
 * view.
 */
function wirePopstate(): void {
    window.addEventListener('popstate', () => {
        const root = $('app-root');
        // Back/forward out of a live session: defer to the view's confirm
        // overlay rather than a native window.confirm so all leave prompts
        // share the same UI (end-button, in-session History/Settings links,
        // and this Back path). The browser has already changed the URL by
        // the time popstate fires, so re-arm '/session' immediately to hold
        // the user in place while the overlay is up — on confirm, the view's
        // onEnd routes to `target`; on cancel, the re-arm has already
        // restored the URL.
        if (currentSession || currentNoting) {
            const target = viewFromPath(window.location.pathname);
            window.history.pushState({ view: 'session' }, '', routePath('/session'));
            if (currentSession) currentSession.requestLeave(target);
            else if (currentNoting) currentNoting.requestLeave(target);
            return;
        }
        const target = viewFromPath(window.location.pathname);
        void routeTo(root, target, { fromPopstate: true });
    });
}

/**
 * Single routing entry point. Handles URL changes (pushState /
 * replaceState as appropriate), tears down any running session,
 * and mounts the target view. `replace` is used on initial load
 * so we don't push a duplicate entry for the page we arrived on;
 * `fromPopstate` skips the URL update because the browser already
 * changed the URL for us.
 */
async function routeTo(
    root: HTMLElement,
    view: Exclude<View, 'session'>,
    options: { replace?: boolean; fromPopstate?: boolean } = {}
): Promise<void> {
    // No-op if we're already on that view and there's no in-flight
    // session/noting placeholder to tear down. currentView is null on
    // the very first mount so the deep-link routes correctly.
    if (
        currentView === view &&
        currentSession === null &&
        currentNoting === null
    ) {
        return;
    }

    const path = ROUTE_FOR_VIEW[view];
    if (!options.fromPopstate) {
        if (options.replace) {
            window.history.replaceState({ view }, '', path);
        } else if (window.location.pathname !== path) {
            window.history.pushState({ view }, '', path);
        }
    }

    if (view === 'setup') await goSetup(root);
    else if (view === 'history') await goHistory(root);
    else if (view === 'settings') await goSettings(root);
}

function setActiveNav(view: View): void {
    currentView = view;
    document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
        // Use `nav-active` to match the lifted CSS — Python's base.html
        // applies the same class to mark the current page link. The mobile
        // bottom-nav uses its own `bottom-nav-active` class.
        const active = el.dataset['nav'] === view;
        el.classList.toggle('nav-active', active);
        if (el.classList.contains('bottom-nav-link')) {
            el.classList.toggle('bottom-nav-active', active);
        }
    });
    // Nav center: every non-session view shows an idle orb (Python's
    // index.html and settings.html both put one there; history.html
    // doesn't, but the user wants the orb everywhere except active
    // sessions for visual consistency). Session manages its own
    // breathing orb.
    const navCenter = document.getElementById('navCenter');
    if (navCenter && view !== 'session') {
        navCenter.innerHTML = `
            <div class="nav-session-info">
                <div class="orb orb-idle orb-nav" id="home-orb"></div>
            </div>`;
        wireHomeOrbBounce();
    }
}

/**
 * Click-to-bounce affordance on the idle orb. Lifted from
 * src/web/static/js/setup.js:819 — toggles the .orb-bounce class
 * and lets the CSS keyframe animation play, removing it on
 * animationend so subsequent clicks re-trigger cleanly.
 */
function wireHomeOrbBounce(): void {
    const orb = document.getElementById('home-orb');
    if (!orb) return;
    orb.addEventListener('click', () => {
        orb.classList.remove('orb-bounce');
        // Reflow so the animation restarts on rapid double-clicks.
        void orb.offsetWidth;
        orb.classList.add('orb-bounce');
    });
    orb.addEventListener('animationend', () => {
        orb.classList.remove('orb-bounce');
    });
}

async function goSetup(root: HTMLElement): Promise<void> {
    if (currentSession) {
        currentSession.teardown();
        currentSession = null;
    }
    if (currentNoting) {
        currentNoting.teardown();
        currentNoting = null;
    }
    setActiveNav('setup');
    await mountSetupView(root, (setup, continueFrom) => {
        // Branch on the meditation type the user picked via the tab bar.
        // Both stay under the Setup tab conceptually (same '/session' trap).
        if (setup.meditationType === 'noting') {
            void goNotingSession(root, setup);
        } else {
            void goSession(root, setup, continueFrom);
        }
    });
}

async function goSession(
    root: HTMLElement,
    setup: SessionSetup,
    continueFrom: SessionState | null = null
): Promise<void> {
    setActiveNav('setup'); // session is still under Setup tab conceptually
    // Push a '/session' history entry so the browser Back button has
    // something to pop while the session is live — wirePopstate intercepts
    // it to confirm before leaving. (Normal exits below route via routeTo,
    // which replaces this URL.)
    window.history.pushState({ view: 'session' }, '', routePath('/session'));
    currentSession = await mountSessionView(
        root,
        setup,
        (destination) => {
            // Session view tells us where to land the user. "history" or
            // "settings" come from the in-session link / Back-button confirm
            // flow; default is back to setup. Route via routeTo so the
            // '/session' URL we pushed above gets replaced with the
            // destination's.
            if (destination === 'history') void routeTo(root, 'history');
            else if (destination === 'settings') void routeTo(root, 'settings');
            else void routeTo(root, 'setup');
        },
        continueFrom
    );
}

async function goNotingSession(root: HTMLElement, setup: SessionSetup): Promise<void> {
    setActiveNav('setup');
    // Same back-button trap as goSession (see wirePopstate).
    window.history.pushState({ view: 'session' }, '', routePath('/session'));
    currentNoting = await mountNotingSessionView(root, setup, (destination) => {
        // Same as goSession: the view tells us where to land. "history" and
        // "settings" come from the in-session link / Back-button confirm
        // flow; otherwise setup.
        if (destination === 'history') void routeTo(root, 'history');
        else if (destination === 'settings') void routeTo(root, 'settings');
        else void routeTo(root, 'setup');
    });
}

async function goHistory(root: HTMLElement): Promise<void> {
    teardownInflightSessions();
    setActiveNav('history');
    await mountHistoryView(root, () => {
        void goSetup(root);
    });
}

async function goSettings(root: HTMLElement): Promise<void> {
    teardownInflightSessions();
    setActiveNav('settings');
    await mountSettingsView(root);
}

function teardownInflightSessions(): void {
    if (currentSession) {
        currentSession.teardown();
        currentSession = null;
    }
    if (currentNoting) {
        currentNoting.teardown();
        currentNoting = null;
    }
}

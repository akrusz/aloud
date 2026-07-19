/**
 * Top-level app - routes between Setup, Session, History, Settings, Account.
 * A running session owns the only persistent state; it's torn down before any
 * view switch. Routing uses the History API so browser back/forward (and
 * Android's hardware back under Tauri 2 / Capacitor) walk the in-app history;
 * initial load deep-links from the URL path.
 */

import { mountSetupView } from './views/setup.js';
import { runUpdateNudge } from './about.js';
import { openBugReport } from './bug-report.js';
import { closeIfActive as closeGuideIfActive } from './tour/index-guide.js';
import { mountSessionView, type SessionViewHandle } from './views/session.js';
import {
    mountNotingSessionView,
    type NotingSessionViewHandle,
} from './views/noting-session.js';
import { mountHistoryView } from './views/history.js';
import { mountSettingsView } from './views/settings.js';
import { mountAccountView } from './views/account.js';
import type { SessionSetup } from './settings.js';
import type { SessionState } from '../../src/facilitation/session.js';
import { applyChromeSettings, loadAppSettings } from './app-settings.js';
import { detectCapabilities } from './capabilities.js';
import { isCloudBuild } from './cloud-base.js';
import { routePath, appPath } from './route-base.js';
import { ensureCloudAccess } from './cloud-gate.js';
import { consumePurchaseReturn } from './cloud-billing.js';
import { checkAndShowGifts } from './gift-modal.js';
import { showErrorToast, showSuccessToast } from './toast.js';

type View = 'setup' | 'session' | 'history' | 'settings' | 'account';

// Paths carry the deploy base ('/' in dev, '/app/' for the hosted subpath
// build) so pushState + refresh resolve under either - see route-base.ts.
const ROUTE_FOR_VIEW: Record<Exclude<View, 'session'>, string> = {
    setup: routePath('/'),
    history: routePath('/history'),
    settings: routePath('/settings'),
    account: routePath('/account'),
};

function viewFromPath(path: string): Exclude<View, 'session'> {
    const p = appPath(path);
    if (p.startsWith('/history')) return 'history';
    if (p.startsWith('/settings')) return 'settings';
    if (p.startsWith('/account')) return 'account';
    return 'setup';
}

let currentSession: SessionViewHandle | null = null;
let currentNoting: NotingSessionViewHandle | null = null;
// null until the first routeTo lands, so the initial-load deep-link isn't
// treated as "already on setup" and skipped.
let currentView: View | null = null;
// True until the #boot-orb has been retired. While set, setActiveNav leaves the
// nav orb slot empty (settleBootOrb fills it) so we never paint two orbs.
let bootOrbPending = true;

function $<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el as T;
}

export async function bootApp(): Promise<void> {
    // Before the first view mounts, so there's no default-style flash.
    const settings = await loadAppSettings();
    applyChromeSettings(settings);

    // Read (and clear) any `?purchase=` Stripe appended on return from checkout,
    // before the router normalizes the URL. The toast waits until a view is
    // mounted (end of boot) so it has a surface to show on. (meditation-pal-8sj)
    const purchase = consumePurchaseReturn();

    // Probe the runtime environment (app backend / aloud cloud / Ollama) so menus
    // and desktop-only controls gate themselves to what's reachable.
    // Fire-and-forget: views read the cached value at render and tolerate the
    // initial `false`. (Also populates the is-desktop cache.)
    // Reveal the Account nav on any cloud-capable build, so the tab is a stable
    // fixture rather than blinking out during a transient outage (the page shows
    // a "back soon" notice then). A fully-local build keeps it hidden.
    const revealAccountNav = (): void =>
        document.querySelectorAll('.nav-link-account').forEach((el) => el.classList.remove('hidden'));
    if (isCloudBuild()) revealAccountNav();
    void detectCapabilities().then((caps) => {
        if (caps.cloud) revealAccountNav();
    });

    wireNav();
    wireMobileMore();
    wirePopstate();
    const root = $('app-root');
    // Dev-only: `?slowboot=<ms>` holds the boot orb on screen *before* the view
    // mounts, to eyeball the loading state. Waiting ahead of routeTo keeps the
    // content area empty during the delay, mirroring a real slow load rather
    // than the finished page sitting behind the orb. Read the query here because
    // routeTo replaceState's it away. Tree-shaken from production builds.
    if (import.meta.env.DEV) {
        const ms = Number(new URLSearchParams(window.location.search).get('slowboot'));
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    }
    const initial = viewFromPath(window.location.pathname);
    await routeTo(root, initial, { replace: true });
    // View mounted and the nav slot in place: cross-fade the boot orb out and
    // the idle nav orb in, then resume normal nav-orb painting.
    settleBootOrb();
    bootOrbPending = false;

    // Fulfilment is the server's webhook, so credits are usually already added
    // by the time the user lands back; copy avoids promising timing.
    if (purchase === 'success') {
        showSuccessToast('Payment received. Your credits have been added.');
    } else if (purchase === 'cancel') {
        showErrorToast('Checkout canceled. You have not been charged.');
    }

    // Prompt to accept any clouds gifted to this account (no-op when signed out
    // or none pending). meditation-pal-bd5.
    void checkAndShowGifts();
}

/**
 * Retire the first-paint #boot-orb: fade it out, then fade the small idle orb
 * into the nav. setActiveNav left the nav slot empty while bootOrbPending, so
 * the boot orb is the only one on screen until the crossfade. A plain fade
 * reads calmer than flying the orb across the page.
 */
function settleBootOrb(): void {
    const navInfo = document.querySelector<HTMLElement>('.nav-session-info');
    if (!navInfo) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const showNavOrb = (): void => {
        navInfo.innerHTML = '<div class="orb orb-idle orb-nav" id="home-orb"></div>';
        wireHomeOrbBounce();
        // Fade up to the idle orb's resting opacity (0.6, from .orb-idle).
        if (!reduce) {
            document
                .getElementById('home-orb')
                ?.animate([{ opacity: 0 }, { opacity: 0.6 }], {
                    duration: 400,
                    easing: 'ease-in',
                });
        }
    };

    const bootOrb = document.getElementById('boot-orb');
    if (!bootOrb || reduce) {
        bootOrb?.remove();
        showNavOrb();
        return;
    }

    const fade = bootOrb.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 500,
        easing: 'ease-out',
        fill: 'forwards',
    });
    fade.onfinish = () => {
        bootOrb.remove();
        showNavOrb();
    };
}

function wireNav(): void {
    document.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
        if (!target) return;
        const view = target.dataset['nav'] as View | undefined;
        if (!view || view === 'session') return;
        e.preventDefault();
        // During a live session, route through the session's end-confirm overlay
        // instead of tearing it down silently. Mirrors the popstate guard.
        if (currentSession || currentNoting) {
            (currentSession ?? currentNoting)?.requestLeave(view as Exclude<View, 'session'>);
            return;
        }
        const root = $('app-root');
        void routeTo(root, view);
    });
}

/**
 * Mobile "More" sheet (bottom-nav ⋯). Actions click through to the already-wired
 * top-nav controls so there's a single source of truth. Fullscreen /
 * window-close are omitted (Tauri-native).
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
            // Session-only: route through the end-confirm overlay, as End does.
            close();
            (currentSession ?? currentNoting)?.requestLeave('setup');
        } else if (t.closest('#moreHistory')) {
            close();
            (currentSession ?? currentNoting)?.requestLeave('history');
        } else if (t.closest('#moreSessionInfo')) {
            close();
            (currentSession ?? currentNoting)?.showInfo();
        } else if (t.closest('#moreAccount')) {
            // wireNav's global data-nav handler does the routing; just dismiss.
            close();
        } else if (t.closest('#moreAbout') || t.closest('#moreUpdate')) {
            // Update is only visible when one's waiting; like About it just
            // opens the box, where the install button lives.
            close();
            document.getElementById('aboutLink')?.click();
        } else if (t.closest('#moreReportBug')) {
            close();
            void openBugReport();
        } else if (t.closest('#moreTheme')) {
            close();
            document.querySelector<HTMLElement>('.nav-links [data-theme-toggle]')?.click();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !sheet.classList.contains('hidden')) close();
    });
}

/** Browser back/forward (and Android hardware back): remount the matching view.
 *  No URL push - the browser already changed it. */
function wirePopstate(): void {
    window.addEventListener('popstate', () => {
        const root = $('app-root');
        // Back/forward out of a live session defers to the view's confirm
        // overlay, so every leave prompt shares one UI. The browser has already
        // changed the URL by the time popstate fires, so re-arm '/session'
        // immediately to hold the user in place while the overlay is up: on
        // confirm the view's onEnd routes to `target`, on cancel the re-arm has
        // already restored the URL.
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
 * Single routing entry point: updates the URL, tears down any running session,
 * mounts the target view. `replace` (initial load) avoids a duplicate entry for
 * the page we arrived on; `fromPopstate` skips the URL update entirely.
 */
async function routeTo(
    root: HTMLElement,
    view: Exclude<View, 'session'>,
    options: { replace?: boolean; fromPopstate?: boolean } = {}
): Promise<void> {
    // Already there with nothing to tear down. currentView is null on the very
    // first mount, so the deep-link still routes.
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
    else if (view === 'account') await goAccount(root);
}

function setActiveNav(view: View): void {
    // The onboarding tour's overlay lives on <body>, not the view root, so
    // navigating away would leave it floating over the new view (and with its
    // setup targets gone it would skip to the "you're ready" screen).
    // setActiveNav is the one chokepoint every go* transition passes through.
    // Method-tab switches don't route here, so the tour's tab-stepping is safe.
    closeGuideIfActive();
    // Throttled to once an hour inside runUpdateNudge, so cheap per transition.
    runUpdateNudge();
    currentView = view;
    document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
        const active = el.dataset['nav'] === view;
        el.classList.toggle('nav-active', active);
        if (el.classList.contains('bottom-nav-link')) {
            el.classList.toggle('bottom-nav-active', active);
        }
    });
    // Every non-session view shows an idle orb; a session manages its own
    // breathing orb.
    const navCenter = document.getElementById('navCenter');
    if (navCenter && view !== 'session') {
        // settleBootOrb fills this slot once the boot orb retires; painting one
        // here while that's pending would briefly show two.
        const orb = bootOrbPending ? '' : '<div class="orb orb-idle orb-nav" id="home-orb"></div>';
        navCenter.innerHTML = `<div class="nav-session-info">${orb}</div>`;
        if (!bootOrbPending) wireHomeOrbBounce();
    }
}

/** Click-to-bounce on the idle orb. The class is removed on animationend so
 *  subsequent clicks re-trigger cleanly. */
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
    // Pre-flight hosted sign-in: if this session will hit a credit-metered cloud
    // service (hosted LLM, Cloud STT/TTS - all gated on a session token) and
    // we're not signed in, prompt now rather than failing on the first
    // utterance. Dismissing aborts the start and leaves the user on setup.
    if (!(await ensureCloudAccess(setup, await loadAppSettings(), setup.meditationType))) return;
    // Give the browser Back button something to pop while the session is live;
    // wirePopstate intercepts it to confirm before leaving. Normal exits below
    // route via routeTo, which replaces this URL.
    window.history.pushState({ view: 'session' }, '', routePath('/session'));
    currentSession = await mountSessionView(
        root,
        setup,
        (destination) => {
            // Where the session view wants the user to land. Routing via routeTo
            // replaces the '/session' URL pushed above.
            if (destination === 'history') void routeTo(root, 'history');
            else if (destination === 'settings') void routeTo(root, 'settings');
            else if (destination === 'account') void routeTo(root, 'account');
            else void routeTo(root, 'setup');
        },
        continueFrom
    );
}

async function goNotingSession(root: HTMLElement, setup: SessionSetup): Promise<void> {
    setActiveNav('setup');
    // Same sign-in pre-flight as goSession; 'noting' so participant voices
    // count toward the cloud-usage decision.
    if (!(await ensureCloudAccess(setup, await loadAppSettings(), 'noting'))) return;
    // Same back-button trap as goSession (see wirePopstate).
    window.history.pushState({ view: 'session' }, '', routePath('/session'));
    currentNoting = await mountNotingSessionView(root, setup, (destination) => {
        if (destination === 'history') void routeTo(root, 'history');
        else if (destination === 'settings') void routeTo(root, 'settings');
        else if (destination === 'account') void routeTo(root, 'account');
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

async function goAccount(root: HTMLElement): Promise<void> {
    teardownInflightSessions();
    setActiveNav('account');
    await mountAccountView(root);
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

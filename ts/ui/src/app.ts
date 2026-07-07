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
import { runUpdateNudge } from './about.js';
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
// build) so pushState + refresh resolve under either — see route-base.ts.
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
// null until the first routeTo lands — keeps the initial-load
// deep-link from being treated as "already on setup" and skipped.
let currentView: View | null = null;
// True until the #boot-orb has flown into the nav. While set, setActiveNav
// leaves the nav orb slot empty — the boot orb itself becomes the idle nav
// orb (see flyBootOrbToNav), so we never paint two orbs at once.
let bootOrbPending = true;

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

    // Read (and clear) any `?purchase=` Stripe appended on return from checkout,
    // before the router normalizes the URL. The toast waits until a view is
    // mounted (end of boot) so it has a surface to show on. (meditation-pal-8sj)
    const purchase = consumePurchaseReturn();

    // Probe the runtime environment (app backend / aloud cloud / Ollama) so
    // menus and desktop-only controls can gate themselves to what's reachable.
    // Fire-and-forget — views read the cached value at render and tolerate the
    // initial `false`. (detectCapabilities also populates the is-desktop cache.)
    // Reveal the Account nav entry (hidden by default) on any cloud-capable
    // build, so the tab is a stable fixture rather than blinking out during a
    // transient outage (the page shows a calm "back soon" notice then). A
    // fully-local build (no cloud URL baked in, never reaches one) keeps it hidden.
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
    // Deep-link into the right view based on the URL the user landed
    // on. Refreshing /history or /settings stays put instead of
    // bouncing the user back to setup.
    // Dev-only: `?slowboot=<ms>` holds the boot orb on screen *before* the view
    // mounts, to eyeball the loading state (otherwise a blink on localhost).
    // Waiting here — ahead of routeTo — keeps the content area empty during the
    // delay, so it mirrors a real slow load (static nav + centered orb, nothing
    // mounted) rather than the finished page sitting behind the orb. Read the
    // query now too: routeTo replaceState's the URL to a clean path, dropping
    // it. import.meta.env.DEV is false in `vite build`, so this is
    // dead-code-eliminated from production bundles.
    if (import.meta.env.DEV) {
        const ms = Number(new URLSearchParams(window.location.search).get('slowboot'));
        if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
    }
    const initial = viewFromPath(window.location.pathname);
    await routeTo(root, initial, { replace: true });
    // First view is mounted and the nav slot is in place — cross-fade the big
    // boot orb out and the small idle nav orb in, then resume normal nav-orb
    // painting for later view changes.
    settleBootOrb();
    bootOrbPending = false;

    // Fulfilment is the server's webhook, so by the time the user lands back the
    // credits are usually already added; phrase it without over-promising timing.
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
 * Retire the first-paint #boot-orb (a centered kasina-form orb): fade it out,
 * then fade the small idle orb into the nav. setActiveNav left the nav orb slot
 * empty while bootOrbPending, so the boot orb is the only orb on screen until
 * the crossfade. A plain fade reads calmer than flying the orb across the page.
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
        // During a live session, route through the session's end-confirm
        // overlay (Cancel / End / End without saving) instead of tearing it
        // down silently — covers the in-session History link and any
        // bottom-nav link that's visible. Mirrors the popstate guard.
        if (currentSession || currentNoting) {
            (currentSession ?? currentNoting)?.requestLeave(view as Exclude<View, 'session'>);
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
 * top-nav theme button, and Update (shown only when one's waiting) opens
 * the same box. Fullscreen / window-close are omitted (Tauri-native);
 * session-only End/History land with the in-session floating hamburger
 * (separate follow-up).
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
        } else if (t.closest('#moreSessionInfo')) {
            // Session-only: open the in-session info panel (model, mode, …).
            close();
            (currentSession ?? currentNoting)?.showInfo();
        } else if (t.closest('#moreAccount')) {
            // Routing is handled by the global data-nav click handler (wireNav);
            // here we just dismiss the sheet.
            close();
        } else if (t.closest('#moreAbout') || t.closest('#moreUpdate')) {
            // The update entry is only visible when an update is waiting; like
            // About, it just opens the box (where the install button lives).
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
    else if (view === 'account') await goAccount(root);
}

function setActiveNav(view: View): void {
    // Tear down the setup-page onboarding tour on any view change. The tour
    // overlay lives on <body>, not inside the view root, so navigating away
    // (bottom-nav Session/History/Settings/More, top nav, Back) would
    // otherwise leave it floating over the new view — and with its setup
    // targets gone it would skip straight to the "you're ready" screen.
    // setActiveNav runs on every go* transition, so this is the one chokepoint
    // that covers them all. Method-tab switches (Exploration/Noting/Felt
    // Sense) don't route through here, so the tour's own tab-stepping is safe.
    closeGuideIfActive();
    // Every nav is a chance to refresh the update nudge — throttled to once an
    // hour inside runUpdateNudge, so this is cheap to call on every transition.
    runUpdateNudge();
    currentView = view;
    document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
        // Use `nav-active` to match the base CSS, which marks the current
        // page link with the same class. The mobile bottom-nav uses its own
        // `bottom-nav-active` class.
        const active = el.dataset['nav'] === view;
        el.classList.toggle('nav-active', active);
        if (el.classList.contains('bottom-nav-link')) {
            el.classList.toggle('bottom-nav-active', active);
        }
    });
    // Nav center: every non-session view shows an idle orb (the user wants
    // the orb everywhere except active sessions for visual consistency).
    // Session manages its own breathing orb.
    const navCenter = document.getElementById('navCenter');
    if (navCenter && view !== 'session') {
        // While the boot orb is still pending it flies into this slot and
        // becomes the idle orb itself (flyBootOrbToNav), so leave it empty —
        // painting an orb here too would briefly show two.
        const orb = bootOrbPending ? '' : '<div class="orb orb-idle orb-nav" id="home-orb"></div>';
        navCenter.innerHTML = `<div class="nav-session-info">${orb}</div>`;
        if (!bootOrbPending) wireHomeOrbBounce();
    }
}

/**
 * Click-to-bounce affordance on the idle orb — toggles the .orb-bounce class
 * and lets the CSS keyframe animation play, removing it on animationend so
 * subsequent clicks re-trigger cleanly.
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
    // Pre-flight hosted sign-in: if this session will hit a credit-metered
    // cloud service (hosted LLM, or Cloud STT/TTS — all gated on a session
    // token) and we're not signed in, surface the sign-in modal before mounting
    // rather than failing on the first utterance. Dismissing it aborts the
    // start and leaves the user on setup (which is still mounted).
    if (!(await ensureCloudAccess(setup, await loadAppSettings(), setup.meditationType))) return;
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
            else if (destination === 'account') void routeTo(root, 'account');
            else void routeTo(root, 'setup');
        },
        continueFrom
    );
}

async function goNotingSession(root: HTMLElement, setup: SessionSetup): Promise<void> {
    setActiveNav('setup');
    // Same hosted sign-in pre-flight as goSession — 'noting' so participant
    // voices count toward the cloud-usage decision.
    if (!(await ensureCloudAccess(setup, await loadAppSettings(), 'noting'))) return;
    // Same back-button trap as goSession (see wirePopstate).
    window.history.pushState({ view: 'session' }, '', routePath('/session'));
    currentNoting = await mountNotingSessionView(root, setup, (destination) => {
        // Same as goSession: the view tells us where to land. "history" and
        // "settings" come from the in-session link / Back-button confirm
        // flow; otherwise setup.
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

/**
 * Info panels and guided tour for the setup (index) page. Each section's ?
 * button toggles an inline info panel; the guide walks all panels in sequence
 * with a spotlight overlay, reusing the settings tour's .tour-* CSS.
 *
 * The card the guide opens on is also the first-run welcome: it offers a first
 * sit ("Try right now", first-sit.ts) ahead of the tour, and after that sit
 * comes back once to offer the tour again, when the settings mean something.
 */

import { sharedKv } from '../state.js';
import { t } from '../i18n.js';
import { FIRST_SIT_TIMER_MIN } from '../first-sit.js';
import { footerHtml, getNavHeight } from './tour-common.js';

const GUIDE_DONE_KEY = 'aloud-index-guide-done';
const GUIDE_REMIND_KEY = 'aloud-index-guide-remind';
const CLIENT_ID_KEY = 'aloud-client-id';
/** Set when a first sit starts; the next visit to setup spends it on the
 *  "Shape your next sit" card. */
const FOLLOW_UP_KEY = 'aloud-first-sit-follow-up';

const PADDING = 10;
const FOOTER_HEIGHT = 60;

function hideInfoPanels(): void {
    document.querySelectorAll('.info-panel').forEach(function (p) {
        p.classList.add('hidden');
    });
}

function toggleInfo(id: string): void {
    const panel = document.getElementById('info-' + id);
    if (!panel) return;
    const wasHidden = panel.classList.contains('hidden');
    hideInfoPanels();
    if (wasHidden) panel.classList.remove('hidden');
}

// Delegated so ? clicks survive any DOM manipulation during the tour - no
// chance of stale per-element listeners blocking clicks after a partial close.
// Registered lazily on the first startGuide/autoStart from the setup view, so
// it never attaches on pages with no info-btn[data-info] elements.
let infoBtnHandlerInstalled = false;
function installInfoBtnHandler(): void {
    if (infoBtnHandlerInstalled) return;
    infoBtnHandlerInstalled = true;
    document.addEventListener('click', function (e) {
        const target = e.target as Element | null;
        const btn = target?.closest<HTMLElement>('.info-btn[data-info]');
        if (!btn) return;
        e.preventDefault();
        e.stopPropagation();
        if (guideActive) return;
        const info = btn.dataset['info'];
        if (info) toggleInfo(info);
    });
}

let overlayEl: HTMLDivElement | null = null;
let spotlightEl: HTMLDivElement | null = null;
let cardEl: HTMLDivElement | null = null;
let currentStep = 0;
let guideActive = false;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let prevTarget: HTMLElement | null = null;
let lastViewportWidth = 0;

/** What the welcome card needs from the setup view to offer a first sit. */
export interface QuickStart {
    /** Why a first sit can't start right now, or null when it can. Polled
     *  while the card is up, since the usual reasons clear on their own. */
    blocker(): string | null;
    /** Called from the click itself, so it can still prompt for the mic. */
    start(): void;
}

/** Which card step 0 shows: the first-run welcome (offers a first sit), the
 *  one-time follow-up after that sit, or the plain two-choice welcome a
 *  "Take the full tour" visitor reaches with Back. */
type WelcomeVariant = 'first-run' | 'after-first-sit' | 'plain';

let welcomeVariant: WelcomeVariant = 'plain';
let quickStart: QuickStart | null = null;
let quickStartPoll: ReturnType<typeof setInterval> | null = null;
const QUICK_START_POLL_MS = 500;

interface Section {
    id: string;
    /** Info panel to open (defaults to `id`). Lets several steps share one panel. */
    panel?: string;
    /** Tab to activate before showing this step. */
    tab?: string;
    target: () => HTMLElement | null;
}

function setupHeader(): HTMLElement | null {
    return document.querySelector<HTMLElement>('.setup-header');
}

/** The focus/vibe group owning the `?` button for `info`. Those groups sit
 *  inside the "Customize facilitator" disclosure, collapsed by default on
 *  phones - open it so the step has a visible target to spotlight. */
function modifierGroup(info: string): HTMLElement | null {
    const section = document.getElementById('customize-section');
    if (section && !section.classList.contains('open')) {
        section.classList.add('open');
        document.getElementById('customize-toggle')?.setAttribute('aria-expanded', 'true');
    }
    const btn = document.querySelector<HTMLElement>(`[data-info="${info}"]`);
    return btn ? btn.closest<HTMLElement>('.form-group') : null;
}

// The methods panel shows only the active tab's text (views/setup.ts), so the
// tour visits each tab in turn to cover all three methods.
const SECTIONS: ReadonlyArray<Section> = [
    { id: 'methods-exploration', panel: 'methods', tab: 'exploration', target: setupHeader },
    { id: 'methods-noting', panel: 'methods', tab: 'noting', target: setupHeader },
    { id: 'methods-felt-sense', panel: 'methods', tab: 'felt_sense', target: setupHeader },
    { id: 'focus', tab: 'exploration', target: () => modifierGroup('focus') },
    { id: 'vibe', tab: 'exploration', target: () => modifierGroup('vibe') },
];

const TOTAL_STEPS = SECTIONS.length + 2; // welcome + sections + done

function createOverlay(): void {
    overlayEl = document.createElement('div');
    overlayEl.className = 'tour-overlay';
    // Tapping the dimmed area closes the tour, the way Escape does - which on
    // a phone is the only way, since there's no Escape key and the overlay is
    // what's swallowing every tap outside the spotlight. The spotlit target
    // (z-index 60) and the card sit above the overlay (55), so taps on those
    // never land here, and the spotlight ring is pointer-events: none.
    // A scroll gesture is safe: the browser fires no click after a drag, so
    // flicking the page during a step leaves the tour up. No px threshold of
    // our own - it would only second-guess that.
    overlayEl.addEventListener('click', dismissRemindLater);
    spotlightEl = document.createElement('div');
    spotlightEl.className = 'tour-spotlight';
    document.body.appendChild(overlayEl);
    document.body.appendChild(spotlightEl);
}

/** Drop the spotlit target's elevation and close every info panel. */
function resetTarget(): void {
    if (prevTarget) {
        prevTarget.classList.remove('guide-elevated');
        prevTarget = null;
    }
    hideInfoPanels();
}

function stopQuickStartPoll(): void {
    if (quickStartPoll !== null) clearInterval(quickStartPoll);
    quickStartPoll = null;
}

function cleanup(): void {
    stopQuickStartPoll();
    overlayEl?.remove();
    spotlightEl?.remove();
    cardEl?.remove();
    overlayEl = spotlightEl = cardEl = null;
    guideActive = false;
    document.body.classList.remove('guide-running');
    resetTarget();
    window.removeEventListener('resize', onResizeDebounced);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKeyDown);
}

function showCard(html: string, className?: string): void {
    stopQuickStartPoll();
    if (cardEl) cardEl.remove();
    cardEl = document.createElement('div');
    cardEl.className = className || 'tour-tooltip';
    cardEl.innerHTML = html;
    document.body.appendChild(cardEl);
    if (overlayEl) overlayEl.classList.toggle('tour-overlay-flat', className === 'tour-welcome');
    wireActions();
}

function wireActions(): void {
    if (!cardEl) return;
    cardEl.querySelectorAll<HTMLElement>('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            const action = btn.dataset['action'];
            if (action === 'next') advanceStep();
            else if (action === 'back') goBack();
            else if (action === 'done') completeGuide();
            else if (action === 'dismiss') dismissRemindLater();
            else if (action === 'start') goToStep(1);
            else if (action === 'quick-start') beginQuickStart();
        });
    });
}

function hideSpotlight(): void {
    if (spotlightEl) spotlightEl.style.display = 'none';
}

function positionSpotlight(el: HTMLElement): void {
    if (!spotlightEl) return;
    const rect = el.getBoundingClientRect();
    spotlightEl.classList.remove('tour-spotlight-fixed');
    spotlightEl.style.top = rect.top + window.scrollY - PADDING + 'px';
    spotlightEl.style.left = rect.left + window.scrollX - PADDING + 'px';
    spotlightEl.style.width = rect.width + PADDING * 2 + 'px';
    spotlightEl.style.height = rect.height + PADDING * 2 + 'px';
    spotlightEl.style.display = '';
}

function positionTooltip(el: HTMLElement): void {
    if (!cardEl) return;
    const rect = el.getBoundingClientRect();
    const tipRect = cardEl.getBoundingClientRect();
    const maxBottom = window.innerHeight - FOOTER_HEIGHT - 8;

    if (maxBottom - rect.bottom > tipRect.height + 16) {
        cardEl.style.top = rect.bottom + 12 + 'px';
    } else {
        cardEl.style.top = Math.max(getNavHeight() + 4, rect.top - tipRect.height - 12) + 'px';
    }

    let left = rect.left + (rect.width - tipRect.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    cardEl.style.left = left + 'px';
}

function scrollToSection(el: HTMLElement, cb: () => void): void {
    const rect = el.getBoundingClientRect();
    const scrollTarget = window.scrollY + rect.top - getNavHeight();
    window.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' });
    setTimeout(function () {
        // Bail if the tour closed while we waited - otherwise the cb re-creates
        // cardEl after cleanup and leaks the tour.
        if (!guideActive) return;
        cb();
    }, 300);
}

function ensureTab(tab: string): void {
    const btn = document.querySelector<HTMLElement>('.tab-bar [data-tab="' + tab + '"]');
    if (btn && !btn.classList.contains('active')) btn.click();
}

function quickStartNote(): string {
    return t('Takes {min} minutes, nothing to set up.', { min: FIRST_SIT_TIMER_MIN });
}

/** Paint the "Try right now" choice from the setup view's gate: disabled,
 *  with the reason where its note was, until a first sit can start. */
function syncQuickStart(): void {
    const btn = cardEl?.querySelector<HTMLButtonElement>('[data-action="quick-start"]');
    const note = btn?.querySelector('small');
    if (!btn || !note || !quickStart) return;
    const blocker = quickStart.blocker();
    btn.disabled = blocker !== null;
    note.textContent = blocker ?? quickStartNote();
}

function beginQuickStart(): void {
    const offer = quickStart;
    if (!offer || offer.blocker() !== null) return;
    // Same standing as "I'll explore on my own": a start abandoned at the mic
    // or sign-in prompt leaves the card away for the rest of this visit.
    dismissRemindLater();
    // No await before this: the mic prompt and the audio unlock both need the
    // click's user gesture (app.ts ensureMicAvailable).
    offer.start();
}

function showWelcome(): void {
    currentStep = 0;
    hideSpotlight();
    resetTarget();

    const offerQuickStart = welcomeVariant === 'first-run' && quickStart !== null;
    let html =
        welcomeVariant === 'after-first-sit'
            ? '<h3>' + t('Shape your next sit') + '</h3><p>' + t('Customize your next session. Set the vibe, attention focus, and more.') + '</p>'
            : '<p><span class="brand-mark">aloud.</span> ' + t('is a meditation facilitator that listens and responds to your experience in real time.') + '</p>';
    html += '<div class="tour-choices">';
    if (offerQuickStart) {
        html += '<button class="tour-choice" data-action="quick-start">';
        html += '<strong>' + t('Try right now') + '</strong>';
        html += '<small>' + quickStartNote() + '</small>';
        html += '</button>';
    }
    html += '<button class="tour-choice" data-action="start">';
    html += '<strong>' + t('Show me around') + '</strong>';
    html += '<small>' + t('A quick look at how it works') + '</small>';
    html += '</button>';
    html += '<button class="tour-choice" data-action="dismiss">';
    html += '<strong>' + t('I’ll explore on my own') + '</strong>';
    html += '<small>' + t('Tap <span class="info-btn-glyph">?</span> on any section for details') + '</small>';
    html += '</button>';
    html += '</div>';

    showCard(html, 'tour-welcome');
    if (offerQuickStart) {
        syncQuickStart();
        quickStartPoll = setInterval(syncQuickStart, QUICK_START_POLL_MS);
    }
}

function showSection(index: number): void {
    currentStep = index + 1;
    const section = SECTIONS[index];
    if (!section) return;

    if (section.tab) ensureTab(section.tab);

    const target = section.target();
    if (!target) {
        advanceStep();
        return;
    }

    resetTarget();

    const panel = document.getElementById('info-' + (section.panel || section.id));
    if (panel) panel.classList.remove('hidden');

    // Elevate the target above the overlay so its info panel is readable.
    target.classList.add('guide-elevated');
    prevTarget = target;

    // Let layout settle after opening the panel.
    requestAnimationFrame(function () {
        scrollToSection(target, function () {
            positionSpotlight(target);

            // Every section ends in Next - including the last, which advances
            // to showDone(). Ending a section on "Got it" instead would skip
            // that card entirely and leave TOTAL_STEPS' last dot permanently
            // dark (settings-tour.ts closes the same way).
            const html = footerHtml({ back: true, next: true, skip: true }, TOTAL_STEPS, currentStep, 'dismiss');
            showCard(html, 'tour-tooltip');
            positionTooltip(target);
        });
    });
}

function showDone(): void {
    currentStep = SECTIONS.length + 1;
    hideSpotlight();
    resetTarget();

    let html = '<h3>' + t('You’re ready') + '</h3>';
    html += '<p>' + t('Pick what resonates and begin. Tap <span class="info-btn-glyph">?</span> on any section to revisit these notes.') + '</p>';
    html += footerHtml({ back: true, done: true, skip: false }, TOTAL_STEPS, currentStep, 'dismiss');

    showCard(html, 'tour-welcome');
}

function goToStep(step: number): void {
    if (step === 0) showWelcome();
    else if (step <= SECTIONS.length) showSection(step - 1);
    else showDone();
}

function advanceStep(): void {
    if (currentStep < TOTAL_STEPS - 1) goToStep(currentStep + 1);
    else completeGuide();
}

function goBack(): void {
    if (currentStep > 0) goToStep(currentStep - 1);
}

function completeGuide(): void {
    void sharedKv.set(GUIDE_DONE_KEY, '1');
    cleanup();
}

function dismissRemindLater(): void {
    // sessionStorage, so a skip doesn't persist across browser sessions.
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(GUIDE_REMIND_KEY, '1');
    }
    cleanup();
}

function onScroll(): void {
    if (!guideActive || !spotlightEl || spotlightEl.style.display === 'none') return;
    const idx = currentStep - 1;
    if (idx >= 0 && idx < SECTIONS.length) {
        const target = SECTIONS[idx]?.target();
        if (target) positionSpotlight(target);
    }
}

function onResizeDebounced(): void {
    // Mobile browsers fire `resize` when the URL bar shows/hides on scroll,
    // changing only the viewport HEIGHT. Re-rendering there recreates the card
    // and replays its fade-in, a disorienting blink mid-scroll. Only width
    // changes (orientation flip, genuine resize) affect our positioning.
    if (window.innerWidth === lastViewportWidth) return;
    lastViewportWidth = window.innerWidth;
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
        if (guideActive) goToStep(currentStep);
    }, 150);
}

function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') dismissRemindLater();
}

function startGuide(startStep?: number): void {
    if (guideActive) return;
    installInfoBtnHandler();
    guideActive = true;
    document.body.classList.add('guide-running');
    currentStep = 0;
    lastViewportWidth = window.innerWidth;
    createOverlay();
    window.addEventListener('resize', onResizeDebounced);
    window.addEventListener('scroll', onScroll);
    document.addEventListener('keydown', onKeyDown);
    if (typeof startStep === 'number' && startStep > 0) {
        goToStep(startStep);
    } else {
        showWelcome();
    }
}

// "Take the full tour" link - an explicit opt-in, so skip the welcome screen
// and jump to the first section. The link sits in the methods panel the tour
// itself spotlights, so one may already be running, and startGuide() no-ops
// while one is: close it first.
export async function resetAndStart(): Promise<void> {
    await sharedKv.delete(GUIDE_DONE_KEY);
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(GUIDE_REMIND_KEY);
    }
    if (guideActive) cleanup();
    welcomeVariant = 'plain';
    startGuide(1);
}

// The auto-start's delayed timer, so leaving the setup view can cancel it.
let pendingAutoStart: ReturnType<typeof setTimeout> | null = null;

/** Which card, if any, this visit to the setup page opens on. */
async function pendingWelcome(): Promise<WelcomeVariant | null> {
    const session = typeof sessionStorage !== 'undefined' ? sessionStorage : null;
    if (await sharedKv.get(FOLLOW_UP_KEY)) {
        // A History "Continue" or cold-boot resume owns this visit (the resume
        // offer is a modal of its own); the follow-up keeps for the next one.
        return session?.getItem('continueFrom') ? null : 'after-first-sit';
    }
    if (await sharedKv.get(GUIDE_DONE_KEY)) return null;
    if (session?.getItem(GUIDE_REMIND_KEY)) return null;
    // Anyone who has started a session knows the app - no tour. The marker is
    // set by markSessionStarted() on session-view mount.
    if (await sharedKv.get(CLIENT_ID_KEY)) return null;
    return 'first-run';
}

/** @param offer The setup view's first-sit hook; without one the welcome card
 *  has no "Try right now".
 *  @param hold Keep the card down for this visit, unspent: the setup view has
 *  the mode tabs locked (a continuation), and the tour walks all of them. */
export async function autoStart(offer: QuickStart | null = null, hold = false): Promise<void> {
    installInfoBtnHandler();
    quickStart = offer;
    if (hold) return;
    const variant = await pendingWelcome();
    if (!variant) return;
    if (pendingAutoStart) clearTimeout(pendingAutoStart);
    pendingAutoStart = setTimeout(function () {
        pendingAutoStart = null;
        // The awaits above can outlast a quick Begin, after which
        // closeIfActive had nothing to close. Start only while the setup page
        // is still on screen - the overlay lives on <body>, and with no
        // targets it would sit over the whole sit.
        if (!setupHeader()) return;
        // Spent only once the card is really going up, so a visit that left
        // setup inside the delay doesn't use up the one showing.
        if (variant === 'after-first-sit') void sharedKv.delete(FOLLOW_UP_KEY);
        welcomeVariant = variant;
        startGuide();
    }, 250);
}

/**
 * Record that the user has started a session (the aloud-client-id marker
 * autoStart() checks), so the setup tour won't pop up on a later boot.
 *
 * Set unconditionally, NOT gated on "Save session logs" the way sessionStore is:
 * someone who has run a session knows their way around whether or not they keep
 * transcripts, so session history isn't a reliable "new user" signal.
 *
 * @param firstSit This session is a first sit: queue its follow-up card.
 */
export async function markSessionStarted(firstSit = false): Promise<void> {
    if (firstSit) await sharedKv.set(FOLLOW_UP_KEY, '1');
    if (await sharedKv.get(CLIENT_ID_KEY)) return;
    await sharedKv.set(CLIENT_ID_KEY, '1');
}

export function closeIfActive(): void {
    if (pendingAutoStart) {
        clearTimeout(pendingAutoStart);
        pendingAutoStart = null;
    }
    if (guideActive) cleanup();
}

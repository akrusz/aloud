/**
 * Info panels and guided tour for the setup (index) page. Each section's ?
 * button toggles an inline info panel; the guide walks all panels in sequence
 * with a spotlight overlay, reusing the settings tour's .tour-* CSS.
 */

import { sharedKv } from '../state.js';

const GUIDE_DONE_KEY = 'aloud-index-guide-done';
const GUIDE_REMIND_KEY = 'aloud-index-guide-remind';
const CLIENT_ID_KEY = 'aloud-client-id';

const PADDING = 10;
const FOOTER_HEIGHT = 60;

function getNavHeight(): number {
    const nav = document.querySelector('.nav');
    return nav ? nav.getBoundingClientRect().height + 16 : 80;
}

// ---- Standalone info panel toggle ----

function toggleInfo(id: string): void {
    const panel = document.getElementById('info-' + id);
    if (!panel) return;
    const wasHidden = panel.classList.contains('hidden');
    document.querySelectorAll('.info-panel').forEach(function (p) {
        p.classList.add('hidden');
    });
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

// ---- Tour state ----

let overlayEl: HTMLDivElement | null = null;
let spotlightEl: HTMLDivElement | null = null;
let cardEl: HTMLDivElement | null = null;
let currentStep = 0;
let guideActive = false;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let prevTarget: HTMLElement | null = null;
let lastViewportWidth = 0;

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

/** The focus/vibe groups sit inside the "Customize facilitator" disclosure,
 *  collapsed by default on phones - open it so those steps have a visible
 *  target to spotlight. */
function ensureCustomizeOpen(): void {
    const section = document.getElementById('customize-section');
    if (!section || section.classList.contains('open')) return;
    section.classList.add('open');
    document.getElementById('customize-toggle')?.setAttribute('aria-expanded', 'true');
}

// The methods panel shows only the active tab's text (views/setup.ts), so the
// tour visits each tab in turn to cover all three methods.
const SECTIONS: ReadonlyArray<Section> = [
    { id: 'methods-exploration', panel: 'methods', tab: 'exploration', target: setupHeader },
    { id: 'methods-noting', panel: 'methods', tab: 'noting', target: setupHeader },
    { id: 'methods-felt-sense', panel: 'methods', tab: 'felt_sense', target: setupHeader },
    {
        id: 'focus',
        tab: 'exploration',
        target: function () {
            ensureCustomizeOpen();
            const btn = document.querySelector<HTMLElement>('[data-info="focus"]');
            return btn ? btn.closest<HTMLElement>('.form-group') : null;
        },
    },
    {
        id: 'vibe',
        tab: 'exploration',
        target: function () {
            ensureCustomizeOpen();
            const btn = document.querySelector<HTMLElement>('[data-info="vibe"]');
            return btn ? btn.closest<HTMLElement>('.form-group') : null;
        },
    },
];

const TOTAL_STEPS = SECTIONS.length + 2; // welcome + sections + done

// ---- DOM helpers ----

function createOverlay(): void {
    overlayEl = document.createElement('div');
    overlayEl.className = 'tour-overlay';
    spotlightEl = document.createElement('div');
    spotlightEl.className = 'tour-spotlight';
    document.body.appendChild(overlayEl);
    document.body.appendChild(spotlightEl);
}

function cleanup(): void {
    if (overlayEl) overlayEl.remove();
    if (spotlightEl) spotlightEl.remove();
    if (cardEl) cardEl.remove();
    overlayEl = spotlightEl = cardEl = null;
    guideActive = false;
    if (prevTarget) {
        prevTarget.classList.remove('guide-elevated');
        prevTarget = null;
    }
    document.querySelectorAll('.info-panel').forEach(function (p) {
        p.classList.add('hidden');
    });
    window.removeEventListener('resize', onResizeDebounced);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKeyDown);
}

function showCard(html: string, className?: string): void {
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

// ---- Footer (dots + nav) ----

interface FooterOpts {
    skip?: boolean;
    back?: boolean;
    next?: boolean;
    done?: boolean;
}

function footerHtml(opts: FooterOpts): string {
    let html = '<div class="tour-footer">';
    if (opts.skip !== false) {
        html += '<button class="tour-skip" data-action="dismiss">Skip</button>';
    } else {
        html += '<span></span>';
    }
    html += '<div class="tour-dots">';
    for (let i = 0; i < TOTAL_STEPS; i++) {
        html += '<div class="tour-dot' + (i === currentStep ? ' active' : '') + '"></div>';
    }
    html += '</div>';
    html += '<div class="tour-actions">';
    if (opts.back) html += '<button class="btn btn-small btn-secondary" data-action="back">Back</button>';
    if (opts.next) html += '<button class="btn btn-small btn-primary" data-action="next">Next</button>';
    if (opts.done) html += '<button class="btn btn-small btn-primary" data-action="done">Got it</button>';
    html += '</div></div>';
    return html;
}

// ---- Steps ----

function showWelcome(): void {
    currentStep = 0;
    hideSpotlight();
    if (prevTarget) {
        prevTarget.classList.remove('guide-elevated');
        prevTarget = null;
    }
    document.querySelectorAll('.info-panel').forEach(function (p) {
        p.classList.add('hidden');
    });

    let html = '<p><span class="brand-mark">aloud.</span> is a meditation facilitator that listens and responds to your experience in real time.</p>';
    html += '<div class="tour-choices">';
    html += '<button class="tour-choice" data-action="start">';
    html += '<strong>Show me around</strong>';
    html += '<small>A quick look at how it works</small>';
    html += '</button>';
    html += '<button class="tour-choice" data-action="dismiss">';
    html += '<strong>I’ll explore on my own</strong>';
    html += '<small>You can tap <span class="info-btn-glyph">?</span> on any section for more info</small>';
    html += '</button>';
    html += '</div>';

    showCard(html, 'tour-welcome');
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

    if (prevTarget) prevTarget.classList.remove('guide-elevated');
    document.querySelectorAll('.info-panel').forEach(function (p) {
        p.classList.add('hidden');
    });

    const panel = document.getElementById('info-' + (section.panel || section.id));
    if (panel) panel.classList.remove('hidden');

    // Elevate the target above the overlay so its info panel is readable.
    target.classList.add('guide-elevated');
    prevTarget = target;

    // Let layout settle after opening the panel.
    requestAnimationFrame(function () {
        scrollToSection(target, function () {
            positionSpotlight(target);

            const html = footerHtml({
                back: true,
                next: index < SECTIONS.length - 1,
                done: index === SECTIONS.length - 1,
                skip: true,
            });
            showCard(html, 'tour-tooltip');
            positionTooltip(target);
        });
    });
}

function showDone(): void {
    currentStep = SECTIONS.length + 1;
    hideSpotlight();
    if (prevTarget) {
        prevTarget.classList.remove('guide-elevated');
        prevTarget = null;
    }
    document.querySelectorAll('.info-panel').forEach(function (p) {
        p.classList.add('hidden');
    });

    let html = '<h3>You’re ready</h3>';
    html += '<p>Pick what resonates and begin. Tap <span class="info-btn-glyph">?</span> on any section to revisit these notes.</p>';
    html += footerHtml({ back: true, done: true, skip: false });

    showCard(html, 'tour-welcome');
}

// ---- Navigation ----

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

// ---- Event handlers ----

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

// ---- Entry points ----

export function startGuide(startStep?: number): void {
    if (guideActive) return;
    installInfoBtnHandler();
    guideActive = true;
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
// and jump to the first section.
export async function resetAndStart(): Promise<void> {
    await sharedKv.delete(GUIDE_DONE_KEY);
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(GUIDE_REMIND_KEY);
    }
    startGuide(1);
}

export async function autoStart(): Promise<void> {
    installInfoBtnHandler();
    if (await sharedKv.get(GUIDE_DONE_KEY)) return;
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(GUIDE_REMIND_KEY)) return;
    // Anyone who has started a session knows the app - no tour. The marker is
    // set by markSessionStarted() on session-view mount.
    if (await sharedKv.get(CLIENT_ID_KEY)) return;
    setTimeout(function () {
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
 */
export async function markSessionStarted(): Promise<void> {
    if (await sharedKv.get(CLIENT_ID_KEY)) return;
    await sharedKv.set(CLIENT_ID_KEY, '1');
}

export function closeIfActive(): void {
    if (guideActive) cleanup();
}

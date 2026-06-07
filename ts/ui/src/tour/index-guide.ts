/**
 * Info panels and guided tour for the setup (index) page.
 *
 * Each section has a ? button that toggles an inline info panel.
 * The guide walks through all panels sequentially with a spotlight overlay,
 * reusing the .tour-* CSS classes from the settings tour.
 *
 * Lifted from src/web/static/js/index-guide.js — keep behavior in sync.
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

// Delegated handler so ? clicks keep working regardless of any DOM
// manipulation during the tour (the buttons themselves don't get
// re-rendered, but delegation removes any chance of stale per-element
// listeners blocking clicks after a partial tour close).
//
// Registered once, lazily, when startGuide/autoStart is first called from
// the setup view — avoids attaching to settings/history pages that don't
// have info-btn[data-info] elements wired up for this tour.
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

interface Section {
    id: string;
    target: () => HTMLElement | null;
}

const SECTIONS: ReadonlyArray<Section> = [
    {
        id: 'methods',
        target: function () {
            return document.querySelector<HTMLElement>('.setup-header');
        },
    },
    {
        id: 'focus',
        target: function () {
            const btn = document.querySelector<HTMLElement>('[data-info="focus"]');
            return btn ? btn.closest<HTMLElement>('.form-group') : null;
        },
    },
    {
        id: 'vibe',
        target: function () {
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
        // Bail if the tour was closed while we were waiting — otherwise
        // the cb would re-create cardEl after cleanup and leak the tour.
        if (!guideActive) return;
        cb();
    }, 300);
}

function ensureExplorationTab(): void {
    const panel = document.getElementById('exploration-panel');
    if (panel && panel.classList.contains('hidden')) {
        const btn = document.querySelector<HTMLElement>('[data-tab="exploration"]');
        if (btn) btn.click();
    }
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

    // Focus and vibe are on the exploration tab
    if (section.id === 'focus' || section.id === 'vibe') {
        ensureExplorationTab();
    }

    const target = section.target();
    if (!target) {
        advanceStep();
        return;
    }

    // Clean up previous
    if (prevTarget) prevTarget.classList.remove('guide-elevated');
    document.querySelectorAll('.info-panel').forEach(function (p) {
        p.classList.add('hidden');
    });

    // Open this section's info panel
    const panel = document.getElementById('info-' + section.id);
    if (panel) panel.classList.remove('hidden');

    // Elevate target above overlay so info panel is readable
    target.classList.add('guide-elevated');
    prevTarget = target;

    // Wait a frame for layout to settle after opening panel
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
    // Session-scoped in the original Python (sessionStorage) — preserved
    // here so a tour skip doesn't persist across browser sessions.
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

// "Take the full tour" link — user has explicitly opted in, so skip the
// welcome screen and jump straight to the first section.
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
    // If the user has already started at least one session, they know the
    // app — don't pop up the tour. The marker is set by markSessionStarted()
    // when a session view mounts (see session.ts / noting-session.ts).
    if (await sharedKv.get(CLIENT_ID_KEY)) return;
    setTimeout(function () {
        startGuide();
    }, 250);
}

/**
 * Record that the user has started at least one session, so the setup-page
 * tour won't pop up again on a later boot. Called on session mount.
 *
 * Set unconditionally — NOT gated on the "Save session logs" setting the way
 * sessionStore is. The tour is only for genuinely new users; someone who has
 * run a session knows their way around whether or not they keep transcripts
 * (so the session history list isn't a reliable "new user" signal). Restores
 * the aloud-client-id marker the Python app set on first session start, which
 * autoStart() checked but the TS port never wrote.
 */
export async function markSessionStarted(): Promise<void> {
    if (await sharedKv.get(CLIENT_ID_KEY)) return;
    await sharedKv.set(CLIENT_ID_KEY, '1');
}

export function closeIfActive(): void {
    if (guideActive) cleanup();
}

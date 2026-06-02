/**
 * Interactive onboarding wizard for the settings page.
 *
 * Walks first-time users through choosing an LLM provider and voice,
 * actually setting the form values for them based on their choices.
 *
 * Lifted from src/web/static/js/tour.js — keep behavior in sync. DOM
 * selectors that diverge between the Python and TS settings views are
 * adapted inline (e.g. Python's per-provider `#s-anthropic-key` becomes
 * `#s-key-anthropic` in the TS UI, and the model dropdown lives inside
 * `#s-model-slot` as `#model-select`).
 */

import { sharedKv } from '../state.js';
import { appUrl } from '../app-base.js';

const TOUR_DISMISSED_KEY = 'aloud-tour-dismissed';
const TOUR_REMIND_KEY = 'aloud-tour-remind-later';

const PADDING = 10;
const FOOTER_HEIGHT = 60; // approximate footer height

function getNavHeight(): number {
    const nav = document.querySelector('.nav');
    return nav ? nav.getBoundingClientRect().height + 16 : 80;
}
const TOTAL_STEPS = 4; // welcome, llm, voice, done

// ---- State ----

let overlayEl: HTMLDivElement | null = null;
let spotlightEl: HTMLDivElement | null = null;
let cardEl: HTMLDivElement | null = null;
let currentStep = 0;
let onCompleteCb: (() => void) | null = null;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

interface TourOptions {
    piperAvailable?: boolean;
    isMac?: boolean;
    ollamaRec?: string | null;
    onComplete?: () => void;
}

let tourOptions: TourOptions = {};

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
    if (overlayEl && overlayEl.parentNode) overlayEl.remove();
    if (spotlightEl && spotlightEl.parentNode) spotlightEl.remove();
    if (cardEl && cardEl.parentNode) cardEl.remove();
    window.removeEventListener('resize', onResizeDebounced);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKeyDown);
    overlayEl = spotlightEl = cardEl = null;
}

function hideTour(): void {
    if (overlayEl && overlayEl.parentNode) overlayEl.remove();
    if (spotlightEl && spotlightEl.parentNode) spotlightEl.remove();
    if (cardEl && cardEl.parentNode) cardEl.remove();
}

function showTour(): void {
    // Re-attach elements to DOM
    if (overlayEl && !overlayEl.parentNode) document.body.appendChild(overlayEl);
    if (spotlightEl && !spotlightEl.parentNode) document.body.appendChild(spotlightEl);
}

function showCard(html: string, className?: string): void {
    if (cardEl && cardEl.parentNode) cardEl.remove();
    cardEl = document.createElement('div');
    cardEl.className = className || 'tour-tooltip';
    cardEl.innerHTML = html;
    document.body.appendChild(cardEl);
    if (overlayEl) overlayEl.classList.toggle('tour-overlay-flat', className === 'tour-welcome');
    wireActions();
}

function wireActions(): void {
    if (!cardEl) return;
    // Let links inside tour cards open normally without triggering the button action
    cardEl.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(function (link) {
        link.addEventListener('click', function (e) {
            e.stopPropagation();
        });
    });
    cardEl.querySelectorAll<HTMLElement>('[data-action]').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
            const target = e.target as Element | null;
            if (target?.closest('a')) return;
            e.stopPropagation();
            const action = btn.dataset['action'];
            if (action === 'self-serve') dismissRemindLater();
            else if (action === 'help') goToStep(1);
            else if (action === 'back') goBack();
            else if (action === 'done') completeTour();
            else if (action === 'skip') dismissRemindLater();
            else if (action === 'next') advanceStep();
            else if (action === 'provider') chooseProvider(btn.dataset['value'] || '');
            else if (action === 'show-api-keys') showApiKeyChoices();
            else if (action === 'voice') chooseVoice(btn.dataset['value'] || '');
        });
    });
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
        html += '<button class="tour-skip" data-action="skip">Skip</button>';
    } else {
        html += '<span></span>';
    }

    html += '<div class="tour-dots">';
    for (let i = 0; i < TOTAL_STEPS; i++) {
        html += '<div class="tour-dot' + (i === currentStep ? ' active' : '') + '"></div>';
    }
    html += '</div>';

    html += '<div class="tour-actions">';
    if (opts.back) {
        html += '<button class="btn btn-small btn-secondary" data-action="back">Back</button>';
    }
    if (opts.next) {
        html += '<button class="btn btn-small btn-primary" data-action="next">Next</button>';
    }
    if (opts.done) {
        html += '<button class="btn btn-small btn-primary" data-action="done">Got it</button>';
    }
    html += '</div></div>';
    return html;
}

// ---- Positioning ----

function positionSpotlight(el: HTMLElement, fixed: boolean): void {
    if (!spotlightEl) return;
    const rect = el.getBoundingClientRect();
    const pad = fixed ? 0 : PADDING;
    if (fixed) {
        spotlightEl.classList.add('tour-spotlight-fixed');
        spotlightEl.style.top = rect.top - pad + 'px';
        spotlightEl.style.left = rect.left - pad + 'px';
    } else {
        spotlightEl.classList.remove('tour-spotlight-fixed');
        spotlightEl.style.top = rect.top + window.scrollY - pad + 'px';
        spotlightEl.style.left = rect.left + window.scrollX - pad + 'px';
    }
    spotlightEl.style.width = rect.width + pad * 2 + 'px';
    spotlightEl.style.height = rect.height + pad * 2 + 'px';
    spotlightEl.style.display = '';
}

function positionTooltip(el: HTMLElement): void {
    if (!cardEl) return;
    const rect = el.getBoundingClientRect();
    const tipRect = cardEl.getBoundingClientRect();
    const maxBottom = window.innerHeight - FOOTER_HEIGHT - 8;
    const spaceBelow = maxBottom - rect.bottom;

    if (spaceBelow > tipRect.height + 16) {
        cardEl.style.top = rect.bottom + 12 + 'px';
    } else {
        // Place above, clamped below the nav
        cardEl.style.top = Math.max(getNavHeight() + 4, rect.top - tipRect.height - 12) + 'px';
    }

    let left = rect.left + (rect.width - tipRect.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    cardEl.style.left = left + 'px';

    // Final clamp: don't let tooltip extend below footer
    const finalRect = cardEl.getBoundingClientRect();
    if (finalRect.bottom > maxBottom) {
        cardEl.style.top = maxBottom - finalRect.height + 'px';
    }
}

function hideSpotlight(): void {
    if (spotlightEl) spotlightEl.style.display = 'none';
}

function scrollToSection(el: HTMLElement, cb: () => void): void {
    const rect = el.getBoundingClientRect();
    const scrollTarget = window.scrollY + rect.top - getNavHeight();
    window.scrollTo({ top: Math.max(0, scrollTarget), behavior: 'smooth' });
    setTimeout(cb, 300);
}

// ---- Step 0: Welcome ----

function showWelcome(): void {
    currentStep = 0;
    hideSpotlight();

    let html = '<p>Welcome to <span class="brand-mark">aloud.</span> &mdash; let’s get your meditation facilitator set up. It only takes a minute.</p>';
    html += '<div class="tour-choices">';
    html += '<button class="tour-choice" data-action="help">';
    html += '<strong>Help me set up</strong>';
    html += '<small>We’ll walk you through choosing an AI provider and voice</small>';
    html += '</button>';
    html += '<button class="tour-choice" data-action="self-serve">';
    html += '<strong>I’ll set this up myself</strong>';
    html += '<small>Use the settings page directly</small>';
    html += '</button>';
    html += '</div>';

    showCard(html, 'tour-welcome');
}

// ---- Step 1: LLM Provider ----

function getProviderSection(): HTMLElement | null {
    const sel = document.getElementById('s-provider');
    return sel ? sel.closest<HTMLElement>('.settings-section') : null;
}

function showLLMStep(): void {
    currentStep = 1;
    const section = getProviderSection();
    if (!section) {
        advanceStep();
        return;
    }

    scrollToSection(section, function () {
        positionSpotlight(section, false);

        let html = '<h3>Choose Your AI Provider</h3>';
        html += '<p>An LLM is the AI that guides your meditation. Pick what works for you:</p>';
        html += '<div class="tour-choices">';

        // Ollama
        let ollamaDesc = 'Free &amp; private. Runs AI entirely on your computer.';
        if (tourOptions.ollamaRec) {
            ollamaDesc += ' Recommended model: <strong>' + tourOptions.ollamaRec + '</strong>';
        }
        html += '<button class="tour-choice" data-action="provider" data-value="ollama">';
        html += '<strong>Ollama: free, runs locally</strong>';
        html += '<small>' + ollamaDesc + '</small>';
        html += '</button>';

        // Claude subscription
        html += '<button class="tour-choice" data-action="provider" data-value="claude_proxy">';
        html += '<strong>I have a Claude subscription</strong>';
        html += '<small>Uses your Pro or Max plan via the locally-installed <code>claude</code> CLI (Claude Code).</small>';
        html += '</button>';

        // API key
        html += '<button class="tour-choice" data-action="show-api-keys">';
        html += '<strong>I have an API key</strong>';
        html += '<small>Anthropic, OpenAI, Groq, OpenRouter, or Venice</small>';
        html += '</button>';

        html += '</div>';
        html += footerHtml({ back: true, skip: true });

        showCard(html, 'tour-tooltip');
        positionTooltip(section);
    });
}

function showApiKeyChoices(): void {
    const section = getProviderSection();
    if (!section) return;

    let html = '<h3>Which provider?</h3>';
    html += '<p>Select the provider you have an API key for:</p>';
    html += '<div class="tour-choice-group">';
    html += '<button class="tour-choice-sm" data-action="provider" data-value="anthropic">Anthropic</button>';
    html += '<button class="tour-choice-sm" data-action="provider" data-value="openai">OpenAI</button>';
    html += '<button class="tour-choice-sm" data-action="provider" data-value="groq">Groq</button>';
    html += '<button class="tour-choice-sm" data-action="provider" data-value="openrouter">OpenRouter</button>';
    html += '<button class="tour-choice-sm" data-action="provider" data-value="venice">Venice</button>';
    html += '</div>';
    html += footerHtml({ back: true, skip: true });

    showCard(html, 'tour-tooltip');
    positionTooltip(section);
}

/**
 * Locate the TS UI's model picker element. The Python tour reads
 * `#s-model` (a <select>) — in the TS UI the picker mounts inside
 * `#s-model-slot` and renders either `#model-select` or `#model-input`
 * depending on whether the /api/models fetch succeeded.
 */
function findModelElement(): HTMLSelectElement | HTMLInputElement | null {
    return (
        document.querySelector<HTMLSelectElement>('#s-model-slot #model-select') ||
        document.querySelector<HTMLInputElement>('#s-model-slot #model-input')
    );
}

function chooseProvider(value: string): void {
    const sel = document.getElementById('s-provider') as HTMLSelectElement | null;
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change'));

    // Hide tour so user can interact with the section freely
    hideTour();

    const resumeToVoice = function (): void {
        showTour();
        showVoiceStep();
    };

    if (value === 'ollama') {
        // Wait for a model to be available (downloaded) before advancing
        waitForCondition(function () {
            const m = findModelElement();
            if (!m) return false;
            if (m instanceof HTMLSelectElement) {
                if (m.options.length === 0) return false;
                const text = m.options[0]?.textContent || '';
                return Boolean(m.value) && text !== 'Loading...' && text !== 'No models available';
            }
            // Text-input fallback — treat any non-empty value as ready.
            return Boolean(m.value.trim());
        }, resumeToVoice);
    } else if (value === 'claude_proxy') {
        // Wait for the model dropdown to populate (claude CLI detected, models loaded)
        waitForCondition(function () {
            const m = findModelElement();
            if (!m) return false;
            if (m instanceof HTMLSelectElement) {
                if (m.options.length === 0) return false;
                const text = m.options[0]?.textContent || '';
                return Boolean(m.value) && text !== 'Loading...' && text !== 'No models available';
            }
            return Boolean(m.value.trim());
        }, resumeToVoice);
    } else {
        // API key provider — wait for key field to be filled. TS UI uses
        // `#s-key-${provider}` per the render in views/settings.ts; the
        // Python original used `#s-${provider}-key`.
        const keyMap: Record<string, string> = {
            anthropic: 's-key-anthropic',
            openai: 's-key-openai',
            groq: 's-key-groq',
            openrouter: 's-key-openrouter',
            venice: 's-key-venice',
        };
        const fieldId = keyMap[value];
        waitForCondition(function () {
            const input = fieldId
                ? (document.getElementById(fieldId) as HTMLInputElement | null)
                : null;
            return Boolean(input && input.value.trim().length > 8);
        }, resumeToVoice);
    }
}

function waitForCondition(test: () => boolean, cb: () => void): void {
    // Check immediately in case condition is already met
    if (test()) {
        cb();
        return;
    }
    const timer = setInterval(function () {
        if (test()) {
            clearInterval(timer);
            cb();
        }
    }, 500);
    // Safety: don't block forever — after 5 minutes give up and advance
    setTimeout(function () {
        clearInterval(timer);
        cb();
    }, 300000);
}

// ---- Step 2: Voice ----

function getVoiceSection(): HTMLElement | null {
    const sel = document.getElementById('s-tts-engine');
    return sel ? sel.closest<HTMLElement>('.settings-section') : null;
}

function showVoiceStep(): void {
    currentStep = 2;
    const section = getVoiceSection();
    if (!section) {
        advanceStep();
        return;
    }

    scrollToSection(section, function () {
        positionSpotlight(section, false);

        let html = '<h3>Set Up Your Voice</h3>';
        html += '<p>This is how aloud speaks to you. A natural-sounding voice makes a big difference.</p>';
        html += '<div class="tour-choices">';

        if (tourOptions.piperAvailable) {
            html += '<button class="tour-choice" data-action="voice" data-value="piper">';
            html += '<strong>Piper: free, natural sounding</strong>';
            html += '<small>Local neural TTS. Pick and download a voice (~60–100 MB).</small>';
            html += '</button>';
        }

        if (tourOptions.isMac) {
            html += '<button class="tour-choice" data-action="voice" data-value="macos">';
            html += '<strong>Premium macOS voices</strong>';
            html += '<small>Download from System Settings → Accessibility → Spoken Content. In the System Voice row, click the <b>ⓘ</b> then click Voice. <a href="#" onclick="fetch(\'/app/v1/open-voice-settings\',{method:\'POST\'}); return false;">Open Settings</a></small>';
            html += '</button>';
        }

        if (!tourOptions.isMac) {
            html += '<button class="tour-choice" data-action="voice" data-value="skip">';
            html += '<strong>Browser voices</strong>';
            html += '<small>On Windows, Edge and the desktop app include high-quality natural voices.</small>';
            html += '</button>';
        }

        html += '<button class="tour-choice" data-action="voice" data-value="skip">';
        html += '<strong>Skip, I’ll pick later</strong>';
        html += '</button>';

        html += '</div>';
        html += footerHtml({ back: true, skip: true });

        showCard(html, 'tour-tooltip');
        positionTooltip(section);
    });
}

function chooseVoice(value: string): void {
    if (value === 'skip' || value === 'macos') {
        showDoneStep();
        return;
    }

    if (value === 'piper') {
        // Hide the tour so the voice picker modal is fully usable
        hideTour();

        // Open picker (all voices are already loaded)
        setTimeout(function () {
            const btn = document.getElementById('s-voice-btn');
            if (btn) btn.click();
            // Watch for the voice picker to close, then show done step
            waitForPickerClose(function () {
                showTour();
                showDoneStep();
            });
        });
    }
}

function waitForPickerClose(cb: () => void): void {
    // TS UI mounts the settings voice modal with id 'settings-voice-modal'
    // (matches Python). Same hidden-class semantics — toggling 'hidden'
    // is how the modal opens/closes.
    const modal = document.getElementById('settings-voice-modal');
    if (!modal) {
        cb();
        return;
    }

    const observer = new MutationObserver(function () {
        if (modal.classList.contains('hidden')) {
            observer.disconnect();
            cb();
        }
    });
    observer.observe(modal, { attributes: true, attributeFilter: ['class'] });

    // Safety timeout: if modal never gets hidden class, resume after 60s
    setTimeout(function () {
        observer.disconnect();
        cb();
    }, 60000);
}

// ---- Step 3: Done ----

function showDoneStep(): void {
    currentStep = 3;
    const footer = document.querySelector<HTMLElement>('.settings-footer');
    if (!footer) {
        completeTour();
        return;
    }

    // Footer is position:fixed, so spotlight must be fixed too
    positionSpotlight(footer, true);

    let html = '<h3>You’re All Set</h3>';
    html += '<p>Hit <strong>Save &amp; Start</strong> to begin your first meditation. You can always come back to change these settings later.</p>';
    html += footerHtml({ back: true, done: true, skip: false });

    showCard(html, 'tour-tooltip');
    if (!cardEl) return;

    // Position tooltip above the footer, clamped in viewport
    const footerRect = footer.getBoundingClientRect();
    const tipRect = cardEl.getBoundingClientRect();
    cardEl.style.top = footerRect.top - tipRect.height - 12 + 'px';
    let left = footerRect.left + (footerRect.width - tipRect.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    cardEl.style.left = left + 'px';
}

// ---- Navigation ----

function goToStep(step: number): void {
    if (step === 0) showWelcome();
    else if (step === 1) showLLMStep();
    else if (step === 2) showVoiceStep();
    else if (step === 3) showDoneStep();
}

function advanceStep(): void {
    if (currentStep < TOTAL_STEPS - 1) {
        goToStep(currentStep + 1);
    } else {
        completeTour();
    }
}

function goBack(): void {
    if (currentStep > 0) {
        goToStep(currentStep - 1);
    }
}

function completeTour(): void {
    void sharedKv.set(TOUR_DISMISSED_KEY, '1');
    cleanup();
    if (onCompleteCb) onCompleteCb();
}

function dismissRemindLater(): void {
    // Session-scoped — match Python's sessionStorage usage so a "skip"
    // doesn't survive across browser sessions.
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(TOUR_REMIND_KEY, '1');
    }
    cleanup();
    if (onCompleteCb) onCompleteCb();
}

// ---- Event handlers ----

function onScroll(): void {
    if (!spotlightEl || spotlightEl.style.display === 'none') return;
    if (currentStep === 3) return; // footer spotlight is fixed
    let el: HTMLElement | null = null;
    if (currentStep === 1) el = getProviderSection();
    else if (currentStep === 2) el = getVoiceSection();
    if (el) positionSpotlight(el, false);
}

function onResizeDebounced(): void {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
        if (!cardEl) return;
        goToStep(currentStep);
    }, 150);
}

function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') dismissRemindLater();
}

// ---- Entry point ----

export async function startTour(options: TourOptions): Promise<void> {
    if (await sharedKv.get(TOUR_DISMISSED_KEY)) {
        if (options.onComplete) options.onComplete();
        return;
    }
    if (typeof sessionStorage !== 'undefined' && sessionStorage.getItem(TOUR_REMIND_KEY)) {
        if (options.onComplete) options.onComplete();
        return;
    }

    onCompleteCb = options.onComplete || null;
    tourOptions = {};
    if (options.piperAvailable !== undefined) tourOptions.piperAvailable = options.piperAvailable;
    if (options.isMac !== undefined) tourOptions.isMac = options.isMac;

    // Fetch Ollama recommendation, then start
    try {
        const r = await fetch(appUrl('/providers'));
        const data = (await r.json()) as {
            ollama?: { recommendation?: { recommended_model?: string } };
        };
        const rec = data.ollama && data.ollama.recommendation;
        tourOptions.ollamaRec = rec ? rec.recommended_model ?? null : null;
    } catch {
        // Flask not reachable — proceed without an Ollama recommendation.
    }
    initTour();
}

export async function resetAndStart(options: TourOptions): Promise<void> {
    await sharedKv.delete(TOUR_DISMISSED_KEY);
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(TOUR_REMIND_KEY);
    }
    await startTour(options);
}

function initTour(): void {
    currentStep = 0;
    createOverlay();
    window.addEventListener('resize', onResizeDebounced);
    window.addEventListener('scroll', onScroll);
    document.addEventListener('keydown', onKeyDown);
    showWelcome();
}

export function closeIfActive(): void {
    if (overlayEl || spotlightEl || cardEl) cleanup();
}

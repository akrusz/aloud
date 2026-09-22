/**
 * Interactive onboarding wizard for the settings page. Walks first-time users
 * through choosing an LLM provider and voice, setting the form values for them.
 * Selectors are wired to the settings view's ids (per-provider
 * `#s-key-anthropic`, the model dropdown at `#s-model-slot #model-select`).
 */

import { sharedKv } from '../state.js';
import { t } from '../i18n.js';
import { footerHtml as sharedFooterHtml, getNavHeight, type FooterOpts } from './tour-common.js';

const TOUR_DISMISSED_KEY = 'aloud-tour-dismissed';
const TOUR_REMIND_KEY = 'aloud-tour-remind-later';

const PADDING = 10;
const FOOTER_HEIGHT = 60; // approximate footer height
const TOTAL_STEPS = 4; // welcome, llm, voice, done

// ---- State ----

let overlayEl: HTMLDivElement | null = null;
let spotlightEl: HTMLDivElement | null = null;
let cardEl: HTMLDivElement | null = null;
let currentStep = 0;
// aloud cloud brings its own voices, so choosing it drops the voice step - in
// both directions, or Back from the closing card would land on it.
let skipVoiceStep = false;
let resizeTimer: ReturnType<typeof setTimeout> | null = null;

interface TourOptions {
    piperAvailable?: boolean;
    isMac?: boolean;
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
    hideTour();
    window.removeEventListener('resize', onResizeDebounced);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKeyDown);
    overlayEl = spotlightEl = cardEl = null;
}

/** Detach the tour's elements, keeping them for showTour() to put back. */
function hideTour(): void {
    overlayEl?.remove();
    spotlightEl?.remove();
    cardEl?.remove();
}

function showTour(): void {
    if (overlayEl && !overlayEl.parentNode) document.body.appendChild(overlayEl);
    if (spotlightEl && !spotlightEl.parentNode) document.body.appendChild(spotlightEl);
}

function showCard(html: string, className?: string): void {
    cardEl?.remove();
    cardEl = document.createElement('div');
    cardEl.className = className || 'tour-tooltip';
    cardEl.innerHTML = html;
    document.body.appendChild(cardEl);
    if (overlayEl) overlayEl.classList.toggle('tour-overlay-flat', className === 'tour-welcome');
    wireActions();
}

function wireActions(): void {
    if (!cardEl) return;
    // Links inside cards open normally, without firing the button action.
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

/** The shared footer, minus the voice step's dot when that step is skipped. */
function footerHtml(opts: FooterOpts): string {
    if (!skipVoiceStep) return sharedFooterHtml(opts, TOTAL_STEPS, currentStep, 'skip');
    return sharedFooterHtml(opts, TOTAL_STEPS - 1, currentStep > 2 ? currentStep - 1 : currentStep, 'skip');
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
    // A settings section draws its divider as its own border-bottom, under its
    // padding. Stop the box short of it, keeping a sliver of that padding as a
    // gap so the rule reads as outside the highlight.
    const cs = getComputedStyle(el);
    const rule = parseFloat(cs.borderBottomWidth) || 0;
    const below = rule ? parseFloat(cs.paddingBottom) || 0 : 0;
    const padBottom = rule ? Math.min(pad, Math.max(0, below - 4)) : pad;
    spotlightEl.style.width = rect.width + pad * 2 + 'px';
    spotlightEl.style.height = rect.height - rule - below + pad + padBottom + 'px';
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
        // Above, clamped below the nav.
        cardEl.style.top = Math.max(getNavHeight() + 4, rect.top - tipRect.height - 12) + 'px';
    }

    let left = rect.left + (rect.width - tipRect.width) / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tipRect.width - 8));
    cardEl.style.left = left + 'px';

    // Keep the tooltip clear of the footer.
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

    let html = '<p>' + t('Welcome to') + ' <span class="brand-mark">aloud.</span> &mdash; ' + t('let’s get your meditation facilitator set up. It only takes a minute.') + '</p>';
    html += '<div class="tour-choices">';
    html += '<button class="tour-choice" data-action="help">';
    html += '<strong>' + t('Help me set up') + '</strong>';
    html += '<small>' + t('We’ll walk you through choosing an AI provider and voice') + '</small>';
    html += '</button>';
    html += '<button class="tour-choice" data-action="self-serve">';
    html += '<strong>' + t('I’ll set this up myself') + '</strong>';
    html += '<small>' + t('Use the settings page directly') + '</small>';
    html += '</button>';
    html += '</div>';

    showCard(html, 'tour-welcome');
}

// ---- Step 1: LLM Provider ----

function getProviderSection(): HTMLElement | null {
    const sel = document.getElementById('s-provider');
    return sel ? sel.closest<HTMLElement>('.settings-section') : null;
}

const API_KEY_PROVIDERS: ReadonlyArray<readonly [string, string]> = [
    ['anthropic', 'Anthropic'],
    ['openai', 'OpenAI'],
    ['groq', 'Groq'],
    ['openrouter', 'OpenRouter'],
    ['venice', 'Venice'],
];

/** The settings menu is already filtered for this platform (no Ollama or
 *  claude_proxy on web, BYOK opt-in there), so the tour offers only what it
 *  lists: picking a missing option would blank the <select>. */
function hasProvider(value: string): boolean {
    const sel = document.getElementById('s-provider') as HTMLSelectElement | null;
    return Boolean(sel && Array.from(sel.options).some((o) => o.value === value));
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

        let html = '<h3>' + t('Choose Your AI Provider') + '</h3>';
        html += '<p>' + t('This powers facilitator intelligence and session flow.') + '</p>';
        html += '<div class="tour-choices">';

        if (hasProvider('aloud')) {
            html += '<button class="tour-choice" data-action="provider" data-value="aloud">';
            html += '<strong>aloud cloud</strong>';
            html += '<small>' + t('No setup. Sign in and go.') + '</small>';
            html += '</button>';
        }

        if (hasProvider('ollama')) {
            html += '<button class="tour-choice" data-action="provider" data-value="ollama">';
            html += '<strong>Ollama</strong>';
            html += '<small>' + t('Free, everything stays on your computer.') + '</small>';
            html += '</button>';
        }

        if (hasProvider('claude_proxy')) {
            html += '<button class="tour-choice" data-action="provider" data-value="claude_proxy">';
            html += '<strong>' + t('Claude subscription') + '</strong>';
            html += '<small>' + t('Uses your Pro or Max plan.') + '</small>';
            html += '</button>';
        }

        if (API_KEY_PROVIDERS.some(([value]) => hasProvider(value))) {
            html += '<button class="tour-choice" data-action="show-api-keys">';
            html += '<strong>' + t('API key') + '</strong>';
            html += '<small>' + t('Anthropic, OpenAI, Groq, OpenRouter, or Venice') + '</small>';
            html += '</button>';
        }

        html += '</div>';
        html += footerHtml({ back: true, skip: true });

        showCard(html, 'tour-tooltip');
        positionTooltip(section);
    });
}

function showApiKeyChoices(): void {
    const section = getProviderSection();
    if (!section) return;

    let html = '<h3>' + t('Which provider?') + '</h3>';
    html += '<p>' + t('Select the provider you have an API key for:') + '</p>';
    html += '<div class="tour-choice-group">';
    for (const [value, label] of API_KEY_PROVIDERS) {
        if (!hasProvider(value)) continue;
        html += '<button class="tour-choice-sm" data-action="provider" data-value="' + value + '">' + label + '</button>';
    }
    html += '</div>';
    html += footerHtml({ back: true, skip: true });

    showCard(html, 'tour-tooltip');
    positionTooltip(section);
}

/** The model picker's dropdown. It mounts in `#s-model-slot` and renders either
 *  `#model-select` or, with no models, a non-interactive `#model-none` reason. */
function findModelElement(): HTMLSelectElement | null {
    return document.querySelector<HTMLSelectElement>('#s-model-slot #model-select');
}

function chooseProvider(value: string): void {
    const sel = document.getElementById('s-provider') as HTMLSelectElement | null;
    if (!sel) return;
    sel.value = value;
    sel.dispatchEvent(new Event('change'));
    skipVoiceStep = value === 'aloud';

    // Hide the tour so the user can interact with the section freely.
    hideTour();

    const resumeToVoice = function (): void {
        showTour();
        showVoiceStep();
    };

    if (value === 'aloud') {
        // Nothing to fill in here: sign-in happens on the Account page or at
        // Begin, and the hosted voices need no setup either.
        showTour();
        showDoneStep();
    } else if (value === 'ollama' || value === 'claude_proxy') {
        // Wait for a usable model: a downloaded one for Ollama, the `claude`
        // CLI detected for the subscription. Until then the settings page's
        // own status hint and Ollama section say what's missing.
        // The loading placeholder has an empty value, so any value is a model.
        waitForCondition(() => Boolean(findModelElement()?.value), resumeToVoice);
    } else {
        // BYOK provider - wait for its key field (views/settings.ts ids).
        waitForCondition(function () {
            const input = document.getElementById(`s-key-${value}`) as HTMLInputElement | null;
            return Boolean(input && input.value.trim().length > 8);
        }, resumeToVoice);
    }
}

function waitForCondition(test: () => boolean, cb: () => void): void {
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
    // Never block forever: give up and advance after 5 minutes.
    setTimeout(function () {
        clearInterval(timer);
        cb();
    }, 300000);
}

// ---- Step 2: Voice ----

function getVoiceSection(): HTMLElement | null {
    // Anchor on the voice button, not the engine select: on web the select
    // renders inside the collapsed Advanced shelf, so it would spotlight (and
    // scroll to) a hidden control in the wrong section.
    const btn = document.getElementById('s-voice-btn');
    return btn ? btn.closest<HTMLElement>('.settings-section') : null;
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

        let html = '<h3>' + t('Set Up Your Voice') + '</h3>';
        html += '<p>' + t('This is how aloud speaks to you. A natural-sounding voice makes a big difference.') + '</p>';
        html += '<div class="tour-choices">';

        if (tourOptions.piperAvailable) {
            html += '<button class="tour-choice" data-action="voice" data-value="piper">';
            html += '<strong>' + t('Piper: free, natural sounding') + '</strong>';
            html += '<small>' + t('Local neural TTS. Pick and download a voice (~60–100 MB).') + '</small>';
            html += '</button>';
        }

        if (tourOptions.isMac) {
            html += '<button class="tour-choice" data-action="voice" data-value="macos">';
            html += '<strong>' + t('Premium macOS voices') + '</strong>';
            html += '<small>' + t('Download from System Settings → Accessibility → Spoken Content. In the System Voice row, click the <b>ⓘ</b> then click Voice.') + ' <a href="#" onclick="fetch(\'/app/v1/open-voice-settings\',{method:\'POST\'}); return false;">' + t('Open Settings') + '</a></small>';
            html += '</button>';
        }

        if (!tourOptions.isMac) {
            html += '<button class="tour-choice" data-action="voice" data-value="skip">';
            html += '<strong>' + t('Browser voices') + '</strong>';
            html += '<small>' + t('On Windows, Edge and the desktop app include high-quality natural voices.') + '</small>';
            html += '</button>';
        }

        html += '<button class="tour-choice" data-action="voice" data-value="skip">';
        html += '<strong>' + t('Skip, I’ll pick later') + '</strong>';
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
        // Hide the tour so the voice picker modal is fully usable.
        hideTour();

        setTimeout(function () {
            const btn = document.getElementById('s-voice-btn');
            if (btn) btn.click();
            waitForPickerClose(function () {
                showTour();
                showDoneStep();
            });
        });
    }
}

function waitForPickerClose(cb: () => void): void {
    // The settings voice modal is 'settings-voice-modal'; it opens/closes by
    // toggling the 'hidden' class.
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

    // Resume after 60s if the modal never gets the hidden class.
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

    // The footer is position:fixed, so the spotlight must be too.
    positionSpotlight(footer, true);

    let html = '<h3>' + t('You’re All Set') + '</h3>';
    html += '<p>' + t('Your settings apply as you go, so you’re ready to begin your first meditation. You can always come back to change them later.') + '</p>';
    html += footerHtml({ back: true, done: true, skip: false });

    showCard(html, 'tour-tooltip');
    if (!cardEl) return;

    // Above the footer, clamped into the viewport.
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
        const prev = currentStep - 1;
        goToStep(prev === 2 && skipVoiceStep ? 1 : prev);
    }
}

function completeTour(): void {
    void sharedKv.set(TOUR_DISMISSED_KEY, '1');
    cleanup();
}

function dismissRemindLater(): void {
    // sessionStorage, so a skip doesn't survive across browser sessions.
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(TOUR_REMIND_KEY, '1');
    }
    cleanup();
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

/** Clear the dismissed / remind-later flags and walk the wizard from the
 *  welcome step (the Settings "Setup guide" button). */
export async function resetAndStart(options: TourOptions): Promise<void> {
    await sharedKv.delete(TOUR_DISMISSED_KEY);
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(TOUR_REMIND_KEY);
    }
    tourOptions = { ...options };
    currentStep = 0;
    skipVoiceStep = false;
    createOverlay();
    window.addEventListener('resize', onResizeDebounced);
    window.addEventListener('scroll', onScroll);
    document.addEventListener('keydown', onKeyDown);
    showWelcome();
}

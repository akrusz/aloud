/**
 * Info panels and guided tour for the setup (index) page. Each section's ?
 * button toggles an inline info panel; the guide walks all panels in sequence
 * with a spotlight overlay, reusing the settings tour's .tour-* CSS.
 *
 * The card the guide opens on is also the first-run welcome: it offers a first
 * sit ("Try right now", first-sit.ts) ahead of the tour, and after that sit
 * comes back once to offer the tour again, when the settings mean something.
 *
 * The tour is also the voiced onboarding. Where the setup view hands it a
 * voice (TourVoice), each step is spoken as it goes up (core setup-lines.ts),
 * a step offers the two house voices to choose between, another offers to
 * turn the microphone on, and with it on the tour answers to "next", "back",
 * "repeat", a voice's name (core tour-command.ts). Every one of those is also
 * a button: the voice is the second way through, never the only one. The
 * speaker on each card (or saying "mute") stops the reading and leaves the
 * cards.
 */

import { sharedKv } from '../state.js';
import { t } from '../i18n.js';
import { FIRST_SIT_TIMER_MIN } from '../first-sit.js';
import { escapeHtml } from '../escape-html.js';
import { isTauri } from '../is-desktop.js';
import { parseTourCommand, type OfferedVoice, type SetupLineId } from '../../../src/facilitation/index.js';
import { footerHtml, getNavHeight, placeCard } from './tour-common.js';

const GUIDE_DONE_KEY = 'aloud-index-guide-done';
const GUIDE_REMIND_KEY = 'aloud-index-guide-remind';
const CLIENT_ID_KEY = 'aloud-client-id';
/** Set when a first sit starts; the next visit to setup spends it on the
 *  "Shape your next session" card. */
const FOLLOW_UP_KEY = 'aloud-first-sit-follow-up';
/** Set once someone has switched the tour's reading off; it stays off. */
const QUIET_KEY = 'aloud-tour-quiet';

const PADDING = 10;

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

/**
 * What the tour needs of the setup view to speak and to be spoken to. The view
 * owns the speaker, the microphone and the voice setting; the tour only says
 * which line and hears what came back.
 */
export interface TourVoice {
    /** Speak a tour line, the microphone shut while it plays. `as` is the
     *  house voice to say it in (the two introductions); otherwise whoever
     *  speaks the setup screen. Resolves when it has finished or been cut. */
    say(id: SetupLineId, as?: string): Promise<void>;
    /** Cut off the line being spoken. */
    stop(): void;
    /** The two house voices the voice step offers, or none where it doesn't
     *  apply (no clips in this language, or a session voice that is local). */
    voicesOnOffer(): OfferedVoice[];
    /** Make this the voice everywhere, the session's included. */
    pickVoice(name: string): void;
    /** The microphone on this screen: open, openable with a tap (`ask`), or
     *  not on offer at all (switched off in Settings, or blocked). */
    mic(): 'listening' | 'ask' | 'off';
    /** Ask for the microphone. Called from the click itself, since that is the
     *  one place a permission prompt belongs. Resolves true once it listens. */
    enableMic(): Promise<boolean>;
    /** Hand what the microphone hears to the tour first (null: stop). The
     *  handler returns true when the words were the tour's. */
    listen(handler: ((text: string) => boolean) | null): void;
    /** A step went up: an open microphone stays open for it. */
    keepOpen(): void;
}

/** Which card opens the guide: the first-run welcome (offers a first sit), the
 *  one-time follow-up after that sit, or none ("Take the full tour" starts on
 *  the first step). */
type WelcomeVariant = 'first-run' | 'after-first-sit';

let welcomeVariant: WelcomeVariant | null = null;
let quickStart: QuickStart | null = null;
let tourVoice: TourVoice | null = null;
/** The tour's reading is switched off (the speaker on the card, or "mute"). */
let quiet = false;
/** The step whose line was last spoken, so a card redrawn for a resize is not
 *  read out again. */
let spokenStep = -1;
/** Bumped whenever the step changes, so a line still coming for the step
 *  before it knows not to be said. */
let speechTurn = 0;
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

const SECTION_LINES: Readonly<Record<string, SetupLineId>> = {
    'methods-exploration': 'tour-exploration',
    'methods-noting': 'tour-noting',
    'methods-felt-sense': 'tour-felt-sense',
    focus: 'tour-focus',
    vibe: 'tour-vibe',
};

type Step =
    | { kind: 'welcome' }
    /** Offer to turn the microphone on, where a tap could. */
    | { kind: 'mic' }
    /** Choose between the two house voices. */
    | { kind: 'voice' }
    | { kind: 'section'; section: Section }
    /** The setup can be changed out loud. */
    | { kind: 'say-it' }
    | { kind: 'done' };

/** This run's steps, settled when the guide starts so the dots hold still. */
let steps: Step[] = [];

function buildSteps(): Step[] {
    const mic = tourVoice?.mic() ?? 'off';
    return [
        ...(welcomeVariant ? [{ kind: 'welcome' } as const] : []),
        ...(mic === 'ask' ? [{ kind: 'mic' } as const] : []),
        ...(tourVoice && !quiet && tourVoice.voicesOnOffer().length === 2 ? [{ kind: 'voice' } as const] : []),
        ...SECTIONS.map((section) => ({ kind: 'section', section }) as const),
        ...(mic !== 'off' ? [{ kind: 'say-it' } as const] : []),
        { kind: 'done' },
    ];
}

/** The first step past the welcome card: where "Show me around" lands. */
function firstTourStep(): number {
    return steps[0]?.kind === 'welcome' ? 1 : 0;
}

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

// A centered card (welcome, "You're ready") is a modal dialog: while one is up
// the rest of <body> is inert, so a screen reader and Tab start on the card,
// not on the page it covers. That, not the overlay, is also what keeps Begin
// from taking a click: its fixed bar sits above the overlay (z-index,
// app-base.css). The overlay stays live: tapping it closes the card.
let heldPage: HTMLElement[] = [];

function holdPage(card: HTMLDivElement): void {
    const heading = card.querySelector('h3');
    const intro = card.querySelector('p');
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    if (heading) {
        heading.id = 'tour-card-title';
        card.setAttribute('aria-labelledby', heading.id);
    } else {
        card.setAttribute('aria-label', t('Welcome to aloud'));
    }
    if (intro) {
        intro.id = 'tour-card-intro';
        card.setAttribute('aria-describedby', intro.id);
    }
    // The desktop window is dragged by its top bar (tauri-chrome.ts), and an
    // inert element takes no mousedown: there, hold what is in the bar and
    // leave the bar itself live.
    const dragBar = isTauri() ? document.querySelector('nav.nav') : null;
    const page = [...document.body.children].flatMap((el) => (el === dragBar ? [...el.children] : [el]));
    for (const el of page) {
        if (!(el instanceof HTMLElement) || el === card || el === overlayEl || el.inert) continue;
        el.inert = true;
        heldPage.push(el);
    }
    // The card itself, not its first choice: the dialog gets announced with
    // its text, and a stray Enter on a page that has only just loaded can't
    // start a first session (that choice asks for the mic).
    card.tabIndex = -1;
    card.focus({ preventScroll: true });
}

function releasePage(): void {
    for (const el of heldPage) el.inert = false;
    heldPage = [];
}

/** Closing the guide removes the card that held focus, which would drop a
 *  keyboard or screen-reader user at the top of the document with nothing
 *  said. Put them on the setup page's first control instead. */
function landFocus(): void {
    document.querySelector<HTMLElement>('.tab-bar .tab-btn.active')?.focus({ preventScroll: true });
}

function cleanup(): void {
    stopQuickStartPoll();
    releasePage();
    speechTurn++;
    spokenStep = -1;
    tourVoice?.stop();
    tourVoice?.listen(null);
    overlayEl?.remove();
    spotlightEl?.remove();
    cardEl?.remove();
    overlayEl = spotlightEl = cardEl = null;
    guideActive = false;
    document.body.classList.remove('guide-running', 'guide-spotlit');
    resetTarget();
    window.removeEventListener('resize', onResizeDebounced);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('keydown', onKeyDown);
}

function showCard(html: string, className?: string): void {
    stopQuickStartPoll();
    releasePage();
    if (cardEl) cardEl.remove();
    cardEl = document.createElement('div');
    cardEl.className = className || 'tour-tooltip';
    cardEl.innerHTML = html;
    document.body.appendChild(cardEl);
    const centered = className === 'tour-welcome';
    if (overlayEl) overlayEl.classList.toggle('tour-overlay-flat', centered);
    // A section step. On phones the Begin bar steps aside for these
    // (app-base.css), leaving its slot to the docked card.
    document.body.classList.toggle('guide-spotlit', !centered);
    wireActions();
    addSoundToggle();
    if (centered) holdPage(cardEl);
}

const SPEAKER_ICON =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M11 5 6 9H2v6h4l5 4z"></path>' +
    '<path class="tour-sound-waves" d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"></path>' +
    '<path class="tour-sound-off" d="m16 9 6 6M22 9l-6 6"></path></svg>';

/** The speaker beside Skip on every step past the welcome: whether the tour
 *  reads itself out. Only where there is a voice to read it. */
function addSoundToggle(): void {
    const footer = cardEl?.querySelector<HTMLElement>('.tour-footer');
    if (!footer || !tourVoice || steps[currentStep]?.kind === 'welcome') return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tour-sound';
    btn.innerHTML = SPEAKER_ICON;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        setQuiet(!quiet);
    });
    // Skip's slot (or the spacer that stands in for it) takes the speaker
    // too, so the dots stay centered between it and the buttons.
    const lead = document.createElement('span');
    lead.className = 'tour-lead';
    const first = footer.firstElementChild;
    if (first?.classList.contains('tour-skip')) lead.appendChild(first);
    else first?.remove();
    lead.appendChild(btn);
    footer.prepend(lead);
    paintSoundToggle();
}

function paintSoundToggle(): void {
    const btn = cardEl?.querySelector<HTMLButtonElement>('.tour-sound');
    if (!btn) return;
    const label = quiet ? t('Read the tour aloud') : t('Stop reading aloud');
    btn.classList.toggle('quiet', quiet);
    btn.setAttribute('aria-pressed', String(!quiet));
    btn.setAttribute('aria-label', label);
    btn.title = label;
}

function setQuiet(next: boolean): void {
    quiet = next;
    if (quiet) {
        speechTurn++;
        tourVoice?.stop();
        void sharedKv.set(QUIET_KEY, '1');
    } else {
        void sharedKv.delete(QUIET_KEY);
        speakStep(true);
    }
    paintSoundToggle();
}

/** Say `id` unless the step has moved on or the reading is off. */
async function sayLine(id: SetupLineId, as?: string): Promise<boolean> {
    if (!tourVoice || quiet) return false;
    const turn = speechTurn;
    await tourVoice.say(id, as);
    return turn === speechTurn;
}

/** Read the step on screen out, once per arrival (`again`: on request). */
function speakStep(again = false): void {
    const step = steps[currentStep];
    if (!step || !tourVoice || quiet || (!again && spokenStep === currentStep)) return;
    spokenStep = currentStep;
    speechTurn++;
    tourVoice.stop();
    tourVoice.keepOpen();
    const listening = tourVoice.mic() === 'listening';
    if (step.kind === 'mic') void sayLine('tour-hello');
    else if (step.kind === 'voice') void introduceVoices();
    else if (step.kind === 'section') {
        const line = SECTION_LINES[step.section.id];
        if (line) void sayLine(line);
    }
    // Both tell the listener what to say next, which only means something
    // with the microphone open.
    else if (step.kind === 'say-it' && listening) void sayLine('tour-voice-control');
    else if (step.kind === 'done' && listening) void sayLine('tour-done');
}

/** The voice step: each of the two says who it is, lit while it speaks. */
async function introduceVoices(): Promise<void> {
    const offered = tourVoice?.voicesOnOffer() ?? [];
    const lines: SetupLineId[] = ['voice-intro-first', 'voice-intro-second'];
    for (const [i, voice] of offered.entries()) {
        const btn = cardEl?.querySelector<HTMLElement>(`[data-voice="${i}"]`);
        btn?.classList.add('speaking');
        const still = await sayLine(lines[i] ?? 'voice-intro-second', voice.name);
        btn?.classList.remove('speaking');
        if (!still) return;
    }
}

/** A voice chosen, by tap or by name: it becomes the voice, says so, and the
 *  tour moves on. */
function chooseVoice(index: number): void {
    const voice = tourVoice?.voicesOnOffer()[index];
    if (!voice || !tourVoice) return;
    speechTurn++;
    tourVoice.stop();
    tourVoice.pickVoice(voice.name);
    cardEl?.querySelectorAll<HTMLElement>('[data-voice]').forEach((btn) => {
        btn.classList.toggle('chosen', btn.dataset['voice'] === String(index));
    });
    const from = currentStep;
    void sayLine('tour-voice-picked', voice.name).then((still) => {
        // Not if they have already moved on by hand, or left.
        if (guideActive && currentStep === from && (still || quiet)) advanceStep();
    });
}

/** The words the microphone heard, offered to the tour first. */
function onTourHeard(text: string): boolean {
    const step = steps[currentStep];
    if (!guideActive || !step || step.kind === 'welcome') return false;
    const command = parseTourCommand(text, step.kind === 'voice' ? tourVoice?.voicesOnOffer() : undefined);
    if (!command) return false;
    if (command.kind === 'next') advanceStep();
    // Not back onto the welcome card, which answers to no words.
    else if (command.kind === 'back') currentStep > firstTourStep() && goBack();
    else if (command.kind === 'repeat') speakStep(true);
    else if (command.kind === 'close') dismissRemindLater();
    else if (command.kind === 'quiet') setQuiet(true);
    else if (command.kind === 'speak') setQuiet(false);
    else chooseVoice(command.index);
    return true;
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
            else if (action === 'start') {
                // Settled now, not when the card went up: the voices and the
                // microphone's standing were still loading then.
                steps = buildSteps();
                goToStep(firstTourStep());
            }
            else if (action === 'quick-start') beginQuickStart();
            else if (action === 'voice') chooseVoice(Number(btn.dataset['voice']));
            else if (action === 'mic') turnMicOn(btn);
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

/**
 * Run a narrow triangle from the active progress dot to the spotlight's
 * outline, so the card reads as belonging to the box beside it. The shape is
 * the dot's ::before (app-base.css); this sets which way it runs and how far.
 */
function linkDotToSpotlight(el: HTMLElement): void {
    const dot = cardEl?.querySelector<HTMLElement>('.tour-dot.active');
    if (!cardEl || !dot) return;
    // Where the card comes to rest, not where it is: it is mid-entrance
    // (translated) when this first runs.
    const entering = new DOMMatrixReadOnly(getComputedStyle(cardEl).transform).m42;
    const cardRect = cardEl.getBoundingClientRect();
    const cardTop = cardRect.top - entering;
    const dotRect = dot.getBoundingClientRect();
    const dotY = dotRect.top - entering + dotRect.height / 2;
    // The spotlight box as positionSpotlight() draws it, from the target for
    // the same reason: the spotlight itself is still gliding over from the
    // last step.
    const rect = el.getBoundingClientRect();
    const boxTop = rect.top - PADDING;
    const boxBottom = rect.bottom + PADDING;
    // A docked card sits over the box until its tail is scrolled clear. It
    // needs no pointer to a box it is on, and the edge to aim at is behind it.
    if (boxTop < cardTop + cardRect.height && boxBottom > cardTop) {
        delete cardEl.dataset['link'];
        return;
    }
    // Clear of the box, the nearer edge is the one facing the card.
    const reach = Math.abs(boxTop - dotY) < Math.abs(boxBottom - dotY) ? boxTop - dotY : boxBottom - dotY;
    cardEl.dataset['link'] = reach < 0 ? 'up' : 'down';
    cardEl.style.setProperty('--tour-link-length', Math.abs(reach) + 'px');
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
    // Same standing as closing the card: a start abandoned at the mic
    // or sign-in prompt leaves the card away for the rest of this visit.
    closeForNow();
    // No await before this: the mic prompt and the audio unlock both need the
    // click's user gesture (app.ts ensureMicAvailable).
    offer.start();
}

function showWelcome(): void {
    hideSpotlight();
    resetTarget();

    const offerQuickStart = welcomeVariant === 'first-run' && quickStart !== null;
    // Closing is the X, Escape or a tap outside: the card keeps to the things
    // there are to do.
    let html = '<button type="button" class="tour-close" data-action="dismiss" aria-label="' + escapeHtml(t('Close')) + '">&times;</button>';
    html +=
        welcomeVariant === 'after-first-sit'
            ? '<h3>' + t('Shape your next session') + '</h3><p>' + t('Set the vibe, attention focus, and more.') + '</p>'
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
    html += '<small>' + (tourVoice && !quiet ? t('A quick look at how it works, read aloud') : t('A quick look at how it works')) + '</small>';
    html += '</button>';
    html += '</div>';

    showCard(html, 'tour-welcome');
    if (offerQuickStart) {
        syncQuickStart();
        quickStartPoll = setInterval(syncQuickStart, QUICK_START_POLL_MS);
    }
}

function stepFooter(next: boolean): string {
    return footerHtml({ back: currentStep > 0, next, done: !next, skip: next }, steps.length, currentStep, 'dismiss');
}

/** A step with no box on the page to point at: a centered card of its own. */
function showCentered(body: string, next = true): void {
    hideSpotlight();
    resetTarget();
    showCard(body + stepFooter(next), 'tour-welcome');
    speakStep();
}

function showMicStep(): void {
    let html = '<h3>' + t('aloud listens, too') + '</h3>';
    html += '<p>' + t('With the microphone on you can answer out loud: "next", "back", or the voice you like.') + '</p>';
    html += '<div class="tour-choices"><button class="tour-choice" data-action="mic">';
    html += '<strong>' + t('Turn on the microphone') + '</strong>';
    html += '<small>' + t('Tapping works the whole way, too.') + '</small>';
    html += '</button></div>';
    showCentered(html);
}

/** The mic step's button. From the click itself: this is where the
 *  permission prompt belongs. */
function turnMicOn(btn: HTMLElement): void {
    if (!tourVoice) return;
    const from = currentStep;
    const note = btn.querySelector('small');
    void tourVoice.enableMic().then((on) => {
        if (!guideActive || currentStep !== from) return;
        if (on) advanceStep();
        else if (note) note.textContent = t("The microphone didn't come on. You can keep going by tapping.");
    });
}

function showVoiceStep(): void {
    const offered = tourVoice?.voicesOnOffer() ?? [];
    let html = '<h3>' + t('Pick a voice') + '</h3>';
    html += '<p>' + t('Two to start with. There are more in the voice picker, any time.') + '</p>';
    html += '<div class="tour-choices tour-voices">';
    offered.forEach((voice, i) => {
        html += '<button class="tour-choice" data-action="voice" data-voice="' + i + '">';
        html += '<strong>' + escapeHtml(voice.name) + '</strong></button>';
    });
    html += '</div>';
    showCentered(html);
}

function showSayIt(): void {
    let html = '<h3>' + t('Say it out loud') + '</h3>';
    html += '<p>' + t('With the mic beside Begin lit, you can set all of this by voice: "twenty minutes", "add playful", "felt sense". Then say "begin".') + '</p>';
    showCentered(html);
}

function showSection(section: Section): void {
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
            // that card entirely and leave the last dot permanently dark
            // (settings-tour.ts closes the same way).
            showCard(stepFooter(true), 'tour-tooltip');
            if (cardEl) placeCard(cardEl, target.getBoundingClientRect());
            linkDotToSpotlight(target);
            speakStep();
        });
    });
}

function showDone(): void {
    let html = '<h3>' + t('You’re ready') + '</h3>';
    html += '<p>' + t('Pick what you like and begin. Tap <span class="info-btn-glyph">?</span> on any section to revisit these notes.') + '</p>';
    showCentered(html, false);
}

function goToStep(index: number): void {
    const step = steps[index];
    if (!step) return;
    if (index !== currentStep) {
        // The line for the step being left stops with it.
        speechTurn++;
        tourVoice?.stop();
    }
    currentStep = index;
    if (step.kind === 'welcome') showWelcome();
    else if (step.kind === 'mic') showMicStep();
    else if (step.kind === 'voice') showVoiceStep();
    else if (step.kind === 'section') showSection(step.section);
    else if (step.kind === 'say-it') showSayIt();
    else showDone();
}

function advanceStep(): void {
    if (currentStep < steps.length - 1) goToStep(currentStep + 1);
    else completeGuide();
}

function goBack(): void {
    if (currentStep > 0) goToStep(currentStep - 1);
}

function completeGuide(): void {
    void sharedKv.set(GUIDE_DONE_KEY, '1');
    cleanup();
    landFocus();
}

function closeForNow(): void {
    // sessionStorage, so a skip doesn't persist across browser sessions.
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(GUIDE_REMIND_KEY, '1');
    }
    cleanup();
}

function dismissRemindLater(): void {
    closeForNow();
    landFocus();
}

function onScroll(): void {
    if (!guideActive || !spotlightEl || spotlightEl.style.display === 'none') return;
    const step = steps[currentStep];
    if (step?.kind !== 'section') return;
    const target = step.section.target();
    if (!target) return;
    positionSpotlight(target);
    // The card is fixed and the box scrolls with the page.
    linkDotToSpotlight(target);
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

function startGuide(): void {
    if (guideActive) return;
    installInfoBtnHandler();
    guideActive = true;
    document.body.classList.add('guide-running');
    steps = buildSteps();
    currentStep = -1;
    spokenStep = -1;
    lastViewportWidth = window.innerWidth;
    createOverlay();
    window.addEventListener('resize', onResizeDebounced);
    window.addEventListener('scroll', onScroll);
    document.addEventListener('keydown', onKeyDown);
    tourVoice?.listen(onTourHeard);
    goToStep(0);
}

// "Take the full tour" link - an explicit opt-in, so there is no welcome card
// and it opens on the first step. The link sits in the methods panel the tour
// itself spotlights, so one may already be running, and startGuide() no-ops
// while one is: close it first.
export async function resetAndStart(): Promise<void> {
    await sharedKv.delete(GUIDE_DONE_KEY);
    if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(GUIDE_REMIND_KEY);
    }
    if (guideActive) cleanup();
    welcomeVariant = null;
    startGuide();
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
 *  the mode tabs locked (a continuation), and the tour walks all of them.
 *  @param voice The setup view's speaker and microphone; without one the tour
 *  is silent and tap-only. */
export async function autoStart(
    offer: QuickStart | null = null,
    hold = false,
    voice: TourVoice | null = null
): Promise<void> {
    installInfoBtnHandler();
    quickStart = offer;
    tourVoice = voice;
    quiet = Boolean(await sharedKv.get(QUIET_KEY));
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

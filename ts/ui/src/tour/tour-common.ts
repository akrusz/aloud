/** Pieces shared by the setup-page guide and the settings tour. */

import { t } from '../i18n.js';
import { bottomBarsTop } from '../toast.js';

/** Air between a card and the box above it. */
const CARD_GAP = 12;
/** The same between a card and the edge of the room it is docked in. */
const DOCK_GAP = 8;
/** A capped choice list keeps this much: a choice and the start of the next. */
const MIN_CHOICES_HEIGHT = 96;

export function getNavHeight(): number {
    const nav = document.querySelector('.nav');
    return nav ? nav.getBoundingClientRect().height + 16 : 80;
}

/**
 * Put a tour card by the box it is about (`target`, in viewport px): under it,
 * or, when it does not fit there, docked at the foot of the screen over the
 * box's tail, which scrolls out from under it. The box's top is where the
 * reading starts, so the card only reaches it on a screen too short for both.
 *
 * A card with choices gives ground first: they pair up into two columns where
 * it is wide enough to (app-base.css), and on a screen shorter than the card
 * they scroll, so it never runs under the nav or the bottom bars.
 */
export function placeCard(card: HTMLElement, target: DOMRect): void {
    const barsTop = bottomBarsTop();
    const floor = barsTop ?? window.innerHeight;
    const fitsUnder = (): boolean =>
        target.bottom + CARD_GAP + card.getBoundingClientRect().height + DOCK_GAP <= floor;

    const choices = card.querySelector<HTMLElement>('.tour-choices');
    if (choices) {
        choices.style.maxHeight = '';
        choices.classList.remove('tour-choices-paired', 'tour-choices-capped');
        if (!fitsUnder()) choices.classList.add('tour-choices-paired');
        const room = floor - (getNavHeight() - 16) - DOCK_GAP * 2;
        const over = card.getBoundingClientRect().height - room;
        if (over > 0) {
            choices.style.maxHeight = Math.max(MIN_CHOICES_HEIGHT, choices.clientHeight - over) + 'px';
            choices.classList.add('tour-choices-capped');
            trackMoreBelow(choices);
        }
    }

    const tip = card.getBoundingClientRect();
    if (fitsUnder()) {
        card.style.top = target.bottom + CARD_GAP + 'px';
        card.style.bottom = '';
    } else {
        // By `bottom`, like the bars it sits on, so it rides with them when a
        // mobile browser's URL bar resizes the viewport mid-scroll. With no
        // bar under it, it clears the system inset itself, as they do.
        card.style.top = 'auto';
        card.style.bottom =
            barsTop === null
                ? `calc(${DOCK_GAP}px + var(--safe-bottom-clear, 0px))`
                : window.innerHeight - barsTop + DOCK_GAP + 'px';
    }

    const left = target.left + (target.width - tip.width) / 2;
    card.style.left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8)) + 'px';
}

/** Fade the foot of a capped choice list while there is more under it. */
function trackMoreBelow(choices: HTMLElement): void {
    const sync = (): void => {
        // More than a choice's own bottom padding: a fade over the last line
        // of a list that is all there reads as a rendering fault.
        const more = choices.scrollTop + choices.clientHeight < choices.scrollHeight - 12;
        choices.classList.toggle('tour-choices-more', more);
    };
    if (!choices.dataset['tracked']) {
        choices.dataset['tracked'] = '1';
        choices.addEventListener('scroll', sync, { passive: true });
    }
    sync();
}

export interface FooterOpts {
    skip?: boolean;
    back?: boolean;
    next?: boolean;
    done?: boolean;
}

/**
 * A card's footer: Skip (or a spacer when `skip` is false), `dots` progress
 * dots with the `active` one lit, then the nav buttons. `skipAction` is the
 * data-action the tour's card wiring dispatches for Skip.
 */
export function footerHtml(opts: FooterOpts, dots: number, active: number, skipAction: string): string {
    let html = '<div class="tour-footer">';
    if (opts.skip !== false) {
        html += '<button class="tour-skip" data-action="' + skipAction + '">' + t('Skip') + '</button>';
    } else {
        html += '<span></span>';
    }
    html += '<div class="tour-dots">';
    for (let i = 0; i < dots; i++) {
        html += '<div class="tour-dot' + (i === active ? ' active' : '') + '"></div>';
    }
    html += '</div>';
    html += '<div class="tour-actions">';
    if (opts.back) html += '<button class="btn btn-small btn-secondary" data-action="back">' + t('Back') + '</button>';
    if (opts.next) html += '<button class="btn btn-small btn-primary" data-action="next">' + t('Next') + '</button>';
    if (opts.done) html += '<button class="btn btn-small btn-primary" data-action="done">' + t('Got it') + '</button>';
    html += '</div></div>';
    return html;
}

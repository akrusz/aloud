/** Pieces shared by the setup-page guide and the settings tour. */

import { t } from '../i18n.js';

export function getNavHeight(): number {
    const nav = document.querySelector('.nav');
    return nav ? nav.getBoundingClientRect().height + 16 : 80;
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

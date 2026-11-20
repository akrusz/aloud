/**
 * The whole page when the app store's age signal blocks the app (age-tier.ts):
 * no nav, no views, no mic. Mounted by bootApp in place of the router.
 */

import type { BlockingTier } from '../age-tier.js';
import { t } from '../i18n.js';

function copyFor(tier: BlockingTier): { heading: string; body: string } {
    switch (tier) {
        case 'child':
            return {
                heading: t('aloud is for ages 13 and up'),
                body: t('The app store says this account is under 13.'),
            };
        case 'pendingConsent':
            return {
                heading: t('Waiting for a parent or guardian'),
                body: t('They need to approve a recent change to aloud. It opens here once they have.'),
            };
        case 'deniedConsent':
            return {
                heading: t('Not approved'),
                body: t('A parent or guardian declined a recent change to aloud.'),
            };
    }
}

export function mountAgeBlockView(root: HTMLElement, tier: BlockingTier): void {
    document.body.dataset['ageBlock'] = '';
    const { heading, body } = copyFor(tier);
    const section = document.createElement('section');
    section.className = 'age-block';
    const h1 = document.createElement('h1');
    h1.textContent = heading;
    const p = document.createElement('p');
    p.textContent = body;
    section.append(h1, p);
    root.replaceChildren(section);
}

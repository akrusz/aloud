/**
 * How this build can take money for ☁. Every buy entry point asks here.
 *
 * 'web': our own checkout (card via Stripe, USDC) - the browser and the
 * desktop app.
 * 'none': nothing is sold in the app; ☁ bought on the web still land in the
 * account. The store builds, until they sell packs through store billing. Both
 * stores bar an in-app button or link to another payment method (Play Payments
 * policy section 4, App Store guideline 3.1.1), and the regional exceptions
 * each need a program enrollment we don't hold.
 */

import { isCapacitor, capacitorPlatform } from './is-desktop.js';
import { t } from './i18n.js';

export type PurchaseChannel = 'web' | 'none';

export function purchaseChannel(): PurchaseChannel {
    return isCapacitor() ? 'none' : 'web';
}

/**
 * The line a build that sells nothing may show about where ☁ come from, or
 * null when it may say nothing. Plain text only, never a link: Play allows a
 * consumption-only app "purchasing options without direct links", and its own
 * example names a domain ("any movie you rent through our website.com ..."),
 * while the App Store's 3.1.3(f) allows no call to action for a purchase
 * outside the app at all. Render it as text; an <a> around it is the violation.
 */
export function topUpHint(): string | null {
    if (purchaseChannel() !== 'none' || capacitorPlatform() !== 'android') return null;
    return t('You can add more at aloud.rest');
}

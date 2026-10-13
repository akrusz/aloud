/**
 * The thank-you for free ☁ a sign-in just added: the grant for connecting
 * Google/Apple, and the bonus for signing in from a store beta build
 * (meditation-pal-bb4k). One line for the total; the bonus names the occasion
 * when both arrive at once.
 */

import type { AuthResponse } from './cloud-auth.js';
import { creditAmount } from './credit-rate.js';
import { t } from './i18n.js';

/** Null when the sign-in added nothing, which is every returning one. */
export function signInThanks(auth: AuthResponse): string | null {
    const connect = auth.granted?.connect ?? 0;
    const beta = auth.granted?.beta ?? 0;
    const amount = creditAmount(connect + beta, 0);
    if (beta > 0) return t('Thanks for joining the beta! {amount} added to your balance.', { amount });
    if (connect > 0) return t('Thanks for connecting an account! {amount} added to your balance.', { amount });
    return null;
}

/**
 * Which account connections this build can offer, for copy that names them.
 * "Connect Google or Apple" is only true where both buttons exist: Android has
 * Google alone, iOS has Apple alone, and the desktop app has Google alone.
 *
 * Mirrors the three branches of showSignInModal (sign-in-modal.ts), which
 * decides the buttons themselves; a provider added there belongs here too.
 */

import {
    googleDesktopClientId,
    isAppleSignInConfigured,
    isGoogleSignInConfigured,
} from './cloud-auth.js';
import { isNativeAppleConfigured, isNativeGoogleConfigured } from './native-signin.js';
import { isCapacitor, isDesktopSync } from './is-desktop.js';
import { t } from './i18n.js';

export type OfferedSignIn = 'google' | 'apple';

export function offeredSignIns(): OfferedSignIn[] {
    const [google, apple] = isCapacitor()
        ? [isNativeGoogleConfigured(), isNativeAppleConfigured()]
        : isDesktopSync()
          ? [googleDesktopClientId() !== '', false]
          : [isGoogleSignInConfigured(), isAppleSignInConfigured()];
    const offered: OfferedSignIn[] = [];
    if (google) offered.push('google');
    if (apple) offered.push('apple');
    return offered;
}

/** The one this build offers, when it is exactly one. With both, or with none
 *  known (the client ids arrive at boot), copy keeps naming both. */
function onlyOffered(): OfferedSignIn | null {
    const offered = offeredSignIns();
    return offered.length === 1 ? offered[0]! : null;
}

/** For "Connect {providers} ...": "Google or Apple", "Google", or "Apple". */
export function signInNames(): string {
    const only = onlyOffered();
    if (only) return only === 'google' ? 'Google' : 'Apple';
    return t('Google or Apple');
}

/** The same with its article, for "Connecting {account} ...". */
export function signInAccount(): string {
    const only = onlyOffered();
    if (only) return only === 'google' ? t('a Google account') : t('an Apple account');
    return t('a Google or Apple account');
}

/**
 * The oldest app version aloud cloud still serves, per platform. A client below
 * its platform's minimum shows a blocking "update" screen at load
 * (ts/ui/src/update-gate.ts). '0.0.0' is no cutoff. Served on the public
 * GET /cloud/v1/config, so a change ships with a server deploy.
 *
 * Raised when a release is cut, never lowered: scripts/release.sh rewrites the
 * three lines of MIN_CLIENT_VERSION after the developer confirms
 * (scripts/lib/min-version.sh matches their exact shape, so keep one platform
 * per line, single-quoted). When to raise one: Part D of
 * dev-docs/pre-release-checklist.md.
 */

import type { ClientPlatform, MinVersionPlatform } from './contract.js';

export const MIN_CLIENT_VERSION: Readonly<Record<MinVersionPlatform, string>> = {
    desktop: '2.22.0',
    android: '0.0.0',
    ios: '0.0.0',
};

const CLIENT_PLATFORMS: readonly string[] = ['desktop', 'android', 'ios', 'web'];

/** "2.20.1", or a pre-release such as "2.21.0-rc.1"; 31 characters at most. */
const CLIENT_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,16})?$/;

/**
 * The build a client names on GET /cloud/v1/me (`?v=&platform=`), or null
 * when either part is missing or not shaped like one. Whatever passes is
 * stored on the account as sent, so nothing else gets through.
 */
export function parseClientReport(
    version: string | undefined,
    platform: string | undefined
): { version: string; platform: ClientPlatform } | null {
    if (!version || !platform || !CLIENT_VERSION.test(version) || !CLIENT_PLATFORMS.includes(platform)) {
        return null;
    }
    return { version, platform: platform as ClientPlatform };
}

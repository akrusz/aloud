/**
 * "Report a bug": opens the mail composer prefilled with a diagnostics block
 * (version, platform, mode, user agent) so a reply doesn't start by asking
 * "which version? what device?".
 *
 * Reached from the in-session ⓘ info panel (desktop) and the mobile More sheet.
 */

import { isTauri, isCapacitor, capacitorPlatform } from './is-desktop.js';
import { appMode } from './app-mode.js';
import { openExternal } from './external-links.js';

/** Same inbox as the About "kind words" / privacy contact. */
const SUPPORT_EMAIL = 'lexkrusz@gmail.com';

function platformLabel(): string {
    if (isTauri()) return 'Desktop';
    if (isCapacitor()) return `Mobile (${capacitorPlatform()})`;
    return 'Web';
}

/** A `mailto:` link prefilled with the report template + diagnostics. */
export function bugReportMailtoHref(): string {
    const diagnostics = [
        `Version: ${__APP_VERSION__}`,
        `Platform: ${platformLabel()}`,
        `Mode: ${appMode()}`,
        `Browser: ${navigator.userAgent}`,
    ].join('\n');
    const body =
        'What happened?\n\n\n' +
        'What did you expect instead?\n\n\n' +
        `. . .\n${diagnostics}`;
    const subject = `aloud bug report (v${__APP_VERSION__})`;
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Desktop hands the `mailto:` to the opener plugin; web and native mobile let
 * the webview pass it to the OS composer, since `@capacitor/browser` can't open
 * `mailto:`.
 */
export async function openBugReport(): Promise<void> {
    const href = bugReportMailtoHref();
    if (isTauri()) {
        await openExternal(href);
        return;
    }
    window.location.href = href;
}

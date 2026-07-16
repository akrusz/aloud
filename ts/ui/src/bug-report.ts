/**
 * "Report a bug" — opens the user's mail composer with a prefilled report so a
 * reply doesn't have to start by asking "which version? what device?". The
 * body carries a short diagnostics block (version, platform, mode, user agent)
 * plus a two-line template for the user to fill in.
 *
 * Reached from the in-session ⓘ info panel (desktop) and the mobile More sheet.
 */

import { isTauri, isCapacitor, capacitorPlatform } from './is-desktop.js';
import { appMode } from './app-mode.js';
import { openExternal } from './external-links.js';

/** Where reports land. Same inbox as the About "kind words" / privacy contact. */
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
 * Open the prefilled bug-report email. On desktop the opener plugin hands the
 * `mailto:` to the system mail client; on web and native mobile we let the
 * webview pass it to the OS composer (`@capacitor/browser` can't open
 * `mailto:`, so we don't route those through `openExternal`).
 */
export async function openBugReport(): Promise<void> {
    const href = bugReportMailtoHref();
    if (isTauri()) {
        await openExternal(href);
        return;
    }
    window.location.href = href;
}

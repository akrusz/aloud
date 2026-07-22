/**
 * "Report a bug" and "Report AI content": open the mail composer prefilled
 * with a diagnostics block (version, platform, mode, user agent) so a reply
 * doesn't start by asking "which version? what device?".
 *
 * Reached from the in-session ⓘ info panel (desktop) and the mobile More
 * sheet. The AI-content report also satisfies Google Play's AI-Generated
 * Content policy (apps whose core feature is generative AI must offer in-app
 * reporting of offensive AI output), so it must stay reachable from a session
 * regardless of which LLM source is active.
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

function diagnostics(extra: string[] = []): string {
    return [
        `Version: ${__APP_VERSION__}`,
        `Platform: ${platformLabel()}`,
        `Mode: ${appMode()}`,
        ...extra,
        `Browser: ${navigator.userAgent}`,
    ].join('\n');
}

function mailtoHref(subject: string, body: string): string {
    return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/** A `mailto:` link prefilled with the report template + diagnostics. */
export function bugReportMailtoHref(): string {
    const body =
        'What happened?\n\n\n' +
        'What did you expect instead?\n\n\n' +
        `. . .\n${diagnostics()}`;
    return mailtoHref(`aloud bug report (v${__APP_VERSION__})`, body);
}

export interface AiReportContext {
    /** Human label for the active LLM source ("aloud cloud", "OpenAI (API Key)"). */
    sourceLabel: string;
    /** True when responses came from the user's own account or hardware (BYOK
     *  key, local Ollama, Claude subscription) rather than aloud cloud. */
    ownProvider: boolean;
}

/** A `mailto:` link for flagging an inappropriate facilitator response. */
export function aiContentReportMailtoHref(ctx: AiReportContext): string {
    const ownNote = ctx.ownProvider
        ? `Note: this session's responses came from your own AI source (${ctx.sourceLabel}), not aloud cloud. We can still review how aloud instructs the model.\n\n`
        : '';
    const body =
        'What did the facilitator say? (paste or describe the response)\n\n\n' +
        'Why was it inappropriate or concerning?\n\n\n' +
        ownNote +
        `. . .\n${diagnostics([`AI source: ${ctx.sourceLabel}`])}`;
    return mailtoHref(`aloud AI content report (v${__APP_VERSION__})`, body);
}

/**
 * Desktop hands the `mailto:` to the opener plugin; web and native mobile let
 * the webview pass it to the OS composer, since `@capacitor/browser` can't open
 * `mailto:`.
 */
async function openMailto(href: string): Promise<void> {
    if (isTauri()) {
        await openExternal(href);
        return;
    }
    window.location.href = href;
}

export async function openBugReport(): Promise<void> {
    await openMailto(bugReportMailtoHref());
}

export async function openAiContentReport(ctx: AiReportContext): Promise<void> {
    await openMailto(aiContentReportMailtoHref(ctx));
}

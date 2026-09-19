/**
 * Who gets the Jev judge (spoken commands + the silence classifiers' fast path).
 *
 * aloud cloud sessions always do: every word already goes through our server.
 * Any other provider (BYOK, local) is a session that promised not to, so there
 * it is an opt-in (AppSettings.voiceCommandsViaCloud) and needs an account for
 * /cloud/v1/judge to answer. The call is free, so no balance is involved.
 */

import { getCloudToken, isGoogleSignInConfigured } from './cloud-auth.js';
import { isDevBypass } from './app-mode.js';
import { alertDialog } from './dialog.js';
import { t } from './i18n.js';
import { VOICE_COMMAND_EXAMPLES, VOICE_COMMANDS_NOTE, endExampleFor } from './voice-command-hints.js';

export type VoiceCommandsAccess = 'hosted' | 'opted-in' | 'off' | 'signed-out';

export function voiceCommandsAccess(args: {
    provider: string;
    optedIn: boolean;
    signedIn: boolean;
}): VoiceCommandsAccess {
    if (args.provider === 'aloud') return 'hosted';
    if (!args.optedIn) return 'off';
    return args.signedIn ? 'opted-in' : 'signed-out';
}

/** True when a judge call can get a token without a sign-in popup: one is
 *  stored, or this server mints dev sessions (ensureCloudToken). */
export async function canReachJudge(): Promise<boolean> {
    try {
        if ((await getCloudToken()) !== null) return true;
    } catch {
        return false;
    }
    return !isGoogleSignInConfigured() || isDevBypass();
}

// English source strings; callers pass them through t().
export const VOICE_COMMANDS_CONSENT = "What you say is checked through aloud cloud; we don't store it.";
/** Trails the consent line wherever it is shown. A plain anchor: the webview
 *  shells route it through external-links.ts. */
export function privacyPolicyLink(): string {
    return `<a href="https://aloud.rest/privacy/" target="_blank" rel="noopener">${t('Privacy policy')}</a>`;
}
export const VOICE_COMMANDS_NEEDS_ACCOUNT = 'Needs a free account.';
export const VOICE_COMMANDS_SIGN_IN = 'Sign in to enable voice commands.';
export const VOICE_COMMANDS_ALWAYS_ON = 'Always on with aloud cloud.';

/** The "what can I say?" list: the info panel's row and the Settings label. */
export function showVoiceCommandExamples(savesByDefault: boolean): Promise<void> {
    return alertDialog(
        `<strong>${t('Voice commands')}</strong><ul class="voice-command-list">` +
            [...VOICE_COMMAND_EXAMPLES, endExampleFor(savesByDefault)].map((line) => `<li>${t(line)}</li>`).join('') +
            `</ul><p class="voice-command-note">${t(VOICE_COMMANDS_NOTE)}</p>`,
        undefined,
        { html: true }
    );
}

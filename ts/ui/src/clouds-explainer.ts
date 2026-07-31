/**
 * "What are ☁️?" - the one shared explainer for the credit currency, opened
 * from the setup page's ☁️ legend and the account page (meditation-pal-msig:
 * users couldn't tell what drives cloud usage). Keep the story aligned with
 * the buy-credits modal subtitle and the pricing assumptions in
 * server/src/pricing/meter.ts.
 */

import { confirmDialog } from './dialog.js';
import { withCloudOutline } from './credit-rate.js';
import { getCloudToken, fetchMe } from './cloud-auth.js';
import { showBuyCreditsModal } from './buy-credits-modal.js';
import { showSignInModal } from './sign-in-modal.js';
import { withTimeout } from './net-timeout.js';

const EXPLAINER =
    '<strong>☁️ are aloud cloud credits.</strong>\n\n' +
    'aloud cloud uses selected providers for AI models powering three core functions: the facilitator, the voice you hear, and speech recognition.\n\n' +
    'the ☁️ badge on a model or voice shows roughly how many credits it uses per hour. this will vary depending on factors such as talking speed, response length, and session length.\n\n' +
    'options that use ☁️ are clearly labeled, and deduct ☁️ only as you use them. you may use other providers for these functions, such as your device\'s speech recognition or your own API keys; these do not use any ☁️.\n\n';

const FREE_CLOUDS_LINE =
    '<strong>connecting a Google or Apple account gets you free ☁️ to start.</strong>';

/** Whether to pitch the free-clouds grant: signed out, or signed in without a
 *  Google/Apple connection. False when already connected - or when we can't
 *  confirm in time, so we never promise clouds the server won't grant. */
async function needsFreeCloudsHint(): Promise<boolean> {
    try {
        if (!(await getCloudToken())) return true;
        const me = await withTimeout(fetchMe(), 1500, 'me timed out');
        if (!me) return true;
        return !me.providers.some((p) => p === 'google' || p === 'apple');
    } catch {
        return false;
    }
}

export async function showCloudsExplainer(): Promise<void> {
    const hint = (await needsFreeCloudsHint()) ? `${FREE_CLOUDS_LINE}\n\n` : '';
    // html mode: the copy's own <strong> plus the cloud-glyph outline spans
    // (EXPLAINER is our own static copy, safe to inject).
    const getClouds = await confirmDialog(withCloudOutline(EXPLAINER + hint), {
        okLabel: withCloudOutline('Get ☁️'),
        cancelLabel: 'Got it',
        // Got it is the focused primary - an explainer shouldn't upsell by default.
        primary: 'cancel',
        html: true,
    });
    if (!getClouds) return;
    // Signed out: sign in first (the modal's default copy sells the free
    // Google/Apple credits); the buy modal follows for card top-ups.
    if (!(await getCloudToken())) {
        if (!(await showSignInModal())) return;
    }
    await showBuyCreditsModal();
}

/** Wire a "what are ☁️?" link if `id` is present under `root`. */
export function wireCloudsExplainer(root: ParentNode, id: string): void {
    root.querySelector(`#${id}`)?.addEventListener('click', () => void showCloudsExplainer());
}

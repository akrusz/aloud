/**
 * "What are ☁️?" - the one shared explainer for the credit currency, opened
 * from the setup page's ☁️ legend and the account page (meditation-pal-msig:
 * users couldn't tell what drives cloud usage). Keep the story aligned with
 * the buy-credits modal subtitle and the pricing assumptions in
 * server/src/pricing/meter.ts.
 */

import { alertDialog } from './dialog.js';
import { withCloudOutline } from './credit-rate.js';

const EXPLAINER =
    '☁️ are aloud cloud credits.\n\n' +
    'They pay for the hosted AI in a session, and three things use them: the facilitator (AI model), the voice you hear, and speech recognition. Each is billed separately, only as you use it, so a quiet session spends less.\n\n' +
    'The ☁️ badge on a model or voice shows roughly how many credits an hour of it uses.\n\n' +
    'Options without a badge use no ☁️ at all: device voices and speech recognition, local AI, or your own API keys.';

export function showCloudsExplainer(): void {
    // html mode carries the cloud-glyph outline spans; EXPLAINER is our own
    // static copy with no markup of its own, so wrapping is safe.
    void alertDialog(withCloudOutline(EXPLAINER), 'Got it', { html: true });
}

/** Wire a "what are ☁️?" link if `id` is present under `root`. */
export function wireCloudsExplainer(root: ParentNode, id: string): void {
    root.querySelector(`#${id}`)?.addEventListener('click', showCloudsExplainer);
}

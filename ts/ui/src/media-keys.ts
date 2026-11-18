/**
 * Desktop: keep macOS media commands from pausing the facilitator.
 *
 * Speech plays through an <audio> element (cloud-tts.ts), which makes the app
 * macOS's now-playing app, and macOS sends that app a Pause when a headset
 * disconnects or the Play/Pause key (F8) is pressed. cloud-tts.ts reads an
 * element pause as a cancel, so the line would skip to its next sentence. A
 * registered handler replaces WebKit's default action, so these do nothing on
 * purpose.
 */

import { isTauri } from './is-desktop.js';

const IGNORED_ACTIONS: readonly MediaSessionAction[] = ['play', 'pause', 'stop'];

export function initMediaKeys(): void {
    if (!isTauri()) return;
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!session) return;
    for (const action of IGNORED_ACTIONS) {
        try {
            session.setActionHandler(action, () => {});
        } catch {
            /* an action this WebKit doesn't support throws */
        }
    }
}

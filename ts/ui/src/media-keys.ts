/**
 * Keep media commands from pausing the facilitator or the signature sound.
 *
 * Speech and the signature sound play through <audio> elements (cloud-tts.ts,
 * sound-player.ts) long enough to make the app the system's now-playing app,
 * on a Mac and on a phone, and the system sends that app a Pause when a
 * headset disconnects or a Play/Pause key is pressed. cloud-tts.ts reads an
 * element pause as a cancel, so the line would skip to its next sentence. A
 * registered handler is called instead of WebKit pausing the element, so these
 * do nothing on purpose. One exception: on iOS, unplugging headphones pauses
 * the audible elements directly, without asking the handlers
 * (dev-docs/audio-output.md).
 */

const IGNORED_ACTIONS: readonly MediaSessionAction[] = ['play', 'pause', 'stop'];

export function initMediaKeys(): void {
    const session = typeof navigator !== 'undefined' ? navigator.mediaSession : undefined;
    if (!session) return;
    for (const action of IGNORED_ACTIONS) {
        try {
            session.setActionHandler(action, () => {});
        } catch {
            /* an action this browser doesn't support throws */
        }
    }
}

/**
 * The one <audio> element every spoken line plays through, and the priming a
 * Begin click gives it and the sound player's elements (sound-player.ts).
 *
 * Safari (macOS and iOS) grants playback permission PER ELEMENT, and only to an
 * element whose play() was called inside a user gesture. A session's first
 * sentence arrives several awaits after the Begin click - LLM, then synthesis -
 * so a freshly constructed `new Audio(blobUrl)` is unprivileged by then and
 * play() rejects with NotAllowedError: the session runs mute (macOS Safari's
 * default per-site "Stop Media with Sound" auto-play setting does the same).
 * The opening sound, the close and the noting chime come later still. Chrome
 * doesn't gate this way.
 *
 * So: play every element once inside the Begin handler, then reuse them. The
 * permission stays with the element through later src changes.
 *
 * Nothing audible goes through an AudioContext (dev-docs/audio-output.md); the
 * only contexts are the mic capture graphs, which make no sound.
 */

import { primeSounds, SILENT_WAV } from './sound-player.js';

let element: HTMLAudioElement | null = null;

/** The AudioContext constructor, webkit-prefixed on older Safari; undefined
 *  where Web Audio is unavailable. For mic capture only. */
export function audioContextCtor(): typeof AudioContext | undefined {
    return (
        (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    );
}

/**
 * Can this page make sound with no gesture behind the call? A browser tab
 * nobody has touched can't; the desktop and mobile webviews can (measured in
 * a macOS WKWebView: play() resolves on a page whose userActivation has never
 * been active). Asked by playing the silent clip on a throwaway element, so
 * the answer is the platform's own.
 */
export async function canPlayUntouched(): Promise<boolean> {
    try {
        const probe = new Audio(SILENT_WAV);
        // A page that isn't visible may never settle play() at all.
        await Promise.race([
            probe.play(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
        ]);
        return true;
    } catch {
        return false;
    }
}

/** The shared playback element, created on first use. */
export function playbackAudio(): HTMLAudioElement {
    if (!element) {
        element = new Audio();
        // Buffer before play(), trimming the lead-in gap (Firefox most of all).
        element.preload = 'auto';
    }
    return element;
}

/**
 * Grant the voice's element and the sound elements playback permission. MUST
 * be called synchronously from a user gesture (the Begin click) - before any
 * await, exactly like acquireMicOnce - or the gesture is spent and this
 * no-ops silently.
 */
export function primeAudioPlayback(): void {
    primeSounds();
    const audio = playbackAudio();
    // A prime mid-session would cut off the sentence being spoken.
    if (!audio.paused) return;
    try {
        audio.src = SILENT_WAV;
        // Rejects when the browser blocks it anyway; nothing to do but continue -
        // the real playback attempt reports its own failure.
        void audio.play().catch(() => {});
    } catch {
        // ignore
    }
}

/**
 * aloud's signature sound: a short original sound that opens a session and a
 * sibling that closes it. Several pairs ship as presets, picked in Settings
 * ("Look and Feel", AppSettings.signatureSound). The files in
 * public/audio/signature/ are written by
 * assets/promo/signature-candidates/app_copies.py, 4 dB under the candidates
 * so they sit under the voice; its README says which candidate each preset is.
 *
 * Played on the sound player's open and close elements (sound-player.ts), not
 * the voice's: a sound sharing the voice's element would cut a line off or be
 * cut off by one.
 */

import type { SttEngine } from '../../src/platform/stt.js';
import { pulseNavOrb } from './orb-pulse.js';
import { assetPath } from './route-base.js';
import { diag } from './diag.js';
import { captureLive, endCaptureHandover } from './mic-check.js';
import { playSound, preloadSound, primeSounds, type Sound } from './sound-player.js';

/** [id, label], in menu order. An id names its two files, so renaming one
 *  means renaming them. */
export const SIGNATURE_SOUNDS = [
    ['bloom', 'Bloom'],
    ['handpan', 'Handpan'],
    ['ripples', 'Ripples'],
    ['drone', 'Drone'],
    ['marimba', 'Marimba'],
    ['none', 'None'],
] as const;

export type SignatureSound = (typeof SIGNATURE_SOUNDS)[number][0];
export type SignatureHalf = 'open' | 'close';

export const DEFAULT_SIGNATURE_SOUND: SignatureSound = 'bloom';

/** A stored pick, or the default when it isn't on the menu (never set, or a
 *  preset since retired). */
export function resolveSignatureSound(stored: unknown): SignatureSound {
    const hit = SIGNATURE_SOUNDS.find(([id]) => id === stored);
    return hit ? hit[0] : DEFAULT_SIGNATURE_SOUND;
}

/** An opening that hasn't loaded by now is skipped: it would overlap the
 *  facilitator's first words instead of ahead of them. */
const LOAD_DEADLINE_MS = 1500;
/** How long the audio output gets to settle once the mic has opened, before
 *  the opening plays (see playOpening). By ear, not measured: the drop-out it
 *  avoids was "some fraction of a second". */
const MIC_SETTLE_MS = 600;
/** The same on Android when that mic switched call mode on: the audio policy
 *  mutes media playback for 2 s as call mode starts (2.0 s measured on a
 *  phone, 2026-11-19), and the elements primed at the Begin click opened their
 *  output before the switch. A little over, as the mute ends on a ramp. */
const CALL_MODE_SETTLE_MS = 2200;
/** A mic that hasn't opened by now doesn't hold the opening any longer. */
const MIC_OPEN_CAP_MS = 1500;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const bytes = new Map<string, Promise<ArrayBuffer>>();
const objectUrls = new Map<string, Promise<string>>();

function fileUrl(sound: SignatureSound, half: SignatureHalf): string {
    return assetPath(`/audio/signature/${sound}-${half}.mp3`);
}

function fetchBytes(url: string): Promise<ArrayBuffer> {
    let pending = bytes.get(url);
    if (!pending) {
        pending = fetch(url).then((res) => {
            // Status 0 is the iOS app's own file server: Capacitor answers media
            // extensions with no HTTP status, so a whole file reads as not ok.
            if (!res.ok && res.status !== 0) throw new Error(`signature sound ${res.status}`);
            return res.arrayBuffer();
        });
        // Not cached, so the next session tries again.
        pending.catch(() => bytes.delete(url));
        bytes.set(url, pending);
    }
    return pending;
}

/** The file as an object URL, made once and kept: the element holds it as its
 *  src for as long as the preset stays picked. */
function objectUrl(url: string): Promise<string> {
    let pending = objectUrls.get(url);
    if (!pending) {
        pending = fetchBytes(url).then((data) => URL.createObjectURL(new Blob([data], { type: 'audio/mpeg' })));
        pending.catch(() => objectUrls.delete(url));
        objectUrls.set(url, pending);
    }
    return pending;
}

/** Fetch a preset's opening ahead of the session, so it starts on the click
 *  and not a round-trip after it. (Its close is fetched as the opening plays.) */
export function preloadOpening(sound: SignatureSound): void {
    if (sound !== 'none') preloadSound('open', objectUrl(fileUrl(sound, 'open')));
}

interface Sounding {
    half: SignatureHalf;
    sound: Sound;
}
let sounding: Sounding | null = null;
/** Settles when the last sound cut short has faded out: two of these
 *  overlapping, the same sound twice above all, beat against each other. */
let faded: Promise<void> = Promise.resolve();
/** Bumped by every opening and close, so an opening still waiting for its mic
 *  knows when the session it belonged to has ended or been replaced. */
let sessionTicket = 0;
/** The ticket of an opening that is waiting for its mic, or 0. */
let openingWaiting = 0;

function cutSounding(): void {
    if (!sounding) return;
    faded = sounding.sound.stop();
    sounding = null;
}

/**
 * Play one half, replacing whatever is sounding once it has faded. The promise
 * resolves when the sound is over - played out, cut short, or never audible -
 * and never rejects or hangs: the facilitator's first words wait on it.
 */
function play(sound: SignatureSound, half: SignatureHalf): Promise<void> {
    cutSounding();
    if (sound === 'none') return Promise.resolve();
    const me: Sounding = {
        half,
        sound: playSound(half, objectUrl(fileUrl(sound, half)), {
            label: `[signature] ${half}`,
            startDeadlineMs: LOAD_DEADLINE_MS,
            after: faded,
        }),
    };
    sounding = me;
    return me.sound.done.then(() => {
        if (sounding === me) sounding = null;
    });
}

function onAndroid(): boolean {
    return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent || '');
}

async function waitForMic(micOpening: Promise<unknown>): Promise<void> {
    const t0 = performance.now();
    await Promise.race([micOpening.catch(() => {}), sleep(MIC_OPEN_CAP_MS)]);
    diag(`[signature] open: mic ready after ${Math.round(performance.now() - t0)}ms`);
}

/**
 * A session starts. Resolves when the opening is over and the mic is open,
 * which is when the facilitator may speak. The orb ripples with it.
 *
 * `openMic` opens the recognizer's capture stream, where it opens one now
 * (SttEngine.prime); a recognizer that opens the mic only when it listens
 * passes nothing, and the sound starts at once. The mic opens first and the
 * sound waits for it and a beat more, on every platform: the session's
 * capture is open across everything the session makes audible
 * (dev-docs/audio-output.md). Opening an echo-cancelled mic disturbs sound
 * already playing: macOS rebuilds its audio output (voice processing), a drop
 * of a fraction of a second (MacBook speakers, 2026-10-12), and Android
 * switches to call mode, which mutes the media stream for 2 s and moves later
 * sound to the call stream. A mic opened beside one of ours already open (the
 * setup screen's, held by Begin; the last session's, held through its close)
 * switches nothing, so only the short settle applies.
 */
export async function playOpening(
    sound: SignatureSound,
    openMic?: () => Promise<unknown> | undefined
): Promise<void> {
    const mine = ++sessionTicket;
    const cold = !captureLive();
    const micOpening = openMic?.();
    // A capture held across Begin (holdCaptureForSession) goes once this one
    // hears; with none to open, or one that fails, nothing will hear.
    if (micOpening) void micOpening.catch(endCaptureHandover);
    else endCaptureHandover();
    if (sound === 'none') {
        if (micOpening) await waitForMic(micOpening);
        return;
    }
    void objectUrl(fileUrl(sound, 'close')).catch(() => {});
    if (micOpening) {
        openingWaiting = mine;
        await waitForMic(micOpening);
        await sleep(cold && onAndroid() ? CALL_MODE_SETTLE_MS : MIC_SETTLE_MS);
        if (openingWaiting === mine) openingWaiting = 0;
        // Ended (or restarted) while it waited.
        if (sessionTicket !== mine) return;
    }
    pulseNavOrb('session');
    await play(sound, 'open');
}

/**
 * A session ends. One that ends inside its own opening, or before it began,
 * only loses the opening: it was too short to have a close. Resolves when the
 * close is over (at once when none plays, once faded when the opening is cut).
 *
 * `stt` stops listening now and keeps its capture open until then
 * (SttStopOptions.keepMicUntil), so the mic closes after the last sound and
 * never under it. The engine lets the stream go when this settles however it
 * ends, and by its own cap should it never settle.
 */
export function playClosing(sound: SignatureSound, stt?: SttEngine | null): Promise<void> {
    ++sessionTicket;
    endCaptureHandover();
    const over = closingSound(sound);
    void stt?.stop({ keepMicUntil: over });
    return over;
}

function closingSound(sound: SignatureSound): Promise<void> {
    if (openingWaiting) {
        openingWaiting = 0;
        return Promise.resolve();
    }
    if (sounding?.half === 'open') {
        cutSounding();
        return faded;
    }
    if (sound !== 'none') pulseNavOrb('home');
    return play(sound, 'close');
}

/** Settings: hear one half of a preset. Called from the click, which is what
 *  lets the element play once the file is in (primeSounds). */
export function previewSignatureSound(sound: SignatureSound, half: SignatureHalf): void {
    primeSounds();
    void play(sound, half);
}

/**
 * aloud's signature sound: a short original sound that opens a session and a
 * sibling that closes it. Several pairs ship as presets, picked in Settings
 * ("Look and Feel", AppSettings.signatureSound). The files in
 * public/audio/signature/ are rendered by
 * assets/promo/signature-candidates/synth_signature.py; its README says which
 * candidate each preset is.
 *
 * Played through the shared AudioContext, not the shared <audio> element: that
 * element is the voice's, and a sound sharing it would cut a line off or be cut
 * off by one. A gain node is also the only level control iOS honors (an
 * element's volume is read-only there).
 */

import { playbackAudioContext } from './audio-unlock.js';
import { diag } from './diag.js';
import { pulseNavOrb } from './orb-pulse.js';
import { assetPath } from './route-base.js';

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

/** How far the files are turned down to sit with the facilitator's voice: the
 *  audition page's "under the voice" default (-6 dB), where the pairs were
 *  chosen, then raised 2 dB by ear in the app (2026-10-14). */
const GAIN = 10 ** (-4 / 20);
/** Fade when a sound is cut short (a session ended early, another preview).
 *  Whatever replaces it starts once the fade is done: two of these overlapping,
 *  the same sound twice above all, beat against each other. */
const FADE_S = 0.25;
/** An opening that hasn't loaded by now is skipped: it would overlap the
 *  facilitator's first words instead of ahead of them. */
const LOAD_DEADLINE_MS = 1500;
/** How long a context that isn't running gets to start (a Bluetooth route can
 *  take a beat) before the sound is given up as inaudible. */
const RESUME_GRACE_MS = 400;
/** How long the audio output gets to settle once the mic has opened, before
 *  the opening plays (see playOpening). By ear, not measured: the drop-out it
 *  avoids was "some fraction of a second". */
const MIC_SETTLE_MS = 600;
/** A mic that hasn't opened by now doesn't hold the opening any longer. */
const MIC_OPEN_CAP_MS = 1500;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const bytes = new Map<string, Promise<ArrayBuffer>>();

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

async function load(ctx: AudioContext, url: string): Promise<AudioBuffer> {
    const data = await fetchBytes(url);
    return new Promise<AudioBuffer>((resolve, reject) => {
        // Callback form: older Safari has no promise form. Where both exist the
        // promise rejects too, hence the catch. A copy, because decoding
        // detaches what it is given and the cached bytes are played again.
        const decoding = ctx.decodeAudioData(data.slice(0), resolve, reject) as Promise<AudioBuffer> | undefined;
        decoding?.catch(() => {});
    });
}

/** Fetch a preset's opening ahead of the session, so it starts on the click
 *  and not a round-trip after it. (Its close is fetched as the opening plays.) */
export function preloadOpening(sound: SignatureSound): void {
    if (sound !== 'none') void fetchBytes(fileUrl(sound, 'open')).catch(() => {});
}

interface Sounding {
    half: SignatureHalf;
    stop(): void;
}
let sounding: Sounding | null = null;
/** Context time at which the last sound cut short has faded out. */
let clearAt = 0;
/** Bumped by every opening and close, so an opening still waiting for its mic
 *  knows when the session it belonged to has ended or been replaced. */
let sessionTicket = 0;
/** The ticket of an opening that is waiting for its mic, or 0. */
let openingWaiting = 0;

/**
 * Play one half, replacing whatever is sounding. The promise resolves when the
 * sound is over - played out, cut short, or never audible - and never rejects
 * or hangs: the facilitator's first words wait on it.
 */
function play(sound: SignatureSound, half: SignatureHalf): Promise<void> {
    sounding?.stop();
    if (sound === 'none') return Promise.resolve();
    const ctx = playbackAudioContext();
    if (!ctx) return Promise.resolve();
    return new Promise<void>((resolve) => {
        let source: AudioBufferSourceNode | null = null;
        let gain: GainNode | null = null;
        let over = false;
        const t0 = performance.now();
        const finish = (): void => {
            if (over) return;
            over = true;
            clearTimeout(giveUp);
            if (sounding === me) sounding = null;
            resolve();
        };
        const me: Sounding = {
            half,
            stop: () => {
                if (source && gain) {
                    const now = ctx.currentTime;
                    gain.gain.cancelScheduledValues(now);
                    gain.gain.setValueAtTime(gain.gain.value, now);
                    gain.gain.linearRampToValueAtTime(0, now + FADE_S);
                    source.stop(now + FADE_S);
                    clearAt = now + FADE_S;
                }
                finish();
            },
        };
        sounding = me;
        let giveUp = setTimeout(() => {
            diag(`[signature] ${half}: not loaded in ${LOAD_DEADLINE_MS}ms, skipped`);
            finish();
        }, LOAD_DEADLINE_MS);
        void (async () => {
            const buffer = await load(ctx, fileUrl(sound, half));
            if (over) return;
            // A function, so the checks either side of the await aren't
            // narrowed into one.
            const running = (): boolean => ctx.state === 'running';
            if (!running()) {
                await Promise.race([
                    ctx.resume().catch(() => {}),
                    new Promise((r) => setTimeout(r, RESUME_GRACE_MS)),
                ]);
                if (over) return;
                // No gesture behind this context. Started anyway, the sound
                // would play whenever the context next woke, mid-session.
                if (!running()) {
                    diag(`[signature] ${half}: context ${ctx.state}, skipped`);
                    finish();
                    return;
                }
            }
            source = ctx.createBufferSource();
            gain = ctx.createGain();
            source.buffer = buffer;
            gain.gain.value = GAIN;
            source.connect(gain);
            gain.connect(ctx.destination);
            source.onended = () => {
                diag(`[signature] ${half}: ended at +${Math.round(performance.now() - t0)}ms`);
                source?.disconnect();
                gain?.disconnect();
                finish();
            };
            const wait = Math.max(0, clearAt - ctx.currentTime);
            source.start(ctx.currentTime + wait);
            diag(
                `[signature] ${half}: start at +${Math.round(performance.now() - t0)}ms ` +
                    `dur=${buffer.duration.toFixed(2)}s wait=${wait.toFixed(2)}s ` +
                    `outputLatency=${ctx.outputLatency ?? '?'}`
            );
            // onended never fires on a context that stalls (an interruption on
            // iOS), so the clock ends the wait and the sound with it.
            clearTimeout(giveUp);
            giveUp = setTimeout(me.stop, (wait + buffer.duration) * 1000 + 300);
        })().catch((err: unknown) => {
            diag(`[signature] ${half}: failed, ${err instanceof Error ? err.message : String(err)}`);
            finish();
        });
    });
}

/**
 * Whether the opening plays before the mic opens, rather than after. On
 * Android an echo-cancelled mic puts the app in call mode, and Android mutes
 * media playback for 2s when a call starts and drops its outputs for ~0.5s
 * when one ends. The opening plays on the WebAudio output, a media track, so
 * it came in a second or so late on any session whose mic started call mode
 * (meditation-pal-x4n9). The voice's tracks open after the switch, as call
 * audio, and aren't muted.
 *
 * Not while the last session's close is sounding: its mic is held until the
 * close is over (SttStopOptions.keepMicUntil), so call mode is already on, and
 * the opening cutting the close lets that mic go. Opening this session's mic
 * first keeps call mode on through the handover; the other way round it ends
 * under the opening and starts again at its tail.
 */
function micOpensAfterOpening(): boolean {
    if (sounding?.half === 'close') return false;
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
 * passes nothing, and the sound starts at once. Opening an echo-cancelled mic
 * disturbs sound already playing, so the two take turns. Mostly the sound
 * waits for the mic and a beat more: the OS rebuilds its audio output (voice
 * processing on macOS), and a sound playing through that drops out for a
 * fraction of a second (heard on MacBook speakers, 2026-10-12). On Android
 * the mic mostly waits for the sound instead (micOpensAfterOpening).
 */
export async function playOpening(
    sound: SignatureSound,
    openMic?: () => Promise<unknown> | undefined
): Promise<void> {
    const mine = ++sessionTicket;
    if (micOpensAfterOpening()) {
        if (sound !== 'none') {
            void fetchBytes(fileUrl(sound, 'close')).catch(() => {});
            pulseNavOrb('session');
            await play(sound, 'open');
        }
        // Ended (or restarted) during the sound: that session gets no mic.
        if (sessionTicket !== mine) return;
        const micOpening = openMic?.();
        if (micOpening) await waitForMic(micOpening);
        return;
    }
    const micOpening = openMic?.();
    if (sound === 'none') {
        if (micOpening) await waitForMic(micOpening);
        return;
    }
    void fetchBytes(fileUrl(sound, 'close')).catch(() => {});
    if (micOpening) {
        openingWaiting = mine;
        await waitForMic(micOpening);
        await sleep(MIC_SETTLE_MS);
        if (openingWaiting === mine) openingWaiting = 0;
        // Ended (or restarted) while it waited.
        if (sessionTicket !== mine) return;
    }
    pulseNavOrb('session');
    await play(sound, 'open');
}

/** A session ends. One that ends inside its own opening, or before it began,
 *  only loses the opening: it was too short to have a close. Resolves when the
 *  close is over (at once when none plays): the mic is held open until then
 *  (SttStopOptions.keepMicUntil). */
export function playClosing(sound: SignatureSound): Promise<void> {
    ++sessionTicket;
    if (openingWaiting) {
        openingWaiting = 0;
        return Promise.resolve();
    }
    if (sounding?.half === 'open') {
        sounding.stop();
        return Promise.resolve();
    }
    if (sound !== 'none') pulseNavOrb('home');
    return play(sound, 'close');
}

/** Settings: hear one half of a preset. */
export function previewSignatureSound(sound: SignatureSound, half: SignatureHalf): void {
    void play(sound, half);
}

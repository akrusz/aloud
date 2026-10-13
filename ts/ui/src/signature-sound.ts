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
import { pulseNextNavOrb } from './orb-pulse.js';
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
 *  audition page's "under the voice" default, where the pairs were chosen. */
const GAIN = 10 ** (-4 / 20);
/** Fade when a sound is cut short (a session ended early, another preview).
 *  Whatever replaces it starts once the fade is done: two of these overlapping,
 *  the same sound twice above all, beat against each other. */
const FADE_S = 0.25;
/** An opening that hasn't loaded by now is skipped: it would land on the
 *  facilitator's first words instead of ahead of them. */
const LOAD_DEADLINE_MS = 1500;
/** How long a context that isn't running gets to start (a Bluetooth route can
 *  take a beat) before the sound is given up as inaudible. */
const RESUME_GRACE_MS = 400;

const bytes = new Map<string, Promise<ArrayBuffer>>();

function fileUrl(sound: SignatureSound, half: SignatureHalf): string {
    return assetPath(`/audio/signature/${sound}-${half}.mp3`);
}

function fetchBytes(url: string): Promise<ArrayBuffer> {
    let pending = bytes.get(url);
    if (!pending) {
        pending = fetch(url).then((res) => {
            if (!res.ok) throw new Error(`signature sound ${res.status}`);
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
        let giveUp = setTimeout(finish, LOAD_DEADLINE_MS);
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
                source?.disconnect();
                gain?.disconnect();
                finish();
            };
            const wait = Math.max(0, clearAt - ctx.currentTime);
            source.start(ctx.currentTime + wait);
            // onended never fires on a context that stalls (an interruption on
            // iOS), so the clock ends the wait and the sound with it.
            clearTimeout(giveUp);
            giveUp = setTimeout(me.stop, (wait + buffer.duration) * 1000 + 300);
        })().catch(finish);
    });
}

/** A session starts. Resolves when the opening is over, which is when the
 *  facilitator may speak. The orb ripples with it. */
export function playOpening(sound: SignatureSound): Promise<void> {
    if (sound !== 'none') {
        void fetchBytes(fileUrl(sound, 'close')).catch(() => {});
        pulseNextNavOrb();
    }
    return play(sound, 'open');
}

/** A session ends. One that ends inside its own opening only loses the
 *  opening: it was too short to have a close. */
export function playClosing(sound: SignatureSound): void {
    if (sounding?.half === 'open') {
        sounding.stop();
        return;
    }
    if (sound !== 'none') pulseNextNavOrb();
    void play(sound, 'close');
}

/** Settings: hear one half of a preset. */
export function previewSignatureSound(sound: SignatureSound, half: SignatureHalf): void {
    void play(sound, half);
}

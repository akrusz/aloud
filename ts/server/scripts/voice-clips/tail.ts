/**
 * The silence after a setup clip's last sound, cut down to TAIL.keepS.
 *
 * The providers end a take in silence of their own: up to 0.8s on Harper's
 * short lines and 0.9s on Ethan's (both padded to 2.16s), about 0.85s on every
 * one of Xiaoyue's. The setup screen stops its recognizer while a clip plays
 * and starts it again only once the file has ended (ui/src/voice-start.ts
 * SPEECH_TAIL_MS), so all of that was time the mic could not hear after the
 * voice had stopped, and requests said at a natural pace lost their first
 * word (2026-11-18).
 *
 * The floor sits far below the gate's (analysis.ts GATE.floorDb, -40): from
 * these soft voices a final "f" or "s" runs 150 to 230ms between -40 and -57
 * dBFS, then falls to the providers' silence (-80 to -99, or digital zero)
 * within about 60ms, and the cut has to land in that silence, not in the
 * consonant.
 *
 * Pure, on mono float PCM and MP3 bytes: decoding lives in the script. The
 * silence ahead of the voice is left alone.
 */

import { mp3Frames } from '../../src/providers/mp3-gain.js';
import { windowDb } from './analysis.js';

export const TAIL = {
    /** A 10ms window at or over this, in dBFS as the clip will play, is sound. */
    floorDb: -60,
    /** Kept after the last sound. */
    keepS: 0.15,
    /** The most clips:check lets through: keepS, plus up to a frame a cut on
     *  whole MP3 frames keeps (24ms) or an encode adds (about 25ms), plus a
     *  re-level moving the floor a little. */
    maxS: 0.25,
} as const;

const WINDOW_MS = 10;

/** Where the last sound in `samples` ends, in seconds; 0 for a silent clip.
 *  `gainDb` is a level change still to come, so the floor is judged where the
 *  clip will play. */
export function soundEndS(samples: Float32Array, rate: number, gainDb = 0): number {
    const size = Math.max(1, Math.round((rate * WINDOW_MS) / 1000));
    const levels = windowDb(samples, rate, WINDOW_MS);
    for (let i = levels.length - 1; i >= 0; i--) {
        if (levels[i]! + gainDb >= TAIL.floorDb) return Math.min(samples.length, (i + 1) * size) / rate;
    }
    return 0;
}

/** Seconds of silence after the last sound in `samples`. */
export function trailingSilenceS(samples: Float32Array, rate: number): number {
    return samples.length / rate - soundEndS(samples, rate);
}

/** `samples` ending TAIL.keepS after their last sound, or the input itself
 *  when it already ends sooner or holds no sound at all. */
export function trimTail(samples: Float32Array, rate: number, gainDb = 0): Float32Array {
    const end = soundEndS(samples, rate, gainDb);
    const keep = Math.round((end + TAIL.keepS) * rate);
    return end > 0 && keep < samples.length ? samples.subarray(0, keep) : samples;
}

/**
 * `mp3` without the Xing/Info header frame it opens with, or the input itself
 * when there is none. The header counts the frames and its LAME tag gives the
 * encoder delay and end padding, all of which a cut makes wrong. Without it a
 * decoder plays the delay (about 46ms of silence at the start), as it does in
 * every clip the render writes: those are encoded to a pipe, which gets no
 * header.
 */
export function withoutHeader(mp3: Uint8Array): Uint8Array {
    const first = mp3Frames(mp3)?.[0];
    if (!first || first.gainBits.length) return mp3;
    const out = new Uint8Array(mp3.length - first.length);
    out.set(mp3.subarray(0, first.offset));
    out.set(mp3.subarray(first.offset + first.length), first.offset);
    return out;
}

/**
 * `mp3` ending with the whole frame that holds the point TAIL.keepS after
 * `soundEnd` (seconds into its decode, soundEndS), re-encoding nothing: a
 * frame draws on earlier frames' bytes (the bit reservoir), never on later
 * ones, so the frames kept decode exactly as they did. The input itself when
 * there is nothing to cut or no sound.
 *
 * Null for a stream mp3Frames can't walk, and for one with a header frame
 * (withoutHeader first): the decoder delay it declares would shift the decode
 * against the frames, so `soundEnd` would land in the wrong one.
 */
export function cutMp3Tail(mp3: Uint8Array, soundEnd: number): Uint8Array | null {
    const frames = mp3Frames(mp3);
    if (!frames || frames.some((f) => !f.gainBits.length)) return null;
    if (soundEnd <= 0) return mp3;
    const frameS = frames[0]!.samples / frames[0]!.sampleRate;
    const keep = Math.ceil((soundEnd + TAIL.keepS) / frameS - 1e-9);
    return keep < frames.length ? mp3.slice(0, frames[keep]!.offset) : mp3;
}

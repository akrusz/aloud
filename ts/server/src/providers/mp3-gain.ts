/**
 * A level change on MP3 bytes without decoding them. Every Layer III granule
 * carries an 8-bit global_gain that scales its whole spectrum by 2^(1/4) per
 * step (1.5 dB), so adding to it makes the clip louder or quieter with no
 * re-encode and no loss: what mp3gain does. All three TTS providers send
 * Layer III, so one trim serves every curated voice (CuratedVoice.gainDb).
 *
 * All or nothing: a stream that does not walk as whole frames from start to
 * end comes back untouched, so a clip is never louder in one half than the
 * other. That includes a CRC-protected stream, whose checksum covers the
 * field moved here: no provider sends one today (measured 2026-11-16), and if
 * one starts to, its voices' trims stop applying without an error.
 */

export const MP3_GAIN_STEP_DB = 1.5;

// Layer III bitrates in kbps by index, and sample rates by version index
// (0 = MPEG-2.5, 2 = MPEG-2, 3 = MPEG-1; 1 is reserved).
const MPEG1_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const MPEG2_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, readonly number[]> = {
    0: [11025, 12000, 8000],
    2: [22050, 24000, 16000],
    3: [44100, 48000, 32000],
};

export interface Mp3Frame {
    /** Where the frame's header starts in the stream. */
    offset: number;
    length: number;
    crc: boolean;
    /** Bit offsets of each granule's global_gain, from the frame's first byte;
     *  none on a Xing/Info/VBRI header frame, which carries no audio. */
    gainBits: number[];
    /** Samples per channel the frame decodes to: 1152 on MPEG-1, 576 otherwise. */
    samples: number;
    sampleRate: number;
    /** main_data_begin: its bit offset from the frame's first byte and its
     *  width (9 bits on MPEG-1, 8 otherwise). */
    mainDataBit: number;
    mainDataWidth: number;
    /** Where the side info ends and the main data bytes begin, from the
     *  frame's first byte. */
    mainDataStart: number;
}

function frameAt(b: Uint8Array, i: number): Mp3Frame | null {
    if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1]! & 0xe0) !== 0xe0) return null;
    const version = (b[i + 1]! >> 3) & 3;
    const layer = (b[i + 1]! >> 1) & 3;
    const bitrateIndex = b[i + 2]! >> 4;
    const rateIndex = (b[i + 2]! >> 2) & 3;
    // Layer III only; free-format (0) and bad (15) bitrates have no length to walk by.
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
    const mpeg1 = version === 3;
    const crc = (b[i + 1]! & 1) === 0;
    const padding = (b[i + 2]! >> 1) & 1;
    const channels = b[i + 3]! >> 6 === 3 ? 1 : 2;
    const kbps = (mpeg1 ? MPEG1_KBPS : MPEG2_KBPS)[bitrateIndex]!;
    const length = Math.floor(((mpeg1 ? 144 : 72) * kbps * 1000) / SAMPLE_RATES[version]![rateIndex]!) + padding;

    // Side info: main_data_begin and private bits (and MPEG-1's scfsi), then
    // one block per granule per channel with global_gain 21 bits in. MPEG-1
    // has two granules of 59 bits, MPEG-2 and 2.5 one of 63.
    const sideInfo = (4 + (crc ? 2 : 0)) * 8;
    const lead = mpeg1 ? 9 + (channels === 1 ? 5 : 3) + 4 * channels : 8 + channels;
    const stride = mpeg1 ? 59 : 63;
    const gainBits: number[] = [];
    // A Xing/Info (or VBRI) frame is the stream's header, not audio, and the
    // LAME tag in it checksums these bytes: left alone.
    const sideBytes = mpeg1 ? (channels === 1 ? 17 : 32) : channels === 1 ? 9 : 17;
    const tag = (at: number) => String.fromCharCode(...b.subarray(at, at + 4));
    const header = ['Xing', 'Info'].includes(tag(i + sideInfo / 8 + sideBytes)) || tag(i + 36) === 'VBRI';
    if (!header) {
        for (let block = 0; block < (mpeg1 ? 2 : 1) * channels; block++) gainBits.push(sideInfo + lead + block * stride + 21);
    }
    return {
        offset: i,
        length,
        crc,
        gainBits,
        samples: mpeg1 ? 1152 : 576,
        sampleRate: SAMPLE_RATES[version]![rateIndex]!,
        mainDataBit: sideInfo,
        mainDataWidth: mpeg1 ? 9 : 8,
        mainDataStart: sideInfo / 8 + sideBytes,
    };
}

/** Bytes of an ID3v2 tag at the start, footer included; 0 without one. */
function id3v2Length(b: Uint8Array): number {
    if (b.length < 10 || b[0] !== 0x49 || b[1] !== 0x44 || b[2] !== 0x33) return 0;
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f);
    return 10 + size + (b[5]! & 0x10 ? 10 : 0);
}

function writeByteAt(b: Uint8Array, bit: number, value: number): void {
    const at = bit >> 3;
    const shift = 8 - (bit & 7);
    const word = (((b[at]! << 8) | b[at + 1]!) & ~(0xff << shift)) | (value << shift);
    b[at] = (word >> 8) & 0xff;
    b[at + 1] = word & 0xff;
}

/** Every frame of `mp3` in order, or null when the stream does not walk as
 *  whole frames from start to end: junk, a frame cut short, or a
 *  CRC-protected frame (its checksum covers the side info the callers move).
 *  An ID3v2 tag at the start and an ID3v1 tag at the end are stepped over. */
export function mp3Frames(mp3: Uint8Array): Mp3Frame[] | null {
    const frames: Mp3Frame[] = [];
    let i = id3v2Length(mp3);
    for (let frame = frameAt(mp3, i); frame; frame = frameAt(mp3, i)) {
        if (frame.crc || i + frame.length > mp3.length) return null;
        frames.push(frame);
        i += frame.length;
    }
    const rest = mp3.length - i;
    const id3v1 = rest === 128 && mp3[i] === 0x54 && mp3[i + 1] === 0x41 && mp3[i + 2] === 0x47;
    return frames.length && (rest === 0 || id3v1) ? frames : null;
}

/** The 8-bit field at `bit` in `b`. */
export function readByteAt(b: Uint8Array, bit: number): number {
    const at = bit >> 3;
    return (((b[at]! << 8) | b[at + 1]!) >> (8 - (bit & 7))) & 0xff;
}

/** `mp3` with every granule's gain moved by `gainDb`, rounded to whole
 *  1.5 dB steps; a new array, or the input itself when nothing changes. */
export function withGain(mp3: Uint8Array, gainDb: number): Uint8Array {
    const steps = Math.round(gainDb / MP3_GAIN_STEP_DB);
    if (steps === 0) return mp3;
    const fields = (mp3Frames(mp3) ?? []).flatMap((f) => f.gainBits.map((bit) => f.offset * 8 + bit));
    if (!fields.length) return mp3;
    const out = mp3.slice();
    for (const bit of fields) writeByteAt(out, bit, Math.min(255, Math.max(0, readByteAt(out, bit) + steps)));
    return out;
}

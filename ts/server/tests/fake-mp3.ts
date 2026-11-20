/**
 * Hand-built MP3 frames for the tests of code that reads or rewrites Azure's
 * stream without decoding it (providers/mp3-lead-trim.ts, mp3-marks.ts).
 */

export function bits(b: Uint8Array, at: number, n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | ((b[(at + i) >> 3]! >> (7 - ((at + i) & 7))) & 1);
    return v;
}

export function setBits(b: Uint8Array, at: number, n: number, value: number): void {
    for (let i = 0; i < n; i++) {
        const mask = 0x80 >> ((at + i) & 7);
        if ((value >> (n - 1 - i)) & 1) b[(at + i) >> 3]! |= mask;
        else b[(at + i) >> 3]! &= ~mask;
    }
}

export function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** MPEG-2 mono side info, in bits from the frame's start: main_data_begin
 *  (8) at 32, then the granule: part2_3_length (12) at 41, big_values (9) at
 *  53, global_gain (8) at 62. */
export const MDB = 32;
export const P23 = 41;
export const BV = 53;
export const GAIN = 62;

/** One 24 ms frame as Azure sends them (24 kHz, 96 kbps, 288 bytes), its
 *  reservoir pointer and main data length set as a real one's are. */
export function frame(gain: number, { crc = false, kbps32 = false } = {}): Uint8Array {
    const f = new Uint8Array(kbps32 ? 96 : 288).fill(0xa5);
    f.set([0xff, crc ? 0xf2 : 0xf3, kbps32 ? 0x44 : 0xa4, 0xc4]);
    const shift = crc ? 16 : 0;
    setBits(f, MDB + shift, 8, 200);
    setBits(f, P23 + shift, 12, 2100);
    setBits(f, BV + shift, 9, 270);
    setBits(f, GAIN + shift, 8, gain);
    return f;
}

/** `n` frames at `gain`. */
export const run = (n: number, gain: number) => concat(...Array.from({ length: n }, () => frame(gain)));

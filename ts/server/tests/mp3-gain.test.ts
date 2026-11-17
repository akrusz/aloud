import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AZURE_LEAD_SILENCE_MP3, withLeadSilence } from '../src/providers/mp3-lead-silence.js';
import { MP3_GAIN_STEP_DB, withGain } from '../src/providers/mp3-gain.js';
import { CURATED_VOICES, resolveVoice } from '../src/providers/voice-catalog.js';
import { billedCharsFor, synthFor } from '../src/routes/tts.js';

function get8(b: Uint8Array, bit: number): number {
    const at = bit >> 3;
    return (((b[at]! << 8) | b[at + 1]!) >> (8 - (bit & 7))) & 0xff;
}

function set8(b: Uint8Array, bit: number, value: number): void {
    const at = bit >> 3;
    const shift = 8 - (bit & 7);
    const word = (((b[at]! << 8) | b[at + 1]!) & ~(0xff << shift)) | (value << shift);
    b[at] = (word >> 8) & 0xff;
    b[at + 1] = word & 0xff;
}

function concat(...parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        out.set(p, at);
        at += p.length;
    }
    return out;
}

/** Bit of the global_gain in an MPEG-2 mono frame: 32 header bits, 8 of
 *  main_data_begin, 1 private, then 21 into the granule. */
const LSF_GAIN_BIT = 32 + 8 + 1 + 21;

/** An MPEG-2 Layer III mono frame as Azure sends them (24 kHz, 96 kbps, so
 *  288 bytes), filled with a pattern past the header so a stray write shows. */
function lsfFrame(gain: number, { crc = false } = {}): Uint8Array {
    const f = new Uint8Array(288).fill(0xa5);
    f.set([0xff, crc ? 0xf2 : 0xf3, 0xa4, 0xc4]);
    set8(f, LSF_GAIN_BIT + (crc ? 16 : 0), gain);
    return f;
}

describe('withGain', () => {
    it('moves every granule up a step per 1.5 dB and touches nothing else', () => {
        const input = concat(lsfFrame(140), lsfFrame(170), lsfFrame(0));
        const out = withGain(input, 3);
        expect([0, 288, 576].map((at) => get8(out, at * 8 + LSF_GAIN_BIT))).toEqual([142, 172, 2]);
        const restored = out.slice();
        [140, 170, 0].forEach((g, k) => set8(restored, k * 288 * 8 + LSF_GAIN_BIT, g));
        expect(restored).toEqual(input);
        // A new array: the provider's bytes are left as they came.
        expect(get8(input, LSF_GAIN_BIT)).toBe(140);
    });

    it('finds both granules of both channels in an MPEG-1 stereo frame', () => {
        // 44.1 kHz, 128 kbps, no CRC: 417 bytes. Side info: 9 bits of
        // main_data_begin, 3 private, 8 of scfsi, then 59-bit granule blocks.
        const frame = new Uint8Array(417).fill(0x5a);
        frame.set([0xff, 0xfb, 0x90, 0x00]);
        const bits = [0, 1, 2, 3].map((k) => 32 + 20 + 21 + k * 59);
        bits.forEach((bit, k) => set8(frame, bit, 100 + k));
        const out = withGain(frame, -4.5);
        expect(bits.map((bit) => get8(out, bit))).toEqual([97, 98, 99, 100]);
    });

    it('rounds to whole steps and stays inside the field', () => {
        const input = concat(lsfFrame(254), lsfFrame(1));
        expect(withGain(input, 0.7)).toBe(input);
        expect(get8(withGain(input, 2), LSF_GAIN_BIT)).toBe(255);
        const loud = withGain(input, 6);
        expect([get8(loud, LSF_GAIN_BIT), get8(loud, 288 * 8 + LSF_GAIN_BIT)]).toEqual([255, 5]);
        expect(get8(withGain(input, -6), 288 * 8 + LSF_GAIN_BIT)).toBe(0);
    });

    it('steps over ID3 tags at either end', () => {
        const id3v2 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
        const id3v1 = new Uint8Array(128);
        id3v1.set([0x54, 0x41, 0x47]);
        const out = withGain(concat(id3v2, lsfFrame(150), id3v1), 1.5);
        expect(get8(out, id3v2.length * 8 + LSF_GAIN_BIT)).toBe(151);
        expect(out.slice(0, id3v2.length)).toEqual(id3v2);
    });

    it('leaves a stream it cannot walk end to end untouched, all of it', () => {
        const crc = concat(lsfFrame(150), lsfFrame(150, { crc: true }));
        expect(withGain(crc, 3)).toBe(crc);
        const junk = concat(lsfFrame(150), new Uint8Array([1, 2, 3]));
        expect(withGain(junk, 3)).toBe(junk);
        const cut = concat(lsfFrame(150), lsfFrame(150).slice(0, 100));
        expect(withGain(cut, 3)).toBe(cut);
        const notMp3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]);
        expect(withGain(notMp3, 3)).toBe(notMp3);
    });

    it('walks the real lead-silence frames, so a padded clip takes the trim', () => {
        const padded = withLeadSilence(lsfFrame(150));
        const out = withGain(padded, 3);
        expect(out).not.toBe(padded);
        expect(get8(out, AZURE_LEAD_SILENCE_MP3.length * 8 + LSF_GAIN_BIT)).toBe(152);
    });
});

describe('CuratedVoice.gainDb', () => {
    it('sits on a whole step for every voice that has one', () => {
        for (const v of CURATED_VOICES.filter((c) => c.gainDb !== undefined)) {
            expect(Math.abs(v.gainDb! / MP3_GAIN_STEP_DB) % 1, v.name).toBe(0);
        }
    });

    describe('in the synthesis sessions and setup clips share', () => {
        const realFetch = globalThis.fetch;
        let ssml: string[] = [];
        beforeEach(() => {
            ssml = [];
            globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
                ssml.push(String(init?.body));
                return new Response(concat(lsfFrame(150), lsfFrame(160)), { status: 200 });
            }) as typeof fetch;
        });
        afterEach(() => {
            globalThis.fetch = realFetch;
        });

        it("lifts Ethan's audio and leaves his SSML, and so his bill, as Harper's", async () => {
            const config = loadConfig({ AZURE_SPEECH_KEY: 'az-key' });
            const ethan = resolveVoice('Ethan');
            expect(ethan.gainDb).toBe(3);
            const harper = resolveVoice('Harper');
            expect(harper.gainDb).toBeUndefined();

            const lifted = await synthFor(config, ethan)!('Breathe in.', 1);
            const plain = await synthFor(config, harper)!('Breathe in.', 1);
            const first = AZURE_LEAD_SILENCE_MP3.length * 8 + LSF_GAIN_BIT;
            expect([get8(lifted, first), get8(lifted, first + 288 * 8)]).toEqual([152, 162]);
            expect([get8(plain, first), get8(plain, first + 288 * 8)]).toEqual([150, 160]);

            expect(ssml[0]).not.toContain('<prosody');
            expect(ssml[0]).toContain('<mstts:express-as style="softvoice">');
            expect(billedCharsFor(ethan, 'Breathe in.', 1)).toBe(billedCharsFor(harper, 'Breathe in.', 1));
        });
    });
});

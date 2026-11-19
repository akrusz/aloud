import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { AZURE_LEAD_SILENCE_MP3 } from '../src/providers/mp3-lead-silence.js';
import { withGain } from '../src/providers/mp3-gain.js';
import { LEAD_TRIM, trimLead } from '../src/providers/mp3-lead-trim.js';
import { azureBilledChars } from '../src/providers/tts.js';
import { resolveVoice } from '../src/providers/voice-catalog.js';
import { billedCharsFor, leadExpect, leadFor, synthFor } from '../src/routes/tts.js';

function bits(b: Uint8Array, at: number, n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | ((b[(at + i) >> 3]! >> (7 - ((at + i) & 7))) & 1);
    return v;
}

function setBits(b: Uint8Array, at: number, n: number, value: number): void {
    for (let i = 0; i < n; i++) {
        const mask = 0x80 >> ((at + i) & 7);
        if ((value >> (n - 1 - i)) & 1) b[(at + i) >> 3]! |= mask;
        else b[(at + i) >> 3]! &= ~mask;
    }
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

/** MPEG-2 mono side info, in bits from the frame's start: main_data_begin
 *  (8) at 32, then the granule: part2_3_length (12) at 41, big_values (9) at
 *  53, global_gain (8) at 62. */
const MDB = 32;
const P23 = 41;
const BV = 53;
const GAIN = 62;

/** One 24 ms frame as Azure sends them (24 kHz, 96 kbps, 288 bytes), its
 *  reservoir pointer and main data length set as a real one's are. */
function frame(gain: number, { crc = false, kbps32 = false } = {}): Uint8Array {
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
const run = (n: number, gain: number) => concat(...Array.from({ length: n }, () => frame(gain)));

const LEAD = 150;
const QUIET = 120;
const SPEECH = 160;
/** "Okay." (0.36 s), the gap (0.72 s), the sentence (0.48 s). */
const LED = concat(run(15, LEAD), run(30, QUIET), run(20, SPEECH));
const KEEP = Math.round(LEAD_TRIM.keepS / 0.024);

describe('trimLead', () => {
    it('cuts on a frame boundary just ahead of the sentence and empties the first kept frame', () => {
        const out = trimLead(LED)!;
        const cut = 45 - KEEP;
        expect(out.length).toBe((65 - cut) * 288);
        // The first kept frame needs nothing from the bytes cut away.
        expect([bits(out, MDB, 8), bits(out, P23, 12), bits(out, BV, 9), bits(out, GAIN, 8)]).toEqual([0, 0, 0, 0]);
        out.set(LED.subarray(cut * 288, cut * 288 + 288).subarray(0, 9), 0);
        expect(out).toEqual(LED.subarray(cut * 288));
        // The provider's bytes are left as they came.
        expect(bits(LED, cut * 288 * 8 + GAIN, 8)).toBe(QUIET);
    });

    it('empties every kept frame whose main data reaches back past the cut', () => {
        // At 32 kbps a frame carries 83 bytes of main data, so a pointer 200
        // bytes back reaches into the third frame before.
        const small = (n: number, gain: number) => concat(...Array.from({ length: n }, () => frame(gain, { kbps32: true })));
        const out = trimLead(concat(small(15, LEAD), small(30, QUIET), small(20, SPEECH)))!;
        expect(out.length).toBe((65 - (45 - KEEP)) * 96);
        expect([0, 1, 2, 3].map((k) => bits(out, k * 96 * 8 + MDB, 8))).toEqual([0, 0, 0, 200]);
        expect([0, 1, 2, 3].map((k) => bits(out, k * 96 * 8 + P23, 12))).toEqual([0, 0, 0, 2100]);
    });

    it('does not take a lone loud frame in the gap for the sentence', () => {
        // Either half of the gap alone is under minGapS.
        const blip = concat(run(15, LEAD), run(12, QUIET), frame(SPEECH), run(12, QUIET), run(20, SPEECH));
        expect(trimLead(blip)!.length).toBe((60 - (40 - KEEP)) * 288);
    });

    it('declines a sentence that is not what the caller expects', () => {
        const twice = concat(run(15, LEAD), run(30, QUIET), run(17, LEAD), run(30, QUIET), run(20, SPEECH));
        expect(trimLead(twice)!.length).toBe((112 - (45 - KEEP)) * 288);
        expect(trimLead(twice, 'one-burst')).toBeNull();
        expect(trimLead(twice, { shortOpenings: 0 })).toBeNull();
        // One mark early in the text allows one short burst, not two.
        expect(trimLead(twice, { shortOpenings: 1 })).toEqual(trimLead(twice));
        expect(trimLead(LED, 'one-burst')).toEqual(trimLead(LED));
        // An opening burst longer than a lead, then a pause: a sentence.
        const clause = concat(run(15, LEAD), run(30, QUIET), run(45, SPEECH), run(30, QUIET), run(20, SPEECH));
        expect(trimLead(clause, { shortOpenings: 0 })).toEqual(trimLead(clause));
        expect(trimLead(clause, 'one-burst')).toBeNull();
        // "Yes, [pause] I hear you" said behind a doubled lead: two short bursts.
        const yes = concat(run(15, LEAD), run(30, QUIET), run(15, LEAD), run(30, QUIET), run(12, SPEECH), run(20, QUIET), run(45, SPEECH));
        expect(trimLead(yes, { shortOpenings: 1 })).toBeNull();
    });

    it('treats a short dip inside the lead as part of it', () => {
        const dipped = concat(run(6, LEAD), run(4, QUIET), run(6, LEAD), run(30, QUIET), run(20, SPEECH));
        expect(trimLead(dipped)!.length).toBe((66 - (46 - KEEP)) * 288);
    });

    it('declines without a gap long enough, early enough, behind a short lead', () => {
        // No gap at all.
        expect(trimLead(run(60, SPEECH))).toBeNull();
        // A gap under minGapS (0.29 s).
        expect(trimLead(concat(run(15, LEAD), run(12, QUIET), run(20, SPEECH)))).toBeNull();
        // A first burst too long to be the lead alone (1.08 s).
        expect(trimLead(concat(run(45, LEAD), run(30, QUIET), run(20, SPEECH)))).toBeNull();
        // A gap that starts after gapWithinS.
        expect(trimLead(concat(run(40, QUIET), run(30, LEAD), run(30, QUIET), run(20, SPEECH)))).toBeNull();
        // Nothing after the gap.
        expect(trimLead(concat(run(15, LEAD), run(40, QUIET)))).toBeNull();
    });

    it('declines a stream it cannot walk: CRC frames, junk, not MP3', () => {
        expect(trimLead(concat(LED, frame(SPEECH, { crc: true })))).toBeNull();
        expect(trimLead(concat(LED, new Uint8Array([1, 2, 3])))).toBeNull();
        expect(trimLead(new Uint8Array([0x49, 0x44, 0x33, 0x04]))).toBeNull();
    });

    it('drops an ID3v2 tag and a Xing/Info frame ahead of the cut and keeps an ID3v1 tail', () => {
        const id3v2 = new Uint8Array([0x49, 0x44, 0x33, 4, 0, 0, 0, 0, 0, 5, 1, 2, 3, 4, 5]);
        const info = frame(0);
        info.set([0x49, 0x6e, 0x66, 0x6f], 4 + 9);
        const id3v1 = new Uint8Array(128);
        id3v1.set([0x54, 0x41, 0x47]);
        const out = trimLead(concat(id3v2, info, LED, id3v1))!;
        expect(out.length).toBe((65 - (45 - KEEP)) * 288 + 128);
        expect(out.subarray(out.length - 128)).toEqual(id3v1);
        expect([out[0], out[1]]).toEqual([0xff, 0xf3]);
    });
});

describe('leadFor', () => {
    const harper = resolveVoice('Harper');

    it('leads a consonant-initial opening, digits and "one" included', () => {
        for (const text of ['Back to Exploration.', 'that can’t change.', '“Timer set.”', '5 minutes left.', 'One more breath.', 'Once more.', 'Use the breath.'])
            expect(leadFor(harper, text), text).toBe('Okay.');
    });

    it('leaves a vowel-initial opening, Chinese text, and every other voice alone', () => {
        for (const text of ['And let that be.', 'Every breath.', 'I hear you.', 'Okay, noting mode.', '...Open your hands.', '吸气，呼气。'])
            expect(leadFor(harper, text), text).toBeNull();
        expect(leadFor(resolveVoice('Ethan'), 'Back to Exploration.')).toBeNull();
        expect(leadFor(resolveVoice('Leda'), 'Back to Exploration.')).toBeNull();
    });

    it('expects one burst of a short input, and a short opening burst per short opening phrase', () => {
        expect(leadExpect("That's good.")).toBe('one-burst');
        expect(leadExpect('Yes, I hear that there is some tension.')).toEqual({ shortOpenings: 1 });
        expect(leadExpect('Yes, yes, I hear that there is some tension.')).toEqual({ shortOpenings: 2 });
        expect(leadExpect('So \u2014 where were we, before the timer?')).toEqual({ shortOpenings: 2 });
        expect(leadExpect("That makes sense. What's the tightness like right now?")).toEqual({ shortOpenings: 1 });
        expect(leadExpect('Take your time. Let it move on its own.')).toEqual({ shortOpenings: 1 });
        expect(leadExpect('Does it feel firm, soft, or somewhere in between?')).toEqual({ shortOpenings: 2 });
        expect(leadExpect('Back to Exploration, which is the best place to start.')).toEqual({ shortOpenings: 1 });
        // A first phrase too long to come back under maxLeadS, and one with nothing after it.
        expect(leadExpect('Where do you feel the clenching most? Stay with that spot.')).toEqual({ shortOpenings: 0 });
        expect(leadExpect('Notice where the breath is easiest to feel.')).toEqual({ shortOpenings: 0 });
    });

    describe('takes behind a short opening phrase (Harper, raw takes of 2026-11-19)', () => {
        /** Frames for [gain, seconds] spans, at Azure's 24 ms a frame. */
        const shape = (...spans: [number, number][]) => concat(...spans.map(([gain, s]) => run(Math.round(s / 0.024), gain)));
        const takeYourTime = 'Take your time. Let it move on its own.';
        const cutBefore = (mp3: Uint8Array, frames: number) => mp3.length - (frames - KEEP) * 288;

        it('keeps a good take whose short first sentence came back under maxLeadS, cut at that sentence', () => {
            // "Okay. | Take your time. | Let it move on its own." (raw/C2-t1)
            const good = shape([LEAD, 0.55], [QUIET, 0.79], [SPEECH, 0.98], [QUIET, 0.91], [SPEECH, 2.04]);
            expect(trimLead(good, leadExpect(takeYourTime))!.length).toBe(cutBefore(good, 23 + 33));
            // "Okay. | That makes sense. | What's the tightness..." (raw/C1-t4)
            const sense = shape([LEAD, 0.43], [QUIET, 1.61], [SPEECH, 0.72], [QUIET, 1.32], [SPEECH, 2.4]);
            expect(trimLead(sense, leadExpect("That makes sense. What's the tightness like right now?"))!.length).toBe(cutBefore(sense, 18 + 67));
        });

        it('still declines the lead said twice, a stall past the opening phrase, and a lead run into the text', () => {
            const twice = shape([LEAD, 0.55], [QUIET, 0.79], [LEAD, 0.55], [QUIET, 0.79], [SPEECH, 0.98], [QUIET, 0.91], [SPEECH, 2.04]);
            expect(trimLead(twice, leadExpect(takeYourTime))).toBeNull();
            // "Take your time. | Let it | move on its own." (raw/C2-t3)
            const stall = shape([LEAD, 0.53], [QUIET, 0.7], [SPEECH, 0.82], [QUIET, 0.84], [SPEECH, 0.65], [QUIET, 0.48], [SPEECH, 2.23]);
            expect(trimLead(stall, leadExpect(takeYourTime))).toBeNull();
            const runIn = shape([LEAD, 0.55], [SPEECH, 0.98], [QUIET, 0.91], [SPEECH, 2.04]);
            expect(trimLead(runIn, leadExpect(takeYourTime))).toBeNull();
        });
    });

    it('is what Azure bills, lead included', () => {
        expect(billedCharsFor(harper, 'Back to Exploration.', 1)).toBe(azureBilledChars('Okay. Back to Exploration.', 1, 'softvoice'));
        expect(billedCharsFor(harper, 'And so.', 1)).toBe(azureBilledChars('And so.', 1, 'softvoice'));
    });
});

describe('synthFor with a lead (Harper)', () => {
    const realFetch = globalThis.fetch;
    let ssml: string[] = [];
    let replies: Uint8Array[] = [];
    beforeEach(() => {
        ssml = [];
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            ssml.push(String(init?.body));
            return new Response(replies.shift()!, { status: 200 });
        }) as typeof fetch;
    });
    afterEach(() => {
        globalThis.fetch = realFetch;
    });

    const config = loadConfig({ AZURE_SPEECH_KEY: 'az-key' });
    const harper = resolveVoice('Harper');

    it('speaks the lead inside the style, cuts it off, and skips the lead-silence pad', async () => {
        replies = [LED];
        const extra: number[] = [];
        const out = await synthFor(config, harper)!('Back to Exploration.', 1, (c) => extra.push(c));
        expect(ssml).toHaveLength(1);
        expect(ssml[0]).toContain('<mstts:express-as style="softvoice">Okay. Back to Exploration.</mstts:express-as>');
        expect(out).toEqual(withGain(trimLead(LED)!, harper.gainDb!));
        expect(extra).toEqual([]);
    });

    it('says the text again without the lead when two takes have no gap, and reports those calls’ bills', async () => {
        const plain = run(20, SPEECH);
        replies = [run(60, SPEECH), run(60, SPEECH), plain];
        const extra: number[] = [];
        const text = 'Back to Exploration, which is the best place to start.';
        const out = await synthFor(config, harper)!(text, 1, (c) => extra.push(c));
        expect(ssml).toHaveLength(3);
        expect(ssml[2]).toContain(`<mstts:express-as style="softvoice">${text}</mstts:express-as>`);
        expect(extra).toEqual([azureBilledChars(`Okay. ${text}`, 1, 'softvoice'), azureBilledChars(text, 1, 'softvoice')]);
        expect(out).toEqual(withGain(concat(AZURE_LEAD_SILENCE_MP3, plain), harper.gainDb!));
    });

    it('rolls a short input again when it comes back as two bursts, and bills the second call', async () => {
        const twice = concat(run(15, LEAD), run(30, QUIET), run(17, LEAD), run(30, QUIET), run(20, SPEECH));
        replies = [twice, LED];
        const extra: number[] = [];
        const out = await synthFor(config, harper)!("That's good.", 1, (c) => extra.push(c));
        expect(ssml).toHaveLength(2);
        expect(ssml[1]).toBe(ssml[0]);
        expect(extra).toEqual([azureBilledChars("Okay. That's good.", 1, 'softvoice')]);
        expect(out).toEqual(withGain(trimLead(LED)!, harper.gainDb!));
    });

    it('speaks without the lead when the second take is not as expected either', async () => {
        const twice = concat(run(15, LEAD), run(30, QUIET), run(17, LEAD), run(30, QUIET), run(20, SPEECH));
        const plain = run(20, SPEECH);
        replies = [twice, twice, plain];
        const extra: number[] = [];
        const out = await synthFor(config, harper)!("That's good.", 1, (c) => extra.push(c));
        expect(ssml).toHaveLength(3);
        expect(ssml[2]).toContain("softvoice\">That's good.</mstts");
        expect(extra).toEqual([azureBilledChars("Okay. That's good.", 1, 'softvoice'), azureBilledChars("That's good.", 1, 'softvoice')]);
        expect(out).toEqual(withGain(concat(AZURE_LEAD_SILENCE_MP3, plain), harper.gainDb!));
    });

    it('sends a vowel-initial input as it is', async () => {
        const plain = run(20, SPEECH);
        replies = [plain];
        await synthFor(config, harper)!('Every breath.', 1);
        expect(ssml).toHaveLength(1);
        expect(ssml[0]).toContain('softvoice">Every breath.</mstts');
    });
});

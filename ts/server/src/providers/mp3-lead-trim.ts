/**
 * A spoken lead cut off the front of an MP3 synthesis, without decoding it.
 *
 * Harper's softvoice swallows a consonant-initial opening word on most takes
 * ("Back to Exploration" heard as "to exploration" in 6 of 7), never a
 * vowel-initial one, and never the sentence behind a short lead: sent as
 * "Okay. Back to Exploration...", the "Back" was heard 24 of 24 and "Okay"
 * came back as its own burst, then a pause of 0.48s or more (103 takes,
 * 2026-11-16). So the route speaks the lead and this cuts it off again.
 *
 * Azure's MP3 is constant bitrate and spends its whole budget on every frame,
 * silence included, so part2_3_length says nothing about level. global_gain
 * does: the encoder picks the quantizer step that fits the budget, and it
 * tracks the frame's level at about 1.7 dB a step (speech 140-171, digital
 * silence 117-125, a breath 124-132). A frame at or over `voicedGain` is
 * speech.
 *
 * The cut lands on a frame boundary in the silence, `keepS` before the
 * sentence. A kept frame's main data may begin in the bytes cut away (the bit
 * reservoir: main_data_begin points back into earlier frames), so each such
 * frame, on Azure's 96 kbps stream only ever the first, is rewritten as an
 * empty one: no reservoir, no main data. It decodes to silence, which it was
 * anyway.
 */

import { mp3Frames, readByteAt, type Mp3Frame } from './mp3-gain.js';

export const LEAD_TRIM: {
    voicedGain: number;
    minSpeechS: number;
    minGapS: number;
    gapWithinS: number;
    maxLeadS: number;
    keepS: number;
} = {
    /** A frame whose largest global_gain reaches this is loud enough... */
    voicedGain: 140,
    /** ...and a run of such frames this long is speech. A lone loud frame
     *  turns up in silence now and then (27 in 103 takes, one at -89 dB). */
    minSpeechS: 0.06,
    /** The silence after the lead must last at least this long (0.48s was
     *  the shortest in 103 takes, the next 0.60s)... */
    minGapS: 0.35,
    /** ...and begin within this much of the start. */
    gapWithinS: 1.5,
    /** A first burst longer than this is not the lead alone: "Okay." ran
     *  0.31-0.82s over 103 takes, so a longer one means the lead and the
     *  sentence ran together (or the lead was lost) and a cut could take the
     *  sentence's opening. */
    maxLeadS: 1.0,
    /** Kept ahead of the sentence's first sound, which is often a faint
     *  inhale: the voice proper then starts 0.17-0.24s in (103 takes), about
     *  the margin mp3-lead-silence.ts gives a phone's output track, so this
     *  clip does without that pad. */
    keepS: 0.15,
};

function readBits(b: Uint8Array, bit: number, width: number): number {
    let v = 0;
    for (let k = 0; k < width; k++) v = (v << 1) | ((b[(bit + k) >> 3]! >> (7 - ((bit + k) & 7))) & 1);
    return v;
}

function writeBits(b: Uint8Array, bit: number, width: number, value: number): void {
    for (let k = 0; k < width; k++) {
        const at = bit + k;
        const mask = 0x80 >> (at & 7);
        if ((value >> (width - 1 - k)) & 1) b[at >> 3]! |= mask;
        else b[at >> 3]! &= ~mask;
    }
}

function frameGain(mp3: Uint8Array, f: Mp3Frame): number {
    return Math.max(...f.gainBits.map((bit) => readByteAt(mp3, f.offset * 8 + bit)));
}

/** Speech in `voiced` as [start, end) frame spans, joined across dips
 *  shorter than `minGap` frames. */
function groups(voiced: readonly boolean[], minGap: number): [number, number][] {
    const out: [number, number][] = [];
    for (let k = 0; k < voiced.length; k++) {
        if (!voiced[k]) continue;
        const startK = k;
        while (k + 1 < voiced.length && voiced[k + 1]) k++;
        const last = out[out.length - 1];
        if (last && startK - last[1] < minGap) last[1] = k + 1;
        else out.push([startK, k + 1]);
    }
    return out;
}

/** What the sentence behind the lead should look like, when the caller
 *  knows: one burst (a short input), or an opening burst longer than a lead
 *  (text with no mark in its first words, which gives a pause no reason to
 *  fall there). A take that doesn't is the lead said twice, or the voice
 *  stalling on its first word, and is better synthesized again. */
export type LeadExpect = 'one-burst' | 'long-opening';

/** Where the sentence's first sound starts behind the lead, as a frame
 *  index into the audio frames, or null when the gap is not there or the
 *  sentence is not what `expect` says. */
export function sentenceStart(mp3: Uint8Array, frames: readonly Mp3Frame[], expect?: LeadExpect): number | null {
    const s = frames[0]!.samples / frames[0]!.sampleRate;
    const loud = frames.map((f) => frameGain(mp3, f) >= LEAD_TRIM.voicedGain);
    const minRun = Math.ceil(LEAD_TRIM.minSpeechS / s);
    const voiced = loud.map(() => false);
    for (let k = 0; k < loud.length; ) {
        let end = k;
        while (end < loud.length && loud[end]) end++;
        if (end - k >= minRun) voiced.fill(true, k, end);
        k = Math.max(end, k + 1);
    }
    const speech = groups(voiced, Math.ceil(LEAD_TRIM.minGapS / s));
    const length = ([a, b]: [number, number]) => (b - a) * s;
    const lead = speech[0];
    if (!lead || speech.length < 2 || length(lead) > LEAD_TRIM.maxLeadS || lead[1] * s > LEAD_TRIM.gapWithinS) return null;
    if (expect === 'one-burst' && speech.length > 2) return null;
    if (expect === 'long-opening' && speech.length > 2 && length(speech[1]!) <= LEAD_TRIM.maxLeadS) return null;
    const [sentence] = speech[1]!;
    // Back to the first loud frame of the sentence's approach (an inhale
    // often rises through a frame or two before the speech run).
    let onset = sentence;
    for (let j = sentence - 1, quiet = 0; j >= lead[1] && quiet <= 3; j--) {
        if (loud[j]) {
            onset = j;
            quiet = 0;
        } else quiet++;
    }
    return onset;
}

/**
 * `mp3` from just before the sentence that follows its spoken lead, or null
 * when no silence of minGapS starts within gapWithinS behind a lead no
 * longer than maxLeadS: then the caller has to do without the cut. Also null
 * for a stream mp3Frames can't walk, or a sentence that is not what `expect`
 * says. A new array.
 */
export function trimLead(mp3: Uint8Array, expect?: LeadExpect): Uint8Array | null {
    const all = mp3Frames(mp3);
    if (!all) return null;
    const frames = all.filter((f) => f.gainBits.length);
    if (frames.length < 2) return null;
    const start = sentenceStart(mp3, frames, expect);
    if (start === null) return null;
    const keep = Math.round(LEAD_TRIM.keepS / (frames[0]!.samples / frames[0]!.sampleRate));
    const first = Math.max(1, start - keep);
    const base = frames[first]!.offset;
    const out = mp3.slice(base);
    // Main data bytes kept ahead of each frame, against how far back it reaches.
    let kept = 0;
    for (const f of frames.slice(first)) {
        const at = (f.offset - base) * 8;
        if (readBits(out, at + f.mainDataBit, f.mainDataWidth) > kept) {
            writeBits(out, at + f.mainDataBit, f.mainDataWidth, 0);
            for (const bit of f.gainBits) {
                const block = at + bit - 21;
                writeBits(out, block, 12, 0); // part2_3_length
                writeBits(out, block + 12, 9, 0); // big_values
                writeBits(out, block + 21, 8, 0); // global_gain
            }
        }
        kept += f.length - f.mainDataStart;
    }
    return out;
}

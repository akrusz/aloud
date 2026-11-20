/**
 * Where each sentence of a multi-sentence synthesis begins in its MP3, found
 * without decoding it, so a client that plays a whole reply as one clip can
 * tell which sentences were heard when it is cut off (ui streaming-tts.ts,
 * CloudVoice.wholeReply).
 *
 * The level comes from each frame's global_gain, as in mp3-lead-trim.ts:
 * speech is a run of frames at or over its voicedGain, and a pause is the
 * silence between two runs. Softvoice pauses longest at a sentence end, but
 * not always (a second inside a clause, a quarter of a second at a full
 * stop), and its pace drifts along a reply, so neither the longest pauses nor
 * the share of the text alone find the sentence ends. Of the pauses, the ones
 * picked are as many as the text has sentence ends, in time order, that best
 * fit them: each scored by its length less `distanceCostS` for how far it
 * sits, as a share of the speech, from its sentence end as a share of the
 * spoken characters (the repeat probe's sentenceEnds, on PCM).
 *
 * Measured with the probe's `marks` step against the sentence ends local
 * Whisper confirmed in 226 whole-reply takes (2026-11-19, 337 of the client's
 * chunk starts): within 0.25s of the sentence's first sound on 95% of
 * Harper's and 98% of Ethan's, the rest a pause or more out, so a cut at a
 * random moment keeps or drops the wrong chunk about 2% (Harper) and 1%
 * (Ethan) of the time. Shares of the characters alone: 8% and 13%.
 */

import { MP3_GAIN_STEP_DB, mp3Frames, readByteAt, type Mp3Frame } from './mp3-gain.js';
import { LEAD_TRIM } from './mp3-lead-trim.js';

/** Settings, mutable so the repeat probe can try others. */
export const SENTENCE_MARKS: { voicedGain: number; minPauseS: number; distanceCostS: number; leadS: number } = {
    /** A frame whose largest global_gain reaches this is speech (before the
     *  voice's gainDb). */
    voicedGain: LEAD_TRIM.voicedGain,
    /** Silences shorter than this are articulation, not pauses (the probe's
     *  voice-clips/cadence.ts MIN_PAUSE_S). */
    minPauseS: 0.2,
    /** A pause a whole reply away from its sentence end costs this many
     *  seconds of pause; a tenth of the reply away, 0.3s. 2 and 5 did a
     *  little worse on the same takes. */
    distanceCostS: 3,
    /** A sentence counts from this far ahead of its first sound: about where
     *  a clip of its own would begin to play (its head silence; the route
     *  keeps LEAD_TRIM.keepS ahead of a trimmed one). */
    leadS: LEAD_TRIM.keepS,
};

const spoken = /[\p{L}\p{N}]/u;

function spokenCount(s: string): number {
    let n = 0;
    for (const c of s) if (spoken.test(c)) n++;
    return n;
}

/** Where each sentence after the first begins: behind a . ! or ? that
 *  follows a letter and is followed by a space, the client's sentence
 *  boundary (ui streaming-tts.ts splitOffSentences) before it merges short
 *  sentences. */
function sentenceStarts(text: string): number[] {
    const out: number[] = [];
    for (const m of text.matchAll(/[^.!?][.!?]\s+/g)) {
        const at = m.index + m[0].length;
        if (at < text.length) out.push(at);
    }
    return out;
}

function frameGain(mp3: Uint8Array, f: Mp3Frame): number {
    return Math.max(...f.gainBits.map((bit) => readByteAt(mp3, f.offset * 8 + bit)));
}

/**
 * For each of `marks` (character offsets into `text` where a sentence
 * begins, ascending, none at 0), the time in seconds from the start of `mp3`
 * from which that sentence counts as heard, or null when the stream can't be
 * walked, the marks don't fit the text, or there are fewer pauses than
 * marks. `gainDb` is the trim withGain put on the clip, which moved every
 * frame's global_gain with it.
 */
export function sentenceMarkTimes(mp3: Uint8Array, text: string, marks: readonly number[], gainDb = 0): number[] | null {
    if (!marks.length) return [];
    if (marks.some((m, i) => !Number.isInteger(m) || m <= 0 || m >= text.length || (i && m <= marks[i - 1]!))) return null;
    const all = mp3Frames(mp3);
    if (!all) return null;
    // Time is what a decoder plays: every frame but a leading Xing/Info one.
    const starts: number[] = [];
    let t = 0;
    const frames: Mp3Frame[] = [];
    for (const [i, f] of all.entries()) {
        if (!f.gainBits.length && i === 0) continue;
        if (f.gainBits.length) {
            frames.push(f);
            starts.push(t);
        }
        t += f.samples / f.sampleRate;
    }
    if (frames.length < 2) return null;
    const frameS = frames[0]!.samples / frames[0]!.sampleRate;
    const voicedGain = SENTENCE_MARKS.voicedGain + Math.round(gainDb / MP3_GAIN_STEP_DB);
    const loud = frames.map((f) => frameGain(mp3, f) >= voicedGain);
    const minRun = Math.ceil(LEAD_TRIM.minSpeechS / frameS);
    const minGap = Math.ceil(SENTENCE_MARKS.minPauseS / frameS);
    // Speech as [start, end) frame spans: runs of loud frames long enough to
    // be speech, joined across dips shorter than a pause.
    const speech: [number, number][] = [];
    for (let k = 0; k < loud.length; ) {
        let end = k;
        while (end < loud.length && loud[end]) end++;
        if (end - k >= minRun) {
            const last = speech[speech.length - 1];
            if (last && k - last[1] < minGap) last[1] = end;
            else speech.push([k, end]);
        }
        k = Math.max(end, k + 1);
    }
    const total = speech.reduce((s, [a, b]) => s + (b - a), 0);
    if (speech.length < 2 || !total) return null;
    let before = 0;
    const pauses = speech.slice(1).map(([next], i) => {
        before += speech[i]![1] - speech[i]![0];
        return { from: speech[i]![1], to: next, at: before / total };
    });
    const chars = spokenCount(text);
    if (!chars) return null;
    // Every sentence end in the text is fitted, not only the marks asked
    // about: a mark that may take any pause takes a longer one a sentence
    // away ("Take your time." gets its own pause whether or not the client
    // sent it alone).
    const fitted = [...new Set([...sentenceStarts(text), ...marks])].sort((a, b) => a - b);
    const want = fitted.map((m) => spokenCount(text.slice(0, m)) / chars);
    const m = want.length;
    const c = pauses.length;
    if (c < m) return null;
    const score = (i: number, j: number) =>
        (pauses[j]!.to - pauses[j]!.from) * frameS - SENTENCE_MARKS.distanceCostS * Math.abs(pauses[j]!.at - want[i]!);
    // best[i][j]: the best fit of the first i marks to the first j pauses.
    const best = Array.from({ length: m + 1 }, (_, i) => Array<number>(c + 1).fill(i ? -Infinity : 0));
    for (let i = 1; i <= m; i++) {
        for (let j = i; j <= c; j++) best[i]![j] = Math.max(best[i]![j - 1]!, best[i - 1]![j - 1]! + score(i - 1, j - 1));
    }
    const picks: number[] = [];
    for (let i = m, j = c; i > 0; ) {
        if (j > i && best[i]![j] === best[i]![j - 1]) j--;
        else {
            picks.unshift(j - 1);
            i--;
            j--;
        }
    }
    return marks.map((mark) => {
        const { from, to } = pauses[picks[fitted.indexOf(mark)]!]!;
        // Back to the first loud frame of the sentence's approach (an inhale
        // often rises through a frame or two before the speech run).
        let onset = to;
        for (let j = to - 1, quiet = 0; j >= from && quiet <= 3; j--) {
            if (loud[j]) {
                onset = j;
                quiet = 0;
            } else quiet++;
        }
        const at = Math.max(starts[from]!, starts[onset]! - SENTENCE_MARKS.leadS);
        return Math.round(at * 100) / 100;
    });
}

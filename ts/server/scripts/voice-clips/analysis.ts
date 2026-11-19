/**
 * The quality gate for rendered setup clips (render-voice-clips.ts): measures
 * decoded mono PCM for the two provider faults Azure's softvoice voices show,
 * so a bad render is re-rolled without anyone listening to every clip.
 *
 * - A short input voiced TWICE: two bursts of speech with a ~1.5s gap. Counted
 *   as bursts split by a long stretch below the floor, against the number of
 *   phrases in the text, since a comma can pause past minGapMs as well as a
 *   sentence end: two of three Harper renders of "Okay, noting mode." held a
 *   0.75-1.05s gap while running only 0.4-0.9s longer than the one-burst
 *   render, which fits a pause, not a repeat (2026-11-14, unheard). That
 *   leaves a repeat of a line with a comma to the backstop, a duration check
 *   against the voice's own seconds-per-character norm across its set (a
 *   repeat runs over twice the line's length). Only on a short line
 *   (burstCheckMaxWords), where the fault happens: a long one pauses past
 *   minGapMs inside its clauses on most takes and is said once (heard by
 *   Whisper, 2026-11-16), so the norm and the script's transcript check
 *   judge it.
 * - A first word that starts MID-PHONEME: the voiced part jumps from silence
 *   to full level with no rise. Measured as the time from the floor to
 *   ONSET_TOP_DB in 2ms windows; a cut onset reads 0ms, a clean one 16-80ms
 *   (earlier measurement on these voices). The lead silence the route
 *   prepends is digital silence, so the first window over the floor is the
 *   voice itself.
 *
 * Levels are RMS in dBFS against full scale 1.0 (a full-scale sine is -3).
 * Pure: decoding lives in the script.
 */

export const GATE = {
    /** Below this a window is silence. */
    floorDb: -40,
    /** The onset rise is measured from the floor up to this level. */
    onsetTopDb: -20,
    burstWindowMs: 10,
    onsetWindowMs: 2,
    /** A stretch below the floor at least this long splits two bursts. */
    minGapMs: 600,
    /** A burst shorter than this (a click, a breath tail) is not speech. */
    minBurstMs: 60,
    /** Rise times under this are a cut onset. */
    minRiseMs: 6,
    /** How far past the burst start the onset may take to reach the top level
     *  before it counts as a soft onset (not measured) rather than a cut one. */
    onsetSearchMs: 500,
    /** A clip whose voiced span runs past this multiple of its voice's norm is
     *  flagged as a probable repeat. */
    longRatio: 1.75,
    /** Fewer clips than this in a voice's set and the norm is not trusted. */
    minNormClips: 8,
    /** Bursts are counted against phrases only on a line of at most this
     *  many words: softvoice voices a two-word input twice about a third of
     *  the time and an eight-word one never (ui streaming-tts.ts
     *  MIN_TTS_SENTENCE_CHARS). */
    burstCheckMaxWords: 12,
} as const;

export interface Burst {
    startS: number;
    endS: number;
}

export interface ClipAnalysis {
    durationS: number;
    bursts: Burst[];
    /** Silences between consecutive bursts, seconds. */
    gapsS: number[];
    /** First burst start to last burst end; 0 for a silent clip. */
    voicedS: number;
    /** Floor-to-top rise of the first burst in ms; null when it never reached
     *  the top level within onsetSearchMs (a soft onset) or there is no voice. */
    onsetRiseMs: number | null;
}

/** RMS level of each `windowMs` window of `samples`, in dBFS. */
export function windowDb(samples: Float32Array, sampleRate: number, windowMs: number): number[] {
    const size = Math.max(1, Math.round((sampleRate * windowMs) / 1000));
    const out: number[] = [];
    for (let start = 0; start < samples.length; start += size) {
        const end = Math.min(samples.length, start + size);
        let sum = 0;
        for (let i = start; i < end; i++) {
            const s = samples[i]!;
            sum += s * s;
        }
        out.push(20 * Math.log10(Math.sqrt(sum / (end - start)) + 1e-12));
    }
    return out;
}

export function analyzePcm(samples: Float32Array, sampleRate: number): ClipAnalysis {
    const durationS = samples.length / sampleRate;
    const bw = GATE.burstWindowMs / 1000;
    const levels = windowDb(samples, sampleRate, GATE.burstWindowMs);

    // Runs of windows over the floor, merged across any gap shorter than
    // minGapMs, then stripped of runs too short to be speech.
    const runs: Burst[] = [];
    for (let i = 0; i < levels.length; i++) {
        if (levels[i]! < GATE.floorDb) continue;
        const startS = i * bw;
        while (i + 1 < levels.length && levels[i + 1]! >= GATE.floorDb) i++;
        runs.push({ startS, endS: Math.min(durationS, (i + 1) * bw) });
    }
    const merged: Burst[] = [];
    for (const run of runs) {
        const last = merged[merged.length - 1];
        if (last && (run.startS - last.endS) * 1000 < GATE.minGapMs) last.endS = run.endS;
        else merged.push({ ...run });
    }
    const bursts = merged.filter((b) => (b.endS - b.startS) * 1000 >= GATE.minBurstMs);
    const gapsS = bursts.slice(1).map((b, i) => b.startS - bursts[i]!.endS);
    const first = bursts[0];
    const last = bursts[bursts.length - 1];
    const voicedS = first && last ? last.endS - first.startS : 0;

    let onsetRiseMs: number | null = null;
    if (first) {
        const ow = GATE.onsetWindowMs;
        const fine = windowDb(samples, sampleRate, ow);
        // Start a burst window early: the 10ms window that first crossed the
        // floor may have done so in its last few ms, or just after a quieter
        // 2ms slice of the window before it.
        const from = Math.max(0, Math.floor(((first.startS - bw) * 1000) / ow));
        let atFloor = -1;
        for (let i = from; i < fine.length; i++) {
            if (fine[i]! >= GATE.floorDb) {
                atFloor = i;
                break;
            }
        }
        if (atFloor >= 0) {
            const limit = Math.min(fine.length, atFloor + Math.ceil(GATE.onsetSearchMs / ow));
            for (let i = atFloor; i < limit; i++) {
                if (fine[i]! >= GATE.onsetTopDb) {
                    onsetRiseMs = (i - atFloor) * ow;
                    break;
                }
            }
        }
    }

    return { durationS, bursts, gapsS, voicedS, onsetRiseMs };
}

/** Phrases in a line (split at sentence ends, commas, colons and their CJK
 *  forms), each of which may end in a pause as long as the gap that splits
 *  bursts. */
export function phraseCount(text: string): number {
    const parts = text.split(/(?<=[.!?。！？…,，、;；:：])/u).filter((p) => /[\p{L}\p{N}]/u.test(p));
    return Math.max(1, parts.length);
}

/** Words, each CJK character counting as one. */
export function wordCount(text: string): number {
    return text.match(/\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{N}'’])+/gu)?.length ?? 0;
}

/** Letters, digits and CJK characters: what takes time to say. */
export function spokenChars(text: string): number {
    return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
}

/** Seconds of voice per spoken character across a voice's clips (the median,
 *  so a few repeats in the set can't drag it), or null below minNormClips. */
export function secondsPerCharNorm(clips: readonly { voicedS: number; text: string }[]): number | null {
    const rates = clips
        .filter((c) => c.voicedS > 0 && spokenChars(c.text) > 0)
        .map((c) => c.voicedS / spokenChars(c.text))
        .sort((a, b) => a - b);
    if (rates.length < GATE.minNormClips) return null;
    const mid = Math.floor(rates.length / 2);
    return rates.length % 2 ? rates[mid]! : (rates[mid - 1]! + rates[mid]!) / 2;
}

const fmt = (s: number) => `${s.toFixed(2)}s`;

/** What is wrong with a clip, one reason per fault; empty when it passes.
 *  `norm` (secondsPerCharNorm) adds the duration check. */
export function clipFaults(a: ClipAnalysis, text: string, norm?: number | null): string[] {
    if (a.bursts.length === 0) return ['no voice above the floor'];
    const faults: string[] = [];
    const phrases = phraseCount(text);
    if (wordCount(text) <= GATE.burstCheckMaxWords && a.bursts.length > phrases) {
        faults.push(
            `${a.bursts.length} bursts for ${phrases} phrase${phrases === 1 ? '' : 's'} ` +
                `(gaps ${a.gapsS.map(fmt).join(', ')}): probable repeat`
        );
    }
    if (a.onsetRiseMs !== null && a.onsetRiseMs < GATE.minRiseMs) {
        faults.push(`onset rises in ${a.onsetRiseMs}ms: probable cut first word`);
    }
    if (norm) {
        const expected = norm * spokenChars(text);
        if (a.voicedS > expected * GATE.longRatio) {
            faults.push(
                `voiced ${fmt(a.voicedS)} against ${fmt(expected)} expected at this voice's pace: probable repeat`
            );
        }
    }
    return faults;
}

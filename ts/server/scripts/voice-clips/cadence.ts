/**
 * Pauses in a rendered setup clip, shortened to what the text can carry.
 *
 * Azure's softvoice voices pause erratically on a long line, and differently
 * on every take: 2.4s after a comma, a second inside a clause ("a six step
 * [1.1s] process"). Each silence between words is matched to the punctuation
 * it falls at, by where it sits in the speech against where the mark sits in
 * the text, and kept no longer than PAUSE_CAP_S allows for that mark.
 * Shorter pauses are left as they are.
 *
 * Pure, on mono float PCM: decoding and encoding live in the script.
 */

/** The longest a pause is kept, by what it falls at: about what the tour
 *  takes that sound right hold, well under the 2.1s, 2.4s and 1.1s of the
 *  ones that don't (2026-11-16). */
export const PAUSE_CAP_S = { sentence: 1.0, clause: 0.6, word: 0.4 } as const;

export type PauseKind = keyof typeof PAUSE_CAP_S;

const FLOOR_DB = -40;
const WINDOW_S = 0.01;
/** Silences shorter than this are articulation, not pauses. */
const MIN_PAUSE_S = 0.2;
/** How far (as a share of the line) a pause may sit from a mark and still be its pause. */
const MATCH_TOLERANCE = 0.06;
/** Of a kept pause, the share kept after the word before it: word tails
 *  fade slowly below the floor, onsets rise fast. */
const HEAD_SHARE = 0.6;
const CROSSFADE_S = 0.01;

export interface Pause {
    startS: number;
    endS: number;
    kind: PauseKind;
}

const spoken = /[\p{L}\p{N}]/u;

/** Each punctuation mark inside the line, as the share of its spoken
 *  characters that come before it. */
export function pauseMarks(text: string): { at: number; kind: Exclude<PauseKind, 'word'> }[] {
    const chars = [...text];
    const total = chars.filter((c) => spoken.test(c)).length;
    const marks: { at: number; kind: Exclude<PauseKind, 'word'> }[] = [];
    let before = 0;
    for (let i = 0; i < chars.length; i++) {
        const c = chars[i]!;
        if (spoken.test(c)) before++;
        else if (before > 0 && before < total) {
            const kind = /[.!?。！？…]/u.test(c) ? 'sentence' : /[,，、;；:：]/u.test(c) ? 'clause' : null;
            const last = marks[marks.length - 1];
            if (!kind) continue;
            if (last && last.at === before / total) {
                if (kind === 'sentence') last.kind = kind;
            } else marks.push({ at: before / total, kind });
        }
    }
    return marks;
}

/** Spans of speech: 10ms windows over the floor, joined across silences
 *  shorter than MIN_PAUSE_S. */
function speechSpans(samples: Float32Array, rate: number): { startS: number; endS: number }[] {
    const size = Math.max(1, Math.round(rate * WINDOW_S));
    const spans: { startS: number; endS: number }[] = [];
    for (let start = 0, w = 0; start < samples.length; start += size, w++) {
        const end = Math.min(samples.length, start + size);
        let sum = 0;
        for (let i = start; i < end; i++) sum += samples[i]! * samples[i]!;
        if (20 * Math.log10(Math.sqrt(sum / (end - start)) + 1e-12) < FLOOR_DB) continue;
        const startS = w * WINDOW_S;
        const last = spans[spans.length - 1];
        if (last && startS - last.endS < MIN_PAUSE_S) last.endS = startS + WINDOW_S;
        else spans.push({ startS, endS: startS + WINDOW_S });
    }
    return spans;
}

/** The pauses between words in `samples`, each matched to the mark it falls
 *  at, if any: one pause per mark, within MATCH_TOLERANCE of it. */
export function findPauses(samples: Float32Array, rate: number, text: string): Pause[] {
    const spans = speechSpans(samples, rate);
    const speech = spans.reduce((s, b) => s + (b.endS - b.startS), 0);
    if (spans.length < 2 || speech === 0) return [];
    let before = 0;
    const pauses = spans.slice(1).map((b, i) => {
        before += spans[i]!.endS - spans[i]!.startS;
        return { startS: spans[i]!.endS, endS: b.startS, at: before / speech, kind: 'word' as PauseKind };
    });
    // Sentence ends first, then clauses; each takes the longest unclaimed
    // pause near it. Position alone misplaces about one pause in two (the
    // pace drifts along a line), and the voice pauses longest at its marks.
    const marks = pauseMarks(text).sort((a, b) => Number(a.kind === 'clause') - Number(b.kind === 'clause'));
    for (const mark of marks) {
        let best: (typeof pauses)[number] | undefined;
        for (const p of pauses) {
            if (p.kind !== 'word' || Math.abs(p.at - mark.at) > MATCH_TOLERANCE) continue;
            if (!best || p.endS - p.startS > best.endS - best.startS) best = p;
        }
        if (best) best.kind = mark.kind;
    }
    return pauses.map(({ startS, endS, kind }) => ({ startS, endS, kind }));
}

/** `samples` with every pause longer than its cap cut down to the cap,
 *  crossfaded where the two ends meet. The input itself when none is. */
export function capPauses(samples: Float32Array, rate: number, text: string): Float32Array {
    const cuts = findPauses(samples, rate, text)
        .filter((p) => p.endS - p.startS > PAUSE_CAP_S[p.kind])
        .map((p) => {
            const keep = PAUSE_CAP_S[p.kind];
            return {
                from: Math.round((p.startS + keep * HEAD_SHARE) * rate),
                to: Math.round((p.endS - keep * (1 - HEAD_SHARE)) * rate),
            };
        });
    if (!cuts.length) return samples;
    const fade = Math.round(CROSSFADE_S * rate);
    const pieces: Float32Array[] = [];
    let at = 0;
    for (const { from, to } of cuts) {
        pieces.push(samples.subarray(at, from));
        at = to;
    }
    pieces.push(samples.subarray(at));
    const out = new Float32Array(pieces.reduce((n, p) => n + p.length, 0) - fade * cuts.length);
    let w = 0;
    pieces.forEach((piece, k) => {
        if (k === 0) {
            out.set(piece, 0);
            w = piece.length;
            return;
        }
        // Overlap the head of this piece with the last `fade` samples written.
        const start = w - fade;
        for (let i = 0; i < fade && i < piece.length; i++) {
            const t = (i + 1) / (fade + 1);
            out[start + i] = out[start + i]! * (1 - t) + piece[i]! * t;
        }
        out.set(piece.subarray(fade), w);
        w += piece.length - fade;
    });
    return out;
}

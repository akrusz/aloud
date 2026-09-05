/**
 * Word error rate between what the sim user said and what the app heard.
 *
 * The number that matters in tier 2: everything downstream reasons about the
 * transcript, so a facilitator that answers a garbled sentence sensibly is still
 * a session the user would call broken. Normalized hard (case, punctuation,
 * common contractions) because none of that survives speech anyway, and a
 * recognizer writing "I'm" for "I am" is not an error a meditator would notice.
 */

const CONTRACTIONS: Array<[RegExp, string]> = [
    [/\bi'm\b/g, 'i am'],
    [/\b(\w+)'re\b/g, '$1 are'],
    [/\b(\w+)'ve\b/g, '$1 have'],
    [/\b(\w+)'ll\b/g, '$1 will'],
    [/\b(can)'t\b/g, '$1 not'],
    [/\b(\w+)n't\b/g, '$1 not'],
    [/\b(\w+)'d\b/g, '$1 would'],
];

/** Drop `say` inline commands ([[slnc 3000]], [[rate 150]]) from a scripted
 *  line: they shape the audio, they're not words. */
export function stripSayMarkup(text: string): string {
    return text.replace(/\[\[[^\]]*\]\]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeForWer(text: string): string[] {
    let t = stripSayMarkup(text).toLowerCase();
    for (const [re, to] of CONTRACTIONS) t = t.replace(re, to);
    return t
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

/** Levenshtein over words, divided by the reference length. Capped at 1. */
export function wordErrorRate(said: string, heard: string): number {
    const ref = normalizeForWer(said);
    const hyp = normalizeForWer(heard);
    if (ref.length === 0) return hyp.length === 0 ? 0 : 1;

    let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
    for (let i = 1; i <= ref.length; i++) {
        const row = [i, ...new Array<number>(hyp.length).fill(0)];
        for (let j = 1; j <= hyp.length; j++) {
            const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
            row[j] = Math.min(
                (row[j - 1] as number) + 1,
                (prev[j] as number) + 1,
                (prev[j - 1] as number) + cost
            );
        }
        prev = row;
    }
    return Math.min(1, (prev[hyp.length] as number) / ref.length);
}

/**
 * Stock phrases: the therapy-speak and meditation-app filler a facilitator
 * reaches for instead of the meditator's own words. The report counts, per
 * model, the replies that contain one (aggregate.ts styleOf). A count for a
 * reader, never a verdict rule. Kept to the phrases that are a tell wherever
 * they appear: softeners that are fine in the right place ("gently", "allow",
 * "sit with") are left to the judge (rubric.md, 9). Matching is
 * case-insensitive, on word boundaries.
 */
export const STOCK_PHRASES: readonly string[] = [
    'I hear you',
    'that sounds really hard',
    'that makes sense',
    'thank you for sharing',
    "I'm here with you",
    "that's completely normal",
    "that's valid",
    'take all the time you need',
    "let's explore",
    'I invite you to',
    'holding space',
    'hold space',
    'lean into',
    'whatever arises',
    'no right or wrong',
];

/** Curly apostrophes read as straight ones, so "I’m" matches "I'm". */
function normalize(s: string): string {
    return s.replace(/[‘’ʼ]/g, "'");
}

function phraseRe(phrase: string): RegExp {
    const body = normalize(phrase)
        .trim()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+');
    return new RegExp(`(?<!\\w)${body}(?!\\w)`, 'i');
}

/** The phrases from `phrases` that occur in `text`, in list order. */
export function stockPhrasesIn(text: string, phrases: readonly string[] = STOCK_PHRASES): string[] {
    const t = normalize(text);
    return phrases.filter((p) => phraseRe(p).test(t));
}

/**
 * Transcript-level TTS echo guard - the acoustics-independent backstop for
 * meditation-pal-p8lx, where TTS leaking past the acoustic gates came back as
 * phantom user turns. An utterance that landed during/just after playback AND
 * reads as a run of the spoken text is echo.
 *
 * Two matchers, both gated on timing by the caller:
 *  - exact: a contiguous (normalized) run of the spoken words, 4+ words long.
 *  - fuzzy: 6+ words that recover 80%+ of the utterance as an in-order
 *    subsequence of a tight window of the spoken text. Recognizers mangle
 *    leaked speaker audio - dropped articles, a merged word, a stray filler -
 *    so exact runs miss most real phone echo (meditation-pal-oxmt).
 *
 * Still strict on purpose: meditators do legitimately repeat the facilitator
 * back, so short utterances and paraphrases are never dropped, and the fuzzy
 * window keeps a sentence from matching words scattered across the whole tail.
 */

/** Minimum normalized word count before an utterance can be called echo.
 *  Below this, mirroring the facilitator is as likely as acoustic leakage. */
export const MIN_ECHO_WORDS = 4;

/** The fuzzy matcher tolerates errors, so it needs more words to be safe. */
const MIN_FUZZY_ECHO_WORDS = 6;

/** Fraction of the utterance's words that must survive as an in-order
 *  subsequence of the spoken window. Below ~0.8 real paraphrases start
 *  matching; above it, ordinary recognition slips stop matching. */
const FUZZY_COVERAGE = 0.8;

/** How much longer than the utterance the matching span of spoken text may run.
 *  Keeps "a buzzing sensation" from matching one word here and one 40 words
 *  later - echo tracks the spoken text closely or it isn't echo. */
const FUZZY_SPAN_SLACK = 1.5;

/** Whisper renders echo with its own casing/punctuation, so match on bare words. */
function normalizedWords(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9']+/g, ' ')
        .split(' ')
        .filter(Boolean);
}

/**
 * True when `utterance` is a contiguous run of words inside `recentlySpoken`
 * (text recently handed to the synthesizer). Callers must ALSO gate on timing
 * (arrived during or shortly after playback); overlap alone isn't proof of echo.
 */
export function looksLikeTtsEcho(utterance: string, recentlySpoken: string): boolean {
    const u = normalizedWords(utterance);
    if (u.length < MIN_ECHO_WORDS) return false;
    const s = normalizedWords(recentlySpoken);
    if (u.length > s.length) return false;
    outer: for (let i = 0; i <= s.length - u.length; i++) {
        for (let j = 0; j < u.length; j++) {
            if (s[i + j] !== u[j]) continue outer;
        }
        return true;
    }
    return fuzzyEcho(u, s);
}

/**
 * True when some window of the spoken words contains most of the utterance in
 * order. The window is capped at FUZZY_SPAN_SLACK x the utterance so a match
 * has to stay local to one stretch of what was said.
 */
function fuzzyEcho(u: string[], s: string[]): boolean {
    if (u.length < MIN_FUZZY_ECHO_WORDS) return false;
    const needed = Math.ceil(u.length * FUZZY_COVERAGE);
    const window = Math.ceil(u.length * FUZZY_SPAN_SLACK);
    for (let start = 0; start + needed <= s.length; start++) {
        if (lcsLength(u, s.slice(start, start + window)) >= needed) return true;
    }
    return false;
}

/** Longest common subsequence length; both inputs are a sentence or two. */
function lcsLength(a: string[], b: string[]): number {
    let prev = new Array<number>(b.length + 1).fill(0);
    let row = new Array<number>(b.length + 1).fill(0);
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            row[j] =
                a[i - 1] === b[j - 1]
                    ? prev[j - 1]! + 1
                    : Math.max(prev[j]!, row[j - 1]!);
        }
        [prev, row] = [row, prev];
    }
    return prev[b.length]!;
}

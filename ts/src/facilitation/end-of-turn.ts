/**
 * End-of-turn heuristics: finished thought, or a dangling clause the speaker is
 * still completing? (meditation-pal-fxo1) The STT layer uses this to extend its
 * silence window rather than submit mid-sentence.
 *
 * Beyond ordinary slow speech: macOS's voice-processing noise gate can hard-zero
 * soft trailing speech, so the energy/VAD layer sees a perfect pause while the
 * user is still talking. The unfinished clause in the speculative transcript
 * survives that gate.
 *
 * Whisper punctuates, so missing terminal punctuation is a strong incompleteness
 * signal; the trailing-word list catches clauses Whisper closed anyway.
 */

/** Words that almost never end a finished thought, even with terminal
 *  punctuation after them. */
const DANGLING_TAIL_WORDS = new Set([
    // Conjunctions / connectives.
    'and',
    'but',
    'or',
    'so',
    'because',
    'although',
    'though',
    'while',
    'whereas',
    'if',
    'when',
    'unless',
    'until',
    'than',
    // Prepositions.
    'with',
    'without',
    'to',
    'of',
    'in',
    'on',
    'at',
    'by',
    'for',
    'from',
    'into',
    'onto',
    'about',
    'between',
    'through',
    'toward',
    'towards',
    // Articles / determiners / possessives.
    'the',
    'a',
    'an',
    'this',
    'that',
    'these',
    'those',
    'my',
    'your',
    'his',
    'her',
    'their',
    'our',
    'its',
    'some',
    'any',
    'each',
    'every',
    // Frequent mid-thought modifiers.
    'very',
    'really',
    'quite',
    'pretty',
    'just',
    'more',
    'most',
    'less',
    'kind',
    'sort',
]);

/**
 * True when `text` reads as an unfinished thought. Empty input is NOT
 * incomplete (no clause to dangle). Conservative: a false "incomplete" waits a
 * few extra seconds, a false "complete" cuts the speaker off.
 */
export function transcriptLooksIncomplete(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length === 0) return false;

    // Strip closing quotes/brackets so punctuation right before them counts.
    const unwrapped = trimmed.replace(/["'”’)\]]+$/u, '');
    const endsTerminated = /[.!?…]$/u.test(unwrapped);

    const lastWord =
        unwrapped
            .replace(/[.!?…,;:]+$/u, '')
            .split(/\s+/)
            .pop()
            ?.toLowerCase()
            .replace(/[^a-z'’-]/gu, '') ?? '';
    if (DANGLING_TAIL_WORDS.has(lastWord)) return true;

    // Whisper punctuates what it considers finished, so a comma or bare tail
    // means mid-clause.
    return !endsTerminated;
}

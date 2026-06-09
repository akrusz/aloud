/**
 * End-of-turn heuristics — is a transcript a finished thought, or a dangling
 * clause the speaker is still completing? (meditation-pal-fxo1)
 *
 * Used by the STT layer to extend its silence window instead of submitting
 * mid-sentence. This matters beyond ordinary slow speech: macOS's
 * voice-processing noise gate can hard-zero soft trailing speech, so the
 * energy/VAD layer sees a perfect pause while the user is still talking — but
 * the speculative transcript still ends in an unfinished clause, and that
 * signal survives the gate.
 *
 * Whisper punctuates its output, so "no terminal punctuation" is a strong
 * incompleteness signal on its transcripts; a trailing conjunction, article,
 * or preposition catches dangling clauses Whisper closed with a period anyway.
 */

/** Words that almost never end a finished thought, even when the transcriber
 *  appended terminal punctuation after them. */
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
 * True when `text` reads as an unfinished thought the speaker is likely still
 * completing. Empty/whitespace input is NOT incomplete (there is no clause to
 * dangle). Conservative on purpose: a false "incomplete" merely waits a few
 * extra seconds; a false "complete" cuts the speaker off.
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

    // Ends mid-clause: a comma, or no punctuation at all (Whisper punctuates
    // what it considers finished sentences).
    return !endsTerminated;
}

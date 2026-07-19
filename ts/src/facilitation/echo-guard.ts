/**
 * Transcript-level TTS echo guard - the acoustics-independent backstop for
 * meditation-pal-p8lx, where TTS leaking past the acoustic gates came back as
 * phantom user turns. An utterance that landed during/just after playback AND
 * is a verbatim run of the spoken text is echo.
 *
 * Strict on purpose: meditators do legitimately repeat the facilitator back, so
 * only exact (normalized) contiguous matches of meaningful length are dropped -
 * never paraphrases or short affirmations ("yes", "the tension").
 */

/** Minimum normalized word count before an utterance can be called echo.
 *  Below this, mirroring the facilitator is as likely as acoustic leakage. */
export const MIN_ECHO_WORDS = 4;

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
    return false;
}

/**
 * Transcript-level TTS echo guard.
 *
 * With continuous capture the mic stays live while the facilitator speaks,
 * and on hardware where echo-cancellation underperforms, fragments of the
 * facilitator's own TTS can clear the acoustic gates and come back as
 * phantom user turns (meditation-pal-p8lx) — observed as trailing pieces of
 * the just-spoken sentence ("tightness or maybe a buzzing sensation?").
 *
 * This is the acoustics-independent backstop: an utterance that landed
 * during/just after playback AND reads as a verbatim run of the recently
 * spoken text is echo, not the user. Deliberately strict — meditators DO
 * legitimately repeat the facilitator's words back, so we only drop exact
 * (normalized) contiguous matches of meaningful length, never paraphrases
 * or short affirmations ("yes", "the tension").
 */

/** Minimum normalized word count before an utterance can be called echo.
 *  Below this, repeating the facilitator is at least as likely to be the
 *  user agreeing/mirroring as it is to be acoustic leakage. */
export const MIN_ECHO_WORDS = 4;

/** Lowercase, strip punctuation, split into words. Whisper renders echo
 *  with its own casing/punctuation, so matching happens on bare words. */
function normalizedWords(text: string): string[] {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9']+/g, ' ')
        .split(' ')
        .filter(Boolean);
}

/**
 * True when `utterance` is a contiguous run of words inside
 * `recentlySpoken` (the text recently handed to the synthesizer).
 * Callers must ALSO gate on timing (utterance arrived while TTS was
 * playing or shortly after) — text overlap alone is not proof of echo.
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

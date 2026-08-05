/**
 * "mute" spoken as a command, not as content.
 *
 * Turning the mic off should not require finding a button with your eyes shut,
 * so a bare "mute" does it. No classifier: this has to fire on the utterance
 * that asks for silence, and a round trip to a model is both slow and a turn's
 * worth of credits for a word we can recognize outright.
 *
 * Strict by design - a meditator saying "I feel muted" or "something wants to
 * mute the sound of it" is describing an experience, and losing their mic
 * mid-sentence is a far worse failure than having to reach for the button. So:
 * the whole utterance must be the command, with nothing in it but the word and
 * a few politenesses.
 */

/** Words that may keep "mute" company and still leave it a command. */
const FILLER = new Set([
    'a',
    'aloud',
    'app',
    'can',
    'could',
    'hey',
    'just',
    'mic',
    'microphone',
    'my',
    'now',
    'ok',
    'okay',
    'off',
    'please',
    'the',
    'thanks',
    'turn',
    'you',
    'your',
]);

/** Past this many words it's a sentence about muting, not a command. */
const MAX_WORDS = 5;

/** True when the utterance is the spoken mute command and nothing else. */
export function isMuteCommand(utterance: string): boolean {
    const words = utterance
        .toLowerCase()
        .replace(/[^a-z0-9']+/g, ' ')
        .split(' ')
        .filter(Boolean);
    if (words.length === 0 || words.length > MAX_WORDS) return false;
    if (!words.includes('mute')) return false;
    // "unmute" and "muted" are their own tokens, so neither matches 'mute' nor
    // the filler list: both fall through as ordinary speech.
    return words.every((w) => w === 'mute' || FILLER.has(w));
}

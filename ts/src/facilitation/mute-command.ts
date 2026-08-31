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

/**
 * The zh command, same strictness: the whole utterance (punctuation aside) must
 * be 静音 ("mute") with at most a politeness around it - 请 (please), a leading
 * 把麦克风/把话筒 (the mic, as the object 把-construction puts before the verb),
 * or a trailing 吧/了/一下. Chinese recognizers segment with spaces
 * inconsistently, so this matches the joined utterance rather than words.
 * Anything longer is a sentence ABOUT muting and falls through as speech.
 */
const ZH_MUTE_RE = /^(?:请)?(?:把?(?:麦克风|话筒))?静音(?:吧|了|一下)?$/;

/** True when the utterance is the spoken mute command and nothing else. */
export function isMuteCommand(utterance: string): boolean {
    // zh first: the a-z scrub below would erase it entirely. CJK punctuation
    // and any stray spaces drop; the remainder must BE the command.
    const zh = utterance.replace(/[\s。，！？、．.…,!?~]+/gu, '');
    if (/[㐀-鿿]/.test(zh)) return ZH_MUTE_RE.test(zh);

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

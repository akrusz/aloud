/**
 * "I'm back", opening an utterance inside a held silence, taken as the
 * meditator calling the facilitator back, with no classifier.
 *
 * The resume classifiers lean hard toward staying (silence-mode.md), and an
 * unpunctuated recognizer (a browser's Web Speech, a phone's own) hands them
 * the return and the report as one run-on sentence: "I'm back the warmth in
 * my chest settled". They can read that as describing experience and stay,
 * and the facilitator sits silent while the meditator waits
 * (meditation-pal-kbec). Measured 2026-11-22, Haiku and Jev each stayed on
 * about one such return in eight, mostly the unpunctuated ones.
 *
 * So the words decide, as they do for "mute" (mute-command.ts): the utterance
 * opens with "I'm back", after at most a filler ("okay, I'm back"), and the
 * next word starts a new thought or there is none. "Back" said about a place
 * stays with the classifiers, since that is someone talking to themselves:
 * "I'm back in my body", "back to the breath", "I'm back there" (which the
 * trouble check hears, stepping-out.ts), "I'm back thinking about work". So
 * does an "I'm back" that does not open the utterance, and "I'm back again",
 * the noting meditator's word for coming back from a wander. Anything this
 * does not take goes to the classifiers as before, so it can only add
 * resumes, and only these.
 */

import { HESITATION_WORD } from './hesitation.js';
import { toSimplified } from './zh-script.js';

/** May come before "I'm back": "okay, I'm back", "um, I'm back". */
const LEAD = `(?:ok(?:ay)?|alright|all right|right|so|hey|hi|yeah|well|${HESITATION_WORD})`;

/** The return itself, opening the utterance. */
const OPENING_RE = new RegExp(`^[^a-z']*(?:${LEAD}(?![a-z'])[^a-z']*)*(?:i'?m|i am) back(?![a-z'])`);

/** May come between "back" and what follows it without saying anything. */
const BETWEEN = new Set(['now', 'ok', 'okay', 'alright', 'so', 'and', 'yeah']);
const HESITATION_RE = new RegExp(`^${HESITATION_WORD}$`);

/**
 * A word that starts a new thought after "I'm back": the report ("I'm back it
 * settled"), a word to the facilitator ("I'm back you can talk"), thanks.
 * Closed on purpose: "I'm back in", "to", "at", "there", "here", "home",
 * "again", "and forth" and every word not here are left to the classifiers.
 */
const STARTS_A_THOUGHT = new Set([
    'i',
    "i'm",
    'im',
    "i've",
    'ive',
    "i'd",
    "i'll",
    'it',
    "it's",
    'its',
    'that',
    "that's",
    'thats',
    'this',
    "there's",
    'theres',
    'the',
    'my',
    'everything',
    'something',
    'we',
    'you',
    'what',
    'thank',
    'thanks',
    "let's",
    'lets',
    'wow',
]);

/**
 * zh: 我回来了 (or 我回来啦), after at most 好 / 好了 / 嗯 / OK and the like. Not
 * 我回来了吗 (a question), 我回来了一点 (partly back), nor 我又回来了 ("back
 * again"); 回到 ("back to", 我回到身体里了) is not 回来 at all, and 紧张又回来了
 * ("the tension came back") does not open with 我. Read on the joined text in
 * simplified characters (回來 is converted first, zh-script.ts).
 */
const ZH_RETURN_RE = /^(?:好(?:了|的|啦)?|嗯+|呃|额|行|ok(?:ay)?)*我回来(?:(?:了|啦)(?![吗么没一])|$)/i;

/** Does this utterance open with the meditator saying they are back? */
export function opensWithReturn(utterance: string): boolean {
    const zh = toSimplified(utterance.replace(/[\s。，！？、．.…,!?~]+/gu, ''));
    if (/[㐀-鿿]/.test(zh)) return ZH_RETURN_RE.test(zh);

    const text = utterance.toLowerCase().replace(/[’‘]/g, "'").trim();
    const opening = OPENING_RE.exec(text);
    if (!opening) return false;
    const rest = text.slice(opening[0].length);
    // "I'm back?" is someone wondering, not telling.
    if (/^\s*\?/.test(rest)) return false;
    const next = rest
        .replace(/[^a-z0-9']+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .find((w) => !BETWEEN.has(w) && !HESITATION_RE.test(w));
    return next === undefined || STARTS_A_THOUGHT.has(next);
}

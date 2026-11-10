/**
 * "End the session" and the answer to "Would you like to end the session?",
 * recognized outright, with no judge.
 *
 * Spoken commands run on the Jev judge (voice-command.ts), which a session
 * only has on aloud cloud, by opt-in, or with its own key, and which can be
 * down. Without it the one thing a meditator could say to the app was "mute"
 * (mute-command.ts), so a sit that started by voice still had to be ended by
 * hand, eyes open. Ending is the other half of being able to leave, so it gets
 * the same treatment: a small set of phrasings matched here, free, offline, on
 * every provider. The judge still hears everything first where there is one;
 * this is what catches the plain phrasing when it can't.
 *
 * Looser than the mute match on purpose, because the two failures differ.
 * A wrong "mute" takes the mic away mid-sentence. A wrong "end the session"
 * only gets asked "Would you like to end the session?", and nothing ends
 * without a yes. So this accepts the ways people actually ask ("can we end
 * the session", "I'd like to stop the meditation now") while still requiring
 * the whole utterance to be the request: a verb, the thing being ended, and
 * nothing else but the words that politely surround a request. "I don't want
 * to end the session" and "part of me wants this session to end" are sentences
 * about ending and pass through as speech.
 */

/** What "end" can be said as. */
const END_VERBS = new Set(['end', 'stop', 'finish', 'close', 'quit']);

/** What is being ended. Required: a bare "stop" is as likely meant for the
 *  facilitator's sentence as for the sit. */
const END_OBJECTS = new Set(['session', 'sit', 'meditation', 'sitting']);

/** Words that may surround the request and still leave it one. */
const END_FILLER = new Set([
    'a',
    'aloud',
    'and',
    'can',
    'could',
    'for',
    'here',
    'hey',
    'i',
    "i'd",
    'id',
    'just',
    "let's",
    'lets',
    'like',
    'my',
    'now',
    'ok',
    'okay',
    'our',
    'please',
    'thanks',
    'the',
    'there',
    'this',
    'to',
    'today',
    'want',
    'we',
    'would',
    'you',
]);

/** Past this many words it's a sentence about ending, not a request. */
const END_MAX_WORDS = 9;

/** a-z words, apostrophes kept ("let's", "i'd"), everything else a break. */
function words(utterance: string): string[] {
    return utterance
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/[^a-z0-9']+/g, ' ')
        .split(' ')
        .filter(Boolean);
}

/** The utterance with CJK punctuation and spaces dropped: Chinese recognizers
 *  segment with spaces inconsistently, so zh matches the joined text. */
function joinedZh(utterance: string): string | null {
    const zh = utterance.replace(/[\s。，！？、．.…,!?~]+/gu, '');
    return /[㐀-鿿]/.test(zh) ? zh : null;
}

/**
 * zh: 结束 (end) with the sit as its object and at most a politeness around it:
 * 请 / 我想 / 我要 / 我们 / 可以 before, 这次 / 这个 / 今天的 on the object, 吧 / 了 /
 * 好吗 / 可以吗 after. The object is required, as in English.
 */
const ZH_END_RE =
    /^(?:请|我想|我要|我们|可以|现在|就)*结束(?:这次|这个|本次|今天的|这一次)?(?:冥想|打坐|静坐|练习|会话)(?:吧|了|好吗|可以吗)?$/;

/** True when the utterance asks to end the session and says nothing else. */
export function isEndCommand(utterance: string): boolean {
    const zh = joinedZh(utterance);
    if (zh !== null) return ZH_END_RE.test(zh);

    const w = words(utterance);
    if (w.length < 2 || w.length > END_MAX_WORDS) return false;
    let verbs = 0;
    let objects = 0;
    for (const word of w) {
        if (END_VERBS.has(word)) verbs++;
        else if (END_OBJECTS.has(word)) objects++;
        else if (!END_FILLER.has(word)) return false;
    }
    // One of each: "end the session and stop the meditation" is still a
    // request, but two verbs with one object ("stop, end the session") reads
    // as someone correcting themselves mid-thought. Ask the judge, or nobody.
    return verbs === 1 && objects === 1;
}

// ---- the answer --------------------------------------------------------------

/** Says yes on its own. */
const YES_WORDS = new Set([
    'yes',
    'yeah',
    'yep',
    'yup',
    'yea',
    'sure',
    'ok',
    'okay',
    'please',
    'absolutely',
    'definitely',
    'correct',
]);

/** Says no wherever it appears: "yes... no, not yet" is a no. */
const NO_WORDS = new Set([
    'no',
    'nope',
    'nah',
    'not',
    "don't",
    'dont',
    'cancel',
    'never',
    'nevermind',
    'wait',
    'continue',
    'keep',
    'stay',
]);

/** May sit beside a yes or a no without changing it. */
const REPLY_NEUTRAL = new Set([
    'a',
    'ahead',
    'bit',
    'do',
    'end',
    'for',
    'go',
    'going',
    'i',
    "i'd",
    'id',
    'it',
    'just',
    "let's",
    'lets',
    'like',
    'little',
    'longer',
    'mind',
    'more',
    'now',
    'on',
    'right',
    'session',
    'sitting',
    'thank',
    'thanks',
    'that',
    "that's",
    'thats',
    'the',
    'to',
    'we',
    "we'll",
    'well',
    'would',
    'yet',
    'you',
]);

/** A yes with no yes-word in it, as the whole reply. */
const YES_PHRASES = new Set([
    'end it',
    'do it',
    'go ahead',
    'i would',
    "i'd like to",
    'i would like to',
    "that's right",
    'thats right',
    'end the session',
    'end session',
]);

/** Past this many words it's a turn, not an answer. */
const REPLY_MAX_WORDS = 6;

const ZH_YES_RE = /^(?:嗯+|好|好的|好吧|是|是的|对|对的|可以|行|要|要的|结束|结束吧|好的?结束吧?|是的?结束吧?)$/;
const ZH_NO_RE =
    /^(?:不|不要|不用|不用了|不了|不行|先不|先不要|先不了|还不|还没|还没有|等一下|等等|继续|继续吧|我们继续|不结束|先不结束|再坐一会儿?|再等一会儿?)$/;

/**
 * The reply to "Would you like to end the session?" when it is plainly a yes
 * or a no, or null when it is anything else (which then goes on as an ordinary
 * turn; the button still works). Every word has to be one this knows, so "yes,
 * I think my leg is asleep" is a turn and not a yes. Any no-word makes it a
 * no: of the two mistakes, carrying on a sit someone wanted to end costs them
 * one more sentence, and ending one they wanted to keep costs them the sit.
 */
export function endConfirmReply(utterance: string): 'yes' | 'no' | null {
    const zh = joinedZh(utterance);
    if (zh !== null) return ZH_NO_RE.test(zh) ? 'no' : ZH_YES_RE.test(zh) ? 'yes' : null;

    const w = words(utterance);
    if (w.length === 0 || w.length > REPLY_MAX_WORDS) return null;
    if (!w.every((word) => YES_WORDS.has(word) || NO_WORDS.has(word) || REPLY_NEUTRAL.has(word))) return null;
    if (w.some((word) => NO_WORDS.has(word))) return 'no';
    if (w.some((word) => YES_WORDS.has(word))) return 'yes';
    return YES_PHRASES.has(w.join(' ')) ? 'yes' : null;
}

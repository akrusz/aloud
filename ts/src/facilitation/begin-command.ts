/**
 * "Begin", said on the setup screen, with no judge.
 *
 * The other half of end-command.ts: a sit that can be left by voice should be
 * startable by voice, so that after one touch to open the app the rest of a
 * sitting - begin, speak, end, begin again - needs no hands. Recognized
 * outright, like "mute" and "end the session": nothing to sign in to, nothing
 * sent anywhere, nothing to pay for.
 *
 * On the setup screen nobody is meditating aloud, so unlike the in-session
 * matchers the word can stand alone: "begin", "start". What it must not be is
 * a sentence someone nearby happened to say, so the whole utterance still has
 * to be the request: begin or start, optionally what (the session, the sit),
 * and the few words people wrap around it. "Let's begin", "okay, start the
 * session", "I'm ready to begin". "When does the movie start?" has words this
 * doesn't know and is ignored.
 */

const BEGIN_VERBS = new Set(['begin', 'start']);

const BEGIN_OBJECTS = new Set(['session', 'sit', 'meditation', 'sitting', 'meditating']);

const BEGIN_FILLER = new Set([
    'a',
    'aloud',
    'can',
    'could',
    'hey',
    'i',
    "i'd",
    "i'm",
    'id',
    'im',
    'just',
    "let's",
    'lets',
    'like',
    'my',
    'new',
    'now',
    'ok',
    'okay',
    'our',
    'please',
    'ready',
    'thanks',
    'the',
    'to',
    'we',
    'you',
]);

/** Past this many words it's a sentence, not a request. */
const BEGIN_MAX_WORDS = 7;

/** zh: 开始 with at most the sit as its object and a politeness around it. */
const ZH_BEGIN_RE = /^(?:请|我们|我想|我要|可以|现在|好的?)*开始(?:冥想|打坐|静坐|练习)?(?:吧|了)?$/;

/** True when the utterance asks to begin and says nothing else. */
export function isBeginCommand(utterance: string): boolean {
    const zh = utterance.replace(/[\s。，！？、．.…,!?~]+/gu, '');
    if (/[㐀-鿿]/.test(zh)) return ZH_BEGIN_RE.test(zh);

    const words = utterance
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/[^a-z0-9']+/g, ' ')
        .split(' ')
        .filter(Boolean);
    if (words.length === 0 || words.length > BEGIN_MAX_WORDS) return false;
    let verbs = 0;
    let objects = 0;
    for (const word of words) {
        if (BEGIN_VERBS.has(word)) verbs++;
        else if (BEGIN_OBJECTS.has(word)) objects++;
        else if (!BEGIN_FILLER.has(word)) return false;
    }
    return verbs === 1 && objects <= 1;
}

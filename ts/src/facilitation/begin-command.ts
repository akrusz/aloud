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
 *
 * It can also say which sit: a mode by the name the setup screen gives it, and
 * a length. "Begin a twenty minute felt sense session." Those are the two
 * choices worth making with eyes closed; everything else about a sit (voice,
 * model, focuses) stays whatever it was last time.
 */

import { parseTimerRequest } from './voice-command.js';

/** The modes a request can name, by the names the setup screen shows. */
export type BeginMode = 'exploration' | 'noting' | 'felt_sense';

/** What a request to begin asked for beyond beginning. */
export interface BeginRequest {
    /** A mode named in it ("begin a noting session"). */
    mode?: BeginMode;
    /** A length named in it, in whole minutes ("a twenty minute sit"). */
    minutes?: number;
}

const BEGIN_VERBS = new Set(['begin', 'start']);

const BEGIN_OBJECTS = new Set(['session', 'sit', 'meditation', 'sitting', 'meditating']);

const BEGIN_FILLER = new Set([
    'a',
    'aloud',
    'an',
    'can',
    'could',
    'for',
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
    'long',
    'my',
    'new',
    'now',
    'of',
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

/** A mode's name. "felt sense" is two words and needs both, in order. */
const MODE_WORDS: Record<string, BeginMode> = {
    exploration: 'exploration',
    noting: 'noting',
    felt: 'felt_sense',
    sense: 'felt_sense',
};

/** What a length is said with. The number itself is read by parseTimerRequest,
 *  which is also what an in-session "set a timer for ten minutes" goes through. */
const LENGTH_UNITS = new Set(['minute', 'minutes', 'min', 'mins', 'hour', 'hours', 'hr', 'hrs']);
const LENGTH_WORDS = new Set([
    'and', 'half',
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
    'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
]);

/** Past this many words it's a sentence, not a request. */
const BEGIN_MAX_WORDS = 11;

/**
 * zh: 开始, optionally a length (二十分钟, 半小时), a mode by its setup-screen
 * name (探索 / 标记 / 体会) and the sit itself, with a politeness around it.
 */
const ZH_LENGTH = '(?:[\\d零一二两三四五六七八九十]+分钟|[\\d零一二两三四五六七八九十]+个?半?小时|半个?小时)';
const ZH_BEGIN_RE = new RegExp(
    `^(?:请|我们|我想|我要|可以|现在|好的?)*开始(?:一个|一次|个)?(?:${ZH_LENGTH})?的?(探索|标记|体会)?的?(?:冥想|打坐|静坐|练习)?(?:吧|了)?$`
);
const ZH_MODES: Record<string, BeginMode> = { 探索: 'exploration', 标记: 'noting', 体会: 'felt_sense' };

/**
 * What the utterance asks to begin, or null when it is not (only) a request to
 * begin. `{}` is a plain "begin".
 */
export function parseBeginRequest(utterance: string): BeginRequest | null {
    const zh = utterance.replace(/[\s。，！？、．.…,!?~]+/gu, '');
    if (/[㐀-鿿]/.test(zh)) {
        const match = ZH_BEGIN_RE.exec(zh);
        if (!match) return null;
        const length = new RegExp(ZH_LENGTH).test(zh) ? parseTimerRequest(zh) : null;
        return {
            ...(match[1] ? { mode: ZH_MODES[match[1]]! } : {}),
            ...(length ? { minutes: length.minutes } : {}),
        };
    }

    const words = utterance
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        // "twenty-minute", "felt-sense".
        .replace(/-/g, ' ')
        .replace(/[^a-z0-9' ]+/g, ' ')
        .split(' ')
        .filter(Boolean);
    if (words.length === 0 || words.length > BEGIN_MAX_WORDS) return null;

    let verbs = 0;
    let objects = 0;
    let hasUnit = false;
    const modes = new Set<BeginMode>();
    for (const [i, word] of words.entries()) {
        if (BEGIN_VERBS.has(word)) verbs++;
        else if (BEGIN_OBJECTS.has(word)) objects++;
        else if (word in MODE_WORDS) {
            // "felt sense" only as the pair: "start, I sense something" has
            // words this doesn't know anyway, but half a name is not a name.
            if (word === 'felt' && words[i + 1] !== 'sense') return null;
            if (word === 'sense' && words[i - 1] !== 'felt') return null;
            modes.add(MODE_WORDS[word]!);
        } else if (LENGTH_UNITS.has(word)) hasUnit = true;
        else if (!LENGTH_WORDS.has(word) && !/^\d{1,3}$/.test(word) && !BEGIN_FILLER.has(word)) return null;
    }
    if (verbs !== 1 || objects > 1 || modes.size > 1) return null;

    // A unit with no number it can read ("start a minute") is not a request
    // this understands; neither is "five more minutes", which has no "more"
    // in this vocabulary to begin with.
    const length = hasUnit ? parseTimerRequest(words.join(' ')) : null;
    if (hasUnit && (!length || length.relative)) return null;

    const [mode] = modes;
    return { ...(mode ? { mode } : {}), ...(length ? { minutes: length.minutes } : {}) };
}

/** True when the utterance asks to begin and says nothing else. */
export function isBeginCommand(utterance: string): boolean {
    return parseBeginRequest(utterance) !== null;
}

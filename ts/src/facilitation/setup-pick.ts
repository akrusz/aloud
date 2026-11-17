/**
 * Picking from a list by name on the setup screen: a voice ("set the voice to
 * Ethan", "preview Harper", "open the voice picker") or a model ("set the
 * model to Opus"). Matched on the device like the rest of setup-command.ts,
 * by the same rule: the whole utterance has to be the request.
 *
 * Unlike a vibe or a mode these lists are not known ahead: the voices are
 * whatever this machine and account have, the models whatever the provider
 * lists. So the names come in with the utterance (`PickContext`), and nothing
 * here can go to the judge, which scores fixed asks and extracts no names.
 *
 * A name alone is a person being called across a room, so it only counts while
 * the voice picker is open. Otherwise it needs the word for what is being
 * picked ("voice", "model") or, for a voice, a word that asks to hear it.
 */

import { editDistance, soundKey } from './setup-command.js';
import { zhSaysName } from './voice-names.js';
import { toSimplified, trimHeardZh } from './zh-script.js';

export type SetupPick =
    | { kind: 'voice-picker'; open: boolean }
    /** `preview`: play it and change nothing. Otherwise it becomes the voice. */
    | { kind: 'voice'; name: string; preview: boolean }
    | { kind: 'model'; value: string };

export interface PickContext {
    /** The voices on offer, best first, by the name the picker shows. */
    voices: readonly string[];
    /** The model picker's options as shown, in its order. */
    models: ReadonlyArray<{ value: string; label: string }>;
    /** The voice picker is up, so a bare name is an answer to it. */
    pickerOpen: boolean;
}

const POLITE = new Set(['please', 'ok', 'okay', 'hey', 'aloud', 'thanks', 'now', 'yes', 'yeah', 'sure']);

/** Words around a name that ask for it to become the choice. */
const CHOOSING = new Set(['set', 'change', 'switch', 'make', 'use', 'pick', 'choose', 'select', 'try']);
/** Words that ask to hear a voice without choosing it. */
const HEARING = new Set(['preview', 'hear', 'play', 'sample', 'demo', 'listen', 'sound', 'sounds']);
const AROUND = new Set([
    'the', 'my', 'a', 'to', 'be', 'with', 'i', "i'd", 'id', 'want', 'like', 'would', 'go', "let's", 'lets', 'let', 'me',
    'can', 'could', 'you', 'it', 'as', 'for', 'of', 'this', 'one', 'please', 'instead', 'how', 'does',
    'what', "what's", 'whats',
]);
const VOICE_WORDS = new Set(['voice', 'voices', "voice's"]);
const MODEL_WORDS = new Set(['model', 'models']);

const OPEN_PICKER = new Set([
    'open voice picker', 'open the voice picker', 'voice picker', 'show voice picker', 'show the voice picker',
    'open voices', 'open the voices', 'show voices', 'show the voices', 'show me the voices', 'list voices',
    'list the voices', 'open voice list', 'open the voice list', 'voice list', 'voice options', 'show voice options',
    'change voice', 'change the voice', 'change my voice', 'pick a voice', 'choose a voice', 'select a voice',
    'pick a new voice', 'choose a new voice', 'another voice', 'a different voice', 'different voice', 'other voices',
    'more voices', 'switch voice', 'switch voices', 'switch the voice', 'what voices are there', 'what voices do you have',
]);
const CLOSE_PICKER = new Set([
    'close', 'close it', 'close this', 'close the picker', 'close the voice picker', 'close voices', 'close the voices',
    'done', "i'm done", 'im done', "that's all", 'thats all', "that's it", 'thats it', 'go back', 'back', 'cancel',
    'never mind', 'nevermind', 'exit', 'keep it', 'keep this one', 'keep that one',
]);

function words(utterance: string): string[] {
    return utterance
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        .replace(/[^a-z0-9' ]+/g, ' ')
        .split(' ')
        .filter(Boolean);
}

/**
 * Which of `names` the words `said` name, or null. In order: the whole name
 * (with or without the spaces between the words said);
 * else the names that contain every word said ("opus" for "Claude Opus 5.5",
 * "amy" for "en_US-amy-medium"), the first listed winning, since both lists
 * come best first; else, for one word, a name that sounds like it ("Eason"
 * for "Ethan"), and only when exactly one does.
 */
export function namedIn(said: readonly string[], names: readonly string[]): number | null {
    if (said.length === 0 || said.length > 5) return null;
    const tokens = names.map((name) => words(name));
    const joined = said.join(' ');
    // An English recognizer writes a Chinese name as two words ("yun fan").
    const run = said.join('');
    const whole = tokens.findIndex((name) => name.join(' ') === joined || name.join('') === run);
    if (whole >= 0) return whole;
    const contains = tokens.findIndex((name) => said.every((word) => name.includes(word)));
    if (contains >= 0) return contains;
    if (said.length !== 1 || said[0]!.length < 4) return null;
    const heard = said[0]!;
    const key = soundKey(heard);
    const near = tokens.flatMap((name, i) =>
        name.some((word) => word.length >= 4 && soundKey(word) === key && editDistance(word, heard) <= Math.max(1, Math.floor(word.length / 3)))
            ? [i]
            : []
    );
    return near.length === 1 ? near[0]! : null;
}

function parseZhPick(utterance: string, ctx: PickContext): SetupPick | null {
    const said = toSimplified(trimHeardZh(utterance)).replace(/[\s。，！？、．.…,!?~]+/gu, '').replace(/^(?:好的?|请|麻烦)+/u, '').replace(/(?:吧|了|一下)+$/u, '');
    if (/^(?:打开|显示|看看)?(?:声音|语音|嗓音)(?:选择|列表|选项)$/.test(said) || /^(?:换|切换|选|选择|更换)(?:一个|个)?(?:声音|语音)$/.test(said)) {
        return { kind: 'voice-picker', open: true };
    }
    if (ctx.pickerOpen && /^(?:关闭|关掉|完成|返回|好了|取消|就这个)$/.test(said)) return { kind: 'voice-picker', open: false };
    const preview = /试听|听听|预览|播放/.test(said);
    const asks = preview || /声音|语音/.test(said);
    if (!asks && !ctx.pickerOpen) return null;
    const named = ctx.voices.filter((name) => zhSaysName(said, name));
    if (named.length !== 1) return null;
    return { kind: 'voice', name: named[0]!, preview };
}

/**
 * What an utterance picks, or null when it is not (only) a request to pick a
 * voice or a model from the lists in `ctx`.
 */
export function parseSetupPick(utterance: string, ctx: PickContext): SetupPick | null {
    if (/[㐀-鿿]/.test(utterance)) return parseZhPick(utterance, ctx);
    const said = words(utterance).filter((w) => !POLITE.has(w));
    if (said.length === 0 || said.length > 10) return null;
    const whole = said.join(' ');
    if (ctx.pickerOpen && CLOSE_PICKER.has(whole)) return { kind: 'voice-picker', open: false };
    if (OPEN_PICKER.has(whole)) return { kind: 'voice-picker', open: true };

    const rest = said.filter((w) => !CHOOSING.has(w) && !HEARING.has(w) && !AROUND.has(w) && !VOICE_WORDS.has(w) && !MODEL_WORDS.has(w));
    if (rest.length === 0) return null;
    const choosing = said.some((w) => CHOOSING.has(w));
    const hearing = said.some((w) => HEARING.has(w));
    const voiceWord = said.some((w) => VOICE_WORDS.has(w));
    const modelWord = said.some((w) => MODEL_WORDS.has(w));
    if (voiceWord && modelWord) return null;

    if (modelWord) {
        if (hearing) return null;
        const at = namedIn(rest, ctx.models.map((m) => m.label));
        return at === null ? null : { kind: 'model', value: ctx.models[at]!.value };
    }
    // A bare name, or "use Ethan" with nothing saying it is a voice, is only
    // an answer while the picker is up.
    if (!voiceWord && !hearing && !ctx.pickerOpen) return null;
    const at = namedIn(rest, ctx.voices);
    if (at === null) return null;
    return { kind: 'voice', name: ctx.voices[at]!, preview: hearing && !choosing };
}

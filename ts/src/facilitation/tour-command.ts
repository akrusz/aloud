/**
 * The few words the setup tour answers to when the microphone is on: next,
 * back, repeat, close, quiet, and on the step that offers two voices, which
 * one. Matched on the device like "begin" (begin-command.ts), by the same
 * rule: the whole utterance has to be the request, so a sentence that happens
 * to contain "next" moves nothing.
 *
 * The tour's buttons do all of this too. Voice is the second way, never the
 * only one.
 */

import { editDistance, soundKey } from './setup-command.js';
import { zhSaysName } from './voice-names.js';
import { toSimplified, trimHeardZh } from './zh-script.js';

export type TourCommand =
    | { kind: 'next' }
    | { kind: 'back' }
    | { kind: 'repeat' }
    /** Leave the tour. */
    | { kind: 'close' }
    /** Stop speaking the steps; the cards stay. */
    | { kind: 'quiet' }
    | { kind: 'speak' }
    /** The voice step: 0 is the first voice offered, 1 the second. */
    | { kind: 'voice'; index: number };

const SAID: ReadonlyArray<readonly [TourCommand['kind'], readonly string[]]> = [
    ['next', ['next', 'next one', 'next step', 'continue', 'go on', 'keep going', 'carry on', 'got it', 'go ahead', 'move on']],
    ['back', ['back', 'go back', 'previous', 'previous one', 'previous step', 'last one']],
    ['repeat', ['repeat', 'repeat that', 'again', 'say that again', 'say it again', 'one more time', 'what was that']],
    ['close', ['skip', 'skip it', 'skip this', 'skip this step', 'skip the tour', 'close', 'close this', 'close the tour', 'end the tour', 'stop the tour', 'exit', "that's enough", 'thats enough', "i'm done", 'im done']],
    // Not a bare "quiet" or "hush": said to a child, it would switch the
    // reading off for good.
    ['quiet', ['mute', 'be quiet', 'stop talking', 'no talking', 'sound off', 'voice off']],
    ['speak', ['unmute', 'talk to me', 'speak', 'sound on', 'voice on', 'read it to me']],
];

const SAID_ZH: ReadonlyArray<readonly [TourCommand['kind'], readonly string[]]> = [
    ['next', ['下一步', '下一个', '继续', '接着说', '往下', '知道了', '明白了']],
    ['back', ['上一步', '上一个', '返回', '回去', '后退']],
    ['repeat', ['再说一遍', '再说一次', '重复', '重复一遍', '再来一遍']],
    ['close', ['跳过', '关闭', '结束导览', '退出', '不看了', '够了']],
    ['quiet', ['静音', '安静', '别说了', '不要说话', '别说话']],
    ['speak', ['取消静音', '说吧', '读给我听', '打开声音']],
];

const POLITE = new Set(['please', 'ok', 'okay', 'hey', 'aloud', 'thanks', 'now', 'yes', 'yeah', 'sure']);

/** A voice on offer at the voice step. */
export interface OfferedVoice {
    name: string;
    gender: string;
}

const PLACE: Record<string, number> = { first: 0, former: 0, second: 1, latter: 1, two: 1 };
/** Not the pronouns: "would you like to go with him" is a question to
 *  someone else. */
const GENDER: Record<string, string> = {
    woman: 'female', female: 'female', lady: 'female', "woman's": 'female',
    man: 'male', male: 'male', guy: 'male', "man's": 'male',
};
const PICK_FILLER = new Set([
    'the', 'a', 'i', "i'd", "i'll", 'id', 'ill', 'like', 'want', 'pick', 'choose', 'take', 'go', 'with', 'one', 'voice',
    'prefer', "let's", 'lets', 'use', 'number',
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
 * Which of the two offered voices an answer names, or null: by name
 * ("Harper"), by place ("the first one"), or by how it sounds ("the woman",
 * where the two differ that way). Both at once is no answer.
 */
/** The offered voice a word names, or -1: the name itself, the name with a
 *  letter or two run on ("Harperd", "Harper's"), one letter off and sounding
 *  the same ("Ethen"), or five letters or more opening on the name's first
 *  two and no more than half its length away ("Happy", "Happen" for Harper, as a phone
 *  heard it twice running, 2026-11-20). Loose, because only two voices are on
 *  offer and the card takes a tap; never a word that could be either. */
function namedVoice(word: string, voices: readonly OfferedVoice[]): number {
    const bare = word.replace(/'/g, '');
    const near = voices.flatMap((voice, i) => {
        const name = voice.name.toLowerCase();
        if (bare === name) return [i];
        if (name.length < 4 || bare.length < 4) return [];
        const off = editDistance(bare, name);
        const runOn = bare.startsWith(name) && bare.length - name.length <= 2;
        const sounds = soundKey(bare) === soundKey(name) && off <= 1;
        const opens = bare.length >= 5 && bare.slice(0, 2) === name.slice(0, 2) && off <= Math.floor(name.length / 2);
        return runOn || sounds || opens ? [i] : [];
    });
    return near.length === 1 ? near[0]! : -1;
}

function pickedVoice(utterance: string, voices: readonly OfferedVoice[]): number | null {
    const byGender = (gender: string): number | null => {
        const matches = voices.flatMap((voice, i) => (voice.gender === gender ? [i] : []));
        return matches.length === 1 ? matches[0]! : null;
    };
    const picked = new Set<number>();
    const zh = toSimplified(trimHeardZh(utterance)).replace(/[\s。，！？、．.…,!?~]+/gu, '');
    if (/[㐀-鿿]/.test(zh)) {
        if (/第一|前一个|前者/.test(zh)) picked.add(0);
        if (/第二|后一个|后者/.test(zh)) picked.add(1);
        const female = /女/.test(zh) ? byGender('female') : null;
        const male = /男/.test(zh) ? byGender('male') : null;
        if (female !== null) picked.add(female);
        if (male !== null) picked.add(male);
        voices.forEach((voice, i) => {
            if (zhSaysName(zh, voice.name)) picked.add(i);
        });
        return picked.size === 1 ? [...picked][0]! : null;
    }
    const said = words(utterance).filter((w) => !POLITE.has(w));
    if (said.length === 0 || said.length > 8) return null;
    // "Number one": the only way "one" is a pick and not "the first one".
    if (said.join(' ') === 'number one') return 0;
    // A word that picks has to be there; "the one" names neither.
    if (!said.some((w) => w in PLACE || w in GENDER || namedVoice(w, voices) >= 0)) return null;
    for (const word of said) {
        const named = namedVoice(word, voices);
        if (named >= 0) picked.add(named);
        else if (word in PLACE) picked.add(PLACE[word]!);
        else if (word in GENDER) {
            const index = byGender(GENDER[word]!);
            if (index === null) return null;
            picked.add(index);
        } else if (!PICK_FILLER.has(word)) return null;
    }
    return picked.size === 1 ? [...picked][0]! : null;
}

/** A zh utterance without its punctuation and the softeners around a request
 *  (好的 and 请 ahead, 吧 and 了 after). */
function bareZh(utterance: string): string {
    return toSimplified(trimHeardZh(utterance))
        .replace(/[\s。，！？、．.…,!?~]+/gu, '')
        .replace(/^(?:好的?|请)+/u, '')
        .replace(/(?:吧|了)+$/u, '');
}

/**
 * What a tour utterance asks for, or null when it is not (only) one of the
 * tour's words. `voices` are the two on offer while the voice step is up
 * (first offered first), absent on every other step.
 */
export function parseTourCommand(utterance: string, voices?: readonly OfferedVoice[]): TourCommand | null {
    if (voices && voices.length === 2) {
        const index = pickedVoice(utterance, voices);
        if (index !== null) return { kind: 'voice', index };
    }
    const zh = bareZh(utterance);
    if (/[㐀-鿿]/.test(zh)) {
        // The phrases go through the same trimming: 知道了 is said, and
        // matched, as 知道.
        for (const [kind, phrases] of SAID_ZH) {
            if (phrases.some((phrase) => bareZh(phrase) === zh)) return { kind } as TourCommand;
        }
        return null;
    }
    const said = words(utterance)
        .filter((w) => !POLITE.has(w))
        .join(' ');
    if (!said) return null;
    for (const [kind, phrases] of SAID) {
        if (phrases.includes(said)) return { kind } as TourCommand;
    }
    return null;
}

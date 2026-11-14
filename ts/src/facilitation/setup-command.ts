/**
 * Settings said on the setup screen, matched on the device with no judge.
 *
 * begin-command.ts starts a session; this makes the choices before it: the
 * mode, a length, vibes and focuses, how much the facilitator leads and says,
 * the intention. Like "begin" it needs no account, sends nothing anywhere and
 * costs nothing, so it is the whole feature for someone signed out.
 *
 * The rule is begin-command's: the whole utterance has to be the request.
 * Every word must be one this knows, so a sentence from the room that happens
 * to contain "playful" changes nothing.
 *
 * Unlike "begin", the words that carry a value are matched loosely
 * (`nearestWord`): on-device recognition is poor at exactly these ("spaces"
 * for "spacious", "nothing" for "noting"), a wrong setting is cheap, and the
 * app says back what it changed. The loosening stops at the value words.
 * Filler, numbers and negations are exact, and nothing here can begin a
 * session: begin and start are not in this vocabulary at all.
 *
 * What it can't rescue is a far miss ("advice" for "vibes"). That is the
 * judge's tier (voice-command-specs.ts, `setup-command`).
 */

import type { BeginMode } from './begin-command.js';
import type { Quality, Verbosity } from './prompts.js';
import { parseTimerRequest } from './voice-command.js';

/** The focuses the setup screen offers (open awareness is no checkbox there). */
export type SetupFocus = 'body_sensations' | 'emotions' | 'inner_parts';

/** The guidance slider's stops, 0 (following) to 4 (directing). */
export const GUIDANCE_STOPS = 5;

/** One change to the setup form. `views/setup.ts` applies them. */
export type SetupAction =
    | { kind: 'mode'; mode: BeginMode }
    /** The session timer, in whole minutes. */
    | { kind: 'length'; minutes: number }
    | { kind: 'no-timer' }
    | { kind: 'focus'; focus: SetupFocus; on: boolean }
    | { kind: 'quality'; quality: Quality; on: boolean }
    /** Uncheck every focus, or every vibe. */
    | { kind: 'clear'; group: 'focus' | 'quality' }
    /** One stop along the guidance slider, or straight to a stop. */
    | { kind: 'guidance'; to: 'up' | 'down' | number }
    | { kind: 'verbosity'; to: 'up' | 'down' | Verbosity }
    /** The intention field of the mode on screen; '' empties it. */
    | { kind: 'intention'; text: string }
    | { kind: 'checkins'; on: boolean }
    | { kind: 'stop-listening' }
    | { kind: 'help' };

/** Past this many words it's a sentence, not a request (an intention aside). */
const SETUP_MAX_WORDS = 14;
/** An intention is a sentence of the meditator's own, so it runs longer. */
const INTENTION_MAX_WORDS = 40;

// ---- vocabulary -------------------------------------------------------------

type Meaning =
    | { t: 'mode'; mode: BeginMode }
    | { t: 'focus'; focus: SetupFocus }
    | { t: 'quality'; quality: Quality }
    /** A word about who leads. `stop` is where the bare word puts the slider;
     *  without one it only means something beside "more" or "less". */
    | { t: 'lead'; toward: 'up' | 'down'; stop?: number }
    | { t: 'length-word'; to: 'up' | 'down' | Verbosity }
    | { t: 'checkin' }
    | { t: 'open-ended' }
    | { t: 'target'; of: 'vibe' | 'focus' | 'guidance' | 'responses' | 'timer' };

const mode = (m: BeginMode): Meaning => ({ t: 'mode', mode: m });
const focus = (f: SetupFocus): Meaning => ({ t: 'focus', focus: f });
const quality = (q: Quality): Meaning => ({ t: 'quality', quality: q });
const target = (of: 'vibe' | 'focus' | 'guidance' | 'responses' | 'timer'): Meaning => ({ t: 'target', of });

/**
 * Everything that carries a value, by the words it is said with. Multi-word
 * entries win over their parts ("feeling good" is a vibe, "feeling tone" a
 * focus, and a bare "feeling" is neither).
 */
const PHRASES: Record<string, Meaning> = {
    exploration: mode('exploration'),
    explore: mode('exploration'),
    exploring: mode('exploration'),
    exploratory: mode('exploration'),
    noting: mode('noting'),
    'felt sense': mode('felt_sense'),
    feltsense: mode('felt_sense'),
    focusing: mode('felt_sense'),

    body: focus('body_sensations'),
    bodily: focus('body_sensations'),
    physical: focus('body_sensations'),
    sensations: focus('body_sensations'),
    sensation: focus('body_sensations'),
    'body sensations': focus('body_sensations'),
    emotions: focus('emotions'),
    emotion: focus('emotions'),
    emotional: focus('emotions'),
    feelings: focus('emotions'),
    'feeling tone': focus('emotions'),
    parts: focus('inner_parts'),
    'inner parts': focus('inner_parts'),
    'inner world': focus('inner_parts'),
    'parts work': focus('inner_parts'),

    playful: quality('playful'),
    playfulness: quality('playful'),
    lighthearted: quality('playful'),
    light: quality('playful'),
    compassionate: quality('compassionate'),
    compassion: quality('compassionate'),
    loving: quality('loving'),
    love: quality('loving'),
    kind: quality('loving'),
    kindness: quality('loving'),
    'loving kindness': quality('loving'),
    spacious: quality('spacious'),
    spaciousness: quality('spacious'),
    space: quality('spacious'),
    effortless: quality('effortless'),
    effortlessness: quality('effortless'),
    'feeling good': quality('feeling_good'),
    'feel good': quality('feeling_good'),
    'feels good': quality('feeling_good'),
    pleasant: quality('feeling_good'),

    following: { t: 'lead', toward: 'down', stop: 0 },
    'somewhat following': { t: 'lead', toward: 'down', stop: 1 },
    balanced: { t: 'lead', toward: 'up', stop: 2 },
    'somewhat directing': { t: 'lead', toward: 'up', stop: 3 },
    directing: { t: 'lead', toward: 'up', stop: 4 },
    directive: { t: 'lead', toward: 'up', stop: 4 },
    follow: { t: 'lead', toward: 'down' },
    lead: { t: 'lead', toward: 'up' },
    leading: { t: 'lead', toward: 'up' },
    direction: { t: 'lead', toward: 'up' },

    shorter: { t: 'length-word', to: 'down' },
    fewer: { t: 'length-word', to: 'down' },
    longer: { t: 'length-word', to: 'up' },
    brief: { t: 'length-word', to: 'low' },
    short: { t: 'length-word', to: 'low' },
    medium: { t: 'length-word', to: 'medium' },
    long: { t: 'length-word', to: 'high' },

    'check in': { t: 'checkin' },
    'check ins': { t: 'checkin' },
    'checking in': { t: 'checkin' },
    checkin: { t: 'checkin' },
    checkins: { t: 'checkin' },

    'open ended': { t: 'open-ended' },
    untimed: { t: 'open-ended' },

    vibe: target('vibe'),
    vibes: target('vibe'),
    focus: target('focus'),
    focuses: target('focus'),
    attention: target('focus'),
    guidance: target('guidance'),
    guide: target('guidance'),
    guiding: target('guidance'),
    responses: target('responses'),
    response: target('responses'),
    replies: target('responses'),
    reply: target('responses'),
    answers: target('responses'),
    talk: target('responses'),
    talking: target('responses'),
    speak: target('responses'),
    speaking: target('responses'),
    say: target('responses'),
    words: target('responses'),
    timer: target('timer'),
    clock: target('timer'),
};

/**
 * What a recognizer has been seen to write for one of the phrases above, where
 * no rule of sound would get there. From the misheard corpus
 * (scripts/jev-commands.ts, `SETUP_MISHEARD`); add to it from real transcripts.
 */
const HEARD_AS: Record<string, string> = {
    'felt cents': 'felt sense',
    'felt since': 'felt sense',
    'felt scents': 'felt sense',
    'felt sends': 'felt sense',
    'fell sense': 'felt sense',
    'felt sents': 'felt sense',
    'felt sence': 'felt sense',
    'check ends': 'check ins',
    'check inns': 'check ins',
};

const LONGEST_PHRASE = 2;

/** Said in front of (or after) a value to take it away. */
const NEGATIONS = new Set([
    'no', 'not', 'without', 'remove', 'drop', 'off', 'stop', 'disable', 'lose', 'uncheck',
    'unselect', 'deselect', 'clear', 'cancel', "don't", 'dont', 'never',
]);
/** Said to put one back. A value by itself already means this. */
const ADDITIONS = new Set(['add', 'on', 'enable', 'include', 'plus', 'yes']);
/** "Change the vibe to spacious" replaces the vibes; "add spacious" adds one. */
const SETTERS = new Set(['set', 'change', 'switch', 'make']);
const ONLY = new Set(['only']);
const STEPS: Record<string, 'up' | 'down'> = {
    more: 'up', up: 'up', higher: 'up', increase: 'up', raise: 'up',
    less: 'down', down: 'down', lower: 'down', decrease: 'down', reduce: 'down',
};

/** The words people wrap around a request. Exact only. */
const FILLER = new Set([
    'a', 'aloud', 'also', 'an', 'are', 'be', 'bit', 'can', 'choose', 'could', 'do', 'for', 'give', 'go',
    'have', 'hey', 'i', "i'd", "i'm", 'id', 'im', 'in', 'is', 'it', 'just', 'kinda', 'length', 'let', "let's",
    'lets', 'level', 'like', 'little', 'me', 'meditation', 'mode', 'my', 'now', 'of', 'ok', 'okay', 'one',
    'pick', 'please', 'practice', 'put', 'select', 'session', 'setting', 'some', 'thanks', 'that', 'the',
    'this', 'to', 'too', 'try', 'turn', 'use', 'want', 'we', 'with', 'would', 'you',
]);

/** A length, taken out before the rest is read (parseTimerRequest reads it). */
const LENGTH_UNITS = new Set(['minute', 'minutes', 'min', 'mins', 'hour', 'hours', 'hr', 'hrs']);
const NUMBER_WORDS = new Set([
    'half',
    'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
    'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
    'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
]);

/** Splits a request into its parts: "felt sense and twenty minutes". */
const JOINERS = new Set(['and', 'then', 'plus']);

/** Whole requests, said as they are. */
const STOP_LISTENING = new Set([
    'stop listening', 'mute', 'mic off', 'microphone off', 'turn off the mic', 'turn off the microphone',
    'turn the mic off', 'turn the microphone off', 'close the mic', 'close the microphone', 'you can stop listening',
    'stop listening to me',
]);
const HELP = new Set([
    'help', 'what can i say', 'what can i say here', 'what can you do', 'what are my options',
    'what are the options', 'what can i change',
]);
const POLITE = new Set(['please', 'ok', 'okay', 'hey', 'aloud', 'now', 'thanks']);

// ---- loose matching ---------------------------------------------------------

/**
 * A word reduced to roughly how it sounds: consonants only, the ones a
 * recognizer confuses folded together (b/p, d/t, v/f, s/z, m/n), a leading
 * vowel kept as a mark. "spacious" and "spaces" are both `spss`; "noting" and
 * "nothing" both `ntnk`.
 */
export function soundKey(word: string): string {
    const w = word
        .toLowerCase()
        .replace(/[^a-z]/g, '')
        .replace(/^kn/, 'n')
        .replace(/^wr/, 'r')
        .replace(/ph/g, 'f')
        .replace(/gh/g, '')
        .replace(/tch/g, 'x')
        .replace(/[sc]h/g, 'x')
        .replace(/ti(?=o)/g, 'x')
        .replace(/th/g, 't')
        .replace(/ck/g, 'k')
        .replace(/c(?=[eiy])/g, 's')
        .replace(/[cqg]/g, 'k')
        .replace(/x(?=.)|x$/g, (m, at: number, all: string) => (all[at - 1] === undefined ? m : m))
        .replace(/z/g, 's')
        .replace(/v/g, 'f')
        .replace(/b/g, 'p')
        .replace(/d/g, 't')
        .replace(/m/g, 'n');
    const lead = /^[aeiou]/.test(w) ? 'a' : '';
    return lead + w.replace(/[aeiouyhw]/g, '').replace(/(.)\1+/g, '$1');
}

/** Edits between two words, a swap of neighbours counting as one. */
export function editDistance(a: string, b: string): number {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const d: number[][] = Array.from({ length: rows }, (_, i) => {
        const row = new Array<number>(cols).fill(0);
        row[0] = i;
        return row;
    });
    for (let j = 0; j < cols; j++) d[0]![j] = j;
    for (let i = 1; i < rows; i++) {
        for (let j = 1; j < cols; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                best = Math.min(best, d[i - 2]![j - 2]! + 1);
            }
            d[i]![j] = best;
        }
    }
    return d[a.length]![b.length]!;
}

/** The single words that carry a value, the only ones matched loosely. Under
 *  four letters there is too little of a word to be near anything. */
const LOOSE_WORDS: ReadonlyArray<{ word: string; key: string }> = [
    ...new Set(
        Object.keys(PHRASES)
            .flatMap((phrase) => phrase.split(' '))
            .filter((word) => word.length >= 4)
    ),
].map((word) => ({ word, key: soundKey(word) }));

/** Every word this file reads exactly; none of these is ever "near" another. */
const EXACT_WORDS = new Set<string>([
    ...Object.keys(PHRASES).flatMap((p) => p.split(' ')),
    ...Object.keys(HEARD_AS).flatMap((p) => p.split(' ')),
    ...NEGATIONS, ...ADDITIONS, ...SETTERS, ...ONLY, ...Object.keys(STEPS), ...FILLER,
    ...LENGTH_UNITS, ...NUMBER_WORDS, ...JOINERS,
    // Never a setting, whatever they sound like: begin-command.ts owns these.
    'begin', 'start',
]);

/**
 * The value word a misheard one most likely was, or null. Close in spelling
 * (one edit, two in a long word), or the same in sound and not far in
 * spelling. Two candidates equally near is no answer.
 */
export function nearestWord(heard: string): string | null {
    if (heard.length < 4 || !/^[a-z']+$/.test(heard)) return null;
    const key = soundKey(heard);
    let best: { word: string; distance: number; sameSound: boolean } | null = null;
    let tied = false;
    for (const candidate of LOOSE_WORDS) {
        const length = candidate.word.length;
        const distance = editDistance(heard, candidate.word);
        const sameSound = candidate.key === key;
        const near =
            (sameSound && distance <= (length <= 4 ? 1 : Math.max(2, Math.floor(length / 3)))) ||
            (length >= 5 && distance <= 1) ||
            (length >= 8 && distance <= 2);
        if (!near) continue;
        if (!best || distance < best.distance || (distance === best.distance && sameSound && !best.sameSound)) {
            best = { word: candidate.word, distance, sameSound };
            tied = false;
        } else if (distance === best.distance && sameSound === best.sameSound) {
            tied = true;
        }
    }
    return best && !tied ? best.word : null;
}

// ---- reading a request ------------------------------------------------------

function tokens(utterance: string): string[] {
    return utterance
        .toLowerCase()
        .replace(/[’‘]/g, "'")
        // "check-ins", "open-ended", "twenty-minute".
        .replace(/-/g, ' ')
        .replace(/[^a-z0-9' ]+/g, ' ')
        .split(' ')
        .filter(Boolean);
}

/** Pull "twenty minutes" / "an hour and a half" out of the words. Returns the
 *  minutes and what is left, null when a unit has no number it can read. */
function takeLength(words: string[]): { minutes: number | null; rest: string[] } | null {
    const unitAt = words.findIndex((w) => LENGTH_UNITS.has(w));
    if (unitAt < 0) return { minutes: null, rest: words };
    let from = unitAt;
    while (
        from > 0 &&
        (NUMBER_WORDS.has(words[from - 1]!) || /^\d{1,3}$/.test(words[from - 1]!) || /^(a|an|and)$/.test(words[from - 1]!))
    ) {
        from--;
    }
    let to = unitAt + 1;
    if (words.slice(to, to + 3).join(' ') === 'and a half') to += 3;
    const request = parseTimerRequest(words.slice(from, to).join(' '));
    if (!request || request.relative) return null;
    const rest = [...words.slice(0, from), ...words.slice(to)];
    // One length to a request.
    if (rest.some((w) => LENGTH_UNITS.has(w))) return null;
    return { minutes: request.minutes, rest };
}

type Polarity = 'on' | 'off';

interface Clause {
    actions: SetupAction[];
    /** A negation said ahead of its values carries into the next part:
     *  "remove playful and loving" removes both. */
    carry: Polarity | null;
}

/** One part of a request (between "and"s). Null when it isn't one. */
function readClause(words: string[], carried: Polarity | null): Clause | null {
    const meanings: Meaning[] = [];
    let negated = false;
    let added = false;
    let negatedFirst = false;
    let setter = false;
    let only = false;
    let step: 'up' | 'down' | null = null;

    for (let i = 0; i < words.length; ) {
        let matched = false;
        for (let span = Math.min(LONGEST_PHRASE, words.length - i); span >= 1 && !matched; span--) {
            const said = words.slice(i, i + span).join(' ');
            const phrase = PHRASES[HEARD_AS[said] ?? said];
            if (phrase) {
                meanings.push(phrase);
                i += span;
                matched = true;
            }
        }
        if (matched) continue;
        const word = words[i]!;
        i++;
        if (NEGATIONS.has(word)) {
            if (!negated && !added && meanings.every((m) => m.t === 'target')) negatedFirst = true;
            negated = true;
        } else if (ADDITIONS.has(word)) added = true;
        else if (SETTERS.has(word)) setter = true;
        else if (ONLY.has(word)) only = true;
        else if (word in STEPS) {
            // "Turn down the guidance" and "no, less guidance" both mean down;
            // two directions in one part mean nothing.
            if (step && step !== STEPS[word]) return null;
            step = STEPS[word]!;
        } else if (!FILLER.has(word)) return null;
    }

    const has = (of: string): boolean => meanings.some((m) => m.t === 'target' && m.of === of);
    const own: Polarity | null = negated && !added ? 'off' : added || negated ? 'on' : null;
    const polarity: Polarity = own ?? carried ?? 'on';
    const carry = own === null ? carried : negatedFirst && own === 'off' ? 'off' : null;
    const actions: SetupAction[] = [];
    let stepUsed = false;
    let targetUsed = { vibe: false, focus: false, guidance: false, responses: false, timer: false };

    const leads = meanings.filter((m): m is Extract<Meaning, { t: 'lead' }> => m.t === 'lead');
    const lengthWords = meanings.filter((m): m is Extract<Meaning, { t: 'length-word' }> => m.t === 'length-word');
    const values = meanings.filter((m) => m.t === 'mode' || m.t === 'focus' || m.t === 'quality');

    // Who leads. "More guidance", "guide me less", "more directing", or a
    // stop by its name ("following").
    if (leads.length > 1) return null;
    if (leads.length === 1) {
        const lead = leads[0]!;
        if (step) {
            actions.push({ kind: 'guidance', to: step === lead.toward ? 'up' : 'down' });
            // "More following" is less guidance.
            if (lead.toward === 'down') actions[actions.length - 1] = { kind: 'guidance', to: step === 'up' ? 'down' : 'up' };
            stepUsed = true;
        } else if (lead.stop !== undefined && !negated) actions.push({ kind: 'guidance', to: lead.stop });
        else return null;
        targetUsed.guidance = true;
    } else if (has('guidance')) {
        if (!step) return null;
        actions.push({ kind: 'guidance', to: step });
        stepUsed = true;
        targetUsed.guidance = true;
    }

    // How much it says. Always beside a word for the talking, since "longer"
    // alone could as well be the session.
    if (lengthWords.length > 1) return null;
    if (lengthWords.length === 1) {
        if (!has('responses')) return null;
        actions.push({ kind: 'verbosity', to: lengthWords[0]!.to });
        targetUsed.responses = true;
    } else if (has('responses')) {
        if (!step || stepUsed) return null;
        actions.push({ kind: 'verbosity', to: step });
        stepUsed = true;
        targetUsed.responses = true;
    }

    if (meanings.some((m) => m.t === 'open-ended')) actions.push({ kind: 'no-timer' });
    if (has('timer')) {
        // A timer by itself says nothing; with a length it is filler.
        if (negated && !added) actions.push({ kind: 'no-timer' });
        targetUsed.timer = true;
    }

    if (meanings.some((m) => m.t === 'checkin')) actions.push({ kind: 'checkins', on: polarity === 'on' });

    // "More playful" is playful; "less playful" is not.
    const valuePolarity: Polarity = step && !stepUsed ? (step === 'down' ? 'off' : 'on') : polarity;
    if (values.length > 0 && step && !stepUsed) stepUsed = true;
    const replace = only || setter;
    for (const group of ['focus', 'quality'] as const) {
        const said = values.filter((m) => m.t === group);
        const named = has(group === 'quality' ? 'vibe' : 'focus');
        if (said.length === 0) {
            // "Clear the vibes", "no focus".
            if (named && negated && !added) actions.push({ kind: 'clear', group });
            else if (named && values.length === 0 && actions.length === 0) return null;
            continue;
        }
        if (replace && valuePolarity === 'on' && (only || named)) actions.push({ kind: 'clear', group });
    }
    for (const value of values) {
        if (value.t === 'mode') {
            if (negated && !added) return null;
            actions.push({ kind: 'mode', mode: value.mode });
        } else if (value.t === 'focus') actions.push({ kind: 'focus', focus: value.focus, on: valuePolarity === 'on' });
        else if (value.t === 'quality') actions.push({ kind: 'quality', quality: value.quality, on: valuePolarity === 'on' });
    }
    if (step && !stepUsed) return null;
    void targetUsed;
    return { actions, carry };
}

/** The same change said twice in one request is one change; the later wins. */
function dedupe(actions: SetupAction[]): SetupAction[] {
    const keyOf = (a: SetupAction): string =>
        a.kind === 'focus' ? `focus:${a.focus}` : a.kind === 'quality' ? `quality:${a.quality}` : a.kind === 'clear' ? `clear:${a.group}` : a.kind;
    const last = new Map<string, number>();
    actions.forEach((a, i) => last.set(keyOf(a), i));
    // A clear stays where it was first said, ahead of what it makes room for.
    const firstClear = new Map<string, number>();
    actions.forEach((a, i) => {
        if (a.kind === 'clear' && !firstClear.has(keyOf(a))) firstClear.set(keyOf(a), i);
    });
    return actions.filter((a, i) => (a.kind === 'clear' ? firstClear.get(keyOf(a)) === i : last.get(keyOf(a)) === i));
}

const INTENTION_RE =
    /^(?:(?:ok|okay|please|hey|aloud|and)\s+)*(?:(?:set|change|make|let)\s+)?(?:(?:my|the|an|our)\s+)?intention(?:\s+for\s+(?:this|today|the)(?:\s+session)?)?\s+(?:is\s+|to\s+be\s+|as\s+|be\s+)?(.+)$/i;
const SIT_WITH_RE =
    /^(?:(?:ok|okay|please|hey|aloud)\s+)*(?:(?:i\s+want|i'd\s+like|i\s+would\s+like|let's|lets|let\s+me)\s+(?:to\s+)?)?(?:something\s+to\s+)?sit\s+with\s+(?:is\s+)?(.+)$/i;
const CLEAR_INTENTION_RE =
    /^(?:(?:ok|okay|please)\s+)*(?:clear|remove|drop|delete|erase|no|cancel|forget)\s+(?:(?:my|the)\s+)?intention(?:\s+please)?$/i;

function parseIntention(utterance: string): SetupAction | null {
    const said = utterance.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!?。]+$/u, '');
    if (CLEAR_INTENTION_RE.test(said)) return { kind: 'intention', text: '' };
    const match = INTENTION_RE.exec(said) ?? SIT_WITH_RE.exec(said);
    if (!match) return null;
    const text = match[1]!.trim().replace(/^[:,\s]+/, '');
    if (!text || text.split(' ').length > INTENTION_MAX_WORDS) return null;
    if (/^(?:off|clear|cleared|none|nothing|blank|empty)$/i.test(text)) return { kind: 'intention', text: '' };
    return { kind: 'intention', text };
}

// ---- zh ---------------------------------------------------------------------

const ZH_LENGTH = '(?:[\\d零一二两三四五六七八九十]+分钟|[\\d零一二两三四五六七八九十]+个?半?小时|半个?小时)';
const ZH_OFF = '(?:不要|不用|去掉|取消|关掉|关闭|别)';
const ZH_ON = '(?:加上|添加|打开|开启|要|选|用|来点|换成|改成|切换到|切到|设为|设成)';

/** A value by the setup screen's own name, and the shorter things people say. */
const ZH_VALUES: ReadonlyArray<[RegExp, (on: boolean) => SetupAction | null]> = [
    [/^探索(?:模式)?$/, () => ({ kind: 'mode', mode: 'exploration' })],
    [/^标记(?:模式)?$/, () => ({ kind: 'mode', mode: 'noting' })],
    [/^体会(?:模式)?$/, () => ({ kind: 'mode', mode: 'felt_sense' })],
    [/^(?:身体(?:与|和)?感受|身体|感受)$/, (on) => ({ kind: 'focus', focus: 'body_sensations', on })],
    [/^(?:情绪(?:与|和)?感受基调|情绪|情感)$/, (on) => ({ kind: 'focus', focus: 'emotions', on })],
    [/^(?:内在部分(?:与|和)?内心世界|内在部分|内心世界|部分)$/, (on) => ({ kind: 'focus', focus: 'inner_parts', on })],
    [/^(?:轻松有玩心|轻松|玩心|有玩心)$/, (on) => ({ kind: 'quality', quality: 'playful', on })],
    [/^慈悲$/, (on) => ({ kind: 'quality', quality: 'compassionate', on })],
    [/^慈爱$/, (on) => ({ kind: 'quality', quality: 'loving', on })],
    [/^开阔$/, (on) => ({ kind: 'quality', quality: 'spacious', on })],
    [/^不费力$/, (on) => ({ kind: 'quality', quality: 'effortless', on })],
    [/^(?:感觉不错|感觉好|感觉良好)$/, (on) => ({ kind: 'quality', quality: 'feeling_good', on })],
    [/^(?:氛围|所有氛围)$/, (on) => (on ? null : { kind: 'clear', group: 'quality' })],
    [/^(?:焦点|注意焦点|所有焦点)$/, (on) => (on ? null : { kind: 'clear', group: 'focus' })],
    [/^(?:计时器?|定时器?)$/, (on) => (on ? null : { kind: 'no-timer' })],
    [/^(?:问候我?|打扰我?)$/, (on) => ({ kind: 'checkins', on })],
    [/^跟随$/, (on) => (on ? { kind: 'guidance', to: 0 } : null)],
    [/^均衡$/, (on) => (on ? { kind: 'guidance', to: 2 } : null)],
    [/^主导$/, (on) => (on ? { kind: 'guidance', to: 4 } : null)],
];

/** Whole phrases with a direction in them. */
const ZH_STEPS: ReadonlyArray<[RegExp, SetupAction]> = [
    [/^(?:多(?:一点|一些|点|些)?引导|引导多(?:一点|一些|点|些)|多引导我?(?:一点|一些)?)$/, { kind: 'guidance', to: 'up' }],
    [/^(?:少(?:一点|一些|点|些)?引导|引导少(?:一点|一些|点|些)|少引导我?(?:一点|一些)?)$/, { kind: 'guidance', to: 'down' }],
    [/^(?:说少(?:一点|一些|点|些)|少说(?:一点|一些|点|些)?|回应短(?:一点|一些|点|些)|短(?:一点|一些|点|些))$/, { kind: 'verbosity', to: 'down' }],
    [/^(?:说多(?:一点|一些|点|些)|多说(?:一点|一些|点|些)?|回应长(?:一点|一些|点|些)|长(?:一点|一些|点|些))$/, { kind: 'verbosity', to: 'up' }],
    [/^(?:回应)?简短(?:一点|一些)?$/, { kind: 'verbosity', to: 'low' }],
    [/^(?:回应)?更长$/, { kind: 'verbosity', to: 'high' }],
    [/^(?:安静时)?(?:轻声)?问候我$/, { kind: 'checkins', on: true }],
    [/^(?:停止聆听|别听了|不要听了|停止收听|静音|关闭麦克风|关掉麦克风)$/, { kind: 'stop-listening' }],
    [/^(?:帮助|我可以说什么|我能说什么|可以说什么|有哪些选项)$/, { kind: 'help' }],
    [/^(?:清除|清空|删除|去掉|取消)(?:我的)?意图$/, { kind: 'intention', text: '' }],
];

function parseZh(utterance: string): SetupAction[] | null {
    const intention = /^(?:请|把)?(?:我的|这次的?)?意图(?:是|设为|设成|改成|为)(.+?)[。！？.!?]*$/u.exec(utterance.replace(/\s+/g, ''));
    if (intention && intention[1]!.length <= 120) return [{ kind: 'intention', text: intention[1]! }];

    const said = utterance.replace(/[\s。！？．.…!?~]+/gu, '');
    if (!said || said.length > 40) return null;
    const actions: SetupAction[] = [];
    // 、 and 和 join values; 然后 / 还有 join requests.
    for (const rawPart of said.split(/[，,、；;]|然后|还有|以及|和(?!感受)(?!内心)/u)) {
        // The polite wrapping, front and back.
        let part = rawPart.replace(/^(?:好的?|请|麻烦|我想要?|我要|帮我|给我|把|我们)+/u, '').replace(/(?:吧|了|一下|好吗|可以吗|谢谢|的?模式|的?氛围|的?焦点)+$/u, (tail) =>
            // "探索模式" keeps its name; only the trailing politeness goes.
            /模式|氛围|焦点/.test(tail) ? tail.replace(/(?:吧|了|一下|好吗|可以吗|谢谢)+/gu, '') : ''
        );
        if (!part) continue;

        const step = ZH_STEPS.find(([re]) => re.test(part));
        if (step) {
            actions.push(step[1]);
            continue;
        }
        const length = new RegExp(`^(?:设(?:定|置)?|定)?(?:一个)?(?:计时器?|定时器?|时间|时长)?(?:为|成|到)?(${ZH_LENGTH})(?:的?计时器?)?$`, 'u').exec(part);
        if (length) {
            const request = parseTimerRequest(length[1]!);
            if (!request || request.relative) return null;
            actions.push({ kind: 'length', minutes: request.minutes });
            continue;
        }
        let on = true;
        const off = new RegExp(`^${ZH_OFF}`, 'u').exec(part);
        if (off) {
            on = false;
            part = part.slice(off[0].length);
        } else {
            const add = new RegExp(`^${ZH_ON}`, 'u').exec(part);
            if (add) part = part.slice(add[0].length);
        }
        part = part.replace(/(?:的?氛围|的?焦点)$/u, (tail) => (part === tail.replace(/^的/, '') ? tail : ''));
        const value = ZH_VALUES.find(([re]) => re.test(part));
        const action = value ? value[1](on) : null;
        if (!action) return null;
        actions.push(action);
    }
    return actions.length > 0 ? dedupe(actions) : null;
}

// ---- the parser -------------------------------------------------------------

/**
 * The changes an utterance asks for, in the order said, or null when it is not
 * (only) a request to change the setup. Never a request to begin.
 */
export function parseSetupCommand(utterance: string): SetupAction[] | null {
    if (/[㐀-鿿]/.test(utterance)) return parseZh(utterance);

    const exact = tokens(utterance);
    if (exact.length === 0) return null;
    const bare = exact.filter((w) => !POLITE.has(w)).join(' ');
    if (STOP_LISTENING.has(bare)) return [{ kind: 'stop-listening' }];
    if (HELP.has(bare)) return [{ kind: 'help' }];

    const intention = parseIntention(utterance);
    if (intention) return [intention];
    if (exact.length > SETUP_MAX_WORDS) return null;
    // A request to begin is begin-command's, with its strict match.
    if (exact.includes('begin') || exact.includes('start')) return null;

    const words = exact.map((word) => (EXACT_WORDS.has(word) || /^\d+$/.test(word) ? word : (nearestWord(word) ?? word)));
    const length = takeLength(words);
    if (!length) return null;

    const actions: SetupAction[] = [];
    if (length.minutes !== null) actions.push({ kind: 'length', minutes: length.minutes });
    let carried: Polarity | null = null;
    let part: string[] = [];
    const parts: string[][] = [];
    for (const word of length.rest) {
        if (JOINERS.has(word)) {
            parts.push(part);
            part = [];
        } else part.push(word);
    }
    parts.push(part);
    for (const clauseWords of parts) {
        if (clauseWords.length === 0) continue;
        const clause = readClause(clauseWords, carried);
        if (!clause) return null;
        actions.push(...clause.actions);
        carried = clause.carry;
    }
    return actions.length > 0 ? dedupe(actions) : null;
}

/** True when the utterance changes the setup and says nothing else. */
export function isSetupCommand(utterance: string): boolean {
    return parseSetupCommand(utterance) !== null;
}

/**
 * What to tell a recognizer to expect on the setup screen (Whisper's initial
 * prompt, a hosted model's prompt, the phone recognizers' phrase lists).
 * "Begin" is left out on purpose: a prompted word is the one a recognizer
 * writes over noise, and it is the one costly thing to hear by mistake.
 */
export function setupVocabulary(language: string): { prompt: string; phrases: string[] } {
    if (language === 'zh') {
        const phrases = [
            '探索', '标记', '体会', '氛围', '焦点', '身体与感受', '情绪', '内在部分', '轻松有玩心', '慈悲', '慈爱',
            '开阔', '不费力', '感觉不错', '多一点引导', '少一点引导', '跟随', '均衡', '主导', '简短', '意图',
            '二十分钟', '计时器',
        ];
        return { prompt: `${phrases.join('，')}。`, phrases };
    }
    const phrases = [
        'exploration', 'noting', 'felt sense', 'vibes', 'focus', 'body and sensations', 'emotions', 'parts',
        'playful', 'compassionate', 'loving', 'spacious', 'effortless', 'feeling good', 'more guidance',
        'less guidance', 'following', 'balanced', 'directing', 'shorter responses', 'longer responses',
        'my intention is', 'check-ins', 'twenty minutes', 'no timer',
    ];
    return {
        prompt:
            'Exploration, noting, felt sense. Vibes: playful, compassionate, loving, spacious, effortless, feeling good. ' +
            'Focus: body and sensations, emotions, parts. More guidance, less guidance. Shorter responses. ' +
            'My intention is to rest. Check-ins off. Twenty minutes, no timer.',
        phrases,
    };
}

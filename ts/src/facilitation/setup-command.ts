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

/** The shortest session a spoken length can ask for. */
const SETUP_MIN_MINUTES = 2;

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
    | { t: 'target'; of: Target };

type Target = 'vibe' | 'focus' | 'guidance' | 'responses' | 'timer' | 'mode';

interface Entry {
    meaning: Meaning;
    /**
     * Whether the phrase is a request all by itself. The names the setup
     * screen shows are ("Playful.", "Noting."). Another form of one
     * ("emotional", "playfulness") is only a request beside a word that asks
     * for something (`ASKING`): alone it is what a room says. The everyday
     * words that also mean one ("light", "kind", "space", "love") are not
     * here at all: "turn on the light" is said in rooms. The judge tier
     * reads those, where there is one.
     */
    bare: boolean;
}

const named = (meaning: Meaning): Entry => ({ meaning, bare: true });
const also = (meaning: Meaning): Entry => ({ meaning, bare: false });
const mode = (m: BeginMode): Meaning => ({ t: 'mode', mode: m });
const focus = (f: SetupFocus): Meaning => ({ t: 'focus', focus: f });
const quality = (q: Quality): Meaning => ({ t: 'quality', quality: q });
const target = (of: Target): Entry => named({ t: 'target', of });

/**
 * Everything that carries a value, by the words it is said with. Longer
 * entries win over their parts ("feeling good" is a vibe, "feeling tone" a
 * focus, and a bare "feeling" is neither), which is also how a label with an
 * "and" in it stays one thing ("playful and light").
 */
const PHRASES: Record<string, Entry> = {
    exploration: named(mode('exploration')),
    explore: named(mode('exploration')),
    exploring: also(mode('exploration')),
    exploratory: also(mode('exploration')),
    noting: named(mode('noting')),
    'felt sense': named(mode('felt_sense')),
    feltsense: named(mode('felt_sense')),

    body: named(focus('body_sensations')),
    sensations: named(focus('body_sensations')),
    'body sensations': named(focus('body_sensations')),
    'body and sensations': named(focus('body_sensations')),
    'bodily sensations': named(focus('body_sensations')),
    'physical sensations': named(focus('body_sensations')),
    bodily: also(focus('body_sensations')),
    physical: also(focus('body_sensations')),
    sensation: also(focus('body_sensations')),
    emotions: named(focus('emotions')),
    'feeling tone': named(focus('emotions')),
    'emotions and feeling tone': named(focus('emotions')),
    emotion: also(focus('emotions')),
    emotional: also(focus('emotions')),
    feelings: also(focus('emotions')),
    parts: named(focus('inner_parts')),
    'inner parts': named(focus('inner_parts')),
    'inner world': named(focus('inner_parts')),
    'parts and inner world': named(focus('inner_parts')),
    'parts work': named(focus('inner_parts')),

    playful: named(quality('playful')),
    'playful and light': named(quality('playful')),
    lighthearted: named(quality('playful')),
    playfulness: also(quality('playful')),
    compassionate: named(quality('compassionate')),
    compassion: named(quality('compassionate')),
    loving: named(quality('loving')),
    'loving and kind': named(quality('loving')),
    'loving kindness': named(quality('loving')),
    kindness: also(quality('loving')),
    spacious: named(quality('spacious')),
    spaciousness: named(quality('spacious')),
    effortless: named(quality('effortless')),
    effortlessness: named(quality('effortless')),
    'feeling good': named(quality('feeling_good')),
    'feel good': also(quality('feeling_good')),
    'feels good': also(quality('feeling_good')),
    pleasant: also(quality('feeling_good')),

    following: named({ t: 'lead', toward: 'down', stop: 0 }),
    'somewhat following': named({ t: 'lead', toward: 'down', stop: 1 }),
    balanced: named({ t: 'lead', toward: 'up', stop: 2 }),
    balance: also({ t: 'lead', toward: 'up', stop: 2 }),
    'somewhat directing': named({ t: 'lead', toward: 'up', stop: 3 }),
    directing: named({ t: 'lead', toward: 'up', stop: 4 }),
    directive: also({ t: 'lead', toward: 'up', stop: 4 }),
    follow: named({ t: 'lead', toward: 'down' }),
    lead: named({ t: 'lead', toward: 'up' }),
    leading: named({ t: 'lead', toward: 'up' }),
    direction: named({ t: 'lead', toward: 'up' }),

    shorter: named({ t: 'length-word', to: 'down' }),
    fewer: named({ t: 'length-word', to: 'down' }),
    longer: named({ t: 'length-word', to: 'up' }),
    brief: named({ t: 'length-word', to: 'low' }),
    short: named({ t: 'length-word', to: 'low' }),
    medium: named({ t: 'length-word', to: 'medium' }),
    long: named({ t: 'length-word', to: 'high' }),

    'check in': named({ t: 'checkin' }),
    'check ins': named({ t: 'checkin' }),
    'checking in': named({ t: 'checkin' }),
    checkin: named({ t: 'checkin' }),
    checkins: named({ t: 'checkin' }),

    'open ended': named({ t: 'open-ended' }),
    untimed: named({ t: 'open-ended' }),

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
    'time limit': target('timer'),
    mode: target('mode'),
};

/**
 * What a recognizer has been seen to write for one of the phrases above, where
 * no rule of sound would get there or the word heard is too ordinary to match
 * loosely. From synthetic speech through local Whisper
 * (scripts/setup-voice); add to it from real transcripts. These count as the
 * phrase itself, so the phrase's own `bare` rule applies.
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
    spaces: 'spacious',
};

const LONGEST_PHRASE = Math.max(...[...Object.keys(PHRASES), ...Object.keys(HEARD_AS)].map((p) => p.split(' ').length));

/** Two-word things a room says that are made of this vocabulary's words. */
const NOT_A_REQUEST = new Set(['body parts']);

/** Level words: they move the guidance, and say nothing of how much is said
 *  ("speak up" asks for volume). */
const LEVEL_STEPS = new Set(['up', 'down', 'higher', 'lower', 'raise']);

/** What may stand around a length for it to be a request to set one. "Give me
 *  five minutes" and "in twenty minutes" are what people say to each other. */
const LENGTH_COMPANY = new Set([
    'a', 'an', 'the', 'for', 'to', 'it', 'set', 'make', 'change', 'timer', 'clock', 'session', 'meditation',
    'please', 'ok', 'okay', "let's", 'lets', 'do', 'i', "i'd", 'id', 'want', 'like', 'would', 'about',
]);

/** Said in front of (or after) a value to take it away. */
const NEGATIONS = new Set([
    'no', 'not', 'without', 'remove', 'drop', 'off', 'stop', 'disable', 'lose', 'uncheck',
    'unselect', 'deselect', 'clear', 'cancel', "don't", 'dont', 'never',
]);
/** These deny whatever else is said: "don't check in on me" is off, for all
 *  its "on". */
const DENIALS = new Set(['no', 'not', 'without', 'stop', "don't", 'dont', 'never']);
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
    'a', 'about', 'all', 'aloud', 'also', 'an', 'bit', 'can', 'choose', 'could', 'do', 'for', 'give', 'go',
    'have', 'hey', 'i', "i'd", 'id', 'in', 'it', 'just', 'keep', 'kinda', 'length', 'let',
    "let's", 'lets', 'level', 'like', 'little', 'me', 'meditation', 'now', 'of', 'ok', 'okay', 'one',
    'pick', 'please', 'practice', 'put', 'select', 'session', 'setting', 'some', 'thanks', 'the',
    'this', 'to', 'too', 'try', 'turn', 'use', 'want', 'with', 'would', 'you', 'your',
]);

/**
 * Words that make an utterance a request rather than a remark. A value that
 * can't stand alone (an `also` entry, or one matched loosely) needs one of
 * these, a target ("vibe", "mode") or a step ("more") somewhere beside it.
 * Only verbs of choosing: "I want nothing" and "I have feelings" ask for
 * nothing.
 */
const ASKING = new Set([
    ...NEGATIONS, ...ADDITIONS, ...SETTERS, ...ONLY, ...Object.keys(STEPS),
    'choose', 'pick', 'select', 'use',
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
    'stop listening to me', 'mute the mic', 'mute the microphone',
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
 * vowel kept as a mark. "spacious" and "specious" are both `sps`; "noting" and
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
            .filter((word) => word.length >= 4 && word !== 'and')
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
 * The value word a misheard one most likely was, or null: the same in sound
 * and close in spelling (one edit in a four-letter word, more in a longer
 * one). Two candidates equally near is no answer.
 *
 * Sound alone is not enough to act on: "living" sounds like "loving" and
 * "nothing" like "noting", and both are things a room says. A word matched
 * here only counts beside a word that asks for something (`ASKING`).
 */
export function nearestWord(heard: string): string | null {
    if (heard.length < 4 || !/^[a-z']+$/.test(heard)) return null;
    const key = soundKey(heard);
    let best: { word: string; distance: number } | null = null;
    let tied = false;
    for (const candidate of LOOSE_WORDS) {
        if (candidate.key !== key) continue;
        const length = candidate.word.length;
        const distance = editDistance(heard, candidate.word);
        if (distance > (length <= 4 ? 1 : Math.max(2, Math.floor(length / 3)))) continue;
        if (!best || distance < best.distance) {
            best = { word: candidate.word, distance };
            tied = false;
        } else if (distance === best.distance) tied = true;
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
    // "playful and ten minutes": the joiner belongs to the request, not the number.
    while (from < unitAt && words[from] === 'and') from++;
    let to = unitAt + 1;
    if (words.slice(to, to + 3).join(' ') === 'and a half') to += 3;
    const request = parseTimerRequest(words.slice(from, to).join(' '));
    if (!request || request.relative) return null;
    // A joiner stands where the length was, so what was on either side of it
    // stays apart: "exploration, ten minutes, playful".
    const rest = [...words.slice(0, from), 'and', ...words.slice(to)];
    // One length to a request.
    if (rest.some((w) => LENGTH_UNITS.has(w))) return null;
    return { minutes: request.minutes, rest };
}

/** A request cut into what it means: a phrase from the vocabulary, or a word. */
type Item = { entry: Entry; loose: boolean } | { word: string };

function itemize(words: string[], loose: ReadonlySet<number>): Item[] {
    const items: Item[] = [];
    for (let i = 0; i < words.length; ) {
        let matched = false;
        for (let span = Math.min(LONGEST_PHRASE, words.length - i); span >= 1 && !matched; span--) {
            const said = words.slice(i, i + span).join(' ');
            if (NOT_A_REQUEST.has(said)) {
                items.push({ word: said });
                i += span;
                matched = true;
                continue;
            }
            const entry = PHRASES[HEARD_AS[said] ?? said];
            if (!entry) continue;
            let wasLoose = false;
            for (let at = i; at < i + span; at++) wasLoose ||= loose.has(at);
            items.push({ entry, loose: wasLoose });
            i += span;
            matched = true;
        }
        if (!matched) items.push({ word: words[i++]! });
    }
    return items;
}

type Polarity = 'on' | 'off';

interface Clause {
    actions: SetupAction[];
    /** A negation said ahead of its values carries into the next part:
     *  "remove playful and loving" removes both. */
    carry: Polarity | null;
    /** Some value here can't stand alone (see `Entry.bare`). */
    needsAsking: boolean;
}

/** One part of a request (between "and"s). Null when it isn't one. */
function readClause(items: Item[], carried: Polarity | null): Clause | null {
    const meanings: Meaning[] = [];
    let needsAsking = false;
    let negated = false;
    let denied = false;
    let added = false;
    let negatedFirst = false;
    let setter = false;
    let only = false;
    let step: 'up' | 'down' | null = null;
    let levelStep = false;

    for (const [i, item] of items.entries()) {
        if ('entry' in item) {
            const { meaning } = item.entry;
            meanings.push(meaning);
            const isValue = meaning.t === 'mode' || meaning.t === 'focus' || meaning.t === 'quality' || meaning.t === 'lead';
            if (isValue && (item.loose || !item.entry.bare)) needsAsking = true;
            continue;
        }
        const { word } = item;
        if (NEGATIONS.has(word)) {
            if (!negated && !added && meanings.every((m) => m.t === 'target')) negatedFirst = true;
            negated = true;
            if (DENIALS.has(word)) denied = true;
        } else if (ADDITIONS.has(word)) added = true;
        else if (SETTERS.has(word)) setter = true;
        else if (ONLY.has(word)) only = true;
        else if (word in STEPS) {
            // "Turn down the guidance" and "no, less guidance" both mean down;
            // two directions in one part mean nothing.
            if (step && step !== STEPS[word]) return null;
            step = STEPS[word]!;
            if (LEVEL_STEPS.has(word)) levelStep = true;
        } else if (word === 'just') {
            // "Just spacious" is only spacious; "just a little more" is filler.
            const next = items[i + 1];
            if (next && 'entry' in next && (next.entry.meaning.t === 'focus' || next.entry.meaning.t === 'quality')) {
                only = true;
            }
        } else if (!FILLER.has(word)) return null;
    }

    const has = (of: Target): boolean => meanings.some((m) => m.t === 'target' && m.of === of);
    // "Playful off, no, on": taking away and putting back in one part, with
    // nothing denying either, is not a request this can read.
    if (negated && added && !denied) return null;
    const own: Polarity | null = negated ? 'off' : added ? 'on' : null;
    const polarity: Polarity = own ?? carried ?? 'on';
    const carry = own === null ? carried : negatedFirst && own === 'off' ? 'off' : null;
    const actions: SetupAction[] = [];
    let stepUsed = false;

    const leads = meanings.filter((m): m is Extract<Meaning, { t: 'lead' }> => m.t === 'lead');
    const lengthWords = meanings.filter((m): m is Extract<Meaning, { t: 'length-word' }> => m.t === 'length-word');
    const values = meanings.filter((m) => m.t === 'mode' || m.t === 'focus' || m.t === 'quality');

    // Who leads. "More guidance", "guide me less", "more directing", or a
    // stop by its name ("following").
    if (leads.length > 1) return null;
    if (leads.length === 1) {
        const lead = leads[0]!;
        if (step) {
            // "More following" is less guidance.
            actions.push({ kind: 'guidance', to: step === 'up' ? lead.toward : lead.toward === 'up' ? 'down' : 'up' });
            stepUsed = true;
        } else if (lead.stop !== undefined && !negated) actions.push({ kind: 'guidance', to: lead.stop });
        else return null;
    } else if (has('guidance')) {
        if (!step) return null;
        actions.push({ kind: 'guidance', to: step });
        stepUsed = true;
    }

    // How much it says. Always beside a word for the talking, since "longer"
    // alone could as well be the session.
    if (lengthWords.length > 1) return null;
    if (lengthWords.length === 1) {
        if (!has('responses')) return null;
        actions.push({ kind: 'verbosity', to: lengthWords[0]!.to });
    } else if (has('responses')) {
        if (!step || stepUsed || levelStep) return null;
        actions.push({ kind: 'verbosity', to: step });
        stepUsed = true;
    }

    if (meanings.some((m) => m.t === 'open-ended')) actions.push({ kind: 'no-timer' });
    // A timer by itself says nothing; with a length it is filler.
    if (has('timer') && negated) actions.push({ kind: 'no-timer' });

    // Only with a direction said: "just checking in" is not a request.
    if (meanings.some((m) => m.t === 'checkin')) {
        if (own === null && carried === null) return null;
        actions.push({ kind: 'checkins', on: polarity === 'on' });
    }

    // "More playful" is playful; "less playful" is not. There is no more or
    // less of a mode: "nothing more" is not "noting".
    const graded = values.some((m) => m.t !== 'mode');
    const valuePolarity: Polarity = step && !stepUsed && graded ? (step === 'down' ? 'off' : 'on') : polarity;
    if (graded && step && !stepUsed) stepUsed = true;
    for (const group of ['focus', 'quality'] as const) {
        const said = values.filter((m) => m.t === group);
        const named = has(group === 'quality' ? 'vibe' : 'focus');
        if (said.length === 0) {
            // "Clear the vibes", "no focus".
            if (named && negated) actions.push({ kind: 'clear', group });
            continue;
        }
        if (valuePolarity === 'on' && (only || (setter && named))) actions.push({ kind: 'clear', group });
    }
    for (const value of values) {
        if (value.t === 'mode') {
            // "Not noting" is nothing; "check-ins off for felt sense" is
            // about the check-ins.
            if (negated && !graded && !meanings.some((m) => m.t === 'checkin' || m.t === 'target')) return null;
            actions.push({ kind: 'mode', mode: value.mode });
        } else if (value.t === 'focus') actions.push({ kind: 'focus', focus: value.focus, on: valuePolarity === 'on' });
        else if (value.t === 'quality') actions.push({ kind: 'quality', quality: value.quality, on: valuePolarity === 'on' });
    }
    if (step && !stepUsed) return null;
    return { actions, carry, needsAsking };
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

const INTENTION_LEAD = "(?:(?:ok|okay|please|hey|aloud|and)[,\\s]+)*";
const INTENTION_NOUN = "(?:(?:my|the|an|our)\\s+)?intention(?:\\s+for\\s+(?:this|today|the)(?:\\s+(?:session|meditation))?)?";
/** "My intention is to rest": the "to" is the meditator's. */
const INTENTION_IS_RE = new RegExp(`^${INTENTION_LEAD}${INTENTION_NOUN}(?:\\s*:\\s*|[\\s,]+is\\b[\\s:,]*)(.+)$`, 'i');
/** "Set my intention to rest": the "to" is the request's. */
const INTENTION_SET_RE = new RegExp(
    `^${INTENTION_LEAD}(?:set|change|make|let)\\s+${INTENTION_NOUN}[\\s:,]+(?:(?:to\\s+be|to|as|be|is)\\b[\\s:,]*)?(.+)$`,
    'i'
);
/** Felt sense's field, by its label. "Sit with me" is not this. */
const SIT_WITH_RE =
    /^(?:(?:ok|okay|please|hey|aloud)[,\s]+)*(?:(?:i\s+want|i'd\s+like|i\s+would\s+like)\s+to\s+sit\s+with\s+|something\s+to\s+sit\s+with\s+is\s+)(.+)$/i;
const CLEAR_INTENTION_RE =
    /^(?:(?:ok|okay|please)[,\s]+)*(?:clear|remove|drop|delete|erase|no|cancel|forget)\s+(?:(?:my|the)\s+)?intention(?:\s+please)?$/i;

function parseIntention(utterance: string): SetupAction | null {
    const said = utterance.replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!?。]+$/u, '');
    if (CLEAR_INTENTION_RE.test(said)) return { kind: 'intention', text: '' };
    const match = INTENTION_SET_RE.exec(said) ?? INTENTION_IS_RE.exec(said) ?? SIT_WITH_RE.exec(said);
    if (!match) return null;
    const text = match[1]!.trim();
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
    // Before the guard below: an intention is the meditator's own words, and
    // "my intention is to start fresh" is one. (The listener has already
    // tried the utterance as a request to begin, which it is not.)
    const intention = parseIntention(utterance);
    if (intention) return [intention];
    // A request to begin is begin-command's, with its strict match.
    if (exact.includes('begin') || exact.includes('start')) return null;
    if (exact.length > SETUP_MAX_WORDS) return null;

    // Numbers are read exactly, so the length comes out first.
    const length = takeLength(exact);
    if (!length) return null;
    // A minute is something to wait, not a session ("just a minute").
    if (length.minutes !== null && length.minutes < SETUP_MIN_MINUTES) return null;
    const loose = new Set<number>();
    const words = length.rest.map((word, at) => {
        if (EXACT_WORDS.has(word) || /^\d+$/.test(word)) return word;
        const near = nearestWord(word);
        if (near) loose.add(at);
        return near ?? word;
    });

    const actions: SetupAction[] = [];
    if (length.minutes !== null) actions.push({ kind: 'length', minutes: length.minutes });
    let asked = false;
    let needsAsking = false;
    let carried: Polarity | null = null;
    let part: Item[] = [];
    const parts: Item[][] = [];
    for (const item of itemize(words, loose)) {
        if ('word' in item && JOINERS.has(item.word)) {
            parts.push(part);
            part = [];
            continue;
        }
        if ('word' in item ? ASKING.has(item.word) : item.entry.meaning.t === 'target') asked = true;
        part.push(item);
    }
    parts.push(part);
    for (const items of parts) {
        if (items.length === 0) continue;
        const clause = readClause(items, carried);
        if (!clause) return null;
        actions.push(...clause.actions);
        carried = clause.carry;
        needsAsking ||= clause.needsAsking;
    }
    if (needsAsking && !asked) return null;
    // A length and nothing else has to be said like a request for one.
    if (length.minutes !== null && actions.length === 1 && !length.rest.every((w) => w === 'and' || LENGTH_COMPANY.has(w))) {
        return null;
    }
    if (actions.filter((a) => a.kind === 'mode').length > 1) return null;
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
        'my intention is', 'check-ins off', 'twenty minutes', 'no timer',
    ];
    return {
        prompt:
            'Exploration, noting, felt sense. Vibes: playful, compassionate, loving, spacious, effortless, feeling good. ' +
            'Focus: body and sensations, emotions, parts. More guidance, less guidance. Shorter responses. ' +
            'My intention is to rest. Check-ins off. Twenty minutes, no timer.',
        phrases,
    };
}

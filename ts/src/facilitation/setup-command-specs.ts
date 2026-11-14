/**
 * The judge's tier for requests said on the setup screen: what the on-device
 * parser (setup-command.ts) could not place, mishearings included. The parser
 * always goes first; this runs only where in-session voice commands could
 * (ui setup-judge.ts), and only on what it missed.
 *
 * Two judge ids, the shape of the in-session pair (voice-command-specs.ts):
 * `setup-gate`, one cheap ask, then `setup-command`, one ask per value. Jev
 * returns P(yes) per ask and extracts nothing, so every value is its own ask,
 * and a length's minutes come from parseTimerRequest on the text, as the
 * in-session `set_timer` does. An intention is free text: no ask can carry
 * it, so it stays the parser's.
 *
 * What it is for, as measured (`npm run jev:setup`): natural phrasing outside
 * the parser's grammar ("could you make it a bit more spacious in there"). A
 * mishearing comes back only when a request around it names the kind of
 * setting ("Make it more spayshus.", "Exploration boat, please."): about one
 * in six of local Whisper's, against room and television talk that names a
 * value, which scores as high as the rest.
 *
 * Never a way to begin. A request with begin or start in it is not sent at
 * all (mightBeSetupRequest), and the `begin` ask vetoes the rest, so a
 * misheard begin ("big in a noting session") comes to nothing.
 */

import type { BeginMode } from './begin-command.js';
import type { Quality } from './prompts.js';
import type { SetupAction, SetupFocus } from './setup-command.js';
import type { JudgeAnswers, JudgeQuestion, JudgeSpec, UtteranceJudge } from './utterance-judge.js';
// A value import that closes a cycle (utterance-judge -> here -> voice-command
// -> utterance-judge). Harmless while neither side reads the other at module
// load: keep parseTimerRequest inside functions here, and SETUP_SPECS inside
// functions there.
import { parseTimerRequest } from './voice-command.js';

export type SetupJudgeId = 'setup-gate' | 'setup-command';

export const SETUP_JUDGE_IDS: readonly SetupJudgeId[] = ['setup-gate', 'setup-command'];

export function isSetupJudgeId(v: unknown): v is SetupJudgeId {
    return v === 'setup-gate' || v === 'setup-command';
}

/**
 * Said once per request, so the menu rides here rather than in 24 asks. The
 * mishearing clause is the point of the tier: the parser already takes every
 * request it can read word for word.
 */
const SITUATION =
    "Text from a speech recognizer, heard by the microphone on a meditation app's setup screen before a " +
    'session starts. It may be someone asking the app to change a setting, or talk in the room or on a ' +
    'television. Recognizers often mishear short requests, so words can be wrong: judge what was most ' +
    'plausibly said, by sound, among the few things one can ask for here. Modes: exploration, noting, felt ' +
    'sense. Vibes: playful, compassionate, loving, spacious, effortless, feeling good. Focuses: body and ' +
    'sensations, emotions, parts. Also: more or less guidance, shorter or longer responses, a session ' +
    'length or no timer, check-ins on or off, stop listening, help. Asking to begin or start the session ' +
    'is not a setting.';

/**
 * Each ask here is paid for on every call (~170 tokens however short), so the
 * shape is voice-command-specs.ts's: a question, a plain example and a misheard
 * one, a short exclusion.
 */
function ask(question: string, examples: string[], notFor: string, notExamples: string[] = []): JudgeQuestion {
    return {
        type: 'noul',
        instructions: {
            question,
            inspect: '`utterance`',
            focus: 'Only a request to the app counts. Judge a misheard transcript by what was most plausibly said.',
        },
        criteria: {
            true: { what: 'Yes, including when the recognizer misheard it.', examples },
            false: { what: 'Room or television talk, or a different setting.', not_for: notFor, examples: notExamples },
        },
    };
}

const MODES: ReadonlyArray<readonly [key: string, mode: BeginMode, question: JudgeQuestion]> = [
    [
        'mode_exploration',
        'exploration',
        ask(
            'Does the request ask for the exploration mode?',
            ["Let's do an exploration one today.", 'Explosion mode.'],
            'Exploring something in their life.'
        ),
    ],
    [
        'mode_noting',
        'noting',
        ask(
            'Does the request ask for the noting mode?',
            ["I'd like to do noting this time.", 'Knotting mode, please.'],
            'Noting something down, or saying "nothing" as an answer.'
        ),
    ],
    [
        'mode_felt_sense',
        'felt_sense',
        ask(
            'Does the request ask for the felt sense mode?',
            ['Can we do the felt sense practice?', 'Belt sense.'],
            'Having felt something. The feeling good vibe.',
            ['Something that feels good.']
        ),
    ],
];

/**
 * Jev reads these as near-synonyms unless told apart: compassion scored 0.96
 * on loving and 0.75 on the emotions focus, "felt sense" 0.85 on the body
 * focus. Each names the sibling it is not, with that sibling's own example.
 */
const VIBES: ReadonlyArray<readonly [key: string, quality: Quality, question: JudgeQuestion]> = [
    [
        'vibe_playful',
        'playful',
        ask(
            'Does the request name the playful (lighthearted) vibe, to add it or to take it away?',
            ['Make it a bit more lighthearted.', 'Play full vibe.'],
            'Talk about games or children.'
        ),
    ],
    [
        'vibe_compassionate',
        'compassionate',
        ask(
            'Does the request name the compassionate vibe, to add it or to take it away?',
            ['Bring in some compassion.', 'Come passionate.'],
            'The loving vibe, or the emotions focus.',
            ['Make it loving.']
        ),
    ],
    [
        'vibe_loving',
        'loving',
        ask(
            'Does the request name the loving (loving kindness) vibe, to add it or to take it away?',
            ['Make it loving.', 'Lovin vibe.'],
            'The compassionate vibe, or the emotions focus.',
            ['Bring in some compassion.']
        ),
    ],
    [
        'vibe_spacious',
        'spacious',
        ask(
            'Does the request name the spacious vibe, to add it or to take it away?',
            ['Give it a roomy, spacious feel.', 'Spatial vibe.'],
            'Room in a house or a schedule.'
        ),
    ],
    [
        'vibe_effortless',
        'effortless',
        ask(
            'Does the request name the effortless vibe, to add it or to take it away?',
            ['Make it effortless.', 'Ever less.'],
            'The feeling good vibe.',
            ['Something that feels good.']
        ),
    ],
    [
        'vibe_feeling_good',
        'feeling_good',
        ask(
            'Does the request name the feeling good vibe, to add it or to take it away?',
            ['Something that feels good.', 'Feeling hood.'],
            'Any other vibe, or the felt sense mode.',
            ['Make it effortless.', 'Make it loving.']
        ),
    ],
];

const FOCUSES: ReadonlyArray<readonly [key: string, focus: SetupFocus, question: JudgeQuestion]> = [
    [
        'focus_body',
        'body_sensations',
        ask(
            'Does the request name the body and sensations focus, to add it or to take it away?',
            ['Pay attention to my body.', 'Bawdy sensations.'],
            'The felt sense mode.',
            ['Can we do the felt sense practice?']
        ),
    ],
    [
        'focus_emotions',
        'emotions',
        ask(
            'Does the request name the emotions focus, to add it or to take it away?',
            ['Work with my feelings.', 'Emoshuns.'],
            'A vibe such as compassion or love.',
            ['Bring in some compassion.']
        ),
    ],
    [
        'focus_parts',
        'inner_parts',
        ask(
            'Does the request name the parts (inner parts) focus, to add it or to take it away?',
            ['Do some parts work with me.', 'Inner carts.'],
            'Parts of something else.'
        ),
    ],
];

/** The rest of the set, keyed as sent. */
const SETTINGS = {
    // A veto, not a setting: a misheard begin ("big in a noting session") still
    // names a mode, and begin is never this tier's.
    begin: ask(
        'Is the utterance, most plausibly, a request to begin or start the session, perhaps misheard?',
        ['Okay, ready, go.', 'Bacon a noting session.'],
        'Changing a setting without starting.'
    ),
    // Polarity for the vibes, focuses and check-ins named beside it. One ask
    // for all of them, so a request that adds one and drops another in the same
    // breath can't be told apart; the parser takes most of those whole.
    remove: ask(
        'Is the request to remove, turn off or do without what it names, rather than add it?',
        ["I don't want it playful anymore.", 'Take the body out.'],
        'Adding or switching to something.'
    ),
    replace: ask(
        'Does the request say to keep only what it names, dropping the other choices, or to use it instead of them?',
        ['Just spacious, nothing else.', 'Use loving instead of the others.'],
        'Simply asking for something, which adds it.',
        ["Let's do noting.", 'Add spacious too.']
    ),
    // Jev runs guidance and response length together (0.95 for longer
    // responses on "guide me a bit more" until these counter-examples), hence
    // the crossed examples.
    guide_more: ask(
        'Is the request for the facilitator to guide, lead or direct more?',
        ['Could you take the lead a bit more?', 'More guy dance.'],
        'How much it says: longer or fuller responses. Leading less.',
        ['Longer responses.', 'Say more each time.']
    ),
    guide_less: ask(
        'Is the request for the facilitator to guide, lead or direct less, and follow the meditator more?',
        ["I'd rather lead myself.", 'Less hand-holding, please.'],
        'How much it says: shorter responses or talking less. Guiding more.',
        ['Shorter responses.', 'Talk less.']
    ),
    shorter: ask(
        'Is the request about how much the facilitator says: shorter responses, fewer words, talking less?',
        ['Keep it brief when you talk.', 'Short a response is.'],
        'Guidance, leading or direction, even when less of it is asked for. The length of the session.',
        ['Less guidance, please.', 'Lead less.']
    ),
    longer: ask(
        'Is the request about how much the facilitator says: longer, fuller responses, more words?',
        ['Say a bit more each time.', 'Longer rest bonds.'],
        'Guidance, leading or direction, even when more of it is asked for. The length of the session.',
        ['More guidance, please.', 'Lead more.']
    ),
    length: ask(
        'Is the request to set how long the session will be, in minutes or hours?',
        ["Let's do about fifteen minutes.", 'I only have half an hour.'],
        'Times of day, or how long something else takes.',
        ['The meeting is in ten minutes.']
    ),
    no_timer: ask(
        'Is the request for no time limit, with no session timer?',
        ["Don't set a timer.", 'Let it run as long as it runs.'],
        'Setting a length. Timers on other things.'
    ),
    checkins: ask(
        'Is the request about the facilitator checking in when the meditator goes quiet, on or off?',
        ['Check on me if I go quiet.', "Don't interrupt my silences."],
        'Checking in at a hotel or with a person.'
    ),
    stop_listening: ask(
        'Is the request for the app to stop listening, or to turn off its microphone?',
        ['You can close the mic.', "That's enough listening for now."],
        'Telling a person to stop something, or to leave them alone.',
        ['Stop it, both of you.']
    ),
    help: ask(
        'Is the request to hear what can be said or changed on this screen?',
        ['What are the choices?', 'How do I use this?'],
        'Asking a person for help, or thinking aloud about what to pick.',
        ['Help me carry this.']
    ),
} satisfies Record<string, JudgeQuestion>;

type SettingKey = keyof typeof SETTINGS;

/**
 * PROVISIONAL: set from synthetic transcripts and hand-written lines
 * (`npm run jev:setup`), waiting on real transcripts of real voices in real
 * rooms. Set to miss a mishearing rather than act on room talk: a wrong
 * setting is spoken back and cheap, a screen that reconfigures itself from a
 * television is not.
 *
 * Natural requests score 0.85 and up on their own ask; recovered mishearings
 * 0.6-0.9; a caption or a remark that names a value ("Effortless style.",
 * "and some playful ones too") 0.5-0.9. The bars sit over every such line in
 * the corpus, which costs most mishearings.
 */
const VALUE_THRESHOLD = 0.75;
const THRESHOLDS: Partial<Record<string, number>> = {
    vibe_compassionate: 0.8, // "Don't be so compassionate with him." 0.67
    vibe_effortless: 0.9, // "Effortless style." 0.86
    focus_parts: 0.8, // "Only the parts that matter." 0.64
    begin: 0.5, // a veto: low is the cautious side
    remove: 0.6,
    replace: 0.8, // it clears a whole group; "Swap playful for spacious." 0.88
    guide_more: 0.9, // "More guidance soon." 0.85
    guide_less: 0.8, // "No guidance yet." 0.72
    shorter: 0.85, // "Keep your answers short in the interview." 0.80
    longer: 0.8,
    length: 0.9, // "Half an hour from here." 0.83
    no_timer: 0.92, // "No time." 0.88
    checkins: 0.8, // "Check in online." 0.73
    // Lower than the rest on purpose: a false one closes the mic ("Put it on
    // mute." 0.86), the one change a noisy room can't make worse.
    stop_listening: 0.75,
    help: 0.7,
};

/**
 * The one ask in front (SETUP_GATE_ASK). Nearly everything heard on the setup
 * screen that the parser misses is not a request, and the full set costs
 * ~4,700 tokens whatever the answer; at this bar a fifth of the corpus's room
 * and television lines go on to it. It asks about the form, so a misheard
 * value with no request around it ("Aspacious vide.") stops here, and so does
 * a request put as a statement ("I've only got ten minutes." 0.32). It is not
 * the safeguard, the per-ask bars are: "Check in online." scored 0.91 on it.
 * PROVISIONAL, as THRESHOLDS.
 */
export const SETUP_GATE_ASK = 'is_setup_request';
export const SETUP_GATE_BAR = 0.5;

export const SETUP_SPECS: Readonly<Record<SetupJudgeId, JudgeSpec>> = {
    'setup-gate': {
        situation: SITUATION,
        asks: {
            [SETUP_GATE_ASK]: {
                question: {
                    type: 'noul',
                    instructions: {
                        question:
                            'Is `utterance` phrased as a request to the app: to change, add, remove or switch one of ' +
                            'its setup choices, or for help, or for it to stop listening?',
                        inspect: '`utterance`',
                        focus:
                            'The form decides: a request or instruction aimed at the app. A bare noun phrase, a ' +
                            'description, a remark about someone or something else, or an instruction to another ' +
                            'person is a no, whatever words it uses. A misheard word inside a request still counts.',
                    },
                    criteria: {
                        true: {
                            what: 'A request to the app about its setup, however casually phrased.',
                            examples: [
                                'Could we make it more loving this time?',
                                'Please hold back on the guiding.',
                                'Swish to knotting, please.',
                                'Less talking from you.',
                            ],
                        },
                        false: {
                            what: 'Room talk, a television, or anything not aimed at the app.',
                            not_for:
                                'Headlines, captions and remarks that name space, love, play, ease, feelings, the body, ' +
                                'time or guidance but ask nothing of the app.',
                            examples: [
                                'Loving memories.',
                                'I need more space in the closet.',
                                'She was so compassionate.',
                                'Turn the TV down a bit.',
                                'Good night, everyone.',
                            ],
                        },
                    },
                },
                threshold: SETUP_GATE_BAR,
            },
        },
    },
    'setup-command': {
        situation: SITUATION,
        asks: Object.fromEntries(
            [
                ...[...MODES, ...VIBES, ...FOCUSES].map(([key, , question]) => [key, question] as const),
                ...(Object.entries(SETTINGS) as Array<[SettingKey, JudgeQuestion]>),
            ].map(([key, question]) => [key, { question, threshold: THRESHOLDS[key] ?? VALUE_THRESHOLD }])
        ),
    },
};

// ---- before the wire --------------------------------------------------------

/**
 * Past this many words it is a sentence from the room, not a request. The
 * parser stops at 14 (setup-command.ts SETUP_MAX_WORDS); a mishearing can
 * split a word in two ("come passionate"), so this leaves it two more. The
 * lobby recognizer cuts a turn at a short pause and 10s anyway, and a call
 * costs the same ~4,000 tokens however long the text.
 */
export const SETUP_JUDGE_MAX_WORDS = 16;
/** The same bound for Chinese, in characters (as voice-command.ts counts). */
export const SETUP_JUDGE_MAX_CJK_CHARS = 24;

/**
 * Whether `text` may go to the judge at all.
 *
 * Begin is begin-command.ts's, matched strictly on the device: anything with
 * begin or start in it, as a word or inside one, never reaches this tier.
 *
 * Nor does a lone word. The parser already takes every setting's name said
 * alone, so a single word that reaches here could only be matched by sound,
 * with nothing around it to say it was meant for the app: "Notice." scored
 * 0.83 for noting and "Explosion." 0.79 for exploration, as high as real
 * mishearings with a request around them. The cost is a misheard bare name
 * ("Nothing." for "Noting."), which has to be said again.
 */
export function mightBeSetupRequest(text: string): boolean {
    const said = text.trim();
    if (!said || !/\p{L}/u.test(said)) return false;
    if (/begin|start|开始/i.test(said)) return false;
    const cjk = said.match(/[㐀-鿿]/g)?.length ?? 0;
    if (cjk > 0) return cjk >= 2 && cjk <= SETUP_JUDGE_MAX_CJK_CHARS;
    const words = said.split(/\s+/).filter((w) => /\p{L}/u.test(w)).length;
    return words >= 2 && words <= SETUP_JUDGE_MAX_WORDS;
}

// ---- reading the answers ----------------------------------------------------

/**
 * Asks Jev scores together whatever the examples say: "Bring some compassion
 * into it" scored 0.98 for compassionate and 0.81 for loving, "Fell since,
 * please." 0.82 for felt sense and 0.64 for feeling good. When both of a pair
 * clear, only one was said (siblingKept).
 */
const SIBLINGS: ReadonlyArray<readonly [string, string]> = [
    ['vibe_compassionate', 'vibe_loving'],
    ['vibe_effortless', 'vibe_feeling_good'],
    ['mode_felt_sense', 'vibe_feeling_good'],
    ['guide_more', 'longer'],
    ['guide_less', 'shorter'],
];

/**
 * For guidance against response length the scores alone can pick wrong:
 * Whisper's "illegal less guidance." scored 0.90 for shorter responses and
 * 0.87 for less guidance, with "Less guidance, please." among shorter's own
 * counter-examples. A word in the text that names one side settles it; with
 * neither or both, the higher score does.
 */
const NAMES_GUIDANCE = /guid|lead|\bled\b|direct|steer|follow/i;
const NAMES_RESPONSES = /respon|repl|answer|talk|word|\bsay|speak|brief|short|long/i;

function siblingKept(a: string, b: string, answers: JudgeAnswers, text: string): string {
    if (a.startsWith('guide_')) {
        const guidance = NAMES_GUIDANCE.test(text);
        if (guidance !== NAMES_RESPONSES.test(text)) return guidance ? a : b;
    }
    return answers[a]! >= answers[b]! ? a : b;
}

/** Pairs that can't both be meant; both clearing means the judge couldn't tell. */
const OPPOSITES: ReadonlyArray<readonly [string, string]> = [
    ['guide_more', 'guide_less'],
    ['shorter', 'longer'],
];

const RELATIVE_WORDS = /^(more|another|extra|additional|longer|add|extend)$/;

/**
 * The session length named in `text`, in minutes, or null. parseTimerRequest
 * reads "more" anywhere as "add to the timer", so "twenty minutes with more
 * guidance" would come back relative; here only a word next to the number
 * makes it so ("five more minutes"), and a relative length is no length on a
 * screen with no timer running.
 */
function sessionMinutes(text: string): number | null {
    const request = parseTimerRequest(text);
    if (!request || request.minutes <= 0) return null;
    if (request.relative) {
        const words = text.toLowerCase().replace(/-/g, ' ').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
        const unit = words.findIndex((w) => /^(minutes?|mins?|hours?|hrs?)$/.test(w));
        if (unit < 0 || words.slice(Math.max(0, unit - 4), unit + 2).some((w) => RELATIVE_WORDS.test(w))) return null;
    }
    return request.minutes;
}

/**
 * The changes the answers amount to, or null. Pure. Every ask has to be
 * answered (a partial answer is a failure, not a no); then:
 * - nothing at all when it may have been a request to begin;
 * - of two SIBLINGS that both clear, only one counts (siblingKept);
 * - OPPOSITES that both clear cancel, as do a length and no timer;
 * - a mode only when exactly one clears, and never beside `remove`;
 * - vibes and focuses take their polarity from `remove`, and `replace` clears
 *   their group first; both modifiers at once leaves them out;
 * - a length needs minutes in the text (sessionMinutes);
 * - help only when nothing else was asked for;
 * - modifiers alone are nothing.
 */
export function resolveSetupAnswers(answers: JudgeAnswers, text: string): SetupAction[] | null {
    const asks = SETUP_SPECS['setup-command'].asks;
    for (const key of Object.keys(asks)) {
        const p = answers[key];
        if (typeof p !== 'number' || !Number.isFinite(p)) return null;
    }
    const cleared = new Set(Object.keys(asks).filter((key) => answers[key]! >= asks[key]!.threshold));
    if (cleared.has('begin')) return null;
    for (const [a, b] of SIBLINGS) {
        if (cleared.has(a) && cleared.has(b)) cleared.delete(siblingKept(a, b, answers, text) === a ? b : a);
    }
    for (const [a, b] of OPPOSITES) {
        if (cleared.has(a) && cleared.has(b)) {
            cleared.delete(a);
            cleared.delete(b);
        }
    }
    const on = (key: string): boolean => cleared.has(key);
    const remove = on('remove');
    const replace = on('replace');
    const actions: SetupAction[] = [];

    const modes = MODES.filter(([key]) => on(key));
    if (modes.length === 1 && !remove) actions.push({ kind: 'mode', mode: modes[0]![1] });

    const minutes = on('length') ? sessionMinutes(text) : null;
    if (minutes !== null && !on('no_timer')) actions.push({ kind: 'length', minutes });
    if (on('no_timer') && minutes === null) actions.push({ kind: 'no-timer' });

    if (!(remove && replace)) {
        const focuses = FOCUSES.filter(([key]) => on(key));
        if (focuses.length > 0 && replace) actions.push({ kind: 'clear', group: 'focus' });
        for (const [, focus] of focuses) actions.push({ kind: 'focus', focus, on: !remove });
        const vibes = VIBES.filter(([key]) => on(key));
        if (vibes.length > 0 && replace) actions.push({ kind: 'clear', group: 'quality' });
        for (const [, quality] of vibes) actions.push({ kind: 'quality', quality, on: !remove });
    }

    if (on('guide_more') || on('guide_less')) actions.push({ kind: 'guidance', to: on('guide_more') ? 'up' : 'down' });
    if (on('shorter') || on('longer')) actions.push({ kind: 'verbosity', to: on('longer') ? 'up' : 'down' });
    if (on('checkins')) actions.push({ kind: 'checkins', on: !remove });

    const stop = on('stop_listening');
    if (on('help') && actions.length === 0 && !stop) actions.push({ kind: 'help' });
    if (stop) actions.push({ kind: 'stop-listening' });
    return actions.length > 0 ? actions : null;
}

/**
 * The judge's reading of a setup-screen utterance the parser missed, or null.
 * Never throws. The gate goes first and fails closed: unlike a session, where
 * a lost command becomes a turn the facilitator answers, a lost request here
 * only has to be said again, and a server that can't answer the gate can't
 * answer the set either. No retry for the same reason.
 */
export async function judgeSetupCommand(judge: UtteranceJudge, text: string): Promise<SetupAction[] | null> {
    const said = text.trim();
    if (!mightBeSetupRequest(said)) return null;
    try {
        const gate = await judge.judge('setup-gate', said);
        const p = gate[SETUP_GATE_ASK];
        if (typeof p !== 'number' || !(p >= SETUP_GATE_BAR)) return null;
        return resolveSetupAnswers(await judge.judge('setup-command', said), said);
    } catch {
        return null;
    }
}

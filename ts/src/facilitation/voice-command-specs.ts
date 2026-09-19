/**
 * The Jev questions behind spoken commands (voice-command.ts). Data only, and
 * type-only imports, so utterance-judge.ts can fold these into judgeSpec()
 * without an import cycle.
 *
 * One atomic yes/no ask per command, all sent in one request and answered in
 * parallel (~160ms for the set; ~4,200 input tokens with 24 asks, about $0.00018
 * a call - each ask costs ~170 tokens however short it is, so the count of
 * commands is what drives the price). Measured before building: a
 * single "which command?" choice is the obvious shape, but separate asks are
 * what worked on `resume`, each gets its own contrastive examples, and adding a
 * command can't shift the others' scores.
 */

import type { JudgeQuestion, JudgeSpec } from './utterance-judge.js';

export type VoiceCommandId =
    | 'end_session'
    | 'end_discard'
    | 'end_save'
    | 'slower'
    | 'faster'
    | 'set_timer'
    | 'cancel_timer'
    | 'time_check'
    | 'repeat'
    | 'respond_sooner'
    | 'wait_longer'
    | 'mute'
    | 'mute_speaker'
    | 'unmute_speaker'
    | 'show_clock'
    | 'hide_clock'
    | 'show_orb'
    | 'hide_orb'
    | 'embers_on'
    | 'embers_off'
    | 'dark_mode'
    | 'light_mode'
    | 'toggle_theme'
    | 'help';

/**
 * Lean on purpose. Every ask rides in every request, so a sentence here is paid
 * for once per command, per utterance: the first version carried six shared
 * counter-examples and a long focus line in each ask and cost ~290 tokens an
 * ask (7k a call with 24 commands). Cutting to a question, two examples and a
 * short exclusion lost only the asks Jev has no prior for (embers, the orb), and
 * those got their detail back. Add words only where `npm run jev:commands`
 * shows a need, and rerun it after any edit: one request, shared scores.
 */
function ask(
    question: string,
    examples: string[],
    notFor: string,
    /** The two below: only where the corpus showed the ask needs them. */
    notExamples: string[] = [],
    what = 'Yes.'
): JudgeQuestion {
    return {
        type: 'noul',
        instructions: {
            question,
            inspect: '`utterance`',
            focus: 'Only an instruction to the app counts, not a description of experience.',
        },
        criteria: {
            true: { what, examples },
            false: { what: 'Meditation talk, or a different command.', not_for: notFor, examples: notExamples },
        },
    };
}

/**
 * Think-out-loud scores under 0.15 on every ask and real commands over 0.7, so
 * 0.6 sits in the gap. The known exception is `end_session`: "I want this to be
 * over" scored 0.64. That one is why ending is a spoken question, never an act
 * (END_CONFIRM) - don't "fix" it by raising the threshold.
 */
const COMMAND_THRESHOLD = 0.6;

/**
 * Muting is the one command that can't be undone by voice - the mic is off - so
 * a misfire costs a reach for the button. The bare word still goes through
 * isMuteCommand first, which needs no judge and works on every provider; this
 * ask is for the natural phrasings that regex was too strict to take.
 *
 * The speaker shares the bar for a different reason: "can you be quiet for a
 * while" scores ~0.4 on it, where other asks' near misses sit under 0.15. That
 * request belongs to [HOLD]. Real speaker requests land at 0.84 and up.
 */
const MUTE_THRESHOLD = 0.75;

/**
 * The on-screen extras (clock readout, orb, embers, theme). Jev has never heard of "embers",
 * so real requests land at 0.5-0.7 rather than 0.9, while meditation talk about
 * light, dark, sparks and orbs stays under 0.1. A misfire is a visual flicker
 * that a word undoes, so the bar sits lower than for the rest.
 */
const VISUAL_THRESHOLD = 0.45;
const VISUAL_COMMANDS: readonly VoiceCommandId[] = [
    'show_clock',
    'hide_clock',
    'show_orb',
    'hide_orb',
    'embers_on',
    'embers_off',
    'dark_mode',
    'light_mode',
    'toggle_theme',
];

const COMMANDS: Record<VoiceCommandId, JudgeQuestion> = {
    end_session: ask(
        'Is the meditator telling the app to end the meditation session now?',
        ["Let's stop here for today.", '结束这次冥想。'],
        'Being finished with a feeling, a thought or a silence.',
        ['I wish this feeling would end.']
    ),
    end_discard: ask(
        'Is the meditator telling the app to end the session without saving it?',
        ["End the session and don't save it.", '不保存,直接结束。'],
        'Ending with no mention of saving or discarding.'
    ),
    end_save: ask(
        'Is the meditator telling the app to end the session and save it?',
        ['Save this one and end the session.', '保存并结束。'],
        'Ending with no mention of saving.'
    ),
    slower: ask(
        'Is the meditator asking the facilitator to speak more slowly?',
        ['Can you slow down a bit?', '说慢一点。'],
        'Their experience or breath slowing. Waiting longer before replying.'
    ),
    faster: ask(
        'Is the meditator asking the facilitator to speak faster?',
        ['A bit quicker, please.', '说快一点。'],
        'Their thoughts or heart racing. Replying sooner after they stop talking.'
    ),
    set_timer: ask(
        'Is the meditator asking to set, extend or change a session timer, with a duration?',
        ['Set a timer for twenty minutes.', '定一个十分钟的计时。'],
        'Talking about how long something has lasted.'
    ),
    cancel_timer: ask(
        'Is the meditator asking to cancel or turn off the session timer?',
        ['Turn the timer off.', '取消计时。'],
        'Wanting a feeling to stop. Not wanting to see or look at the timer, which only hides it.',
        ['Take the timer off the screen.']
    ),
    time_check: ask(
        'Is the meditator asking how much session time has passed or is left?',
        ['How much time is left?', '还剩多少时间?'],
        'Reflecting on time in their life.'
    ),
    // The readout only: a hidden clock still counts down and still speaks its
    // notices (showSessionClock).
    show_clock: ask(
        'Is the meditator asking the app to show the session clock or timer on screen?',
        ['Show the clock.', 'Put the time back on screen.', '显示时钟。'],
        'Asking how much time is left.'
    ),
    hide_clock: ask(
        'Is the meditator asking the app to hide the session clock or timer from the screen?',
        ["I don't want to see the time.", '隐藏时钟。'],
        'Cancelling the timer itself.'
    ),
    repeat: ask(
        'Is the meditator asking the facilitator to repeat what it just said?',
        ["Sorry, I didn't catch that.", '再说一遍。'],
        'Asking for more detail or a different explanation.'
    ),
    respond_sooner: ask(
        'Is the meditator asking the app to reply sooner after they finish speaking?',
        ["You're taking too long to answer.", "Don't wait so long after I stop talking.", '回应快一点。'],
        'How fast the voice speaks.',
        [],
        'A request for a shorter wait between them going quiet and the reply, or a complaint that replies are slow to come.'
    ),
    wait_longer: ask(
        'Is the meditator asking the app to wait longer before replying, or complaining of being cut off?',
        ['You keep cutting me off.', '等我说完再回应。'],
        'Asking for a period of silence, or for the facilitator to just listen.'
    ),
    mute: ask(
        'Is the meditator telling the app to mute or turn off the microphone?',
        ['Stop listening to me for now.', '把麦克风关掉。'],
        'Asking the facilitator to be quiet or just listen. Turning off the voice or speaker.'
    ),
    // The facilitator keeps facilitating, in text: this is the speaker button,
    // not a silence. "Be quiet for a while" is [HOLD]'s business.
    mute_speaker: ask(
        "Is the meditator telling the app to turn off the facilitator's spoken voice, so replies are text only?",
        ['Mute the speaker.', '把语音关掉。'],
        'Asking for a period of silence, or for the facilitator to just listen. Muting the microphone.'
    ),
    unmute_speaker: ask(
        "Is the meditator telling the app to turn the facilitator's spoken voice back on?",
        ['Unmute the speaker.', '把语音打开。'],
        'Calling the facilitator back from a silence, or asking it to say more. Bringing back the clock or anything else on screen.'
    ),
    show_orb: ask(
        'Is the meditator asking the app to show the orb, its glowing circle on screen for gazing at?',
        ['Show the orb.', 'Bring up the orb.', 'Can I have the orb to look at?', '显示光球。'],
        'A light, glow or shape in their own experience.',
        [],
        'A request to show, bring up or enlarge the orb.'
    ),
    hide_orb: ask(
        'Is the meditator asking the app to hide the orb, its glowing circle on screen?',
        ['Hide the orb.', 'Put the orb away.', '隐藏光球。'],
        'A light or image in their experience fading.',
        [],
        'A request to hide, dismiss or put away the orb.'
    ),
    embers_on: ask(
        'Is the meditator asking the app to turn on "embers", the decorative floating-sparks animation it draws on screen?',
        ['Turn on embers.', 'Embers on.', 'Can I have the embers back?', '打开余烬。'],
        'Warmth, fire or sparks in their own experience.',
        ["There's a warm glow in my belly."],
        // Jev has never heard of "embers"; without this the asks score ~0.4.
        'A request to turn on, show or bring back the embers or sparks animation.'
    ),
    embers_off: ask(
        'Is the meditator asking the app to turn off "embers", the decorative floating-sparks animation it draws on screen?',
        ['Turn off embers.', 'No more embers.', 'Get rid of the sparks.', '关掉余烬。'],
        'Warmth or fire dying down in their experience.',
        ['The anger is burning itself out.'],
        'A request to turn off, hide or remove the embers or sparks animation.'
    ),
    dark_mode: ask(
        "Is the meditator asking the app to switch its screen to the dark theme?",
        ['Dark mode.', '切换到深色模式。'],
        'Darkness in their experience or mood. Switching theme without saying which.'
    ),
    light_mode: ask(
        "Is the meditator asking the app to switch its screen to the light theme?",
        ['Light mode.', '切换到浅色模式。'],
        'Light in their experience. Switching theme without saying which.'
    ),
    toggle_theme: ask(
        "Is the meditator asking the app to switch its colour theme, without naming dark or light?",
        ['Switch the theme.', '切换主题。'],
        'Naming dark or light. Changing the subject of the meditation.'
    ),
    help: ask(
        'Is the meditator asking what spoken commands the app understands?',
        ['What can I say?', '列出语音指令。'],
        'Asking the facilitator for guidance with their meditation.'
    ),
};

export const VOICE_COMMAND_IDS = Object.keys(COMMANDS) as VoiceCommandId[];

/**
 * Nearly everything a meditator says in eighteen words or fewer is meditation,
 * and the 24-ask request costs ~4,200 tokens whatever the answer. This one ask
 * (~570 tokens) goes first, and only a maybe earns the full set.
 *
 * The bar is deliberately low: a miss here loses the command outright, a false
 * pass costs one full check that then says no. On the corpus (npm run
 * jev:commands) real commands score 0.4 and up, meditation talk 0.15 and under;
 * the silence requests that leak through ("stop talking for a few minutes") are
 * the full check's to turn down, as they always were.
 */
export const COMMAND_GATE_ASK = 'is_command';
export const COMMAND_GATE_BAR = 0.2;

export const COMMAND_SPECS: Readonly<Record<'command' | 'command-gate' | 'end-confirm', JudgeSpec>> = {
    'command-gate': {
        situation:
            'A meditator is in a voice-only guided meditation session with an AI facilitator. ' +
            'The app also accepts a few spoken commands.',
        asks: {
            [COMMAND_GATE_ASK]: {
                question: {
                    type: 'noul',
                    instructions: {
                        question:
                            'Is the meditator giving the app an instruction or asking it about its own controls, rather than describing their experience?',
                        inspect: '`utterance`',
                        focus:
                            'App controls: the timer and clock, speaking speed, reply timing, repeating, the ' +
                            'microphone and speaker, the orb, embers and theme on screen, ending the session, ' +
                            'and what commands exist.',
                    },
                    criteria: {
                        true: {
                            what: 'An instruction, question or complaint to the app about how it runs, however casually phrased.',
                            examples: [
                                'Can you slow down a bit?',
                                'Never mind the timer.',
                                'Put the orb away.',
                                'You keep cutting me off.',
                                "You're taking too long to answer.",
                                'How much time is left?',
                                'Can you repeat that?',
                                '说慢一点。',
                            ],
                        },
                        false: {
                            what: 'Meditation talk, or a request about the meditation itself.',
                            not_for:
                                'Asking for silence or for the facilitator to just listen. Asking the facilitator to explain or say more.',
                            examples: [
                                'Everything feels like it is slowing down.',
                                'I wish this feeling would end.',
                                'Can you be quiet for a while?',
                            ],
                        },
                    },
                },
                threshold: COMMAND_GATE_BAR,
            },
        },
    },
    command: {
        situation:
            'A meditator is in a voice-only guided meditation session with an AI facilitator. ' +
            'The app also accepts a few spoken commands.',
        asks: Object.fromEntries(
            VOICE_COMMAND_IDS.map((id) => [
                id,
                {
                    question: COMMANDS[id],
                    threshold:
                        id === 'mute' || id === 'mute_speaker'
                            ? MUTE_THRESHOLD
                            : VISUAL_COMMANDS.includes(id)
                              ? VISUAL_THRESHOLD
                              : COMMAND_THRESHOLD,
                },
            ])
        ),
    },
    'end-confirm': {
        situation:
            'The meditation app just asked the meditator, out loud, whether they want to end the ' +
            'session. This is their reply.',
        asks: {
            confirms: {
                question: {
                    type: 'noul',
                    instructions: {
                        question: 'Is the meditator confirming that they want to end the session now?',
                        inspect: '`utterance`',
                        focus: 'A clear yes to ending. Anything else, including carrying on with the meditation, is a no.',
                    },
                    criteria: {
                        true: {
                            what: 'Agreeing to end the session.',
                            examples: ['Yes.', "Yes, let's end it.", "Yeah, I'm done for today.", '对,结束吧。'],
                        },
                        false: {
                            what: 'Declining, hesitating, or going back to describing their experience.',
                            examples: [
                                'No, not yet.',
                                "Oh, no, I didn't mean that.",
                                'Hm, I want to stay with this a bit longer.',
                                '不,再等一会儿。',
                            ],
                        },
                    },
                },
                // Ending loses the sit; a missed yes costs one repeat.
                threshold: 0.75,
            },
            // Told apart from "neither": a plain no gets a short spoken
            // acknowledgment, while someone who just carried on meditating gets
            // an ordinary turn.
            declines: {
                question: {
                    type: 'noul',
                    instructions: {
                        question: 'Is the meditator answering the question with a no: they do not want to end the session?',
                        inspect: '`utterance`',
                        focus: 'A reply to the question. Going back to describing their experience is not a reply.',
                    },
                    criteria: {
                        true: {
                            what: 'Declining to end, or saying they were misheard.',
                            examples: ['No, not yet.', "Oh, no, I didn't mean that.", 'Keep going.', '不,再等一会儿。'],
                        },
                        false: {
                            what: 'Agreeing to end, or meditation content that ignores the question.',
                            examples: ['Yes.', "There's a heaviness in my legs.", 'Hm, it moved.', '对,结束吧。'],
                        },
                    },
                },
                threshold: 0.6,
            },
        },
    },
};

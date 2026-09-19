/**
 * The Jev questions behind spoken commands (voice-command.ts). Data only, and
 * type-only imports, so utterance-judge.ts can fold these into judgeSpec()
 * without an import cycle.
 *
 * One atomic yes/no ask per command, all sent in one request and answered in
 * parallel (~150ms for the set, about $0.00007). Measured before building: a
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
    | 'help';

/** Meditation talk that borrows a command's vocabulary. Shared by every ask:
 *  the hard part is never telling commands apart, it's telling them from this. */
const NOT_COMMANDS = [
    "There's a warmth in my chest.",
    'Everything feels like it is slowing down.',
    'I wish this feeling would end.',
    'Time seems to stretch out here.',
    "I think I'm done with this feeling.",
    '一切好像都慢下来了。',
];

function ask(question: string, what: string, examples: string[], notFor: string): JudgeQuestion {
    return {
        type: 'noul',
        instructions: {
            question,
            inspect: '`utterance`',
            focus:
                'Only an instruction to the app about the session itself counts. Describing ' +
                'experience, even in words like "slow", "end", "time" or "stop", is not a command.',
        },
        criteria: {
            true: { what, examples },
            false: { what: 'Meditation content, or a different command.', not_for: notFor, examples: NOT_COMMANDS },
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
 */
const MUTE_THRESHOLD = 0.75;

const COMMANDS: Record<VoiceCommandId, JudgeQuestion> = {
    end_session: ask(
        'Is the meditator telling the app to end the meditation session now?',
        'An instruction to end, finish or stop the session.',
        ['End the session.', "Let's stop here for today.", '结束这次冥想。'],
        'Being finished with a feeling, a thought or a silence. Naming whether to save it is a different command.'
    ),
    end_discard: ask(
        'Is the meditator telling the app to end the session without saving it?',
        'An instruction to end and discard, delete, or not save this session.',
        ['End without saving.', "End the session and don't save it.", 'Discard this session.', '不保存,直接结束。'],
        'Ending the session normally, with no mention of saving or discarding.'
    ),
    end_save: ask(
        'Is the meditator telling the app to end the session and save it?',
        'An instruction to end that explicitly asks to save or keep this session.',
        ['End and save.', 'Save this one and end the session.', "Let's finish, and keep this session.", '保存并结束。'],
        'Ending the session normally, with no mention of saving.'
    ),
    slower: ask(
        'Is the meditator asking the facilitator to speak more slowly?',
        'A request for a slower speaking pace.',
        ['Speak slower.', 'Can you slow down a bit?', '说慢一点。'],
        'Their experience or breath slowing down. Also not a request to wait longer before replying.'
    ),
    faster: ask(
        'Is the meditator asking the facilitator to speak faster?',
        'A request for a faster speaking pace.',
        ['Talk faster.', 'A bit quicker, please.', '说快一点。'],
        'Their thoughts or heart racing. Also not a request to reply sooner after they stop talking.'
    ),
    set_timer: ask(
        'Is the meditator asking to set or change a session timer to a specific length?',
        'A request to set, start, extend or change a timer, with a duration.',
        ['Set a timer for twenty minutes.', 'Make it fifteen minutes instead.', '定一个十分钟的计时。'],
        'Talking about how long something has lasted.'
    ),
    cancel_timer: ask(
        'Is the meditator asking to cancel or turn off the session timer?',
        'A request to cancel, clear or turn off the timer.',
        ['Cancel the timer.', 'Turn the timer off.', '取消计时。'],
        'Wanting a feeling to stop.'
    ),
    time_check: ask(
        'Is the meditator asking how much time has passed or is left in the session?',
        'A question about elapsed or remaining session time.',
        ['How much time is left?', 'How long have we been going?', '还剩多少时间?'],
        'Reflecting on time in their life.'
    ),
    repeat: ask(
        'Is the meditator asking the facilitator to repeat what it just said?',
        'A request to hear the last thing again.',
        ['Say that again?', 'Can you repeat that?', "Sorry, I didn't catch that.", '再说一遍。'],
        'Asking for more detail or a different explanation, which is a question for the facilitator to answer.'
    ),
    respond_sooner: ask(
        'Is the meditator asking the app to reply sooner after they finish speaking?',
        'A request for a shorter wait between them going quiet and the facilitator replying.',
        ['Can you respond more quickly?', "You're taking too long to answer.", "Don't wait so long after I stop talking.", '回应快一点。'],
        'How fast the voice speaks, which is a different command.'
    ),
    wait_longer: ask(
        'Is the meditator asking the app to wait longer before replying, because it replies before they have finished?',
        'A request for a longer pause before the facilitator replies, or a complaint about being cut off.',
        ['Can you wait a little longer before responding?', 'You keep cutting me off.', 'Give me more time to finish my thoughts.', '等我说完再回应。'],
        'Asking for a period of silence or for the facilitator to just listen, which is not about reply timing.'
    ),
    help: ask(
        'Is the meditator asking what spoken commands the app understands?',
        'A question about what they can say to, or ask of, the app itself.',
        ['List voice commands.', 'What can I say?', 'What commands are there?', '列出语音指令。'],
        'Asking the facilitator for guidance with their meditation.'
    ),
    mute: ask(
        'Is the meditator telling the app to mute or turn off the microphone?',
        'An instruction to mute, or to stop the app hearing them.',
        ['Mute the mic.', 'Turn off the microphone.', 'Stop listening to me for now.', '把麦克风关掉。'],
        'Asking the facilitator to be quiet or to just listen: there the mic stays on.'
    ),
};

export const VOICE_COMMAND_IDS = Object.keys(COMMANDS) as VoiceCommandId[];

export const COMMAND_SPECS: Readonly<Record<'command' | 'end-confirm', JudgeSpec>> = {
    command: {
        situation:
            'A meditator is in a voice-only guided meditation session with an AI facilitator. ' +
            'The app also accepts a few spoken commands.',
        asks: Object.fromEntries(
            VOICE_COMMAND_IDS.map((id) => [
                id,
                { question: COMMANDS[id], threshold: id === 'mute' ? MUTE_THRESHOLD : COMMAND_THRESHOLD },
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

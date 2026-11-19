import { describe, expect, it } from 'vitest';
import { parseBeginRequest } from '../src/facilitation/begin-command.js';
import {
    editDistance,
    leavesAsk,
    nearestWord,
    parseSetupCommand,
    setupVocabulary,
    soundKey,
    type SetupAction,
} from '../src/facilitation/setup-command.js';

function expectAll(cases: Array<[string, SetupAction[] | null]>): void {
    for (const [text, want] of cases) expect(parseSetupCommand(text), text).toEqual(want);
}

describe('parseSetupCommand: modes', () => {
    it('takes a mode by the name on its tab', () => {
        expectAll([
            ['Noting.', [{ kind: 'mode', mode: 'noting' }]],
            ['exploration', [{ kind: 'mode', mode: 'exploration' }]],
            ['Felt sense', [{ kind: 'mode', mode: 'felt_sense' }]],
            ['felt-sense mode please', [{ kind: 'mode', mode: 'felt_sense' }]],
            ['Switch to noting', [{ kind: 'mode', mode: 'noting' }]],
            ["Let's do exploration", [{ kind: 'mode', mode: 'exploration' }]],
            ["I'd like a felt sense session", [{ kind: 'mode', mode: 'felt_sense' }]],
            ['change the mode to noting', [{ kind: 'mode', mode: 'noting' }]],
            ['go to exploration mode', [{ kind: 'mode', mode: 'exploration' }]],
        ]);
    });

    it('will not unpick a mode or take two', () => {
        expectAll([
            ['not noting', null],
            ['noting or exploration', null],
            ['noting exploration', null],
        ]);
    });
});

describe('parseSetupCommand: length', () => {
    it('reads a length in words or digits', () => {
        expectAll([
            ['Twenty minutes.', [{ kind: 'length', minutes: 20 }]],
            ['20 minutes', [{ kind: 'length', minutes: 20 }]],
            ['set the timer for ten minutes', [{ kind: 'length', minutes: 10 }]],
            ['a forty five minute session', [{ kind: 'length', minutes: 45 }]],
            ['half an hour', [{ kind: 'length', minutes: 30 }]],
            ['an hour', [{ kind: 'length', minutes: 60 }]],
            ['one hour please', [{ kind: 'length', minutes: 60 }]],
            ['an hour and a half', [{ kind: 'length', minutes: 90 }]],
            ['make it fifteen minutes', [{ kind: 'length', minutes: 15 }]],
            ['timer twenty five minutes', [{ kind: 'length', minutes: 25 }]],
            ['five minute timer', [{ kind: 'length', minutes: 5 }]],
        ]);
    });

    it('turns the timer off', () => {
        expectAll([
            ['no timer', [{ kind: 'no-timer' }]],
            ['turn off the timer', [{ kind: 'no-timer' }]],
            ['timer off', [{ kind: 'no-timer' }]],
            ['open ended', [{ kind: 'no-timer' }]],
            ['cancel the timer', [{ kind: 'no-timer' }]],
            ['without a timer', [{ kind: 'no-timer' }]],
        ]);
    });

    it('leaves alone a length it cannot read, and a bare timer', () => {
        expectAll([
            ['a few minutes', null],
            ['minutes', null],
            ['timer', null],
            ['five more minutes', null],
            ['twenty minutes ago', null],
        ]);
    });
});

describe('parseSetupCommand: focuses and vibes', () => {
    it('flips one said by its name alone', () => {
        expectAll([
            ['Playful.', [{ kind: 'quality', quality: 'playful', on: 'toggle' }]],
            ['playful, please', [{ kind: 'quality', quality: 'playful', on: 'toggle' }]],
            ['Okay, spacious.', [{ kind: 'quality', quality: 'spacious', on: 'toggle' }]],
            ['feeling good', [{ kind: 'quality', quality: 'feeling_good', on: 'toggle' }]],
            ['loving kindness', [{ kind: 'quality', quality: 'loving', on: 'toggle' }]],
            ['compassion', [{ kind: 'quality', quality: 'compassionate', on: 'toggle' }]],
            ['body', [{ kind: 'focus', focus: 'body_sensations', on: 'toggle' }]],
            ['The body.', [{ kind: 'focus', focus: 'body_sensations', on: 'toggle' }]],
            ['sensations', [{ kind: 'focus', focus: 'body_sensations', on: 'toggle' }]],
            ['inner parts', [{ kind: 'focus', focus: 'inner_parts', on: 'toggle' }]],
            // The names on the setup screen's own cards.
            ['body and sensations', [{ kind: 'focus', focus: 'body_sensations', on: 'toggle' }]],
            ['emotions and feeling tone', [{ kind: 'focus', focus: 'emotions', on: 'toggle' }]],
            ['parts and inner world', [{ kind: 'focus', focus: 'inner_parts', on: 'toggle' }]],
            ['playful and light', [{ kind: 'quality', quality: 'playful', on: 'toggle' }]],
            ['loving and kind', [{ kind: 'quality', quality: 'loving', on: 'toggle' }]],
            // What a recognizer has been seen to write for one.
            ['Light-hearted.', [{ kind: 'quality', quality: 'playful', on: 'toggle' }]],
            ['Spaces.', [{ kind: 'quality', quality: 'spacious', on: 'toggle' }]],
        ]);
    });

    it('adds one when asked to, whatever it was', () => {
        expectAll([
            ['add playful', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['add spacious please', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['turn on compassionate', [{ kind: 'quality', quality: 'compassionate', on: true }]],
            ['more playful', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['a playful vibe', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['focus on the body', [{ kind: 'focus', focus: 'body_sensations', on: true }]],
            ['focus on emotions', [{ kind: 'focus', focus: 'emotions', on: true }]],
            ['the body focus', [{ kind: 'focus', focus: 'body_sensations', on: true }]],
            ['add parts', [{ kind: 'focus', focus: 'inner_parts', on: true }]],
            ['add playfulness', [{ kind: 'quality', quality: 'playful', on: true }]],
        ]);
    });

    it('does not flip what needs a word that asks, or a name inside something else', () => {
        expectAll([
            ['playfulness', null],
            ['emotional', null],
            ['body parts', null],
            ['my body', null],
            ['living', null],
            ['the focus', null],
            ['Noting.', [{ kind: 'mode', mode: 'noting' }]],
            ['following', [{ kind: 'guidance', to: 0 }]],
            ['Hell.', [{ kind: 'help' }]],
        ]);
    });

    it('takes one away', () => {
        expectAll([
            ['no playful', [{ kind: 'quality', quality: 'playful', on: false }]],
            ['remove playful', [{ kind: 'quality', quality: 'playful', on: false }]],
            ['playful off', [{ kind: 'quality', quality: 'playful', on: false }]],
            ['turn off spacious', [{ kind: 'quality', quality: 'spacious', on: false }]],
            ['not loving', [{ kind: 'quality', quality: 'loving', on: false }]],
            ['less playful', [{ kind: 'quality', quality: 'playful', on: false }]],
            ['drop the body focus', [{ kind: 'focus', focus: 'body_sensations', on: false }]],
            ['without emotions', [{ kind: 'focus', focus: 'emotions', on: false }]],
        ]);
    });

    it('takes several in one breath', () => {
        expectAll([
            [
                'playful and spacious',
                [
                    { kind: 'quality', quality: 'playful', on: true },
                    { kind: 'quality', quality: 'spacious', on: true },
                ],
            ],
            [
                'remove playful and loving',
                [
                    { kind: 'quality', quality: 'playful', on: false },
                    { kind: 'quality', quality: 'loving', on: false },
                ],
            ],
            [
                'add spacious and remove playful',
                [
                    { kind: 'quality', quality: 'spacious', on: true },
                    { kind: 'quality', quality: 'playful', on: false },
                ],
            ],
            [
                'body and emotions',
                [
                    { kind: 'focus', focus: 'body_sensations', on: true },
                    { kind: 'focus', focus: 'emotions', on: true },
                ],
            ],
        ]);
    });

    it('replaces the set when asked to change it', () => {
        expectAll([
            [
                'change the vibe to spacious',
                [
                    { kind: 'clear', group: 'quality' },
                    { kind: 'quality', quality: 'spacious', on: true },
                ],
            ],
            [
                'set the vibes to playful and loving',
                [
                    { kind: 'clear', group: 'quality' },
                    { kind: 'quality', quality: 'playful', on: true },
                    { kind: 'quality', quality: 'loving', on: true },
                ],
            ],
            [
                'only body',
                [
                    { kind: 'clear', group: 'focus' },
                    { kind: 'focus', focus: 'body_sensations', on: true },
                ],
            ],
            [
                'just spacious',
                [
                    { kind: 'clear', group: 'quality' },
                    { kind: 'quality', quality: 'spacious', on: true },
                ],
            ],
            [
                'change the focus to emotions',
                [
                    { kind: 'clear', group: 'focus' },
                    { kind: 'focus', focus: 'emotions', on: true },
                ],
            ],
        ]);
    });

    it('clears a group', () => {
        expectAll([
            ['clear the vibes', [{ kind: 'clear', group: 'quality' }]],
            ['no vibes', [{ kind: 'clear', group: 'quality' }]],
            ['remove all the vibes', [{ kind: 'clear', group: 'quality' }]],
            ['clear the focus', [{ kind: 'clear', group: 'focus' }]],
            ['no focus', [{ kind: 'clear', group: 'focus' }]],
        ]);
    });

    it('needs more than the name of a group', () => {
        expectAll([
            ['vibes', null],
            ['the focus', null],
            ['change the vibe', null],
        ]);
    });
});

describe('parseSetupCommand: guidance and responses', () => {
    it('steps the guidance', () => {
        expectAll([
            ['more guidance', [{ kind: 'guidance', to: 'up' }]],
            ['less guidance', [{ kind: 'guidance', to: 'down' }]],
            ['guide me more', [{ kind: 'guidance', to: 'up' }]],
            ['guide me less', [{ kind: 'guidance', to: 'down' }]],
            ['turn the guidance up', [{ kind: 'guidance', to: 'up' }]],
            ['turn down the guidance', [{ kind: 'guidance', to: 'down' }]],
            ['a little more guidance please', [{ kind: 'guidance', to: 'up' }]],
            ['more directing', [{ kind: 'guidance', to: 'up' }]],
            ['less directing', [{ kind: 'guidance', to: 'down' }]],
            ['more following', [{ kind: 'guidance', to: 'down' }]],
            ['lead more', [{ kind: 'guidance', to: 'up' }]],
        ]);
    });

    it('goes to a stop by its name', () => {
        expectAll([
            ['following', [{ kind: 'guidance', to: 0 }]],
            ['balanced', [{ kind: 'guidance', to: 2 }]],
            ['directing', [{ kind: 'guidance', to: 4 }]],
            ['somewhat directing', [{ kind: 'guidance', to: 3 }]],
            ['somewhat following', [{ kind: 'guidance', to: 1 }]],
            ['set the guidance to balanced', [{ kind: 'guidance', to: 2 }]],
            ['balanced guidance', [{ kind: 'guidance', to: 2 }]],
        ]);
    });

    it('goes to a stop by the number drawn under it', () => {
        expectAll([
            ['guidance three', [{ kind: 'guidance', to: 2 }]],
            ['Guidance level 3.', [{ kind: 'guidance', to: 2 }]],
            ['set guidance to four', [{ kind: 'guidance', to: 3 }]],
            ['set the guidance level to 2', [{ kind: 'guidance', to: 1 }]],
            ['guidance one', [{ kind: 'guidance', to: 0 }]],
            ['set the guidance to one', [{ kind: 'guidance', to: 0 }]],
            ['okay, guidance five please', [{ kind: 'guidance', to: 4 }]],
            ['guidance two please', [{ kind: 'guidance', to: 1 }]],
            ['playful and guidance four', [{ kind: 'quality', quality: 'playful', on: true }, { kind: 'guidance', to: 3 }]],
            ['guidance four and twenty minutes', [{ kind: 'length', minutes: 20 }, { kind: 'guidance', to: 3 }]],
        ]);
    });

    it('hears "for" and "to" after guidance as the number, said on 2026-11-17', () => {
        expectAll([
            ['Guidance for', [{ kind: 'guidance', to: 3 }]],
            ['Guidance five.', [{ kind: 'guidance', to: 4 }]],
            ['Guidance to.', [{ kind: 'guidance', to: 1 }]],
            ['guidance too', [{ kind: 'guidance', to: 1 }]],
            ['guidance level for', [{ kind: 'guidance', to: 3 }]],
            ['set guidance to for', [{ kind: 'guidance', to: 3 }]],
            // Not where the word is doing its own job.
            ['set the guidance to', null],
            ['more guidance too', [{ kind: 'guidance', to: 'up' }]],
            ['give me guidance too', null],
            ['guidance for ten minutes', null],
            // And numberAsWord still reads a "two" that comes before a value.
            ['set the guidance two balanced', [{ kind: 'guidance', to: 2 }]],
        ]);
    });

    it('takes no number but a stop, and none without guidance', () => {
        expectAll([
            ['guidance 0', null],
            ['guidance six', null],
            ['guidance twenty', null],
            ['guidance five minutes', null],
            ['guidance three more', null],
            ['no guidance three', null],
            ['the guidance one', null],
            ['five', null],
            ['level 3', null],
            ['three', null],
        ]);
    });

    it('changes how much the facilitator says', () => {
        expectAll([
            ['shorter responses', [{ kind: 'verbosity', to: 'down' }]],
            ['longer responses', [{ kind: 'verbosity', to: 'up' }]],
            ['brief responses', [{ kind: 'verbosity', to: 'low' }]],
            ['medium responses', [{ kind: 'verbosity', to: 'medium' }]],
            ['long responses', [{ kind: 'verbosity', to: 'high' }]],
            ['talk less', [{ kind: 'verbosity', to: 'down' }]],
            ['say more', [{ kind: 'verbosity', to: 'up' }]],
            ['make the responses shorter', [{ kind: 'verbosity', to: 'down' }]],
            ['set response length to brief', [{ kind: 'verbosity', to: 'low' }]],
            ['keep your replies short', [{ kind: 'verbosity', to: 'low' }]],
        ]);
    });

    it('does not guess which thing "more" is about', () => {
        expectAll([
            ['more', null],
            ['less', null],
            ['longer', null],
            ['shorter', null],
            ['guidance', null],
            ['more or less guidance', null],
        ]);
    });
});

describe('parseSetupCommand: intention, check-ins, the mic', () => {
    it('takes the intention as said', () => {
        expectAll([
            ['My intention is to rest.', [{ kind: 'intention', text: 'to rest' }]],
            ['my intention is: be kind to myself', [{ kind: 'intention', text: 'be kind to myself' }]],
            ['Set my intention to letting go of the day', [{ kind: 'intention', text: 'letting go of the day' }]],
            ['The intention for this session is patience', [{ kind: 'intention', text: 'patience' }]],
            ['I want to sit with the job decision', [{ kind: 'intention', text: 'the job decision' }]],
            ['Clear my intention', [{ kind: 'intention', text: '' }]],
            ['no intention', [{ kind: 'intention', text: '' }]],
        ]);
    });

    it('keeps the words of an intention as they were said, case included', () => {
        expect(parseSetupCommand('My intention is to call Maria back')).toEqual([
            { kind: 'intention', text: 'to call Maria back' },
        ]);
    });

    it('turns check-ins on and off', () => {
        expectAll([
            ['check-ins off', [{ kind: 'checkins', on: false }]],
            ['no check ins', [{ kind: 'checkins', on: false }]],
            ["don't check in", [{ kind: 'checkins', on: false }]],
            ['turn on check-ins', [{ kind: 'checkins', on: true }]],
            ['check in if I am quiet', null],
            ["check in on me if I'm quiet", [{ kind: 'checkins', on: true }]],
            ["don't check in on me when I'm quiet", [{ kind: 'checkins', on: false }]],
        ]);
    });

    it('takes the special requests field by its label, said like the intention', () => {
        const ask: SetupAction[] = [{ kind: 'special-request-ask' }];
        expectAll([
            ['Special requests.', ask],
            ['special requests, please', ask],
            ['add a special request', ask],
            ["I'd like to add a special request", ask],
            ['I have a special request', ask],
            ['open special requests', ask],
            ['my special request is', ask],
            ['special requests for this session', ask],
            // The label it had before.
            ['Additional instructions.', ask],
            ['Special request: keep it slow.', [{ kind: 'special-request', text: 'keep it slow' }]],
            ['Special request, keep it slow.', [{ kind: 'special-request', text: 'keep it slow' }]],
            ['add a special request to keep it slow', [{ kind: 'special-request', text: 'keep it slow' }]],
            ['add a special request keep it slow', [{ kind: 'special-request', text: 'keep it slow' }]],
            ['my special request is to go gently', [{ kind: 'special-request', text: 'to go gently' }]],
            ['I have a special request, could you speak softly', [{ kind: 'special-request', text: 'could you speak softly' }]],
            // Its own words, so begin and start are the meditator's.
            ['Special request: start slowly.', [{ kind: 'special-request', text: 'start slowly' }]],
            ['Special request: No talk of breathing', [{ kind: 'special-request', text: 'No talk of breathing' }]],
            ['clear my special requests', [{ kind: 'special-request', text: '' }]],
            ['no special requests', [{ kind: 'special-request', text: '' }]],
            ['special request: none', [{ kind: 'special-request', text: '' }]],
            ['add a special request now', ask],
        ]);
    });

    it('leaves alone special requests said to someone else', () => {
        expectAll([
            ['Any special requests?', null],
            ['do you take special requests', null],
            ['special requests are welcome at the front desk', null],
            ['how do I get to additional instructions', null],
            ['special requests', [{ kind: 'special-request-ask' }]],
            ['my intention is to make a special request', [{ kind: 'intention', text: 'to make a special request' }]],
        ]);
    });

    it('closes the mic and offers help', () => {
        expectAll([
            ['stop listening', [{ kind: 'stop-listening' }]],
            ['Mute.', [{ kind: 'stop-listening' }]],
            ['okay, stop listening please', [{ kind: 'stop-listening' }]],
            ['turn off the microphone', [{ kind: 'stop-listening' }]],
            ['What can I say?', [{ kind: 'help' }]],
            ['help', [{ kind: 'help' }]],
        ]);
    });
});

describe('parseSetupCommand: combined requests', () => {
    it('reads the parts in order', () => {
        expectAll([
            [
                'felt sense and twenty minutes',
                [
                    { kind: 'length', minutes: 20 },
                    { kind: 'mode', mode: 'felt_sense' },
                ],
            ],
            [
                'exploration, playful, ten minutes',
                [
                    { kind: 'length', minutes: 10 },
                    { kind: 'mode', mode: 'exploration' },
                    { kind: 'quality', quality: 'playful', on: true },
                ],
            ],
            [
                'more guidance and shorter responses',
                [
                    { kind: 'guidance', to: 'up' },
                    { kind: 'verbosity', to: 'down' },
                ],
            ],
        ]);
    });
});

describe('parseSetupCommand: commas, and how far a "no" reaches', () => {
    it('parts a request at a comma as at "and"', () => {
        expectAll([
            [
                'spacious and effortless, no check-ins',
                [
                    { kind: 'quality', quality: 'spacious', on: true },
                    { kind: 'quality', quality: 'effortless', on: true },
                    { kind: 'checkins', on: false },
                ],
            ],
            [
                'playful, not loving',
                [
                    { kind: 'quality', quality: 'playful', on: true },
                    { kind: 'quality', quality: 'loving', on: false },
                ],
            ],
            ['no, less guidance', [{ kind: 'guidance', to: 'down' }]],
            [
                'Spacious and effortless. No check-ins.',
                [
                    { kind: 'quality', quality: 'spacious', on: true },
                    { kind: 'quality', quality: 'effortless', on: true },
                    { kind: 'checkins', on: false },
                ],
            ],
            // With no punctuation at all (the browser's recognizer writes none).
            [
                'spacious and effortless no check-ins',
                [
                    { kind: 'quality', quality: 'spacious', on: true },
                    { kind: 'quality', quality: 'effortless', on: true },
                    { kind: 'checkins', on: false },
                ],
            ],
            [
                'body not emotions',
                [
                    { kind: 'focus', focus: 'body_sensations', on: true },
                    { kind: 'focus', focus: 'emotions', on: false },
                ],
            ],
            ['Noting, please.', [{ kind: 'mode', mode: 'noting' }]],
        ]);
    });

    it('carries a "no" to more of the same, not to something else', () => {
        expectAll([
            [
                'remove playful, loving and body',
                [
                    { kind: 'quality', quality: 'playful', on: false },
                    { kind: 'quality', quality: 'loving', on: false },
                    { kind: 'focus', focus: 'body_sensations', on: false },
                ],
            ],
            [
                'no check-ins and spacious',
                [
                    { kind: 'checkins', on: false },
                    { kind: 'quality', quality: 'spacious', on: true },
                ],
            ],
            ['no, playful', [{ kind: 'quality', quality: 'playful', on: false }]],
            ['No, nothing.', null],
            ['no, noting', null],
        ]);
    });

    it('goes back to a mode, and takes felt sense by its other name when asked', () => {
        expectAll([
            ['go back to exploration', [{ kind: 'mode', mode: 'exploration' }]],
            ['switch to focusing', [{ kind: 'mode', mode: 'felt_sense' }]],
            ['focusing', null],
            ['I was focusing', null],
        ]);
    });
});

describe('parseSetupCommand: what a room says', () => {
    it('changes nothing', () => {
        for (const text of [
            '',
            'I love playing with my kids',
            'it started twenty minutes ago',
            'the body of the email was fine',
            'she was very loving',
            "that's a lot of space",
            'kind of a long day',
            'I have parts on order for the car',
            'what time is it',
            'can you pass the salt',
            'he was noting that the meeting ran long',
            'we explored the whole city',
            'my intention',
            'emotions were running high at the game',
            'the timer on the oven is broken',
            'turn it off',
            'more',
            'okay',
            'yes please',
            'thanks',
            'on',
            'off',
            'light',
            'kind',
            'love',
            'long',
            'short',
            'lead',
            'follow',
            'space',
        ]) {
            expect(parseSetupCommand(text), text).toBeNull();
        }
    });

    it('leaves alone what people say to each other in this vocabulary', () => {
        for (const text of [
            'give me five minutes',
            'just a minute',
            'In twenty minutes.',
            'one minute',
            'Speak up.',
            'Body parts.',
            'Noting that.',
            'Nothing more.',
            'no more noting',
            'playful off on',
            'in an hour',
            'do nothing',
            'I want nothing',
            'try nothing',
            'turn on the light',
            'turn off the light',
            'make it light',
            'give me some space',
            'I want space',
            "I'm feeling good",
            'are you feeling good',
            'make love',
            'I have feelings',
            'my body',
            'the response is long',
            'just checking in',
            'I have to check in',
            'check-ins',
            'the intention was good',
            'My intention was to call you back',
            'sit with me',
            "let's sit with Grandma",
            'playfulness',
            'emotional',
            'five',
            'level three',
            'number four',
            'thanks for the guidance',
            'guidance for beginners',
            'I need guidance for',
            'I have guidance too',
            'the guidance is two',
        ]) {
            expect(parseSetupCommand(text), text).toBeNull();
        }
    });

    it('still takes a length asked for plainly', () => {
        expectAll([
            ['I want twenty minutes', [{ kind: 'length', minutes: 20 }]],
            ["let's do ten minutes", [{ kind: 'length', minutes: 10 }]],
            ['two minutes', [{ kind: 'length', minutes: 2 }]],
        ]);
    });

    it('reads what the review found it refusing', () => {
        expectAll([
            ['my intention is to start fresh', [{ kind: 'intention', text: 'to start fresh' }]],
            ['My intention: begin again', [{ kind: 'intention', text: 'begin again' }]],
            [
                'check ins off for felt sense',
                [
                    { kind: 'checkins', on: false },
                    { kind: 'mode', mode: 'felt_sense' },
                ],
            ],
            ['about twenty minutes', [{ kind: 'length', minutes: 20 }]],
            ['no time limit', [{ kind: 'no-timer' }]],
            ['playful exploration', [{ kind: 'quality', quality: 'playful', on: true }, { kind: 'mode', mode: 'exploration' }]],
        ]);
    });

    it('lets a denial outrank an "on" in the same breath', () => {
        expectAll([
            ["don't check in on me", [{ kind: 'checkins', on: false }]],
            ["don't turn on check-ins", [{ kind: 'checkins', on: false }]],
            ['no, not playful', [{ kind: 'quality', quality: 'playful', on: false }]],
            ['turn the guidance up', [{ kind: 'guidance', to: 'up' }]],
            ['say more', [{ kind: 'verbosity', to: 'up' }]],
        ]);
    });

    it('never reads a request to begin, however it sounds', () => {
        for (const text of [
            'begin',
            'start',
            'begin a noting session',
            'start a twenty minute session',
            'begin playful',
            'beginning',
            'began',
            'started',
        ]) {
            expect(parseSetupCommand(text), text).toBeNull();
        }
        // And nothing loosely matched turns into one.
        expect(parseBeginRequest('bigin')).toBeNull();
    });
});

describe('parseSetupCommand: mishearings', () => {
    it('hears a value word that is one sound off, beside a word that asks', () => {
        expectAll([
            ['add specious', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['switch to nothing', [{ kind: 'mode', mode: 'noting' }]],
            ['nodding mode', [{ kind: 'mode', mode: 'noting' }]],
            ['add living', [{ kind: 'quality', quality: 'loving', on: true }]],
            ['turn on playfull', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['more guidence', [{ kind: 'guidance', to: 'up' }]],
            ['felt since mode', [{ kind: 'mode', mode: 'felt_sense' }]],
        ]);
    });

    it('does not act on a sound-alike said by itself', () => {
        expectAll([
            ['nothing', null],
            ['living', null],
            ['nodding', null],
            ['knowing mode', null],
            ['explanation', null],
            ['pants', null],
        ]);
    });

    it('takes the mishearings it has been shown as the phrase itself', () => {
        expectAll([
            ['spaces', [{ kind: 'quality', quality: 'spacious', on: 'toggle' }]],
            ['add spaces', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['felt cents', [{ kind: 'mode', mode: 'felt_sense' }]],
            ['check ends off', [{ kind: 'checkins', on: false }]],
            ['compassion it', [{ kind: 'quality', quality: 'compassionate', on: true }]],
        ]);
    });

    it('reads what local Whisper wrote for the synthetic voices', () => {
        expectAll([
            ['More light-hearted.', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['More light hearted.', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['Talkless.', [{ kind: 'verbosity', to: 'down' }]],
            ['Aspacious vibe.', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['auspicious vibe.', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['Noding.', [{ kind: 'mode', mode: 'noting' }]],
            ['Half and hour.', [{ kind: 'length', minutes: 30 }]],
            ['Hell.', [{ kind: 'help' }]],
            ['Health.', [{ kind: 'help' }]],
            ['Held.', [{ kind: 'help' }]],
            ['Muse.', [{ kind: 'stop-listening' }]],
            ['On check-parts.', [{ kind: 'focus', focus: 'inner_parts', on: false }]],
            ['on check-ins', [{ kind: 'checkins', on: true }]],
        ]);
    });

    it('does not trust the rest when the thing asked for was not heard', () => {
        expectAll([
            // "Change the focus to parts."
            ['Change the focus to balance.', null],
            ['set the vibe to following', null],
            // The light is still the room's.
            ['turn on the light', null],
            ['what the hell', null],
            // Whisper wrote this for "less playful" as well as for "playful".
            ["Let's play full.", null],
        ]);
    });

    it('does not stretch to a far miss (the judge tier does)', () => {
        expectAll([
            ['change advice to spaces', null],
            ['add play', null],
        ]);
    });
});

describe('parseSetupCommand: zh', () => {
    it('reads the setup screen by its own names', () => {
        expectAll([
            ['标记', [{ kind: 'mode', mode: 'noting' }]],
            ['探索模式', [{ kind: 'mode', mode: 'exploration' }]],
            ['切换到体会', [{ kind: 'mode', mode: 'felt_sense' }]],
            ['二十分钟', [{ kind: 'length', minutes: 20 }]],
            ['计时十分钟', [{ kind: 'length', minutes: 10 }]],
            ['半小时', [{ kind: 'length', minutes: 30 }]],
            ['不要计时', [{ kind: 'no-timer' }]],
            ['加上开阔', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['去掉慈悲', [{ kind: 'quality', quality: 'compassionate', on: false }]],
            ['轻松有玩心', [{ kind: 'quality', quality: 'playful', on: 'toggle' }]],
            ['身体', [{ kind: 'focus', focus: 'body_sensations', on: 'toggle' }]],
            ['加上身体', [{ kind: 'focus', focus: 'body_sensations', on: true }]],
            ['不要情绪', [{ kind: 'focus', focus: 'emotions', on: false }]],
            ['多一点引导', [{ kind: 'guidance', to: 'up' }]],
            ['少一点引导', [{ kind: 'guidance', to: 'down' }]],
            ['说少一点', [{ kind: 'verbosity', to: 'down' }]],
            ['回应简短', [{ kind: 'verbosity', to: 'low' }]],
            ['我的意图是好好休息', [{ kind: 'intention', text: '好好休息' }]],
            ['清除意图', [{ kind: 'intention', text: '' }]],
            ['停止聆听', [{ kind: 'stop-listening' }]],
            ['我可以说什么', [{ kind: 'help' }]],
            [
                '体会，二十分钟',
                [
                    { kind: 'mode', mode: 'felt_sense' },
                    { kind: 'length', minutes: 20 },
                ],
            ],
        ]);
    });

    it('reads traditional characters, and past what Whisper leaves at the end', () => {
        expectAll([
            ['去掉內在部分', [{ kind: 'focus', focus: 'inner_parts', on: false }]],
            ['加上情緒', [{ kind: 'focus', focus: 'emotions', on: true }]],
            ['半小時', [{ kind: 'length', minutes: 30 }]],
            ['設定45分鐘', [{ kind: 'length', minutes: 45 }]],
            ['幫助', [{ kind: 'help' }]],
            ['多一點引導', [{ kind: 'guidance', to: 'up' }]],
            ['不要問候我', [{ kind: 'checkins', on: false }]],
            ['半小时４', [{ kind: 'length', minutes: 30 }]],
            ['切换到体会\uFFFD', [{ kind: 'mode', mode: 'felt_sense' }]],
            ['轻松和开阔\uFFFD', [
                { kind: 'quality', quality: 'playful', on: true },
                { kind: 'quality', quality: 'spacious', on: true },
            ]],
            // An intention keeps the characters it was said in.
            ['我的意圖是放鬆', [{ kind: 'intention', text: '放鬆' }]],
            ['我的意图是放松４', [{ kind: 'intention', text: '放松' }]],
        ]);
    });

    it('reads a mode and a length run together, "only", and a whole group', () => {
        const notingTen: SetupAction[] = [{ kind: 'mode', mode: 'noting' }, { kind: 'length', minutes: 10 }];
        expectAll([
            ['标记十分钟', notingTen],
            ['标记十分钟，', notingTen],
            ['標記:十分鐘', notingTen],
            ['只要身体', [{ kind: 'clear', group: 'focus' }, { kind: 'focus', focus: 'body_sensations', on: true }]],
            ['只要开阔', [{ kind: 'clear', group: 'quality' }, { kind: 'quality', quality: 'spacious', on: true }]],
            ['去掉所有氛围', [{ kind: 'clear', group: 'quality' }]],
            ['去掉所有焦点', [{ kind: 'clear', group: 'focus' }]],
            ['开阔的氛围', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['只要二十分钟', null],
            ['只要探索', null],
        ]);
    });

    it('flips a lone name, polite words around it allowed; asking adds or removes', () => {
        expectAll([
            ['开阔', [{ kind: 'quality', quality: 'spacious', on: 'toggle' }]],
            ['请开阔吧', [{ kind: 'quality', quality: 'spacious', on: 'toggle' }]],
            ['身體，', [{ kind: 'focus', focus: 'body_sensations', on: 'toggle' }]],
            ['加上开阔', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['我要开阔', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['开阔的氛围', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['去掉开阔', [{ kind: 'quality', quality: 'spacious', on: false }]],
            ['轻松和开阔', [
                { kind: 'quality', quality: 'playful', on: true },
                { kind: 'quality', quality: 'spacious', on: true },
            ]],
            ['标记', [{ kind: 'mode', mode: 'noting' }]],
        ]);
    });

    it('takes the special requests field like the intention', () => {
        expectAll([
            ['特别要求', [{ kind: 'special-request-ask' }]],
            ['我有一个特别要求', [{ kind: 'special-request-ask' }]],
            ['我想提一个特别要求', [{ kind: 'special-request-ask' }]],
            ['加一个特别要求', [{ kind: 'special-request-ask' }]],
            ['补充指引', [{ kind: 'special-request-ask' }]],
            ['特别要求：慢一点', [{ kind: 'special-request', text: '慢一点' }]],
            ['我的特别要求是慢一点', [{ kind: 'special-request', text: '慢一点' }]],
            ['添加特别要求慢一点', [{ kind: 'special-request', text: '慢一点' }]],
            ['特別要求：說話慢一點', [{ kind: 'special-request', text: '說話慢一點' }]],
            ['清除特别要求', [{ kind: 'special-request', text: '' }]],
            ['特别要求大家注意安全', null],
        ]);
    });

    it('takes a guidance stop by its number', () => {
        expectAll([
            ['引导三', [{ kind: 'guidance', to: 2 }]],
            ['把引导调到四吧', [{ kind: 'guidance', to: 3 }]],
            ['引导1', [{ kind: 'guidance', to: 0 }]],
            ['引导六', null],
            ['三', null],
        ]);
    });

    it('takes the sound-alikes Whisper writes for its own words', () => {
        expectAll([
            ['不要记时器。', [{ kind: 'no-timer' }]],
            ['不要計時期', [{ kind: 'no-timer' }]],
            ['加上此爱', [{ kind: 'quality', quality: 'loving', on: true }]],
            ['问号我', [{ kind: 'checkins', on: true }]],
            ['计时期', null],
        ]);
    });

    it('ignores the rest, and never begins', () => {
        for (const text of ['今天天气不错', '开始', '開始', '开始冥想', '我二十分钟前到的', '他很慈悲', '身体不舒服']) {
            expect(parseSetupCommand(text), text).toBeNull();
        }
    });
});

describe('leavesAsk', () => {
    it('tells leaving the question from answering it', () => {
        for (const said of ['Never mind.', 'cancel', 'Cancel that.', 'no', 'okay, forget it', '取消', '算了。', '不加了']) {
            expect(leavesAsk(said), said).toBe('cancel');
        }
        for (const said of ['Done.', "I'm done", "That's it.", 'all done, thanks', 'Close.', '好了', '完成。', '就這樣']) {
            expect(leavesAsk(said), said).toBe('done');
        }
        for (const said of ['keep it slow', 'done with breathing cues', 'to rest', 'not too fast', '慢一点', '完成这个项目']) {
            expect(leavesAsk(said), said).toBeNull();
        }
    });
});

describe('loose matching', () => {
    it('folds sounds a recognizer confuses', () => {
        expect(soundKey('spacious')).toBe(soundKey('spaces'));
        expect(soundKey('noting')).toBe(soundKey('noding'));
        expect(soundKey('playful')).not.toBe(soundKey('painful'));
    });

    it('counts edits', () => {
        expect(editDistance('noting', 'nothing')).toBe(1);
        expect(editDistance('abcd', 'abdc')).toBe(1);
        expect(editDistance('', 'abc')).toBe(3);
    });

    it('finds the near word and refuses a far or short one', () => {
        expect(nearestWord('specious')).toBe('spacious');
        expect(nearestWord('guidence')).toBe('guidance');
        expect(nearestWord('living')).toBe('loving');
        // Close in spelling is not close in sound.
        expect(nearestWord('explanation')).toBeNull();
        expect(nearestWord('painful')).toBeNull();
        expect(nearestWord('advice')).toBeNull();
        expect(nearestWord('bod')).toBeNull();
    });
});

describe('setupVocabulary', () => {
    it('leaves begin out of what a recognizer is told to expect', () => {
        for (const language of ['en', 'zh']) {
            const { prompt, phrases } = setupVocabulary(language);
            const all = [prompt ?? '', ...phrases].join(' ').toLowerCase();
            expect(all).not.toMatch(/begin|start|开始/);
            expect(phrases.length).toBeGreaterThan(10);
        }
    });

    it('prompts in English only: the zh prompt wrote its own words over speech', () => {
        expect(setupVocabulary('en').prompt).toMatch(/noting/i);
        expect(setupVocabulary('zh').prompt).toBeNull();
    });

    it('names only things the parser reads', () => {
        for (const phrase of setupVocabulary('en').phrases) {
            if (phrase === 'vibes' || phrase === 'focus' || phrase === 'my intention is') continue;
            expect(parseSetupCommand(phrase), phrase).not.toBeNull();
        }
    });
});

describe('said on 2026-11-14, in a room', () => {
    const read = (said: string) => parseSetupCommand(said);

    it('reads the number a recognizer writes for "to" and "for"', () => {
        expect(read('Set the focus two parts.')).toEqual(read('Set the focus to parts.'));
        expect(read('set the vibe 2 playful')).toEqual(read('set the vibe to playful'));
        expect(read('set a timer four ten minutes')).toEqual([{ kind: 'length', minutes: 10 }]);
        // Where the number can be the length, it is.
        expect(read('set the timer for two minutes')).toEqual([{ kind: 'length', minutes: 2 }]);
        expect(read('two parts')).toBeNull();
        expect(read('it comes in two parts')).toBeNull();
    });

    it('sets the guidance by level, all five stops', () => {
        expect(read('Set the guidance level to medium.')).toEqual([{ kind: 'guidance', to: 2 }]);
        expect(read('minimum guidance')).toEqual([{ kind: 'guidance', to: 0 }]);
        expect(read('low guidance')).toEqual([{ kind: 'guidance', to: 1 }]);
        expect(read('set guidance to high')).toEqual([{ kind: 'guidance', to: 3 }]);
        expect(read('guidance to the max')).toEqual([{ kind: 'guidance', to: 4 }]);
    });

    it('gives a level to the setting named beside it, and to neither alone', () => {
        expect(read('set response length to medium')).toEqual([{ kind: 'verbosity', to: 'medium' }]);
        expect(read('set verbosity to low')).toEqual([{ kind: 'verbosity', to: 'low' }]);
        expect(read('Medium.')).toBeNull();
        expect(read('high')).toBeNull();
        expect(read('medium guidance and responses')).toBeNull();
    });

    it('tells hiding the clock from turning it off, and both from the timer', () => {
        expect(read('Hide the clock.')).toEqual([{ kind: 'clock', show: false }]);
        expect(read('hide the timer')).toEqual([{ kind: 'clock', show: false }]);
        expect(read('show the clock')).toEqual([{ kind: 'clock', show: true }]);
        expect(read("don't show the clock")).toEqual([{ kind: 'clock', show: false }]);
        expect(read('Turn off the clock.')).toEqual([{ kind: 'clock', show: false, timerOff: true }]);
        expect(read('turn off the timer')).toEqual([{ kind: 'no-timer' }]);
        expect(read('set the clock for twenty minutes')).toEqual([{ kind: 'length', minutes: 20 }]);
        expect(read('hide it')).toBeNull();
    });

    it('switches what the clock counts, when asked to', () => {
        expect(read('show the time of day')).toEqual([{ kind: 'clock-mode', mode: 'wall' }]);
        expect(read('set the clock to time in session')).toEqual([{ kind: 'clock-mode', mode: 'elapsed' }]);
        expect(read('Time of day.')).toBeNull();
    });

    it('asks for the intention when the request stops short of one', () => {
        for (const said of ['Set intention.', 'set my intention', "I'd like to set an intention", 'Set my intention to.']) {
            expect(read(said), said).toEqual([{ kind: 'intention-ask' }]);
        }
        expect(read('set my intention to rest')).toEqual([{ kind: 'intention', text: 'rest' }]);
        expect(read('intention')).toBeNull();
        expect(read('设置意图')).toEqual([{ kind: 'intention-ask' }]);
        expect(read('隐藏时钟')).toEqual([{ kind: 'clock', show: false }]);
    });

    it('takes a few more ways of saying the same things', () => {
        expect(read('set the length to half an hour')).toEqual([{ kind: 'length', minutes: 30 }]);
        expect(read('be more directive')).toEqual([{ kind: 'guidance', to: 'up' }]);
        expect(read('just the body')).toEqual(read('body only'));
        expect(read('set the mood to playful')).toEqual(read('set the vibe to playful'));
        expect(read('just a little more guidance')).toEqual([{ kind: 'guidance', to: 'up' }]);
        expect(read("I'll be twenty minutes")).toBeNull();
        expect(read('what a mood')).toBeNull();
    });
});

import { describe, expect, it } from 'vitest';
import { parseBeginRequest } from '../src/facilitation/begin-command.js';
import {
    editDistance,
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
    it('adds one by naming it', () => {
        expectAll([
            ['Playful.', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['add playful', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['add spacious please', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['feeling good', [{ kind: 'quality', quality: 'feeling_good', on: true }]],
            ['turn on compassionate', [{ kind: 'quality', quality: 'compassionate', on: true }]],
            ['loving kindness', [{ kind: 'quality', quality: 'loving', on: true }]],
            ['more playful', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['a playful vibe', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['body', [{ kind: 'focus', focus: 'body_sensations', on: true }]],
            ['focus on the body', [{ kind: 'focus', focus: 'body_sensations', on: true }]],
            ['focus on emotions', [{ kind: 'focus', focus: 'emotions', on: true }]],
            ['add parts', [{ kind: 'focus', focus: 'inner_parts', on: true }]],
            ['inner parts', [{ kind: 'focus', focus: 'inner_parts', on: true }]],
            ['body and sensations', [{ kind: 'focus', focus: 'body_sensations', on: true }]],
            ['emotions and feeling tone', [{ kind: 'focus', focus: 'emotions', on: true }]],
            ['parts and inner world', [{ kind: 'focus', focus: 'inner_parts', on: true }]],
            ['playful and light', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['loving and kind', [{ kind: 'quality', quality: 'loving', on: true }]],
            ['add a light vibe', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['some space please, add space', [{ kind: 'quality', quality: 'spacious', on: true }]],
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
            ['spaces', [{ kind: 'quality', quality: 'spacious', on: true }]],
            ['felt cents', [{ kind: 'mode', mode: 'felt_sense' }]],
            ['check ends off', [{ kind: 'checkins', on: false }]],
            ['compassion it', [{ kind: 'quality', quality: 'compassionate', on: true }]],
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
            ['轻松有玩心', [{ kind: 'quality', quality: 'playful', on: true }]],
            ['身体', [{ kind: 'focus', focus: 'body_sensations', on: true }]],
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

    it('ignores the rest, and never begins', () => {
        for (const text of ['今天天气不错', '开始', '开始冥想', '我二十分钟前到的', '他很慈悲', '身体不舒服']) {
            expect(parseSetupCommand(text), text).toBeNull();
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
            const all = [prompt, ...phrases].join(' ').toLowerCase();
            expect(all).not.toMatch(/begin|start|开始/);
            expect(phrases.length).toBeGreaterThan(10);
        }
    });

    it('names only things the parser reads', () => {
        for (const phrase of setupVocabulary('en').phrases) {
            if (phrase === 'vibes' || phrase === 'focus' || phrase === 'my intention is') continue;
            expect(parseSetupCommand(phrase), phrase).not.toBeNull();
        }
    });
});

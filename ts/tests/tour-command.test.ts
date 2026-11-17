import { describe, expect, it } from 'vitest';
import { parseTourCommand } from '../src/facilitation/tour-command.js';

const en = [
    { name: 'Harper', gender: 'female' },
    { name: 'Ethan', gender: 'male' },
];
const zh = [
    { name: 'Serena', gender: 'female' },
    { name: 'Yunfan', gender: 'male' },
];

describe('parseTourCommand', () => {
    it('reads the tour words, with the politeness around them', () => {
        const cases: Array<[string, string]> = [
            ['Next.', 'next'],
            ['okay, next', 'next'],
            ['Continue please', 'next'],
            ['got it', 'next'],
            ['go back', 'back'],
            ['Back.', 'back'],
            ['say that again', 'repeat'],
            ['Repeat that please', 'repeat'],
            ['skip', 'close'],
            ['close the tour', 'close'],
            ["that's enough", 'close'],
            ['mute', 'quiet'],
            ['stop talking', 'quiet'],
            ['skip this step', 'close'],
            ['unmute', 'speak'],
            ['下一步', 'next'],
            ['下一個', 'next'],
            ['繼續', 'next'],
            ['好的，继续吧', 'next'],
            // The last card's button, 知道了, said as it reads.
            ['知道了', 'next'],
            ['好的，明白了。', 'next'],
            ['别说了', 'quiet'],
            ['返回', 'back'],
            ['再说一遍', 'repeat'],
            ['跳过', 'close'],
            ['静音', 'quiet'],
        ];
        for (const [text, kind] of cases) expect(parseTourCommand(text), text).toEqual({ kind });
    });

    it('ignores a sentence that only contains one', () => {
        for (const text of [
            '',
            'what happens next',
            'I will be back in a minute',
            'the next train is at six',
            'close the door',
            'okay',
            'yes',
            'begin',
            'stop',
            'quiet',
            'hush',
            'silence',
            '下一步怎么办',
        ]) {
            expect(parseTourCommand(text), text).toBeNull();
        }
    });

    it('takes a voice by name, by place, or by how it sounds', () => {
        const cases: Array<[string, number]> = [
            ['Harper', 0],
            ['Ethan.', 1],
            ["I'd like Harper please", 0],
            ['the first one', 0],
            ['first', 0],
            ['the second one', 1],
            ['number one', 0],
            ['two', 1],
            ['the woman', 0],
            ['the man', 1],
            ["let's go with the second", 1],
        ];
        for (const [text, index] of cases) expect(parseTourCommand(text, en), text).toEqual({ kind: 'voice', index });
        expect(parseTourCommand('第一个', zh)).toEqual({ kind: 'voice', index: 0 });
        expect(parseTourCommand('女声', zh)).toEqual({ kind: 'voice', index: 0 });
        expect(parseTourCommand('我想听Yunfan', zh)).toEqual({ kind: 'voice', index: 1 });
        expect(parseTourCommand('男的', zh)).toEqual({ kind: 'voice', index: 1 });
    });

    it('takes no voice from an answer that names both or neither', () => {
        for (const text of [
            'Harper or Ethan',
            'either one',
            'the first or the second',
            'I like them',
            'Hermione',
            'her',
            'one',
            'the one',
            'he would like to go with me',
            'would you like to go with him',
            'give her the one',
        ]) {
            expect(parseTourCommand(text, en), text).toBeNull();
        }
    });

    it('still reads the tour words on the voice step, and no voice off it', () => {
        expect(parseTourCommand('next', en)).toEqual({ kind: 'next' });
        expect(parseTourCommand('Harper')).toBeNull();
        expect(parseTourCommand('the first one')).toBeNull();
    });

    it('does not guess a voice by gender when both are the same', () => {
        const same = [
            { name: 'Harper', gender: 'female' },
            { name: 'Isla', gender: 'female' },
        ];
        expect(parseTourCommand('the woman', same)).toBeNull();
        expect(parseTourCommand('Isla', same)).toEqual({ kind: 'voice', index: 1 });
    });
});

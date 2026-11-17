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
        // The names as a zh recognizer writes them.
        for (const said of ['云帆', '雲帆。', '我要云凡', '运帆吧', 'Yunfan']) {
            expect(parseTourCommand(said, zh), said).toEqual({ kind: 'voice', index: 1 });
        }
        for (const said of ['瑟琳娜', '塞雷娜', '我选赛琳娜', 'Serena']) {
            expect(parseTourCommand(said, zh), said).toEqual({ kind: 'voice', index: 0 });
        }
        expect(parseTourCommand('云帆和瑟琳娜', zh)).toBeNull();
    });

    // What local Whisper (base, zh) wrote for synthetic Mandarin voices saying
    // the names at the voice step, 2026-11-17.
    it('takes the names as local Whisper writes them', () => {
        for (const said of [
            '云翻', '我選雲翻。', '元凡', '選元翻。', '救援翻吧!', '我要允翻的聲音', '暈翻的聲音。', '我想要云范', '用援翻',
            '我喜歡雲飯。', '勻飯 謝謝', '云山。', '我選雲芳.', '我選銀番。', '勇番,謝謝!', '我喜歡暈分。',
            // Loose: everyday words, or barely the name, taken only as the whole answer.
            '要緣分', '遠方的聲音。', '元芬吧!', '我選人翻。', '就云三八。', '我選一番', '我想要您翻', '邀員犯',
            // Latin, spaced or hyphenated.
            'Yun Fan', 'yun-fan', '我选 Yun Fan',
        ]) {
            expect(parseTourCommand(said, zh), said).toEqual({ kind: 'voice', index: 1 });
        }
        for (const said of [
            'Sarina', 'Srina.', 'Cirina', '我選Srina.', 'sureena吧!', 'Sorena吧!', '我要Seryna的聲音', '就是Rina吧!', 'se rena',
            '色林纳。', '我選色靈娜。', '色林呢', '色灵啊!', '司雷娜', '蘇林娜。', '亞斯里娜',
            // Loose.
            '司霖了吧', '死淋了吧!', '我選是林娜', '我选择领纳', '我選色領納', '撕零了',
        ]) {
            expect(parseTourCommand(said, zh), said).toEqual({ kind: 'voice', index: 0 });
        }
    });

    it('takes no name from a sentence that only contains a loose spelling', () => {
        for (const said of [
            '要死了', '就死人了吧', 'corona', '这是缘分', '我想去远方看看', '呼吸均匀分布', '这里呢?', '要做什么?', '穆斯林', '撕贫。',
            '好好休息一番', '就是这里呢', '有緣分',
        ]) {
            expect(parseTourCommand(said, zh), said).toBeNull();
        }
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

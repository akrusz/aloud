import { describe, expect, it } from 'vitest';
import { toSimplified, trimHeardZh } from '../src/facilitation/zh-script.js';

describe('toSimplified', () => {
    it('brings the matchers\' words to the script they are written in', () => {
        expect(toSimplified('開始')).toBe('开始');
        expect(toSimplified('切換到體會')).toBe('切换到体会');
        expect(toSimplified('輕鬆有玩心')).toBe('轻松有玩心');
        expect(toSimplified('設定45分鐘')).toBe('设定45分钟');
        expect(toSimplified('勻飯 謝謝')).toBe('匀饭 谢谢');
        expect(toSimplified('就這樣吧')).toBe('就这样吧');
    });

    it('keeps the length, so an index into one is an index into the other', () => {
        const said = '我的意圖是放鬆，然後 rest';
        expect(toSimplified(said)).toHaveLength(said.length);
    });

    it('leaves simplified and everything else alone', () => {
        expect(toSimplified('开始 twenty minutes')).toBe('开始 twenty minutes');
    });
});

describe('trimHeardZh', () => {
    it('drops what nobody said from the end, and only from the end', () => {
        expect(trimHeardZh('半小时４')).toBe('半小时');
        expect(trimHeardZh('切换到体会\uFFFD')).toBe('切换到体会');
        expect(trimHeardZh('２０分钟')).toBe('２０分钟');
    });
});

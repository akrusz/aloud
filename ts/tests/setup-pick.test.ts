import { describe, expect, it } from 'vitest';
import { namedIn, parseSetupPick, type PickContext } from '../src/facilitation/setup-pick.js';

const ctx = (over: Partial<PickContext> = {}): PickContext => ({
    voices: ['Harper', 'Ethan', 'Samantha', 'Samantha (Enhanced)', 'en_US-amy-medium', 'Google US English'],
    models: [
        { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
        { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
        { value: 'gpt-6-luna', label: 'GPT-6 Luna' },
        { value: 'claude-opus-5', label: 'Claude Opus 5' },
    ],
    pickerOpen: false,
    ...over,
});
const pick = (said: string, over: Partial<PickContext> = {}) => parseSetupPick(said, ctx(over));

describe('the voice picker by voice', () => {
    it('opens on a request for it, and never on the bare word', () => {
        for (const said of ['Open voice picker.', 'open the voice picker', 'Show me the voices.', 'Change the voice, please.', 'pick a voice']) {
            expect(pick(said), said).toEqual({ kind: 'voice-picker', open: true });
        }
        for (const said of ['Voices.', 'the voice', 'I heard voices', 'her voice is lovely']) expect(pick(said), said).toBeNull();
    });

    it('closes only while it is up', () => {
        expect(pick('Close.')).toBeNull();
        expect(pick('Done.')).toBeNull();
        expect(pick('Close.', { pickerOpen: true })).toEqual({ kind: 'voice-picker', open: false });
        expect(pick("okay, I'm done", { pickerOpen: true })).toEqual({ kind: 'voice-picker', open: false });
    });

    it('closes on the ways people say leave, in both languages', () => {
        const closes = [
            'close', 'Close it.', 'close this', 'close the picker', 'close the voices', 'close the voice list', 'close the window',
            'exit', 'go out', 'get out', 'leave', 'go back', 'Back.', 'done', 'never mind', 'cancel', "that's all",
            'okay, close it', 'please close the picker', 'alright, never mind', 'all set', 'close it, thanks',
            '关闭', '关掉', '关上', '关了', '关闭窗口', '关闭声音选择', '退出', '出去', '离开', '返回', '回去', '不选了',
            '不换了', '不用了', '算了', '取消', '好了', '好了。', '完成', '可以了', '就这样', '关掉吧', '好了，关掉吧',
            '把它关了', '關閉', '就這樣吧', '離開',
            // What local Whisper (base, zh) wrote for some of them.
            '官調。', '观伤.', '關闢聲音選擇', '关闭串口', '放回', '散了', 'Quan Bi', '好啦',
        ];
        for (const said of closes) {
            expect(pick(said, { pickerOpen: true }), said).toEqual({ kind: 'voice-picker', open: false });
            expect(pick(said), said).toBeNull();
        }
    });

    it('never reads a name, a preview or a bare no as a close', () => {
        const zh = { voices: ['Serena', 'Yunfan', 'Harper'], pickerOpen: true };
        expect(pick('Harper.', zh)).toEqual({ kind: 'voice', name: 'Harper', preview: false });
        expect(pick('云帆吧', zh)).toEqual({ kind: 'voice', name: 'Yunfan', preview: false });
        expect(pick('preview Serena', zh)).toEqual({ kind: 'voice', name: 'Serena', preview: true });
        for (const said of ['no', 'stop', 'skip', 'close the door', 'go back to sleep', '好的', '关闭声音', '我不想离开']) {
            expect(pick(said, zh), said).toBeNull();
        }
    });
});

describe('a voice by name', () => {
    it('sets it when the request says voice', () => {
        expect(pick('Set voice to Ethan.')).toEqual({ kind: 'voice', name: 'Ethan', preview: false });
        expect(pick("I'd like the Harper voice")).toEqual({ kind: 'voice', name: 'Harper', preview: false });
        expect(pick('use amy as the voice')).toEqual({ kind: 'voice', name: 'en_US-amy-medium', preview: false });
    });

    it('previews without choosing', () => {
        expect(pick('Preview Ethan.')).toEqual({ kind: 'voice', name: 'Ethan', preview: true });
        expect(pick('Let me hear Harper')).toEqual({ kind: 'voice', name: 'Harper', preview: true });
        expect(pick('How does Samantha sound?')).toEqual({ kind: 'voice', name: 'Samantha', preview: true });
        expect(pick('Harper sounds nice')).toBeNull();
        expect(pick('play the Samantha voice')).toEqual({ kind: 'voice', name: 'Samantha', preview: true });
    });

    it('takes a name alone only while the picker is up: across a room it is a person', () => {
        expect(pick('Ethan.')).toBeNull();
        expect(pick('Use Ethan.')).toBeNull();
        expect(pick('Ethan.', { pickerOpen: true })).toEqual({ kind: 'voice', name: 'Ethan', preview: false });
        expect(pick('Use Harper.', { pickerOpen: true })).toEqual({ kind: 'voice', name: 'Harper', preview: false });
    });

    it('needs the whole utterance to be the request', () => {
        expect(pick('Ethan said the voice was too loud')).toBeNull();
        expect(pick('set the voice to someone nicer')).toBeNull();
        expect(pick('set the voice to Ethan and Harper')).toBeNull();
    });

    it('prefers the whole name, then the first listed that contains what was said', () => {
        expect(namedIn(['samantha'], ctx().voices)).toBe(2);
        expect(namedIn(['samantha', 'enhanced'], ctx().voices)).toBe(3);
        expect(namedIn(['google'], ctx().voices)).toBe(5);
    });

    it('takes a name that only sounds right when one voice does', () => {
        expect(namedIn(['harber'], ctx().voices)).toBe(0);
        expect(namedIn(['eathan'], ctx().voices)).toBe(1);
        expect(namedIn(['bob'], ctx().voices)).toBeNull();
    });

    it('reads Chinese requests for the same things', () => {
        expect(pick('打开声音选择')).toEqual({ kind: 'voice-picker', open: true });
        expect(pick('换个声音吧')).toEqual({ kind: 'voice-picker', open: true });
        // As local Whisper writes it, in traditional characters.
        expect(pick('打開聲音選擇')).toEqual({ kind: 'voice-picker', open: true });
        expect(pick('试听Ethan', { voices: ['Serena', 'Ethan'] })).toEqual({ kind: 'voice', name: 'Ethan', preview: true });
        expect(pick('声音换成Serena', { voices: ['Serena', 'Ethan'] })).toEqual({ kind: 'voice', name: 'Serena', preview: false });
    });

    it('hears the zh house voices by the characters a recognizer writes for them', () => {
        const zh = { voices: ['Serena', 'Yunfan', 'Harper'] };
        for (const said of ['试听云帆', '试听雲帆', '声音换成云凡', '我想听听运帆的声音', '试听Yunfan']) {
            expect(pick(said, zh), said).toMatchObject({ kind: 'voice', name: 'Yunfan' });
        }
        for (const said of ['试听瑟琳娜', '声音换成塞雷娜', '试听賽琳娜', '试听Serena']) {
            expect(pick(said, zh), said).toMatchObject({ kind: 'voice', name: 'Serena' });
        }
        expect(pick('云帆', { ...zh, pickerOpen: true })).toEqual({ kind: 'voice', name: 'Yunfan', preview: false });
        // A name alone is still only an answer while the picker is up.
        expect(pick('云帆', zh)).toBeNull();
        expect(pick('试听云帆和瑟琳娜', zh)).toBeNull();
        expect(pick('试听Harper', zh)).toMatchObject({ kind: 'voice', name: 'Harper' });
    });

    it('hears the zh house voices as local Whisper writes them, picker up', () => {
        const zh = { voices: ['Serena', 'Yunfan', 'Harper'], pickerOpen: true };
        for (const said of ['我選雲翻。', '元凡', '我选 Yun-Fan', '试听元番']) expect(pick(said, zh), said).toMatchObject({ kind: 'voice', name: 'Yunfan' });
        for (const said of ['Sarina', '我選Srina.', '色林呢', '司霖了吧']) expect(pick(said, zh), said).toMatchObject({ kind: 'voice', name: 'Serena' });
        expect(pick('要死了', zh)).toBeNull();
        expect(pick('Sarina', { voices: ['Serena', 'Yunfan'] })).toBeNull();
    });

    it('takes a name an English recognizer wrote as two words', () => {
        expect(pick('set the voice to yun fan', { voices: ['Serena', 'Yunfan'] })).toEqual({ kind: 'voice', name: 'Yunfan', preview: false });
        expect(namedIn(['harper'], ['Harper', 'Ethan'])).toBe(0);
    });
});

describe('a model by name', () => {
    it('needs the word model, and takes the first listed that matches', () => {
        expect(pick('Set model to Opus.')).toEqual({ kind: 'model', value: 'claude-opus-5-5' });
        expect(pick('change the model to opus 5')).toEqual({ kind: 'model', value: 'claude-opus-5-5' });
        expect(pick('switch the model to Luna')).toEqual({ kind: 'model', value: 'gpt-6-luna' });
        expect(pick('use Opus')).toBeNull();
        expect(pick('set the model to something cheaper')).toBeNull();
    });

    it('has nothing to pick where no model is listed', () => {
        expect(pick('Set model to Opus.', { models: [] })).toBeNull();
    });
});

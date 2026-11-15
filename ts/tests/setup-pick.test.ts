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
        expect(pick('试听Ethan', { voices: ['Serena', 'Ethan'] })).toEqual({ kind: 'voice', name: 'Ethan', preview: true });
        expect(pick('声音换成Serena', { voices: ['Serena', 'Ethan'] })).toEqual({ kind: 'voice', name: 'Serena', preview: false });
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

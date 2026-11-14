/**
 * Which voice answers on the setup screen, and when a clip may be played. The
 * rule under test: a hosted voice is never asked to synthesize a line, and a
 * clip rendered from words the line no longer has is not played.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../ui/src/voice-clips.json', () => ({
    default: {
        voices: {
            Ethan: {
                language: 'en',
                gender: 'male',
                fixedPace: true,
                clips: {
                    'mode-noting': { file: 'ethan/en/mode-noting.aaaaaaaa.mp3', text: 'Okay, noting mode.' },
                    'voice-intro-first': { file: 'ethan/en/voice-intro-first.bbbbbbbb.mp3', text: "Hi, I'm Ethan. This is how I sound." },
                },
            },
            Harper: {
                language: 'en',
                gender: 'female',
                fixedPace: true,
                clips: {
                    'mode-noting': { file: 'harper/en/mode-noting.cccccccc.mp3', text: 'Okay, noting mode.' },
                    'timer-off': { file: 'harper/en/timer-off.dddddddd.mp3', text: 'An older wording of this line.' },
                },
            },
            Serena: {
                language: 'zh',
                gender: 'female',
                clips: { 'mode-noting': { file: 'serena/zh/mode-noting.eeeeeeee.mp3', text: '好的，标记模式。' } },
            },
        },
    },
}));
vi.mock('../ui/src/adapters/tts-picker.js', () => ({ createTtsForVoice: vi.fn() }));

import { clipFor, clipPlaybackRate, houseVoiceFor, houseVoices, isLocalVoice } from '../ui/src/setup-speech.js';

describe('houseVoices', () => {
    it('lists the voices of a language, the female one first', () => {
        expect(houseVoices('en').map((v) => v.name)).toEqual(['Harper', 'Ethan']);
        expect(houseVoices('zh').map((v) => v.name)).toEqual(['Serena']);
        // An unknown language is spoken to in English, like the lines.
        expect(houseVoices('fr').map((v) => v.name)).toEqual(['Harper', 'Ethan']);
    });
});

describe('houseVoiceFor', () => {
    it('is the session voice when that is a house voice', () => {
        expect(houseVoiceFor('aloud:Ethan', 'Harper', 'en')).toBe('Ethan');
    });
    it('is the one picked in the tour when the session voice has no clips', () => {
        expect(houseVoiceFor('aloud:Leda', 'Ethan', 'en')).toBe('Ethan');
    });
    it('is the default before anyone has picked', () => {
        expect(houseVoiceFor('aloud:Leda', null, 'en')).toBe('Harper');
        expect(houseVoiceFor(null, null, 'en')).toBe('Harper');
    });
    it("never crosses languages: an English pick doesn't speak Chinese lines", () => {
        expect(houseVoiceFor('aloud:Ethan', 'Ethan', 'zh')).toBe('Serena');
    });
});

describe('clipFor', () => {
    it('finds a clip whose words are still the line', () => {
        expect(clipFor('Harper', 'mode-noting', 'en')?.url).toMatch(/voice-clips\/harper\/en\/mode-noting\.cccccccc\.mp3$/);
        expect(clipFor('Harper', 'mode-noting', 'en')?.fixedPace).toBe(true);
        expect(clipFor('Serena', 'mode-noting', 'zh')?.fixedPace).toBe(false);
    });
    it('refuses one rendered from other words', () => {
        expect(clipFor('Harper', 'timer-off', 'en')).toBeNull();
    });
    it('has none for a line never rendered, a voice not in the house, or the wrong language', () => {
        expect(clipFor('Harper', 'help', 'en')).toBeNull();
        expect(clipFor('Leda', 'mode-noting', 'en')).toBeNull();
        expect(clipFor('Harper', 'mode-noting', 'zh')).toBeNull();
    });
    it("matches an introduction against the voice's own name", () => {
        expect(clipFor('Ethan', 'voice-intro-first', 'en')).not.toBeNull();
    });
});

describe('who synthesizes', () => {
    it('only a local voice does', () => {
        expect(isLocalVoice('server:en_US-lessac')).toBe(true);
        expect(isLocalVoice('browser:Samantha')).toBe(true);
        expect(isLocalVoice(null)).toBe(true);
        expect(isLocalVoice('aloud:Harper')).toBe(false);
    });
});

describe('clipPlaybackRate', () => {
    it('follows the speed setting, within reason', () => {
        expect(clipPlaybackRate(160, false)).toBe(1);
        expect(clipPlaybackRate(140, false)).toBeCloseTo(0.875);
        expect(clipPlaybackRate(60, false)).toBe(0.6);
        expect(clipPlaybackRate(400, false)).toBe(1.5);
    });
    it('leaves a fixed-pace voice alone, as a session does', () => {
        expect(clipPlaybackRate(100, true)).toBe(1);
    });
});

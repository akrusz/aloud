import { describe, it, expect } from 'vitest';
import { hostedVoiceEntry, hostedVoicePromptNote, type CloudVoice } from '../ui/src/voice-picker.js';

const hosted: CloudVoice[] = [
    { name: 'Harper', gender: 'female', default: true, promptNote: 'no Right' },
    { name: 'Leda', gender: 'female' },
];

describe('hostedVoicePromptNote', () => {
    it('resolves an explicit hosted pick', () => {
        expect(hostedVoicePromptNote('aloud:Harper', 'openai', hosted)).toBe('no Right');
        expect(hostedVoicePromptNote('aloud:Leda', 'aloud', hosted)).toBe('');
    });
    it('uses the catalog default when the hosted pipeline has no pick', () => {
        expect(hostedVoicePromptNote(null, 'aloud', hosted)).toBe('no Right');
        // No pick on a BYOK provider falls to browser TTS, never the hosted default.
        expect(hostedVoicePromptNote(null, 'openai', hosted)).toBe('');
    });
    it('never applies to browser or server voices', () => {
        expect(hostedVoicePromptNote('browser:Harper', 'aloud', hosted)).toBe('');
        expect(hostedVoicePromptNote('server:Harper', 'aloud', hosted)).toBe('');
    });
});

describe('hostedVoiceEntry: which voice speaks, and whether it takes whole replies', () => {
    const catalog: CloudVoice[] = [
        { name: 'Harper', gender: 'female', default: true, wholeReply: true },
        { name: 'Ethan', gender: 'male', wholeReply: true },
        { name: 'Leda', gender: 'female' },
    ];
    const whole = (voice: string | null, provider: string, list: CloudVoice[]) =>
        hostedVoiceEntry(voice, provider, list)?.wholeReply === true;

    it('follows an explicit pick, and the default on the hosted pipeline with none', () => {
        expect(whole('aloud:Ethan', 'openai', catalog)).toBe(true);
        expect(whole('aloud:Leda', 'aloud', catalog)).toBe(false);
        expect(whole(null, 'aloud', catalog)).toBe(true);
        expect(whole(null, 'openai', catalog)).toBe(false);
        expect(whole('browser:Harper', 'aloud', catalog)).toBe(false);
    });

    it('keeps every voice a sentence per request on an older server, which sends no flag, or before the catalog arrives', () => {
        const older: CloudVoice[] = [{ name: 'Harper', gender: 'female', default: true }];
        expect(whole('aloud:Harper', 'aloud', older)).toBe(false);
        expect(whole(null, 'aloud', older)).toBe(false);
        expect(whole('aloud:Harper', 'aloud', [])).toBe(false);
    });
});

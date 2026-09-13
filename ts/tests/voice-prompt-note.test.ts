import { describe, it, expect } from 'vitest';
import { hostedVoicePromptNote, type CloudVoice } from '../ui/src/voice-picker.js';

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

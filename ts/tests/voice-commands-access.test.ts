import { describe, expect, it } from 'vitest';
import { voiceCommandsAccess } from '../ui/src/voice-commands.js';

describe('voiceCommandsAccess', () => {
    it('is always hosted on aloud cloud, whatever the opt-in says', () => {
        expect(voiceCommandsAccess({ provider: 'aloud', optedIn: false, signedIn: false })).toBe('hosted');
        expect(voiceCommandsAccess({ provider: 'aloud', optedIn: true, signedIn: true })).toBe('hosted');
    });

    it('stays off for any other provider until opted in, signed in or not', () => {
        expect(voiceCommandsAccess({ provider: 'anthropic', optedIn: false, signedIn: true })).toBe('off');
        expect(voiceCommandsAccess({ provider: 'ollama', optedIn: false, signedIn: false })).toBe('off');
    });

    it('needs an account behind the opt-in', () => {
        expect(voiceCommandsAccess({ provider: 'ollama', optedIn: true, signedIn: true })).toBe('opted-in');
        expect(voiceCommandsAccess({ provider: 'ollama', optedIn: true, signedIn: false })).toBe('signed-out');
    });
});

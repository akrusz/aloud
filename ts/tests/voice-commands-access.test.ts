import { describe, expect, it } from 'vitest';
import { voiceCommandsAccess } from '../ui/src/voice-commands.js';

describe('voiceCommandsAccess', () => {
    it('is always hosted on aloud cloud, whatever the opt-in says', () => {
        expect(voiceCommandsAccess({ provider: 'aloud', ownKey: false, optedIn: false, signedIn: false })).toBe('hosted');
        expect(voiceCommandsAccess({ provider: 'aloud', ownKey: false, optedIn: true, signedIn: true })).toBe('hosted');
    });

    it('stays off for any other provider until opted in, signed in or not', () => {
        expect(voiceCommandsAccess({ provider: 'anthropic', ownKey: false, optedIn: false, signedIn: true })).toBe('off');
        expect(voiceCommandsAccess({ provider: 'ollama', ownKey: false, optedIn: false, signedIn: false })).toBe('off');
    });

    it('runs on the own key ahead of the opt-in, and never instead of aloud cloud', () => {
        expect(voiceCommandsAccess({ provider: 'ollama', ownKey: true, optedIn: false, signedIn: false })).toBe('own-key');
        expect(voiceCommandsAccess({ provider: 'anthropic', ownKey: true, optedIn: true, signedIn: true })).toBe('own-key');
        expect(voiceCommandsAccess({ provider: 'aloud', ownKey: true, optedIn: false, signedIn: true })).toBe('hosted');
    });

    it('needs an account behind the opt-in', () => {
        expect(voiceCommandsAccess({ provider: 'ollama', ownKey: false, optedIn: true, signedIn: true })).toBe('opted-in');
        expect(voiceCommandsAccess({ provider: 'ollama', ownKey: false, optedIn: true, signedIn: false })).toBe('signed-out');
    });
});

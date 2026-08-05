import { describe, it, expect } from 'vitest';

import { isMuteCommand } from '../src/facilitation/mute-command.js';

describe('isMuteCommand', () => {
    it('takes a bare "mute", however the recognizer punctuates it', () => {
        for (const text of ['mute', 'Mute.', 'MUTE!', '  mute  ', 'Mute…']) {
            expect(isMuteCommand(text), text).toBe(true);
        }
    });

    it('allows the politenesses people actually say', () => {
        for (const text of [
            'mute please',
            'okay, mute',
            'hey aloud, mute',
            'mute the mic',
            'mute my microphone',
            'can you mute',
        ]) {
            expect(isMuteCommand(text), text).toBe(true);
        }
    });

    it('leaves the word alone inside real speech', () => {
        for (const text of [
            'I feel muted',
            'something in me wants to mute all of this',
            'there is a mute quality to the sadness',
            'unmute',
            'I could not mute the thought no matter what I tried',
        ]) {
            expect(isMuteCommand(text), text).toBe(false);
        }
    });

    it('ignores an empty utterance', () => {
        expect(isMuteCommand('')).toBe(false);
        expect(isMuteCommand('   ...  ')).toBe(false);
    });
});

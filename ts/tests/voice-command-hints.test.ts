import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
    claimVoiceHint,
    claimIntroSession,
    INTRO_SESSIONS,
    LISTENING_WITH_INVITE,
    VOICE_HINT_TEXT,
    VOICE_COMMAND_EXAMPLES,
    VOICE_COMMANDS_NOTE,
    END_EXAMPLE_WHEN_SAVING,
    END_EXAMPLE_WHEN_NOT_SAVING,
} from '../ui/src/voice-command-hints.js';
import { ZH } from '../ui/src/i18n/zh.js';

beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
    });
});

describe('claimVoiceHint', () => {
    it('is true once per hint, independently', () => {
        expect(claimVoiceHint('speed')).toBe(true);
        expect(claimVoiceHint('speed')).toBe(false);
        expect(claimVoiceHint('timer')).toBe(true);
    });

    it('reads unavailable storage as already seen', () => {
        vi.stubGlobal('localStorage', {
            getItem: () => {
                throw new Error('blocked');
            },
        });
        expect(claimVoiceHint('mute')).toBe(false);
        expect(claimIntroSession()).toBe(false);
    });
});

describe('claimIntroSession', () => {
    it('is true for the first few sessions, then never again', () => {
        for (let i = 0; i < INTRO_SESSIONS; i++) expect(claimIntroSession()).toBe(true);
        expect(claimIntroSession()).toBe(false);
    });
});

describe('hint copy', () => {
    it('has a zh entry for every string it shows', () => {
        for (const text of [
            ...Object.values(VOICE_HINT_TEXT),
            ...VOICE_COMMAND_EXAMPLES,
            LISTENING_WITH_INVITE,
            VOICE_COMMANDS_NOTE,
            END_EXAMPLE_WHEN_SAVING,
            END_EXAMPLE_WHEN_NOT_SAVING,
            'Voice commands',
            'See what you can say',
        ]) {
            expect(ZH[text], text).toBeTruthy();
        }
    });
});

/**
 * Locks the cloud-access gate's core predicate (cloud-gate.ts). The load-
 * bearing insight: sign-in/credits are NOT gated by the LLM provider alone —
 * Cloud STT bills independently, so a local/BYOK LLM paired with the hosted
 * ('aloud') STT choice must still trip the gate. A regression here would let a
 * hosted STT session start unauthenticated and fail mid-utterance.
 *
 * sessionUsesCloud is pure (webMode passed in) so these assertions don't depend
 * on the runtime environment.
 */
import { describe, it, expect } from 'vitest';
import { sessionUsesCloud } from '../ui/src/cloud-gate.js';
import type { SessionSetup } from '../ui/src/settings.js';
import type { AppSettings } from '../ui/src/app-settings.js';

// Only .provider / .sttEngine are read; cast minimal fixtures.
const setupWith = (provider: string): SessionSetup =>
    ({ provider }) as unknown as SessionSetup;
const settingsWith = (sttEngine: AppSettings['sttEngine']): AppSettings =>
    ({ sttEngine }) as unknown as AppSettings;

describe('sessionUsesCloud', () => {
    it('is true whenever the hosted LLM provider is selected, regardless of STT', () => {
        expect(sessionUsesCloud(setupWith('aloud'), settingsWith(null), true)).toBe(true);
        expect(sessionUsesCloud(setupWith('aloud'), settingsWith('whisper'), false)).toBe(true);
    });

    it('is true for a NON-hosted LLM when Cloud STT is chosen (STT bills independently)', () => {
        // 'aloud' is the hosted STT choice — offered in both modes, so it
        // resolves to itself regardless of webMode.
        expect(sessionUsesCloud(setupWith('ollama'), settingsWith('aloud'), true)).toBe(true);
        expect(sessionUsesCloud(setupWith('openai'), settingsWith('aloud'), false)).toBe(true);
    });

    it('is false for a local LLM + local Whisper STT on desktop (no cloud touched)', () => {
        // Desktop (webMode=false) offers local 'whisper', so it resolves to
        // itself — no token needed.
        expect(sessionUsesCloud(setupWith('ollama'), settingsWith('whisper'), false)).toBe(false);
    });
});

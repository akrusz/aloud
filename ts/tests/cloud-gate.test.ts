/**
 * Locks the cloud-access gate's core predicate (cloud-gate.ts). The load-
 * bearing insight: sign-in/credits are NOT gated by the LLM provider alone —
 * Cloud STT bills independently, so a local/BYOK LLM paired with the hosted
 * (hosted) STT choice must still trip the gate. A regression here would let a
 * hosted STT session start unauthenticated and fail mid-utterance.
 *
 * sessionUsesCloud takes webMode as a param, but it also resolves the STT
 * choice (resolveSttChoice → sttEngineOptions), which gates the on-device
 * Whisper option on isTauri(). We mock isTauri so the "on desktop" case is
 * deterministic; the hosted-STT cases don't depend on it (the hosted choice is always
 * offered).
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../ui/src/is-desktop.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../ui/src/is-desktop.js')>();
    return { ...actual, isTauri: vi.fn(() => false) };
});

import { sessionUsesCloud, narratorIsOnlyCloudLeg } from '../ui/src/cloud-gate.js';
import { isTauri } from '../ui/src/is-desktop.js';
import type { SessionSetup } from '../ui/src/settings.js';
import type { AppSettings } from '../ui/src/app-settings.js';

const isTauriMock = vi.mocked(isTauri);

// Only .provider / .sttEngine / .notingParticipants are read; cast minimal fixtures.
const setupWith = (provider: string): SessionSetup =>
    ({ provider }) as unknown as SessionSetup;
const notingSetup = (
    provider: string,
    participants: Array<{ type: string }>
): SessionSetup =>
    ({ provider, notingParticipants: participants }) as unknown as SessionSetup;
const settingsWith = (sttEngine: AppSettings['sttEngine']): AppSettings =>
    ({ sttEngine }) as unknown as AppSettings;

describe('sessionUsesCloud', () => {
    it('is true whenever the hosted LLM provider is selected, regardless of STT', () => {
        expect(sessionUsesCloud(setupWith('aloud'), settingsWith(null), true)).toBe(true);
        expect(sessionUsesCloud(setupWith('aloud'), settingsWith('whisper'), false)).toBe(true);
    });

    it('is true for a NON-hosted LLM when Cloud STT is chosen (STT bills independently)', () => {
        // 'aloud-gpt-transcribe' is the hosted STT choice — offered in both modes, so it
        // resolves to itself regardless of webMode.
        expect(sessionUsesCloud(setupWith('ollama'), settingsWith('aloud-gpt-transcribe'), true)).toBe(true);
        expect(sessionUsesCloud(setupWith('openai'), settingsWith('aloud-gpt-transcribe'), false)).toBe(true);
        // The second hosted model spends credits just the same.
        expect(sessionUsesCloud(setupWith('ollama'), settingsWith('aloud-gpt-transcribe'), true)).toBe(true);
    });

    it('is false for a local LLM + local Whisper STT on desktop (no cloud touched)', () => {
        // Desktop (Tauri, webMode=false) offers local 'whisper', so it resolves
        // to itself — no token needed.
        isTauriMock.mockReturnValue(true);
        expect(sessionUsesCloud(setupWith('ollama'), settingsWith('whisper'), false)).toBe(false);
    });

    /**
     * meditation-pal-vr3w. On mobile there is no local LLM provider, so
     * setup.provider is ALWAYS 'aloud' - taking that at face value made a
     * noting circle that calls no model demand sign-in, which broke the store
     * listing's "noting works with no account" claim. The provider only counts
     * when the session will actually ask it something.
     *
     * These pin the LLM half of the predicate, so they run on desktop with
     * local Whisper to keep the independent STT half out of the way.
     */
    describe('noting circles that call no model', () => {
        it('is false for a fixed/sound-only circle even on the hosted provider', () => {
            isTauriMock.mockReturnValue(true);
            const setup = notingSetup('aloud', [{ type: 'fixed' }, { type: 'sound' }]);
            expect(sessionUsesCloud(setup, settingsWith('whisper'), false, 'noting')).toBe(false);
        });

        it('is false for a solo circle (the opener is static, not generated)', () => {
            isTauriMock.mockReturnValue(true);
            expect(
                sessionUsesCloud(notingSetup('aloud', []), settingsWith('whisper'), false, 'noting')
            ).toBe(false);
        });

        it('is true as soon as one participant is an AI', () => {
            isTauriMock.mockReturnValue(true);
            const setup = notingSetup('aloud', [{ type: 'fixed' }, { type: 'llm' }]);
            expect(sessionUsesCloud(setup, settingsWith('whisper'), false, 'noting')).toBe(true);
        });

        it('still trips on hosted STT, which bills whatever the circle is', () => {
            const setup = notingSetup('aloud', [{ type: 'sound' }]);
            expect(sessionUsesCloud(setup, settingsWith('aloud'), true, 'noting')).toBe(true);
        });

        it('still trips on an aloud: voice, which bills whatever the circle is', () => {
            isTauriMock.mockReturnValue(true);
            const setup = {
                provider: 'aloud',
                voice: 'aloud:vega',
                notingParticipants: [{ type: 'sound' }],
            } as unknown as SessionSetup;
            expect(sessionUsesCloud(setup, settingsWith('whisper'), false, 'noting')).toBe(true);
        });

        it('leaves exploration alone - it always needs the model', () => {
            isTauriMock.mockReturnValue(true);
            expect(sessionUsesCloud(setupWith('aloud'), settingsWith('whisper'), false)).toBe(true);
        });
    });

    /**
     * The narrator voice is the one metered leg an AI-free circle can do
     * without: it reads a static opener, and the session view skips it when
     * there is no account to bill. So it must still register as cloud use
     * (a signed-in user IS charged for it) while the start gate lets the
     * session through instead of demanding sign-in.
     */
    describe('narrator-only cloud use', () => {
        const soundCircleWithCloudNarrator = {
            provider: 'aloud',
            voice: 'aloud:vega',
            notingParticipants: [{ type: 'sound' }],
        } as unknown as SessionSetup;

        it('is the only leg for a sound-only circle with a cloud narrator', () => {
            isTauriMock.mockReturnValue(true);
            expect(
                narratorIsOnlyCloudLeg(soundCircleWithCloudNarrator, settingsWith('whisper'), false, 'noting')
            ).toBe(true);
        });

        it('is not the only leg once an AI participant, a cloud participant voice, or hosted STT joins', () => {
            isTauriMock.mockReturnValue(true);
            const withAi = {
                ...soundCircleWithCloudNarrator,
                notingParticipants: [{ type: 'llm' }],
            } as unknown as SessionSetup;
            expect(narratorIsOnlyCloudLeg(withAi, settingsWith('whisper'), false, 'noting')).toBe(false);
            const withCloudVoice = {
                ...soundCircleWithCloudNarrator,
                notingParticipants: [{ type: 'fixed', voice: 'aloud:vega' }],
            } as unknown as SessionSetup;
            expect(narratorIsOnlyCloudLeg(withCloudVoice, settingsWith('whisper'), false, 'noting')).toBe(false);
            expect(
                narratorIsOnlyCloudLeg(soundCircleWithCloudNarrator, settingsWith('aloud'), true, 'noting')
            ).toBe(false);
        });

        it('never applies outside noting, and not to a device narrator voice', () => {
            isTauriMock.mockReturnValue(true);
            expect(
                narratorIsOnlyCloudLeg(soundCircleWithCloudNarrator, settingsWith('whisper'), false, 'exploration')
            ).toBe(false);
            const deviceVoice = { ...soundCircleWithCloudNarrator, voice: 'browser:Samantha' } as unknown as SessionSetup;
            expect(narratorIsOnlyCloudLeg(deviceVoice, settingsWith('whisper'), false, 'noting')).toBe(false);
        });
    });
});

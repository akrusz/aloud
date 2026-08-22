/**
 * Cloud-access gate for starting a session (meditation-pal-rfb).
 *
 * Cloud STT and TTS bill independently of the LLM provider, and all three go
 * through `ensureCloudToken()`. The LLM path fetches the token eagerly
 * (buildProvider) but STT/TTS fetch it lazily, so catching only at build would
 * let an STT-only hosted session start and then fail mid-utterance.
 *
 * So we pre-flight: if the session will touch ANY metered cloud service and we
 * hold no token, surface the sign-in modal before anything runs. Dev builds with
 * no Google client id fall through to lazy dev sign-in.
 */

import { sessionNeedsLlm, type MeditationType, type SessionSetup } from './settings.js';
import type { AppSettings } from './app-settings.js';
import { isHostedSttChoice, resolveSttChoice } from './adapters/stt-picker.js';
import { isWebMode, isDevBypass } from './app-mode.js';
import { detectCapabilities } from './capabilities.js';
import { getCloudToken, isInteractiveSignInConfigured } from './cloud-auth.js';
import { showSignInModal } from './sign-in-modal.js';

/** Whether this session will hit a metered cloud service: the 'aloud' LLM
 *  provider, hosted STT, or hosted TTS. All three are independent choices (a
 *  local/BYOK LLM with Cloud STT, or an `aloud:`-prefixed voice, which
 *  tts-picker routes to metered TTS whatever the provider), and any one alone
 *  needs credits. In noting mode each participant carries its own voice and the
 *  narrator speaks the opener with setup.voice, so all count. STT keys off the
 *  resolved choice, not the raw setting, to account for the web default.
 *
 *  The LLM provider only counts when the session will actually CALL it
 *  (sessionNeedsLlm): mobile has no local provider, so setup.provider is always
 *  'aloud' there, and taking that at face value made an AI-free noting circle
 *  demand sign-in for a model it never asks anything (meditation-pal-vr3w). */
export function sessionUsesCloud(
    setup: SessionSetup,
    settings: AppSettings,
    webMode: boolean,
    mode: MeditationType = 'exploration'
): boolean {
    if (setup.provider === 'aloud' && sessionNeedsLlm(mode, setup.notingParticipants)) return true;
    if (setup.voice?.startsWith('aloud:')) return true;
    if (
        mode === 'noting' &&
        (setup.notingParticipants ?? []).some(
            (p) => p.type !== 'sound' && p.voice?.startsWith('aloud:')
        )
    ) {
        return true;
    }
    return isHostedSttChoice(resolveSttChoice(settings.sttEngine, webMode));
}

/**
 * Returns true to proceed, false if the user dismissed sign-in (the caller
 * aborts the start and leaves them on setup). True with no work when the session
 * uses no cloud service, a token is cached, or the build ships no sign-in.
 */
export async function ensureCloudAccess(
    setup: SessionSetup,
    settings: AppSettings,
    mode: MeditationType = 'exploration'
): Promise<boolean> {
    if (!sessionUsesCloud(setup, settings, isWebMode(), mode)) return true;
    if (await getCloudToken()) return true;
    // DEV cloud-bypass (?dev): let the session start and lean on the lazy
    // /auth/dev sign-in (ensureCloudToken) instead of the modal.
    if (isDevBypass()) return true;
    // Resolve the runtime client ids (cached after boot) before deciding: a
    // server advertising any interactive sign-in gets the modal; a bare server
    // with none falls back to lazy dev sign-in.
    await detectCapabilities();
    if (!isInteractiveSignInConfigured()) return true;
    return showSignInModal();
}

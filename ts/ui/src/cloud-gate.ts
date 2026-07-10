/**
 * Cloud-access gate for starting a session (meditation-pal-rfb).
 *
 * Sign-in/credits aren't tied to the LLM provider alone — Cloud STT and Cloud
 * TTS bill independently, and all three funnel through `ensureCloudToken()`.
 * The LLM path fetches the token eagerly (buildProvider), but STT/TTS fetch it
 * lazily (first transcription / first spoken response), so a naive "catch at
 * build" would let an STT-only hosted session start and then fail mid-utterance.
 *
 * So we pre-flight at session start: if the session will touch ANY credit-
 * metered cloud service and we don't already hold a token, surface the sign-in
 * modal before anything runs. Dev builds with no Google client id fall through —
 * their lazy dev sign-in (cloud-auth.ensureCloudToken) handles it.
 */

import type { MeditationType, SessionSetup } from './settings.js';
import type { AppSettings } from './app-settings.js';
import { resolveSttChoice } from './adapters/stt-picker.js';
import { isWebMode, isDevBypass } from './app-mode.js';
import { detectCapabilities } from './capabilities.js';
import { getCloudToken, isInteractiveSignInConfigured } from './cloud-auth.js';
import { showSignInModal } from './sign-in-modal.js';

/** Whether this session will hit a credit-metered cloud service: the hosted
 *  ('aloud') LLM provider, the hosted STT path, or hosted TTS. All three are
 *  independent choices — someone can run a local/BYOK LLM with Cloud STT, or
 *  pick an `aloud:`-prefixed voice (tts-picker.createTtsForVoice routes those
 *  to metered cloud TTS regardless of provider), and either alone needs
 *  credits. In noting mode the participants each carry their own voice, and
 *  the narrator speaks the opener with setup.voice, so all of them count. STT
 *  is keyed off the resolved choice, not the raw setting, so the mode's
 *  default ('aloud' on web) is accounted for. */
export function sessionUsesCloud(
    setup: SessionSetup,
    settings: AppSettings,
    webMode: boolean,
    mode: MeditationType = 'exploration'
): boolean {
    if (setup.provider === 'aloud') return true;
    if (setup.voice?.startsWith('aloud:')) return true;
    if (
        mode === 'noting' &&
        (setup.notingParticipants ?? []).some(
            (p) => p.type !== 'sound' && p.voice?.startsWith('aloud:')
        )
    ) {
        return true;
    }
    return resolveSttChoice(settings.sttEngine, webMode) === 'aloud';
}

/**
 * Ensure we can use the cloud services this session needs. Returns true to
 * proceed, false if the user dismissed sign-in (the caller should abort the
 * start and leave the user on setup). No-op (true) when the session uses no
 * cloud service, a token is already cached, or the build ships no Google
 * sign-in (dev fallback).
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
    // server that advertises any interactive sign-in (web/desktop Google or
    // Apple) → sign-in modal; a bare server with none → lazy dev sign-in.
    await detectCapabilities();
    if (!isInteractiveSignInConfigured()) return true; // no sign-in configured → lazy dev sign-in
    return showSignInModal();
}

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

import type { SessionSetup } from './settings.js';
import type { AppSettings } from './app-settings.js';
import { resolveSttChoice } from './adapters/stt-picker.js';
import { isWebMode } from './app-mode.js';
import { detectCapabilities } from './capabilities.js';
import { getCloudToken, isGoogleSignInConfigured } from './cloud-auth.js';
import { showSignInModal } from './sign-in-modal.js';

/** Whether this session will hit a credit-metered cloud service: the hosted
 *  ('aloud') LLM provider, or the hosted STT path. TTS is currently coupled to
 *  the aloud provider (session.ts only builds server TTS when provider ===
 *  'aloud'), so the LLM check already covers it; the STT choice is independent
 *  — someone can run a local/BYOK LLM with Cloud STT, and that alone needs
 *  credits. Keyed off the resolved choice, not the raw setting, so the mode's
 *  default ('aloud' on web) is accounted for. */
export function sessionUsesCloud(
    setup: SessionSetup,
    settings: AppSettings,
    webMode: boolean
): boolean {
    if (setup.provider === 'aloud') return true;
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
    settings: AppSettings
): Promise<boolean> {
    if (!sessionUsesCloud(setup, settings, isWebMode())) return true;
    if (await getCloudToken()) return true;
    // Resolve the runtime client id (cached after boot) before deciding: a
    // Google-configured server → sign-in modal; none → lazy dev sign-in.
    await detectCapabilities();
    if (!isGoogleSignInConfigured()) return true; // no client id → lazy dev sign-in
    return showSignInModal();
}

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
import { getKnownBalance } from './cloud-balance.js';
import { showSignInModal } from './sign-in-modal.js';
import { choiceDialog } from './dialog.js';
import { t } from './i18n.js';

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
    return sessionUsesCloudBeyondNarrator(setup, settings, webMode, mode) || narratorIsCloud(setup);
}

function narratorIsCloud(setup: SessionSetup): boolean {
    return setup.voice?.startsWith('aloud:') ?? false;
}

/** Every metered leg EXCEPT the narrator voice (setup.voice). Split out because
 *  in an AI-free noting circle the narrator only reads the static opener and
 *  the timer notices - a few hundred characters - and that is the one flow
 *  the store listing promises works with no account. */
function sessionUsesCloudBeyondNarrator(
    setup: SessionSetup,
    settings: AppSettings,
    webMode: boolean,
    mode: MeditationType
): boolean {
    if (setup.provider === 'aloud' && sessionNeedsLlm(mode, setup.notingParticipants)) return true;
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

/** True when the cloud narrator voice is the ONLY metered leg: an AI-free
 *  noting circle whose participants and STT are all free. Such a session can
 *  run without an account or credits by simply not reading the opener aloud
 *  (meditation-pal-vr3w). */
export function narratorIsOnlyCloudLeg(
    setup: SessionSetup,
    settings: AppSettings,
    webMode: boolean,
    mode: MeditationType
): boolean {
    return (
        mode === 'noting' &&
        narratorIsCloud(setup) &&
        !sessionUsesCloudBeyondNarrator(setup, settings, webMode, mode)
    );
}

/** Whether the narrator can bill right now: signed in, and not known to be out
 *  of credits. An unknown balance (no /me yet) counts as able - a failed
 *  synthesis then surfaces as a toast, same as any other cloud error. */
export async function narratorCanBill(): Promise<boolean> {
    if (isDevBypass()) return true;
    if (!(await getCloudToken())) return false;
    const balance = getKnownBalance();
    return balance === null || balance > 0;
}

/**
 * The noting view's decision: skip the narrator's lines (opener, timer
 * notices) when the cloud voice is the session's only metered leg and there is
 * nothing to bill it to. The lines still appear as text. Same predicate the
 * start gate uses, so the two can't disagree.
 */
export async function narratorSilencedForCloud(
    setup: SessionSetup,
    settings: AppSettings,
    mode: MeditationType
): Promise<boolean> {
    if (!narratorIsOnlyCloudLeg(setup, settings, isWebMode(), mode)) return false;
    return !(await narratorCanBill());
}

const NARRATOR_NOTICE_SEEN_KEY = 'aloud-narrator-notice-seen';

/** One-time notice for the account-free noting flow: the session goes ahead,
 *  the opener just isn't read aloud. Offers sign-in without requiring it -
 *  dismissing either way still starts the session. */
async function showNarratorSilencedNotice(): Promise<void> {
    // Lazy: state.js builds a storage backend at import, which throws outside
    // a browser, and this module's predicates are unit-tested under node.
    const { sharedKv } = await import('./state.js');
    if (await sharedKv.get(NARRATOR_NOTICE_SEEN_KEY)) return;
    await sharedKv.set(NARRATOR_NOTICE_SEEN_KEY, '1');
    const choice = await choiceDialog(
        t('Noting works without an account. Connect one to enable speech features, like a voice reading the intro.'),
        [
            { label: t('Sign in'), value: 'signin' },
            { label: t('Continue'), value: 'continue', action: true },
        ],
        { closeX: true }
    );
    if (choice === 'signin') {
        await detectCapabilities();
        if (isInteractiveSignInConfigured()) await showSignInModal();
    }
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
    // Narrator-only cloud use never blocks the start: with no account (or no
    // credits) the noting view runs the circle with the opener as text, after
    // a one-time notice that an account would add the voice.
    if (narratorIsOnlyCloudLeg(setup, settings, isWebMode(), mode)) {
        if (!(await narratorCanBill())) await showNarratorSilencedNotice();
        return true;
    }
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

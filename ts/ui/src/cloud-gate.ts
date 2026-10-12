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
import { fetchMe, getCloudToken, isInteractiveSignInConfigured } from './cloud-auth.js';
import { getKnownBalance } from './cloud-balance.js';
import { showSignInModal, type ModalAlternative } from './sign-in-modal.js';
import { bestFreeVoice, loadScoredVoices, prefixedVoiceId } from './voice-picker.js';
import { alertDialog, choiceDialog } from './dialog.js';
import { showBuyCreditsModal } from './buy-credits-modal.js';
import { purchaseChannel, topUpHint } from './purchase-channel.js';
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
 *  'aloud' there, and taking that at face value would make an AI-free noting
 *  circle demand sign-in for a model it never asks anything
 *  (meditation-pal-vr3w). */
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

/** True when the hosted voice (setup.voice) is the session's ONLY metered leg:
 *  a local or own-key model with free STT. Swap the voice and the session
 *  needs no account at all, which is what the start gate offers
 *  (meditation-pal-ntht). */
export function voiceIsOnlyCloudLeg(
    setup: SessionSetup,
    settings: AppSettings,
    webMode: boolean,
    mode: MeditationType
): boolean {
    return narratorIsCloud(setup) && !sessionUsesCloudBeyondNarrator(setup, settings, webMode, mode);
}

/** The same in an AI-free noting circle, whose participants and STT are all
 *  free. There the voice only reads the opener, so the session can run
 *  without an account or credits by simply not reading it aloud
 *  (meditation-pal-vr3w). */
export function narratorIsOnlyCloudLeg(
    setup: SessionSetup,
    settings: AppSettings,
    webMode: boolean,
    mode: MeditationType
): boolean {
    return mode === 'noting' && voiceIsOnlyCloudLeg(setup, settings, webMode, mode);
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

/** Whether a fresh /me says this account can't pay for a session: a known
 *  balance at or below zero, with no retreat pass covering it. Unknown (signed
 *  out, /me failed, an older server without the field) never blocks - the
 *  server still refuses metered calls, so failing open only costs the old
 *  in-session apology. A small positive balance passes: a turn's settle clamps
 *  at zero rather than overdrawing, so those last credits are still usable. */
export function blocksForCredits(
    account: { creditsRemaining?: number; retreatCovered?: boolean } | null
): boolean {
    if (!account || account.retreatCovered === true) return false;
    return typeof account.creditsRemaining === 'number' && account.creditsRemaining <= 0;
}

/** Out of credits at Begin: offer a top-up instead of starting a session whose
 *  first line would be the out-of-credits apology. Proceeds only if a purchase
 *  settles in place (USDC); a card pack navigates away to Stripe. A build that
 *  sells nothing just says so. */
async function ensureCredits(wayOn: WayOn): Promise<boolean> {
    let account: Awaited<ReturnType<typeof fetchMe>>;
    try {
        account = await fetchMe();
    } catch {
        return true;
    }
    if (!blocksForCredits(account)) return true;
    // No way on to offer here: a build that sells nothing is a phone build,
    // whose model is always hosted, so the voice is never the only leg.
    if (purchaseChannel() === 'none') {
        await alertDialog([t("You're out of clouds"), topUpHint()].filter(Boolean).join('\n\n'));
        return false;
    }
    const alternative = await wayOn();
    return showBuyCreditsModal({
        title: t("You're out of clouds"),
        // With a local model already picked, "switch to a local provider" is
        // no advice: the voice is what asks.
        subtitle: alternative
            ? t('Top up to keep going, or use a free voice.')
            : t('Top up to keep going, or switch to a local/BYOK provider in Settings.'),
        ...(alternative ? { alternative } : {}),
    });
}

/** The way past a prompt that needs no account or credits, when there is one.
 *  Asked for only as a prompt is about to show: finding it loads the voice
 *  catalog. */
type WayOn = () => Promise<ModalAlternative | null>;

/**
 * Returns true to proceed, false if the user dismissed sign-in or the top-up
 * (the caller aborts the start and leaves them on setup). True with no work
 * when the session uses no cloud service or the build ships no sign-in.
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
    // A hosted voice on an otherwise free session is the one thing asking, and
    // a fresh install lands on one unasked (views/setup.ts loadVoiceCatalog):
    // whichever prompt stops the start offers the way past it.
    const free: { voice: string | null } = { voice: null };
    const wayOn: WayOn = async () => {
        if (!voiceIsOnlyCloudLeg(setup, settings, isWebMode(), mode)) return null;
        const best = bestFreeVoice(await loadScoredVoices(setup.language));
        if (!best) return null;
        return {
            label: t('Use a free voice'),
            onPick: () => (free.voice = prefixedVoiceId(best.engine, best.name)),
        };
    };
    const cleared = await clearForCloud(setup, wayOn);
    if (free.voice) {
        await switchVoice(setup, free.voice);
        return true;
    }
    return cleared;
}

/** Signed in and able to pay, prompting for whichever is missing. */
async function clearForCloud(setup: SessionSetup, wayOn: WayOn): Promise<boolean> {
    if (await getCloudToken()) return ensureCredits(wayOn);
    // DEV cloud-bypass (?dev): let the session start and lean on the lazy
    // /auth/dev sign-in (ensureCloudToken) instead of the modal.
    if (isDevBypass()) return true;
    // Resolve the runtime client ids (cached after boot) before deciding: a
    // server advertising any interactive sign-in gets the modal; a bare server
    // with none falls back to lazy dev sign-in.
    await detectCapabilities();
    if (!isInteractiveSignInConfigured()) return true;
    // "Try right now" promised no setup, so say why there is this one step.
    // Anyone else pressed Begin on a choice of their own: name what asked.
    const signIn = setup.firstSit
        ? {
              title: t('One quick step'),
              subtitle: t(
                  'Voice and facilitator intelligence run on aloud cloud. Connect Google or Apple to start for free.'
              ),
          }
        : { title: t('Options with ☁ require an account') };
    const alternative = await wayOn();
    const signedIn = await showSignInModal({ ...signIn, ...(alternative ? { alternative } : {}) });
    return signedIn && ensureCredits(wayOn);
}

/** Speak this session with `voice`, and keep it: the voice is an app-level
 *  default (views/setup.ts persistDefaultVoice), so the next Begin doesn't ask
 *  again. */
async function switchVoice(setup: SessionSetup, voice: string): Promise<void> {
    setup.voice = voice;
    // Lazy for the reason state.js is, above: app-settings builds a storage
    // backend at import.
    const { loadAppSettings, saveAppSettings } = await import('./app-settings.js');
    await saveAppSettings({ ...(await loadAppSettings()), defaultVoice: voice });
}

/**
 * Setup view - pre-session configuration.
 *
 * Three mode tabs (exploration / felt sense / noting) over a shared
 * provider + model + speech-recognition row, a voice picker, and Begin.
 */

import type { Focus, Quality, Verbosity } from '../../../src/facilitation/index.js';

import {
    type SessionSetup,
    type MeditationType,
    type Provider,
    type NotingParticipantConfig,
    type NotingReactive,
    type NotingSound,
    NOTING_SOUNDS,
    notingSoundLabel,
    ALL_PROVIDERS,
    isProviderAvailable,
    resolveSetupProvider,
    providerNeedsKey,
    sessionNeedsLlm,
    type ProviderAvailabilityOpts,
    DIRECTIVENESS_VALUES,
    FOCUS_LABELS,
    QUALITY_LABELS,
    VERBOSITY_LABELS,
    loadSetup,
    saveSetup,
} from '../settings.js';
import type { SessionState } from '../../../src/facilitation/session.js';
import type { SttEngine } from '../../../src/platform/index.js';
import {
    defaultVoicePick,
    isOrphanedHostedVoice,
    renamedHostedVoice,
    downloadVoiceFromRow,
    invalidateServerVoicesCache,
    loadScoredVoices,
    prefixedVoiceId,
    previewVoice as runPreview,
    previewErrorMessage,
    renderVoiceList,
    renderVoiceModalHTML,
    stripVoicePrefix,
    voiceLabel,
    syncSpeedControlForVoice,
    voiceRateLabel,
    stopPreview,
    updateVoiceSelection,
    type ScoredVoice,
} from '../voice-picker.js';
import {
    rateBadge,
    MODE_RATE_MULTIPLIER,
    NOTING_NARRATOR_TTS_FRACTION,
} from '../credit-rate.js';
import { narratorCanBill } from '../cloud-gate.js';
import { canReachJudge } from '../voice-commands.js';
import { fetchMe } from '../cloud-auth.js';
import { getRetreatCovered } from '../cloud-coverage.js';
import { createTtsForVoice } from '../adapters/tts-picker.js';
import { mountModelPicker, cloudUtilityCreditsPerHour } from '../model-picker.js';
import {
    sttEngineOptions,
    sttChoiceForMode,
    sttSettingKey,
    isHostedSttChoice,
    sttBackendForChoice,
    cloudSttCreditsPerHour,
    createSttForChoice,
} from '../adapters/stt-picker.js';
import {
    createMicHandover,
    listenOnSetup,
    LOBBY_STT,
    SPEECH_TAIL_MS,
    micPermission,
    pageTouched,
    voiceStartBlocker,
    setupListeningLimits,
    type MicPermission,
    type SetupHearing,
    type VoiceStartHandle,
} from '../voice-start.js';
import {
    leavesAsk,
    parseSetupCommand,
    parseSetupPick,
    looksLikeSpokenTail,
    modelSetLine,
    setupLineText,
    setupOutcomeLines,
    type SetupPick,
    type SpokenSetupLine,
    type BeginRequest,
    type SetupAction,
    type SetupFocus,
    type SetupLineId,
    type SetupOutcome,
} from '../../../src/facilitation/index.js';
import { applySetupActions, type SetupForm } from '../setup-actions.js';
import { createSetupJudge } from '../setup-judge.js';
import { startMicMeter } from '../mic-meter.js';
import { WhisperPcmSttEngine } from '../adapters/whisper-pcm-stt.js';
import { createLocalSetupReader, readsSetupLocally } from '../setup-local-reader.js';
import { clipFor, createSetupSpeaker, houseVoices, isLocalVoice, type SetupSpeaker } from '../setup-speech.js';
import {
    acquireMicOnce,
    describeMicProblem,
    describeMicRequirement,
    endCaptureHandover,
    holdCaptureForSession,
    probeMic,
    type MicStatus,
} from '../mic-check.js';
import { waitForClose } from '../signature-sound.js';
import { diag } from '../diag.js';
import { watchWhisperReady, describeWhisperWait, whisperNotice, type WhisperStatus } from '../whisper-ready.js';
import { t } from '../i18n.js';
import { sessionStore, sharedKv } from '../state.js';
import { clearActiveSession } from '../active-session.js';
import { showResumeModal } from '../resume-modal.js';
import { detectCapabilities, capabilitiesSync, watchCloudReachable } from '../capabilities.js';
import { isWebMode } from '../app-mode.js';
import { capacitorPlatform, isCapacitor, isSingleOwnerMicPlatform } from '../is-desktop.js';
import {
    computeProviderMarker,
    fetchKeyPresence,
    fetchProviderStatus,
    stripMarker,
    type ProviderStatusMap,
} from '../provider-markers.js';
import { alertDialog } from '../dialog.js';
import { escapeHtml } from '../escape-html.js';
import { wireCloudsExplainer } from '../clouds-explainer.js';
import { loadAppSettings, saveAppSettings, type AppSettings, type SttEngineChoice } from '../app-settings.js';
import { clampTimerMinutes, clockModeLabel, showSessionClockModal } from '../session-clock.js';
import { canPlayUntouched } from '../audio-unlock.js';
import { playChime, playCue, primeSounds } from '../sound-player.js';
import {
    autoStart as autoStartGuide,
    closeIfActive as closeGuideIfActive,
    resetAndStart as resetGuide,
    type QuickStart,
    type TourVoice,
} from '../tour/index-guide.js';
import { firstSitSetup } from '../first-sit.js';
import { onBackdropClick } from '../modal-backdrop.js';
import { getNavHeight } from '../tour/tour-common.js';
import { bottomBarsTop } from '../toast.js';

const FOCUSES: ReadonlyArray<{ value: Focus; name: string; description: string }> = [
    {
        value: 'body_sensations',
        name: FOCUS_LABELS.body_sensations,
        description: 'Physical feelings like warmth, movement, or relaxation',
    },
    {
        value: 'emotions',
        name: FOCUS_LABELS.emotions,
        description: 'Joy, sadness, or whatever’s alive underneath',
    },
    {
        value: 'inner_parts',
        name: FOCUS_LABELS.inner_parts,
        description: 'Give attention to the parts of yourself that need care',
    },
];

const QUALITIES: ReadonlyArray<{ value: Quality; name: string; description: string }> = [
    {
        value: 'playful',
        name: QUALITY_LABELS.playful,
        description: 'Play, spontaneity, delight. Doesn’t have to be serious',
    },
    {
        value: 'compassionate',
        name: QUALITY_LABELS.compassionate,
        description: 'Meeting what arises with care and connection',
    },
    {
        value: 'loving',
        name: QUALITY_LABELS.loving,
        description: 'Generating and radiating love and goodwill',
    },
    {
        value: 'spacious',
        name: QUALITY_LABELS.spacious,
        description: 'Notice the openness that’s already here',
    },
    {
        value: 'effortless',
        name: QUALITY_LABELS.effortless,
        description: 'Hands off the wheel, let things unfold',
    },
    {
        value: 'feeling_good',
        name: QUALITY_LABELS.feeling_good,
        description: 'Noticing and cultivating pleasant sensations',
    },
];

const VERBOSITY_OPTIONS: ReadonlyArray<{ value: Verbosity; label: string }> = (
    ['low', 'medium', 'high'] as const
).map((value) => ({ value, label: VERBOSITY_LABELS[value] }));

export interface SetupViewHandle {
    /** Show the setup view (replaces any current content in `root`). */
    show(): Promise<void>;
    /** Hide the setup view (caller handles what to show next). */
    hide(): void;
    /** Current setup snapshot. */
    getSetup(): SessionSetup;
}

/** What the mic beside Begin shows (paintVoiceMic in mountSetupView). */
type VoiceMicLook = 'hidden' | 'listening' | 'sleeping' | 'off' | 'ask' | 'blocked';

/** Human mode name for the resume modal ("Felt sense", "Exploration", ...). */
function resumeModeLabel(state: SessionState): string {
    const labels: Record<string, string> = {
        exploration: 'Exploration',
        noting: 'Noting',
        felt_sense: 'Felt sense',
    };
    return t(labels[state.meditationType ?? ''] ?? 'Session');
}

/** "Felt sense · 12 min in" - mode + elapsed for the resume modal. endTime is
 *  the last autosave stamp, so it approximates where the session was cut off. */
function resumeBannerDetail(state: SessionState): string {
    const end = state.endTime ?? Math.floor(state.startTime);
    const mins = Math.max(1, Math.round((end - state.startTime) / 60));
    return t('{mode} · {mins} min in', { mode: resumeModeLabel(state), mins });
}

/** Counts mounts, so a mount can tell whether it is still the one on screen.
 *  The view has no teardown: its async callbacks (capability and provider
 *  probes) keep firing after it is replaced, and `root.querySelector` then
 *  finds the NEXT mount's elements. Anything that must not act for a screen
 *  that is gone checks this first. */
let setupMounts = 0;

/** The mount on screen's speaker. A line still playing for a screen that has
 *  been replaced is cut when the next one mounts: its mic would hear it. */
let liveSpeaker: SetupSpeaker | null = null;

export async function mountSetupView(
    root: HTMLElement,
    onBegin: (setup: SessionSetup, continueFrom: SessionState | null) => void | Promise<void>
): Promise<SetupViewHandle> {
    const mountNo = ++setupMounts;
    const isLiveMount = (): boolean => mountNo === setupMounts;
    const setup = await loadSetup();
    // Before first render so the provider menu shows only what's reachable.
    await detectCapabilities();
    const appSettings = await loadAppSettings();
    // BYOK visibility: always in local mode; opt-in in web mode.
    const byokOpts: ProviderAvailabilityOpts = {
        webMode: isWebMode(),
        allowByok: appSettings.enableByok,
    };
    // The shared app default is 'ollama' (desktop-only), which in web mode would
    // mount the local-model picker with an "Install Ollama" empty state.
    // applyProviderIndicators reorders available-first later but can't rescue us
    // when NO provider is available (cloud momentarily unreachable), so resolve
    // a web-valid provider up front.
    setup.provider = resolveSetupProvider(setup.provider, capabilitiesSync(), byokOpts);
    // Edits the app-level pick for the active tab's mode (noting keeps its own,
    // sttSettingKey), same as the Voice control. The select itself is built in
    // renderSetupHTML.
    const sttSetupChoice = (): SttEngineChoice =>
        sttChoiceForMode(appSettings, isWebMode(), setup.meditationType);
    // Warm the Silero VAD while the user configures: whisper-pcm's prime()
    // awaits the same app-lifetime singleton, so the multi-MB download is
    // usually done by the time they click Begin. web-speech and capacitor never
    // load the model.
    if (sttBackendForChoice(sttSetupChoice()) === 'server-whisper') {
        void import('../adapters/silero-vad.js')
            .then((m) => m.loadSileroVad())
            .catch(() => {
                /* best-effort warmup; a failed load degrades the session's
                   engine to the energy speech decision (6z11) */
            });
    }
    // Silent mic probe, in parallel with the rest of setup. Optimistic until it
    // answers, so the notice can only appear (never flash away) and Begin isn't
    // disabled during the check.
    let micStatus: MicStatus = 'ok';
    void probeMic().then((status) => {
        micStatus = status;
        renderMicNotice();
    });
    // Local Whisper downloads its model in the background on first launch;
    // Begin waits for it instead of starting a session that can't hear. Only
    // watched while Whisper is the chosen source, and optimistic like the mic.
    let whisperStatus: WhisperStatus = { state: 'ready' };
    let whisperUnwatch: (() => void) | null = null;
    function watchWhisper(choice: string): void {
        whisperUnwatch?.();
        whisperUnwatch = null;
        whisperStatus = { state: 'ready' };
        if (choice === 'whisper') {
            whisperUnwatch = watchWhisperReady(
                appSettings.sttWhisperModel,
                appSettings.language,
                (status) => {
                    whisperStatus = status;
                    renderWhisperNotice();
                }
            );
        }
        renderWhisperNotice();
    }

    /** Point the STT select at the active mode's pick (a tab switch may change
     *  it) and refresh what hangs off it. The device-quality note is for the
     *  facilitated modes: in noting the recognizer hears one-word labels and
     *  talks over nobody. */
    function syncSttPicker(): void {
        const sttSel = root.querySelector<HTMLSelectElement>('#setup-stt-engine');
        if (!sttSel) return;
        const choice = sttSetupChoice();
        sttSel.value = choice;
        root.querySelector<HTMLElement>('#setup-stt-quality-note')?.classList.toggle(
            'hidden',
            choice !== 'capacitor' || setup.meditationType === 'noting'
        );
        // aloud cloud barges in on iOS only with headphones (session.ts,
        // meditation-pal-hi6f), so the iOS app says so for its pick too.
        root.querySelector<HTMLElement>('#setup-stt-iphone-note')?.classList.toggle(
            'hidden',
            capacitorPlatform() !== 'ios' ||
                choice === 'capacitor' ||
                setup.meditationType === 'noting'
        );
        watchWhisper(choice);
    }
    // Lazy-loaded; the setup form is interactive while voices fetch.
    let scoredVoices: ScoredVoice[] = [];
    // False until the first catalog load settles: before that setup.voice may
    // still be the null that means "browser default" (firstSitBlocker).
    let voicesLoaded = false;

    // A pending continuation: a History "Continue" (reason 'history') or a
    // cold-boot resume (reason 'resume', meditation-pal-v73p). The history view /
    // boot seeder writes it to sessionStorage and routes here; initPendingContinue
    // loads it once. While a History one is pending the mode tabs are locked to
    // its session's mode (continuationMode). Noting can't resume (app.ts
    // goNotingSession takes no transcript), so History offers none there.
    let pendingContinue: { state: SessionState; reason: 'resume' | 'history' } | null = null;

    /** The mode a pending History continuation holds the tabs to: its
     *  session's own, or exploration for one saved before modes were recorded.
     *  A transcript resumed under another mode's prompt was never intended;
     *  whether it should be allowed is meditation-pal-g3ou. */
    function continuationMode(): MeditationType | null {
        if (pendingContinue?.reason !== 'history') return null;
        const t = pendingContinue.state.meditationType;
        return t === 'exploration' || t === 'noting' || t === 'felt_sense' ? t : 'exploration';
    }

    function clearContinueStorage(): void {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.removeItem('continueFrom');
        sessionStorage.removeItem('continueFromSummary');
        sessionStorage.removeItem('continueReason');
    }

    // Drop the offer entirely: on ✕, the resume modal's "start fresh", or a
    // resume in a non-resumable mode. Clears the handoff and, for a cold-boot
    // resume, the durable pointer so the next launch doesn't re-offer it.
    function dropPendingContinue(): void {
        const wasResume = pendingContinue?.reason === 'resume';
        pendingContinue = null;
        clearContinueStorage();
        if (wasResume) void clearActiveSession();
    }

    // Paint the inline banner and the tab lock from the in-memory
    // pendingContinue. Both are ONLY for a History "Continue" (reason
    // 'history') - a cold-boot resume uses the modal instead, so it never
    // paints here.
    function paintContinuation(): void {
        const locked = continuationMode();
        root.querySelectorAll<HTMLButtonElement>('.tab-bar .tab-btn').forEach((btn) => {
            btn.disabled = locked !== null && btn.dataset['tab'] !== locked;
        });
        const banner = root.querySelector<HTMLElement>('#continue-banner');
        const text = root.querySelector<HTMLElement>('#continue-banner-text');
        if (!banner || !text) return;
        if (!pendingContinue || pendingContinue.reason !== 'history') {
            banner.classList.add('hidden');
            return;
        }
        const { state } = pendingContinue;
        const summary =
            (typeof sessionStorage !== 'undefined' &&
                sessionStorage.getItem('continueFromSummary')) ||
            new Date(state.startTime * 1000).toLocaleString();
        text.textContent = t('Continuing from: {summary}', { summary });
        // Must be the .hidden class: the HTML hidden attribute loses to
        // .continue-banner's `display: flex`.
        banner.classList.remove('hidden');
    }

    // Load the pending continuation once at mount. A cold-boot resume (reason
    // 'resume', meditation-pal-v73p) is offered in a modal; a History "Continue"
    // (reason 'history') defaults to the session's mode and shows the inline
    // banner. Noting is never resumable (goNotingSession drops continueFrom,
    // meditation-pal-nh53), so a noting resume is quietly discarded.
    async function initPendingContinue(): Promise<void> {
        if (typeof sessionStorage === 'undefined') return;
        const id = sessionStorage.getItem('continueFrom');
        if (!id) return;
        const state = await sessionStore.load(id);
        if (!state) return;
        const reason = sessionStorage.getItem('continueReason') === 'resume' ? 'resume' : 'history';

        if (reason === 'resume') {
            const t = state.meditationType;
            if (t !== 'exploration' && t !== 'felt_sense') {
                // Not a resumable mode (noting / legacy): drop it silently.
                dropPendingContinue();
                return;
            }
            pendingContinue = { state, reason };
            showResumeModal({
                detail: resumeBannerDetail(state),
                onResume: () => {
                    selectMode(t); // enter the paused session's own mode
                    const resumed = state;
                    pendingContinue = null;
                    clearContinueStorage();
                    beginFromSetup(setup, resumed);
                },
                onStartFresh: () => dropPendingContinue(),
            });
            return;
        }

        pendingContinue = { state, reason };
        selectMode(continuationMode() ?? setup.meditationType); // repaints tabs + banner
    }

    // Select a meditation mode (a tab tap, or a continuation entering its
    // session's mode), keeping the banner and dependent copy/estimates in sync.
    function selectMode(tab: MeditationType): boolean {
        const locked = continuationMode();
        if (locked !== null && tab !== locked) return false;
        if (setup.meditationType !== tab) {
            setup.meditationType = tab;
            // Noting has no intention field, so its slot is always empty.
            setup.intention = setup.intentionByMode[tab] ?? '';
            persist();
            applyTabSelection(tab);
            // Switching to/from noting changes whether an LLM is needed, and
            // changes the estimate (noting has its own multiplier).
            updateBeginButton();
            updateAiNotes();
            syncSttPicker();
            updateSessionEstimate();
        }
        paintContinuation();
        return true;
    }

    function persist(): void {
        void saveSetup(setup);
    }

    // ---- the form's changes, by click or by voice (setup-actions.ts) ------
    // Each setter changes the setup, saves it and repaints its own control,
    // whether or not that control is on screen (another mode's tab, the
    // collapsed Customize section). The click handlers in render() call the
    // same ones.

    // The collapsed Customize toggle still shows what's active, so persisted
    // picks from a previous session aren't invisible.
    function updateCustomizeSummary(): void {
        const el = root.querySelector<HTMLElement>('#customize-summary');
        if (!el) return;
        const names = [
            ...setup.focuses.map((f) => FOCUS_LABELS[f]),
            ...setup.qualities.map((q) => QUALITY_LABELS[q]),
        ].filter(Boolean).map((n) => t(n));
        el.textContent = names.join(', ');
    }

    function paintModifiers(name: 'focus' | 'quality', list: readonly string[]): void {
        root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((cb) => {
            cb.checked = list.includes(cb.value);
        });
        updateCustomizeSummary();
    }

    function setFocuses(list: Focus[]): void {
        setup.focuses = list;
        persist();
        paintModifiers('focus', list);
    }

    function setQualities(list: Quality[]): void {
        setup.qualities = list;
        persist();
        paintModifiers('quality', list);
    }

    function paintGuidance(): void {
        const slider = root.querySelector<HTMLInputElement>('#directiveness');
        if (!slider) return;
        slider.value = String(setup.dirStep);
        sayStop(slider, t('Following'), t('Directing'));
        markStop(slider);
    }

    function setGuidance(step: number): void {
        setup.dirStep = step;
        persist();
        paintGuidance();
    }

    function paintVerbosity(): void {
        const select = root.querySelector<HTMLSelectElement>('#verbosity');
        if (select) select.value = setup.verbosity;
    }

    function setVerbosity(value: Verbosity): void {
        setup.verbosity = value;
        persist();
        paintVerbosity();
    }

    const INTENTION_FIELDS: ReadonlyArray<readonly [string, MeditationType]> = [
        ['#intention', 'exploration'],
        ['#felt-sense-intention', 'felt_sense'],
    ];

    /** `mode`'s own field: exploration's intention and felt sense's
     *  "something to sit with" are different inputs. setup.intention mirrors
     *  the ACTIVE mode's, so sessions and prompts downstream stay single-field. */
    function setIntention(mode: MeditationType, text: string, from?: HTMLTextAreaElement): void {
        setup.intentionByMode[mode] = text;
        if (setup.meditationType === mode) setup.intention = text;
        persist();
        const selector = INTENTION_FIELDS.find(([, m]) => m === mode)?.[0];
        const el = selector ? root.querySelector<HTMLTextAreaElement>(selector) : null;
        if (!el) return;
        // Typing in the field must not have its text put back under the caret.
        if (el !== from) el.value = text;
        autosizeIntention(el);
    }

    /** The special requests field from anywhere but its own typing, left open
     *  so what was said shows. */
    function setSpecialRequests(text: string): void {
        setup.customInstructions = text;
        persist();
        const el = root.querySelector<HTMLTextAreaElement>('#custom-instructions');
        if (el) el.value = text;
        paintRequestsPreview();
        openSpecialRequests();
    }

    /** Folded shut, the field still shows it holds something: a dot, and its
     *  start as far as the row has room (CSS hides both while it is open). */
    function paintRequestsPreview(): void {
        const details = root.querySelector('#custom-instructions')?.closest('details');
        const preview = details?.querySelector('.requests-preview');
        if (!details || !preview) return;
        const text = setup.customInstructions.replace(/\s+/g, ' ').trim();
        details.classList.toggle('has-requests', text !== '');
        preview.textContent = text;
    }

    /** True when the field was shut and this opened it. */
    function openSpecialRequests(): boolean {
        const details = root.querySelector('#custom-instructions')?.closest('details');
        if (!details || details.open) return false;
        details.open = true;
        return true;
    }

    // "Special requests" opened the field to ask; left without an answer, an
    // empty field folds shut again.
    let requestsOpenedToAsk = false;
    function foldUnansweredRequests(): void {
        const details = root.querySelector('#custom-instructions')?.closest('details');
        if (requestsOpenedToAsk && details && !setup.customInstructions.trim()) details.open = false;
        requestsOpenedToAsk = false;
    }

    function paintCheckins(): void {
        const on = setup.feltSenseCheckins;
        const toggle = root.querySelector<HTMLInputElement>('#checkin-enabled');
        const slider = root.querySelector<HTMLInputElement>('#checkin-pace');
        if (toggle) toggle.checked = on;
        // Off greys the pace slider out.
        root.querySelector<HTMLElement>('#checkin-pace-control')?.classList.toggle('is-disabled', !on);
        if (slider) slider.disabled = !on;
    }

    function setCheckins(on: boolean): void {
        setup.feltSenseCheckins = on;
        persist();
        paintCheckins();
    }

    // App-level settings written from this page go one after another, each
    // re-reading before it writes, so two controls saving in the same moment
    // can't put back what the other just changed. A begin said in the same
    // breath as a length ("begin a twenty minute session") waits for it,
    // since the session reads its timer from storage.
    let settingsSaved: Promise<void> = Promise.resolve();
    function saveAppPatch(patch: Partial<AppSettings>): Promise<void> {
        settingsSaved = settingsSaved
            .then(() => loadAppSettings())
            .then((stored) => saveAppSettings({ ...stored, ...patch }))
            .catch(() => undefined);
        return settingsSaved;
    }

    function paintClockBtns(): void {
        const face = clockModeLabel(
            appSettings.sessionClockMode,
            appSettings.sessionTimerMin,
            appSettings.showSessionClock
        );
        root.querySelectorAll<HTMLButtonElement>('[data-clock-btn]').forEach((b) => (b.textContent = face));
    }

    /** One clock for every mode: a timer picked under Exploration is still
     *  there under Felt Sense. */
    function setClock(choice: Partial<Pick<typeof appSettings, 'sessionClockMode' | 'sessionTimerMin' | 'showSessionClock' | 'endSessionOnTimer'>>): void {
        Object.assign(appSettings, choice);
        paintClockBtns();
        void saveAppPatch(choice);
    }

    const setupForm: SetupForm = {
        mode: () => setup.meditationType,
        selectMode,
        // The same thing a timer set by voice inside a session does
        // (SessionClock.setTimer): it becomes the timer, for this session and
        // as the default after it.
        setTimer: (minutes) => {
            const timerMin = clampTimerMinutes(minutes);
            setClock({ sessionClockMode: 'timer', sessionTimerMin: timerMin });
            return timerMin;
        },
        clearTimer: () => setClock({ sessionClockMode: 'elapsed' }),
        setClockVisible: (show) => setClock({ showSessionClock: show }),
        setClockMode: (mode) => setClock({ sessionClockMode: mode, showSessionClock: true }),
        focuses: () => setup.focuses.filter((f): f is SetupFocus => f !== 'open_awareness'),
        // Open awareness has no card on this screen; a stored one is kept.
        setFocuses: (list) => setFocuses([...setup.focuses.filter((f) => f === 'open_awareness'), ...list]),
        qualities: () => setup.qualities,
        setQualities,
        guidance: () => setup.dirStep,
        setGuidance,
        verbosity: () => setup.verbosity,
        setVerbosity,
        setIntention: (text) => setIntention(setup.meditationType, text),
        specialRequests: () => setup.customInstructions,
        setSpecialRequests,
        setCheckins,
    };

    /** A request to change the form, from anywhere but a pointer. */
    function applyActions(actions: readonly SetupAction[]): SetupOutcome[] {
        return applySetupActions(setupForm, actions);
    }

    /**
     * Voice + rate are app-level defaults, not per-session state (see loadSetup
     * in settings.ts): this picker edits the same global default the Settings
     * page does, so changes propagate to every session. Callers keep the
     * in-memory `setup` in sync for the live form, then write through here.
     */
    function persistDefaultVoice(voice: string | null, rate: number): Promise<void> {
        return saveAppPatch({ defaultVoice: voice, defaultTtsRate: rate });
    }

    /**
     * Score voices from `/app/v1/voices`, aloud cloud, and the browser's
     * speechSynthesis into scoredVoices. Browser voices are included because
     * preview can drive browser TTS; server voices win any name collision.
     */
    async function loadVoiceCatalog(): Promise<void> {
        // Session language (the app-level Settings value, mirrored by
        // loadSetup) hides incompatible voices in the picker.
        scoredVoices = await loadScoredVoices(setup.language);
        voicesLoaded = true;
        // A pick stored under a hosted voice's old name follows it.
        const renamed = renamedHostedVoice(setup.voice, scoredVoices);
        if (renamed) {
            setup.voice = renamed;
            void persistDefaultVoice(setup.voice, setup.ttsRate);
        }
        // Never leave the picker on a bare "Default", or on a hosted voice
        // that is gone.
        if (!stripVoicePrefix(setup.voice) || isOrphanedHostedVoice(setup.voice, scoredVoices)) {
            const top = defaultVoicePick(scoredVoices, setup.language);
            if (top) {
                setup.voice = prefixedVoiceId(top.engine, top.name);
                void persistDefaultVoice(setup.voice, setup.ttsRate);
            }
        }
        // A noting participant on one takes the session's voice.
        let moved = false;
        for (const p of setup.notingParticipants ?? []) {
            if (p.type === 'sound' || !isOrphanedHostedVoice(p.voice, scoredVoices)) continue;
            p.voice = setup.voice ?? p.voice;
            moved = true;
        }
        if (moved) persist();
        updateVoiceButtonLabel();
        // Voices just arrived: repopulate participant voice dropdowns.
        renderParticipantList();
        // Zero usable voices means TTS needs fixing. Checked only after the
        // catalog resolves so the banner doesn't flash during the load.
        // [data-no-voices], not the bare class: the no-mic notice borrows the
        // same styling and must not be toggled by the voice catalog.
        root.querySelectorAll<HTMLElement>('[data-no-voices]').forEach((banner) => {
            banner.classList.toggle('hidden', scoredVoices.length > 0);
        });
    }

    function findVoice(name: string | null): ScoredVoice | null {
        if (!name) return null;
        return scoredVoices.find((v) => v.name === name) ?? null;
    }

    // Selected hosted model's credits/hr for the estimate. Wired to the model
    // picker once it mounts; 0 until then / for free providers.
    let getModelRate: () => number = () => 0;
    // Whether a cloud narrator voice would actually be read in an AI-free
    // noting circle (signed in with credits). Learned after /me; when false the
    // narrator leg is 0, matching the session view (narratorSilencedForCloud).
    let narratorBillable = true;
    // Wired to the mounted picker so the cloud-reachability watcher can repopulate it
    // once aloud cloud is up.
    let refreshModelPicker: (provider: string) => void = () => {};
    // Cloud-wake watcher unsubscribe (web/mobile only). Called on hide so a
    // pending wait doesn't fire into a torn-down view.
    let cloudUnwatch: (() => void) | null = null;

    function updateVoiceButtonLabel(): void {
        // One button per tab panel (exploration, felt sense, noting's
        // introduction voice), all painting the same app-level default voice.
        const btns = root.querySelectorAll<HTMLButtonElement>('[data-default-voice]');
        if (btns.length === 0) return;
        const selectedName = stripVoicePrefix(setup.voice);
        const entry = findVoice(selectedName);
        // Show a cloud voice's ☁ rate on the collapsed button too, so a paid
        // pick reads as paid without opening the picker.
        const rate = entry ? rateBadge(entry.creditsPerHour) : '';
        const ratePart = rate ? ` · ${rate}` : '';
        let text: string;
        if (entry) {
            text = `${voiceLabel(entry.name)}${ratePart} · ${voiceRateLabel(entry.name, scoredVoices, setup.ttsRate)}`;
        } else if (selectedName) {
            // Voice id is stored but we haven't loaded its details yet.
            text = `${voiceLabel(selectedName)} · ${voiceRateLabel(selectedName, scoredVoices, setup.ttsRate)}`;
        } else {
            text = scoredVoices.length > 0 ? t('Default') : t('Voice');
        }
        for (const btn of btns) btn.textContent = text;
        // The voice leg feeds the combined estimate.
        updateSessionEstimate();
    }

    /**
     * Estimated cloud burn for the configured session, on the setup footer.
     * Estimate only, no live in-session countdown - that would be distracting
     * with eyes closed; balance lives behind the profile button
     * (meditation-pal-e3e). Sums the hosted legs at a typical talk profile:
     * aloud-cloud LLM + cloud STT + cloud voice, each 0 when local/BYOK. Rates
     * come from the same pricing the meter bills with, so only the assumed
     * usage profile can drift, not the prices.
     */
    function updateSessionEstimate(): void {
        const el = root.querySelector<HTMLElement>('#session-estimate');
        if (!el) return;
        // The estimate sits inside the footer's "what are ☁?" pill, which
        // only shows when something on the page costs credits.
        const help = root.querySelector<HTMLElement>('#clouds-help');
        const setCloudUi = (visible: boolean): void => {
            help?.classList.toggle('hidden', !visible);
        };

        // Retreat attendees aren't metered (meditation-pal-414).
        if (getRetreatCovered()) {
            el.classList.add('hidden');
            el.innerHTML = '';
            setCloudUi(false);
            return;
        }

        const sttSel = root.querySelector<HTMLSelectElement>('#setup-stt-engine');
        const sttChoice = sttSel?.value ?? sttSetupChoice();

        const ai = needsLLM();
        const llm = ai && setup.provider === 'aloud' ? getModelRate() : 0;
        const stt = cloudSttCreditsPerHour(sttChoice as SttEngineChoice);
        const voiceRate = findVoice(stripVoicePrefix(setup.voice))?.creditsPerHour ?? 0;
        // In an AI-free noting circle the narrator reads a few hundred
        // characters per sit, not a conversation's worth - and nothing at all
        // when there is no account to bill (the session view skips it).
        const tts = ai
            ? voiceRate
            : narratorBillable
              ? voiceRate * NOTING_NARRATOR_TTS_FRACTION
              : 0;
        // The background-assistant leg (classifiers, summaries, recap) rides
        // every aloud-cloud session on top of the picked model's badge - so the
        // pill runs a touch above the badges' sum, which its title explains.
        // Outside the mode multiplier: noting leans on it MORE, not less. An
        // AI-free circle never calls it (no labels, no recap).
        const util = ai && setup.provider === 'aloud' ? cloudUtilityCreditsPerHour() : 0;
        // Noting mode burns far less than the exploration-calibrated legs imply.
        const total = (llm + stt + tts) * (MODE_RATE_MULTIPLIER[setup.meditationType] ?? 1) + util;

        // All-local/BYOK: hide the pill rather than show a bare "0☁".
        if (total <= 0) {
            el.classList.add('hidden');
            el.innerHTML = '';
            setCloudUi(false);
            return;
        }
        el.classList.remove('hidden');
        setCloudUi(true);
        const rate = t('≈{rate}/hr', { rate: rateBadge(total) });
        el.title = util > 0
            ? t('Rough estimate. Includes a small background model for summaries and quick decisions, so it can sit above the badges combined.')
            : t('Rough estimate; varies with how much is said.');
        el.textContent = rate;
    }

    /**
     * Open the shared voice picker. With no target it edits setup.voice (the
     * narrator voice); pass a target to edit a noting participant's voice.
     * Wiring lives inline because render() would blow the modal away with the
     * rest of the form.
     */
    // The picker while it is up, for a request made by voice: close it, or
    // pick a row the way a tap on it would (a noting participant's included).
    let openVoicePicker: { close: () => void; pick: (name: string) => boolean } | null = null;

    function openVoiceModal(target?: {
        current: () => string | null;
        onSelect: (voiceId: string) => void;
    }): void {
        openVoicePicker?.close();
        const modal = root.querySelector<HTMLElement>('#setup-voice-modal');
        const listEl = root.querySelector<HTMLElement>('#setup-voice-modal-list');
        const closeBtn = root.querySelector<HTMLButtonElement>('#setup-voice-modal-close');
        const speedSlider = root.querySelector<HTMLInputElement>('#setup-speed-slider');
        const speedLabel = root.querySelector<HTMLElement>('#setup-speed-label');
        if (!modal || !listEl || !closeBtn || !speedSlider || !speedLabel) return;

        const currentName = stripVoicePrefix(target ? target.current() : setup.voice);
        renderVoiceList(listEl, scoredVoices, currentName, { showEngine: true, hideIncompatible: true });
        speedSlider.value = String(setup.ttsRate);
        syncSpeedControlForVoice(speedSlider, speedLabel, currentName, scoredVoices, setup.ttsRate);
        modal.classList.remove('hidden');

        const onListClick = (e: MouseEvent) => {
            const target2 = e.target as HTMLElement;
            const row = target2.closest<HTMLElement>('.voice-row');
            if (!row) return;
            const name = row.dataset['voiceName'];
            if (!name) return;
            // Download the Piper model, then re-render so the voice (and any
            // model-sharing speakers) unlock.
            const downloadBtn = target2.closest<HTMLButtonElement>('.voice-row-download');
            if (downloadBtn) {
                e.preventDefault();
                void (async () => {
                    if (!(await downloadVoiceFromRow(listEl, downloadBtn, name, findVoice(name)?.engine))) return;
                    invalidateServerVoicesCache();
                    await loadVoiceCatalog();
                    renderVoiceList(listEl, scoredVoices, currentName, { showEngine: true, hideIncompatible: true });
                })();
                return;
            }
            if (target2.closest('.voice-row-preview')) {
                if (row.classList.contains('voice-row-locked')) return;
                const entry = findVoice(name);
                runPreview(name, setup.ttsRate, entry?.engine).catch((err) => {
                    void alertDialog(previewErrorMessage(err));
                });
                return;
            }
            if (row.classList.contains('voice-row-locked')) return;
            // Persist with the engine prefix so createTtsForVoice picks the
            // right backend.
            const entry = findVoice(name);
            const voiceId = prefixedVoiceId(entry?.engine, name);
            updateVoiceSelection(listEl, name);
            syncSpeedControlForVoice(speedSlider, speedLabel, name, scoredVoices, setup.ttsRate);
            if (target) {
                target.onSelect(voiceId);
            } else {
                setup.voice = voiceId;
                void persistDefaultVoice(setup.voice, setup.ttsRate);
                updateVoiceButtonLabel();
            }
        };
        const onSpeedInput = () => {
            const rate = Number(speedSlider.value);
            setup.ttsRate = rate;
            speedLabel.textContent = t('{rate} wpm', { rate });
            void persistDefaultVoice(setup.voice, setup.ttsRate);
            updateVoiceButtonLabel();
        };
        const closeModal = () => {
            modal.classList.add('hidden');
            stopPreview();
            listEl.removeEventListener('click', onListClick);
            speedSlider.removeEventListener('input', onSpeedInput);
            closeBtn.removeEventListener('click', closeModal);
            offBackdrop();
            openVoicePicker = null;
            // The note that was showing over the picker goes with it.
            modal.querySelector('.voice-start-note')?.classList.add('hidden');
        };
        openVoicePicker = {
            close: closeModal,
            pick: (name) => {
                const row = [...listEl.querySelectorAll<HTMLElement>('.voice-row')].find((r) => r.dataset['voiceName'] === name);
                if (!row || row.classList.contains('voice-row-locked')) return false;
                row.click();
                return true;
            },
        };

        listEl.addEventListener('click', onListClick);
        speedSlider.addEventListener('input', onSpeedInput);
        closeBtn.addEventListener('click', closeModal);
        const offBackdrop = onBackdropClick(modal, closeModal);
    }

    function render(): void {
        root.innerHTML = renderSetupHTML(byokOpts, sttSetupChoice());
        wireTabBar();
        wireInfoButtons();
        wireNotingPanel();

        // Exploration's "intention" and felt sense's "something to sit with"
        // are different inputs, so each textarea binds to its own
        // intentionByMode slot. setup.intention mirrors the ACTIVE mode's value
        // so sessions/prompts downstream stay single-field.
        for (const [selector, mode] of INTENTION_FIELDS) {
            const el = root.querySelector<HTMLTextAreaElement>(selector)!;
            el.value = setup.intentionByMode[mode] ?? '';
            autosizeIntention(el);
            el.addEventListener('input', () => setIntention(mode, el.value, el));
        }

        // "Customize facilitator" disclosure. On phones the focus + vibe grids
        // are most of the page's scroll, so they collapse behind this toggle;
        // on desktop CSS hides the toggle and always shows the body.
        const customizeSection = root.querySelector<HTMLElement>('#customize-section');
        const customizeToggle = root.querySelector<HTMLButtonElement>('#customize-toggle');
        customizeToggle?.addEventListener('click', () => {
            const open = customizeSection?.classList.toggle('open') ?? false;
            customizeToggle.setAttribute('aria-expanded', String(open));
            if (open && customizeSection) revealOpened(customizeSection);
        });
        // Focus + quality checkboxes, each group a list-valued setup field.
        paintModifiers('focus', setup.focuses);
        paintModifiers('quality', setup.qualities);
        root.querySelectorAll<HTMLInputElement>('input[name="focus"]').forEach((cb) => {
            cb.addEventListener('change', () => {
                const value = cb.value as Focus;
                setFocuses(cb.checked ? [...setup.focuses, value] : setup.focuses.filter((v) => v !== value));
            });
        });
        root.querySelectorAll<HTMLInputElement>('input[name="quality"]').forEach((cb) => {
            cb.addEventListener('change', () => {
                const value = cb.value as Quality;
                setQualities(cb.checked ? [...setup.qualities, value] : setup.qualities.filter((v) => v !== value));
            });
        });

        const dirSlider = root.querySelector<HTMLInputElement>('#directiveness')!;
        paintGuidance();
        dirSlider.addEventListener('input', () => setGuidance(Number(dirSlider.value)));

        // Felt-sense check-in pace: same stops as the guidance slider, its own
        // stored value, timing only (SessionSetup.feltSensePaceStep).
        const paceSlider = root.querySelector<HTMLInputElement>('#checkin-pace')!;
        paceSlider.value = String(setup.feltSensePaceStep);
        const sayPace = (): void => {
            sayStop(paceSlider, t('Patient'), t('Attentive'));
            markStop(paceSlider);
        };
        sayPace();
        paceSlider.addEventListener('input', () => {
            setup.feltSensePaceStep = Number(paceSlider.value);
            sayPace();
            persist();
        });
        // Felt sense owns whether silence check-ins happen at all, rather than
        // deferring to the Settings-page Check-In Timing radio (unreachable from
        // here).
        const checkinToggle = root.querySelector<HTMLInputElement>('#checkin-enabled')!;
        paintCheckins();
        checkinToggle.addEventListener('change', () => setCheckins(checkinToggle.checked));

        const verbositySel = root.querySelector<HTMLSelectElement>('#verbosity')!;
        paintVerbosity();
        verbositySel.addEventListener('change', () => setVerbosity(verbositySel.value as Verbosity));

        const customEl = root.querySelector<HTMLTextAreaElement>('#custom-instructions')!;
        customEl.value = setup.customInstructions;
        paintRequestsPreview();
        customEl.addEventListener('input', () => {
            setup.customInstructions = customEl.value;
            persist();
            paintRequestsPreview();
        });

        // Session clock. One control per mode panel, all showing the same
        // app-level choice.
        paintClockBtns();
        root.querySelectorAll<HTMLButtonElement>('[data-clock-btn]').forEach((btn) => {
            btn.addEventListener('click', () => {
                void showSessionClockModal({
                    mode: appSettings.sessionClockMode,
                    timerMin: appSettings.sessionTimerMin,
                    showClock: appSettings.showSessionClock,
                    endOnComplete: appSettings.endSessionOnTimer,
                }).then((choice) => {
                    if (!choice) return;
                    setClock({
                        sessionClockMode: choice.mode,
                        sessionTimerMin: choice.timerMin,
                        showSessionClock: choice.showClock,
                        endSessionOnTimer: choice.endOnComplete,
                    });
                });
            });
        });

        const providerSel = root.querySelector<HTMLSelectElement>('#provider')!;
        providerSel.value = setup.provider;
        providerSel.addEventListener('change', () => {
            setup.provider = providerSel.value as Provider;
            persist();
            void modelPicker.refresh(setup.provider);
            updateProviderHint();
            updateBeginButton();
            // Zero/restore the LLM leg now; the model's actual rate folds in via
            // the picker's onChange once the new provider's models load.
            updateSessionEstimate();
        });
        // Fetches /app/v1/models/<provider>; falls back to a free-form text
        // input when the endpoint isn't available.
        const modelContainer = root.querySelector<HTMLElement>('#model-picker-slot')!;
        const modelPicker = mountModelPicker(
            modelContainer,
            setup.provider,
            setup.model,
            (value) => {
                setup.model = value;
                persist();
                updateSessionEstimate();
            }
        );
        getModelRate = () => modelPicker.getRate();
        refreshModelPicker = (p) => void modelPicker.refresh(p);

        // App-level (like the default voice), so saving here mirrors Settings;
        // under the Noting tab it's noting's own pick.
        const sttSel = root.querySelector<HTMLSelectElement>('#setup-stt-engine');
        syncSttPicker();
        sttSel?.addEventListener('change', async () => {
            const key = sttSettingKey(setup.meditationType);
            const choice = sttSel.value as SttEngineChoice;
            appSettings[key] = choice;
            await saveAppPatch({ [key]: choice });
            syncSttPicker();
            updateSessionEstimate();
        });

        // API key entry itself lives in Settings, not here.
        void refreshProviderAvailability();

        // One button per tab panel, all opening the same picker modal.
        updateVoiceButtonLabel();
        root.querySelectorAll<HTMLButtonElement>('[data-default-voice]').forEach((btn) => {
            btn.addEventListener('click', () => openVoiceModal());
        });

        // One Begin path handles fresh and continued sessions. A cold-boot resume
        // runs through the modal, so pendingContinue here is only ever a History
        // "Continue" (or null).
        root.querySelector('#voice-start-mic')?.addEventListener('click', () => {
            // Voice mode: on (lit), asleep (closed by itself) or off
            // (slashed). A tap wakes one asleep; otherwise it is the toggle,
            // and the setting with it (the same switch as Settings has): off
            // stays off on the next visit, and on stays on.
            // Lit with no listener yet is on too: it waits out a line first.
            if (voiceStart || micShows === 'listening') {
                speaker.stop();
                setSetupVoice(false);
                return closeVoiceStart();
            }
            voiceStartClosed = false;
            setSetupVoice(true);
            if (mic !== 'ask') return void syncVoiceStart();
            // The one place this feature may raise the permission prompt: a
            // tap that asked for it. Called before any await, like Begin's
            // own, so the gesture is still behind it.
            void acquireMicOnce().then((status) => {
                if (status === 'ok') mic = 'granted';
                else if (status === 'denied') mic = 'denied';
                else return paintVoiceMic('ask', describeMicProblem(status) ?? undefined);
                void syncVoiceStart();
            });
        });
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn')!;
        beginBtn.addEventListener('click', beginNow);
        // Initial gate state (recomputed once /providers status arrives).
        updateBeginButton();
        updateAiNotes();
        // Initial estimate; the LLM and voice legs fill in once models/voices
        // load and re-call this.
        updateSessionEstimate();
        // Learn retreat coverage (meditation-pal-414) so the pill can hide for
        // covered attendees. fetchMe is a no-op when signed out.
        void fetchMe()
            .then(() => narratorCanBill())
            .then((ok) => {
                narratorBillable = ok;
                updateSessionEstimate();
            })
            .catch(() => {});

        // Continuation banner. render() rebuilds the DOM, so re-wire the
        // ✕ and repaint from the in-memory pendingContinue every render (the
        // one-time load lives in initPendingContinue, called at mount). ✕ drops
        // the offer, which also shifts layout - fine, it's an explicit dismiss.
        const bannerCancel = root.querySelector<HTMLButtonElement>('#continue-cancel');
        bannerCancel?.addEventListener('click', () => {
            dropPendingContinue();
            paintContinuation();
        });
        paintContinuation();
    }

    // Provider status from /app/v1/providers - see provider-markers.ts.
    let providerStatus: ProviderStatusMap | null = null;
    // Which BYOK providers have a key stored. A keyless API provider is marked
    // ⚙: it can't run without one.
    let keyPresent: Record<string, boolean> = {};

    async function refreshProviderAvailability(): Promise<void> {
        keyPresent = await fetchKeyPresence();
        // Backend not reachable: leave status unknown. The key-presence ⚙ marks
        // still apply, and the session view surfaces a real error if a
        // provider call fails later.
        providerStatus = (await fetchProviderStatus()) ?? providerStatus;
        applyProviderIndicators();
        updateProviderHint();
        scheduleCloudWatch();
    }

    /** Whether the chosen flow needs a working LLM. Shared with the cloud gate
     *  so the two can't disagree. */
    function needsLLM(): boolean {
        return sessionNeedsLlm(setup.meditationType, setup.notingParticipants);
    }

    /**
     * Whether the selected provider is usable. Unknown status (the /providers
     * probe failed) counts as available so we never block on missing info.
     */
    function providerAvailable(): boolean {
        // A keyless API provider can't run; block Begin so the ⚙ and the gate
        // agree.
        if (providerNeedsKey(setup.provider) && keyPresent[setup.provider] === false) return false;
        // A running local Ollama daemon (direct probe) is usable even when the
        // app backend can't see it (browser dev preview against Hono).
        if (setup.provider === 'ollama' && capabilitiesSync().ollama) return true;
        // /app/v1/providers (Hono) reports aloud cloud available unconditionally
        // - it can't see the hosted service's health - so gate on the real
        // reachability probe. Unreachable reads unavailable until the watcher
        // confirms it's up, keeping Begin blocked rather than starting a
        // session that stalls on its first turn.
        if (setup.provider === 'aloud' && byokOpts.webMode) return capabilitiesSync().cloud;
        const info = providerStatus?.[setup.provider];
        return !info || info.available;
    }

    /**
     * Block Begin when an LLM is needed but its provider isn't available, so a
     * user with (say) Ollama stopped sees a disabled button instead of a
     * session that dies on the first turn.
     */
    // ---- the mic on this screen (voice-start.ts) -------------------------
    // "Begin", and changes to the setup said out loud. Runs only while this
    // screen is up and Begin itself is possible; opens by itself where the
    // mic is known to be granted and on a tap where it isn't; closes itself
    // as setupListeningLimits says and when the screen goes away.
    let voiceStart: {
        handle: VoiceStartHandle;
        choice: SttEngineChoice;
        engine: SttEngine;
        /** The mics this listener holds until it can hear, handed to whoever
         *  replaces it first (micHandover). */
        passOn: () => (() => void) | null;
    } | null = null;
    let voiceStartGen = 0;
    // A listener stopped because the mode switched recognizer keeps its mic
    // until the next listener can hear (runVoiceSync), else the card's line
    // loses half a second on macOS (voice-start.ts createMicHandover).
    const micHandover = createMicHandover();
    // Null until the first reading lands: nothing is offered on a guess.
    let mic: MicPermission | null = null;
    // Whether a session begun now could be heard. A webview can play sound
    // untouched and a browser tab can't; only the platform knows which this is.
    let canSound = pageTouched();
    // Closed until asked: asleep when the setting is still on (its window ran
    // out, a room kept talking, the recognizer failed, "stop listening"),
    // which a tap or a tour starting wakes; with it off, off.
    let voiceStartClosed = false;
    // Begin has been pressed (or said) and the session is on its way up. The
    // screen is still here for a moment, and its probes are still landing;
    // none of them may open the mic again underneath the session.
    let beginning = false;
    // The recognizer this mode would use is the hosted one and nobody is
    // signed in (runVoiceSync).
    let sttNeedsAccount = false;
    // A recognizer that can't be built here (createSttForChoice gave none for
    // it): with it picked, nothing listens.
    let noRecognizer: SttEngineChoice | null = null;
    // While the tour is up, the recognizer it started with. The tour walks
    // every mode's tab, and noting keeps its own pick (the phone's recognizer
    // on a phone): swapped there, Android left call mode under the noting
    // card's line and the phone's recognizer failed to come back
    // (2026-11-19). Swaps wait for the tour to end.
    let tourChoice: SttEngineChoice | null = null;
    /** The recognizer this screen listens with. */
    const listenerChoice = (): SttEngineChoice => tourChoice ?? sttSetupChoice();
    // What the mic beside Begin shows (paintVoiceMic). Lit can come before
    // the listener does: a mic switched on while the app speaks shows on at
    // once and starts listening when the line is over.
    let micShows: VoiceMicLook = 'hidden';
    // Whether the listener can hear right now (listenOnSetup onHearing). Lit
    // and not hearing, the mic pulses: words said then are lost.
    let micHearing: SetupHearing = 'opening';
    // Read whether the setting is on or off: with it off the mic still shows,
    // slashed, and a tap switches it on. Neither probe prompts or listens.
    void micPermission().then((permission) => {
        mic = permission;
        void syncVoiceStart();
    });
    if (!canSound) {
        void canPlayUntouched().then((ok) => {
            canSound = ok;
            void syncVoiceStart();
        });
    }

    /** Voice on this screen, switched by a tap on the mic or by the tour. */
    function setSetupVoice(on: boolean): void {
        if (appSettings.setupVoice === on) return;
        appSettings.setupVoice = on;
        void saveAppPatch({ setupVoice: on });
    }

    // What answers a request made by voice: a clip in a house voice, or the
    // session's own voice where that one is local (setup-speech.ts).
    liveSpeaker?.stop();
    const speaker = (liveSpeaker = createSetupSpeaker({
        voiceId: () => setup.voice,
        houseVoice: () => appSettings.houseVoice,
        language: () => appSettings.language,
        rate: () => setup.ttsRate,
    }));
    // Settles when the app has finished speaking and its tail has cleared. A
    // listener rebuilt mid-line (a mode with its own recognizer) waits on it,
    // or it would open on the app's own voice.
    let speaking: Promise<void> = Promise.resolve();

    /**
     * The mic beside Begin, which stands for voice mode on this screen:
     * - `listening`: on. Lit, with the level ring; it hears requests.
     * - `sleeping`: closed by itself for the visit, the setting still on.
     *   Unlit and not slashed; the tour still speaks; a tap wakes it.
     * - `off`: voice mode switched off. Slashed; nothing listens or speaks.
     * - `ask`: on, but held back by something a tap clears (the permission
     *   not yet given, a page not yet touched). Slashed, as before.
     * - `blocked`: slashed and inert (the permission denied).
     * - `hidden`: nothing to offer (Begin itself can't run, hosted
     *   recognition with nobody signed in).
     *
     * Lit while the recognizer can't hear (micHearing), it pulses: no
     * listener yet, the mic opening, or stopped for a line and its tail.
     * Opening says so in its label; the pause around a line keeps the
     * listening one, so a screen reader is not told twice a line.
     */
    function paintVoiceMic(state: VoiceMicLook, why?: string): void {
        const el = root.querySelector<HTMLButtonElement>('#voice-start-mic');
        micShows = state;
        if (!el) return;
        // Lit with no listener yet is the mic opening too.
        const hearing: SetupHearing = voiceStart ? micHearing : 'opening';
        const waiting = state === 'listening' && hearing !== 'hearing';
        const label =
            why ??
            (state === 'listening'
                ? hearing === 'opening'
                    ? t('Opening the mic…')
                    : t('Listening. Say "begin", or what to change. Tap to turn off.')
                : state === 'sleeping'
                  ? t('Sleeping. Tap to listen.')
                  : state === 'off'
                    ? t('Voice off. Tap to turn on.')
                    : state === 'blocked'
                      ? t("The microphone is blocked for aloud, so it can't listen here.")
                      : t('Tap to listen'));
        el.classList.toggle('hidden', state === 'hidden');
        el.classList.toggle('active', state === 'listening');
        el.classList.toggle('waiting', waiting);
        el.classList.toggle('sleeping', state === 'sleeping');
        el.disabled = state === 'blocked';
        el.title = label;
        el.setAttribute('aria-label', label);
        el.setAttribute('aria-pressed', String(state === 'listening'));
    }

    /** How the mic rests once a listener has ended: asleep if it closed by
     *  itself, slashed if switched off, and otherwise until the next sync
     *  says. */
    function restingLook(): VoiceMicLook {
        if (!appSettings.setupVoice) return 'off';
        return voiceStartClosed ? 'sleeping' : 'ask';
    }

    // The words of the line just spoken, above Begin: the answer for anyone
    // with the sound off, and where a mishearing shows.
    let voiceNoteTimer: ReturnType<typeof setTimeout> | undefined;
    /** The note's element: the one in the Begin bar, or, while the voice
     *  picker is up, one inside the picker's own layer. The bar is under the
     *  picker's dimming, and so was the hint that says how to use it. */
    function voiceNoteEl(): HTMLElement | null {
        const bar = root.querySelector<HTMLElement>('#voice-start-note');
        const modal = openVoicePicker ? root.querySelector<HTMLElement>('#setup-voice-modal') : null;
        if (!modal) return bar;
        let over = modal.querySelector<HTMLElement>('.voice-start-note');
        if (!over) {
            over = document.createElement('p');
            over.className = 'voice-start-note over-modal hidden';
            over.setAttribute('role', 'status');
            over.setAttribute('aria-live', 'polite');
            modal.appendChild(over);
        }
        bar?.classList.add('hidden');
        return over;
    }

    function showVoiceNote(text: string, aside = false, heard?: string): void {
        const el = voiceNoteEl();
        if (!el || !text) return;
        // Something heard is one line, cut by the pill to the room it has;
        // its words are a part of their own so the closing quote stays.
        el.classList.toggle('heard', heard !== undefined);
        if (heard === undefined) el.textContent = text;
        else {
            const [before = '', after = ''] = text.split(HEARD_SLOT);
            const words = document.createElement('span');
            words.className = 'heard-words';
            words.textContent = heard;
            el.replaceChildren(before, words, after);
        }
        // An aside is not an answer: what was heard and not understood, or
        // the first-visits hint.
        el.classList.toggle('aside', aside);
        // Back at full strength at once, whatever the last one was doing.
        el.classList.remove('hidden', 'leaving');
        el.style.removeProperty('width');
        placeVoiceNote(el);
        balanceVoiceNote(el);
        clearTimeout(voiceNoteTimer);
        // Whole for its time, then a short fade, then gone.
        voiceNoteTimer = setTimeout(() => {
            el.classList.add('leaving');
            voiceNoteTimer = setTimeout(() => {
                el.classList.add('hidden');
                el.classList.remove('leaving');
            }, VOICE_NOTE_FADE_MS);
        }, VOICE_NOTE_MS);
    }

    /**
     * Where the note goes: in the bar, left of the mic, when its words fit
     * there in two lines; otherwise floated above the bar, where there is
     * always room. Measured each time, since the room is whatever the window
     * leaves between the bar's edge and the mic.
     */
    function placeVoiceNote(el: HTMLElement): void {
        el.classList.remove('in-bar');
        if (el.classList.contains('over-modal')) return;
        const micEl = root.querySelector<HTMLElement>('#voice-start-mic');
        const bar = el.closest<HTMLElement>('.setup-footer');
        if (!micEl || micEl.classList.contains('hidden') || !bar) return;
        const micBox = micEl.getBoundingClientRect();
        const barBox = bar.getBoundingClientRect();
        const room = micBox.left - barBox.left - VOICE_NOTE_GAP_PX - VOICE_NOTE_EDGE_PX;
        if (room < VOICE_NOTE_MIN_ROOM_PX) return;
        el.style.setProperty('--note-right', `${barBox.right - micBox.left + VOICE_NOTE_GAP_PX}px`);
        el.style.setProperty('--note-top', `${micBox.top + micBox.height / 2 - barBox.top}px`);
        el.style.setProperty('--note-room', `${room}px`);
        el.classList.add('in-bar');
        if (el.offsetHeight > barBox.height - 6) el.classList.remove('in-bar');
    }

    /**
     * Two lines of about the same length, in a pill no wider than they need.
     * `text-wrap: balance` evens the lines but leaves the pill as wide as the
     * room it was given, with air at both ends; so the pill is narrowed to
     * the least width that still takes two lines.
     */
    function balanceVoiceNote(el: HTMLElement): void {
        const style = getComputedStyle(el);
        const lineHeight = parseFloat(style.lineHeight);
        const chrome =
            parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
        const lines = (): number => Math.round((el.getBoundingClientRect().height - chrome) / lineHeight);
        if (!(lineHeight > 0) || lines() !== 2) return;
        let wide = el.getBoundingClientRect().width;
        let narrow = wide / 2;
        while (wide - narrow > 4) {
            const mid = (wide + narrow) / 2;
            el.style.width = `${mid}px`;
            if (lines() === 2) wide = mid;
            else narrow = mid;
        }
        el.style.width = `${Math.ceil(wide)}px`;
    }

    /** While the app is saying `line`, the ring around the mic stays still:
     *  what the meter hears then is the app. */
    function quietRingDuring(line: Promise<void>): void {
        const micEl = root.querySelector<HTMLElement>('#voice-start-mic');
        micEl?.classList.add('app-speaking');
        void line.finally(() => {
            if (speaking === line) micEl?.classList.remove('app-speaking');
        });
    }

    /** Say lines, with their words on screen. */
    function sayLines(lines: readonly SpokenSetupLine[]): Promise<void> {
        showVoiceNote(lines.map((line) => line.text).join(' '));
        const said = speaker.say(lines);
        speaking = said.then(() => new Promise((resolve) => setTimeout(resolve, SPEECH_TAIL_MS)));
        quietRingDuring(speaking);
        // Not `speaking`: the listener waits a tail of its own after a request
        // it understood (listenOnSetup), and the two stacked left the mic deaf
        // for two tails after a question.
        return said;
    }

    /** Say what a request came to, on screen and out loud. */
    function answer(outcomes: readonly SetupOutcome[]): Promise<void> {
        return sayLines(setupOutcomeLines(outcomes, appSettings.language));
    }

    // "Set my intention" or "special requests" was said with nothing after it
    // and the app has asked: until `until`, the next thing heard is the answer.
    let awaiting: { field: AskedField; until: number } | null = null;

    /** An intention or a special request is a sentence, with the pauses of
     *  one; a change to the setup is a breath. While the answer is awaited the
     *  turn waits longer to end, on the recognizers that take the hint. */
    function awaitAnswer(field: AskedField | null): void {
        awaiting = field ? { field, until: Date.now() + INTENTION_ANSWER_MS } : null;
        const [base, max] = field ? INTENTION_PAUSE_MS : [LOBBY_STT.silenceBaseMs, LOBBY_STT.silenceMaxMs];
        voiceStart?.engine.setPauseWindow?.(base, max);
    }

    /** What was said after "What is your intention?" or "What's your
     *  request?", as the actions it makes, or how the question was left
     *  unanswered (core leavesAsk). */
    function askedAnswer(field: AskedField, text: string): SetupAction[] | 'cancel' | 'done' {
        const said = text.trim();
        const left = leavesAsk(said);
        if (left) return left;
        // "My intention is to rest" is still the intention "to rest", and
        // "clear it" by its own words still clears.
        const own = parseSetupCommand(said);
        const kinds: readonly SetupAction['kind'][] =
            field === 'intention' ? ['intention', 'intention-ask'] : ['special-request', 'special-request-ask'];
        if (own?.length === 1 && kinds.includes(own[0]!.kind)) return own;
        const answer = said.replace(/[.。]+$/u, '');
        return [field === 'intention' ? { kind: 'intention', text: answer } : { kind: 'special-request', text: answer }];
    }

    /** What the voice and model lists hold right now, for a pick by name. */
    function pickContext(): Parameters<typeof parseSetupPick>[1] {
        const select = root.querySelector<HTMLSelectElement>('#model-select');
        const usable = scoredVoices.filter((v) => !(v.needsDownload && !v.downloaded));
        return {
            // Voices of the session's language first: "the first listed wins".
            voices: [...usable.filter((v) => !v.langMismatch), ...usable.filter((v) => v.langMismatch)].map((v) => v.name),
            models:
                select && !select.disabled && needsLLM()
                    ? [...select.options].filter((o) => o.value).map((o) => ({ value: o.value, label: o.textContent ?? '' }))
                    : [],
            pickerOpen: openVoicePicker !== null,
        };
    }

    /** Play a voice's sample with the recognizer stopped, saying why on screen
     *  when it can't be played. Through the speaker, so whatever stops a line
     *  (Begin above all) stops it too. */
    function previewByVoice(name: string): Promise<void> {
        return sayHeld(() =>
            speaker.sample(name, findVoice(name)?.engine).catch((err: unknown) => {
                showVoiceNote(previewErrorMessage(err), true);
            })
        );
    }

    /** A voice or a model picked by name (core setup-pick.ts). */
    async function applyPick(pick: SetupPick): Promise<void> {
        if (pick.kind === 'voice-picker') {
            if (!pick.open) return void openVoicePicker?.close();
            openVoiceModal();
            return showVoiceNote(t('Say a name to pick a voice, or "preview" and a name.'), true);
        }
        if (pick.kind === 'model') {
            const select = root.querySelector<HTMLSelectElement>('#model-select');
            const option = select ? [...select.options].find((o) => o.value === pick.value) : undefined;
            if (!select || !option) return;
            select.value = pick.value;
            // The picker's own handler: the same path as choosing it by hand.
            select.dispatchEvent(new Event('change'));
            return sayLines([modelSetLine(option.textContent ?? '', appSettings.language)]);
        }
        if (pick.preview) {
            showVoiceNote(t('Previewing {name}', { name: voiceLabel(pick.name) }), true);
            return previewByVoice(pick.name);
        }
        // A row tap where the picker is up (it may be choosing a noting
        // participant's voice); else the session's voice.
        if (!openVoicePicker?.pick(pick.name)) {
            if (openVoicePicker) return;
            setup.voice = prefixedVoiceId(findVoice(pick.name)?.engine, pick.name);
            void persistDefaultVoice(setup.voice, setup.ttsRate);
            updateVoiceButtonLabel();
        }
        showVoiceNote(t('Voice: {name}', { name: voiceLabel(pick.name) }));
        // The voice answers for itself.
        return previewByVoice(pick.name);
    }

    /** The tail of the app's own line, late out of a slow speaker or still in
     *  the room when the recognizer opened again. Without this "Guidance set
     *  to following." could hear itself ask for "following". */
    function heardOwnLine(text: string): boolean {
        const spoken = speaker.lastSpoken();
        return (
            spoken !== null &&
            Date.now() - spoken.endedAt < SETUP_ECHO_WINDOW_MS &&
            looksLikeSpokenTail(text, spoken.text)
        );
    }

    /** Something said on this screen that was not "begin". True when it was a
     *  request, which keeps the mic open for the next. */
    async function heardOnSetup(text: string): Promise<boolean> {
        // The picker sits over the tour, so "close", "back" or 关闭 said while
        // it is up close the picker. The tour reads them as its own close and
        // back, and would end or step back with the picker still up.
        const closing = openVoicePicker ? parseSetupPick(text, pickContext()) : null;
        if (closing?.kind === 'voice-picker' && !closing.open) {
            await applyPick(closing);
            return true;
        }
        // The tour's own words ("next", a voice's name) while it is up.
        if (tourHeard?.(text)) return true;
        const answering = awaiting && Date.now() < awaiting.until ? awaiting.field : null;
        if (awaiting) awaitAnswer(null);
        if (answering) {
            const answered = askedAnswer(answering, text);
            if (typeof answered !== 'string') requestsOpenedToAsk = false;
            else {
                if (answering === 'special-request') foldUnansweredRequests();
                const id: SetupLineId =
                    answered === 'done' ? 'all-set' : answering === 'intention' ? 'never-mind' : 'special-request-never-mind';
                await sayLines([{ id, text: setupLineText(id, appSettings.language) }]);
                return true;
            }
            return act(answered);
        }
        const pick = parseSetupPick(text, pickContext());
        if (pick) {
            await applyPick(pick);
            return true;
        }
        const actions = parseSetupCommand(text) ?? (await judgedSetupCommand(text));
        if (!isLiveMount() || beginning) return false;
        if (!actions) {
            // What came to nothing is shown as heard, so a mishearing reads
            // as one and not as a mic that isn't working.
            const said = text.trim().replace(/[.。!?！？…]+$/u, '');
            if (said) showVoiceNote(t('Heard "{text}"', { text: HEARD_SLOT }), true, said);
            return false;
        }
        return act(actions);
    }

    /** Make the changes and say them back. */
    async function act(actions: readonly SetupAction[]): Promise<boolean> {
        const outcomes = applyActions(actions);
        // Closed before it is said to be: the mic shows off while the line
        // plays. Its stream is kept until the line is over: let go now, the
        // output is rebuilt a second or two later, inside "Okay, the mic is off."
        let lineOver = (): void => {};
        if (outcomes.some((outcome) => outcome.kind === 'stop-listening')) {
            closeVoiceStart(new Promise<void>((resolve) => (lineOver = resolve)));
        }
        // The judge's reading of "could I pick a different voice?".
        if (outcomes.some((outcome) => outcome.kind === 'voice-picker')) await applyPick({ kind: 'voice-picker', open: true });
        if (outcomes.some((outcome) => outcome.kind === 'special-request-ask')) {
            requestsOpenedToAsk = openSpecialRequests() || requestsOpenedToAsk;
        }
        try {
            await answer(outcomes);
        } finally {
            lineOver();
        }
        // After the question, so the wait for an answer starts when it ends.
        const ask = outcomes.find((outcome) => outcome.kind === 'intention-ask' || outcome.kind === 'special-request-ask');
        if (ask) awaitAnswer(ask.kind === 'intention-ask' ? 'intention' : 'special-request');
        return true;
    }

    /** Close the mic until it is tapped again. With `keepMicUntil` the
     *  listener stops now and lets its stream go when that settles. */
    function closeVoiceStart(keepMicUntil?: Promise<unknown>): void {
        const listening = voiceStart;
        voiceStart = null;
        voiceStartClosed = true;
        if (listening) void listening.handle.stop(keepMicUntil ? { keepMicUntil } : undefined).then(() => syncVoiceStart());
        else void syncVoiceStart();
    }

    // The sync most recently started. Each one makes any still in flight
    // stale, so what the screen needs is only known once this stops changing.
    let lastSync: Promise<void> = Promise.resolve();
    function syncVoiceStart(): Promise<void> {
        const sync = runVoiceSync();
        lastSync = sync;
        // A mic held for a listener that this sync did not build: a newer
        // sync under way takes it over; with none, nothing will, so it goes.
        const settled = (): void => {
            if (lastSync === sync) micHandover.release();
        };
        void sync.then(settled, settled);
        return sync;
    }
    async function voiceSyncSettled(): Promise<void> {
        for (let sync = lastSync; ; sync = lastSync) {
            await sync;
            if (sync === lastSync) return;
        }
    }
    /** Until the app has stopped speaking, counting a line that started while
     *  the last one was being waited out. */
    async function speechSettled(): Promise<void> {
        for (let line = speaking; ; line = speaking) {
            await line;
            if (line === speaking) return;
        }
    }

    async function runVoiceSync(): Promise<void> {
        // A mount that has been replaced must not open a mic on its
        // successor's screen: that was a second listener nobody owned.
        if (!isLiveMount() || beginning) return;
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn');
        if (!beginBtn) return;
        // This sync is now the one that decides; a listener still being built
        // by an earlier one is abandoned at its next check.
        const gen = ++voiceStartGen;
        const choice = listenerChoice();
        // Hosted recognition with nobody signed in would refuse the first
        // thing heard. Nothing here may raise a sign-in, so there is no mic.
        sttNeedsAccount = isHostedSttChoice(choice) && !(await canReachJudge());
        if (gen !== voiceStartGen || !isLiveMount() || beginning) return;
        const blocker = sttNeedsAccount
            ? 'not-ready'
            : voiceStartBlocker({
                  enabled: appSettings.setupVoice,
                  mic: mic ?? 'ask',
                  canBegin: !beginBtn.disabled && mic !== null,
                  touched: canSound || pageTouched(),
              });
        if (voiceStart && (blocker || voiceStart.choice !== choice)) {
            const { handle, passOn } = voiceStart;
            voiceStart = null;
            // Closed by a blocker, the mic goes now. Replaced, it is held
            // through the card's line until the new listener can hear.
            await (blocker ? handle.stop() : micHandover.stop(handle, passOn()));
        }
        if (blocker === 'no-touch-yet') {
            // A page nobody has touched can't play sound, so a session begun
            // now would be silent. Any touch lifts it. On pointerup: a finger
            // only counts as a touch once it lifts.
            paintVoiceMic('ask');
            document.addEventListener(
                'pointerup',
                (event) => {
                    // A tap on the mic is its click handler's to answer. Opened
                    // here first, that click would find it lit and close it.
                    if (event.target instanceof Element && event.target.closest('#voice-start-mic')) return;
                    void syncVoiceStart();
                },
                { once: true }
            );
            return;
        }
        if (blocker === 'off') return paintVoiceMic('off');
        if (blocker === 'mic-ask') return paintVoiceMic('ask');
        if (blocker === 'mic-denied') return paintVoiceMic('blocked');
        if (blocker) return paintVoiceMic('hidden');
        if (voiceStart) return;
        // Closed by itself, with the setting on (off returned above).
        if (voiceStartClosed) return paintVoiceMic('sleeping');
        // On from here, though it hears nothing until the app has stopped
        // speaking: a mic switched on under a line shows so at once.
        if (noRecognizer !== choice) paintVoiceMic('listening');
        await speechSettled();
        if (gen !== voiceStartGen) return;
        // This screen comes up as a session ends, often under its close: the
        // mic opens once the close is over, and the session's stays open past
        // it until this listener can hear, held like a replaced listener's.
        const close = waitForClose();
        if (close) {
            micHandover.hold(close.release);
            const t0 = performance.now();
            await close.over;
            diag(`[signature] close: setup mic waited ${Math.round(performance.now() - t0)}ms for it`);
            if (gen !== voiceStartGen) return;
        }
        // The session's own recognizer, mic and language (and, for local
        // Whisper, the model setup has already warmed: naming another here
        // would make the shell swap models under the first turn), tuned for a
        // few words instead of a turn.
        const engine = await createSttForChoice(choice, {
            ...LOBBY_STT,
            language: appSettings.language,
            micDeviceId: appSettings.micDeviceId,
            whisperModelSize: appSettings.sttWhisperModel,
        });
        // A line that began while the engine was being built (a step of the
        // tour) is not to be heard by it.
        await speechSettled();
        // Something changed while the engine was being built: leave it to the
        // sync that change triggered.
        if (gen !== voiceStartGen || voiceStart || beginning || !beginBtn.isConnected || !isLiveMount()) return;
        noRecognizer = engine ? null : choice;
        if (!engine) return paintVoiceMic('ask');
        // The mic of the listener this one replaces goes once this one can
        // hear. Its first frame is too soon: a capture opened afresh on macOS
        // sends digital silence while the OS sets it up. A recognizer with no
        // stream of ours (the browser's, a phone's) has nothing to wait for.
        let owed = micHandover.take();
        const settleOwed = (): void => {
            owed?.();
            owed = null;
        };
        if (!(engine instanceof WhisperPcmSttEngine)) settleOwed();
        micHearing = 'opening';
        const handle = listenOnSetup({
            engine,
            alive: () =>
                isLiveMount() && beginBtn.isConnected && document.body.dataset['sessionActive'] === undefined,
            onBegin: (request) => void beginByVoice(request, beginBtn),
            keepMicForBegin: holdCaptureForSession,
            onHeard: heardOnSetup,
            isEcho: heardOwnLine,
            ...setupListeningLimits(
                isCapacitor() ? 'phone' : choice === 'whisper' || choice === 'web-speech' ? 'free' : 'hosted'
            ),
            ...(engine instanceof WhisperPcmSttEngine
                ? { whenHearing: () => engine.whenHearing(), coldOpening: () => engine.coldOpening() }
                : {}),
            onHearing: (state) => {
                if (state === 'hearing') settleOwed();
                if (voiceStart?.handle !== handle) return;
                micHearing = state;
                if (micShows === 'listening') paintVoiceMic('listening');
                if (state === 'hearing') void hintAtVoice();
            },
            onEnd: (why) => {
                settleOwed();
                dropOpeningNote();
                meter.stop();
                if (voiceStart?.handle === handle) voiceStart = null;
                // The screen went away under a line: nobody is there to hear
                // the rest of it, and the next screen's mic would.
                if (why === 'stopped' && (!isLiveMount() || !beginBtn.isConnected)) speaker.stop();
                // The window ran out or the recognizer failed: asleep until
                // tapped. (A tap on the lit mic has already said so itself.)
                if (why === 'window' || why === 'error') voiceStartClosed = true;
                paintVoiceMic(why === 'begin' ? 'hidden' : restingLook());
            },
        });
        const meter = meterVoiceMic(engine, choice);
        voiceStart = {
            handle,
            choice,
            engine,
            passOn: () => {
                const passed = owed;
                owed = null;
                return passed;
            },
        };
        paintVoiceMic('listening');
        hintWhileOpening();
    }

    /**
     * The ring around the mic that swells with the voice, as in a session
     * (.btn-voice.active reads --mic-level). Whisper's engine reports its own
     * level, so no second stream is opened beside it; the browser's
     * recognizer hides its audio and gets a small meter stream of its own,
     * except where a second capture would starve the recognizer (phones).
     */
    function meterVoiceMic(engine: SttEngine, choice: SttEngineChoice): { stop: () => void } {
        const el = root.querySelector<HTMLButtonElement>('#voice-start-mic');
        if (!el) return { stop: () => undefined };
        if (engine instanceof WhisperPcmSttEngine) {
            let smoothed = 0;
            let lastFrame = 0;
            engine.setLevelListener((rms) => {
                lastFrame = Date.now();
                smoothed = smoothed * 0.6 + Math.min(1, rms * 4) * 0.4;
                el.style.setProperty('--mic-level', smoothed.toFixed(3));
            });
            // The engine stops between turns and while the app speaks, and
            // sends nothing then: the ring must not stay where it last was.
            const settle = setInterval(() => {
                if (Date.now() - lastFrame < 300) return;
                smoothed = 0;
                el.style.removeProperty('--mic-level');
            }, 250);
            return {
                stop: () => {
                    clearInterval(settle);
                    engine.setLevelListener(null);
                    el.style.removeProperty('--mic-level');
                },
            };
        }
        if (sttBackendForChoice(choice) !== 'web-speech' || isSingleOwnerMicPlatform()) return { stop: () => undefined };
        let stopped = false;
        let live: { stop(): void } | null = null;
        void startMicMeter(el, appSettings.micDeviceId)
            .then((m) => {
                if (stopped) m.stop();
                else live = m;
            })
            .catch(() => undefined);
        return {
            stop: () => {
                stopped = true;
                live?.stop();
            },
        };
    }

    /** The first few times the mic opens here, say on screen what it is for,
     *  once it can hear: a try said sooner would be lost. Not under the tour,
     *  which says so itself. */
    let hinted = false;
    async function hintAtVoice(): Promise<void> {
        clearTimeout(openingNoteTimer);
        // Once a visit, however many times the listener is rebuilt.
        if (hinted) return;
        hinted = true;
        const shown = Number(await sharedKv.get(VOICE_HINT_KEY)) || 0;
        const note = root.querySelector<HTMLElement>('#voice-start-note');
        const busy = note !== null && !note.classList.contains('hidden') && note.textContent !== t('Opening the mic…');
        if (shown >= VOICE_HINT_TIMES || busy || !voiceStart || document.body.classList.contains('guide-running')) {
            return dropOpeningNote();
        }
        await sharedKv.set(VOICE_HINT_KEY, String(shown + 1));
        showVoiceNote(t('Listening. Try "twenty minutes", or say "begin".'), true);
    }

    /** On the visits the hint is for, a fresh capture slow to hear says it is
     *  opening meanwhile, and the hint takes its place. */
    let openingNoteTimer: ReturnType<typeof setTimeout> | undefined;
    function hintWhileOpening(): void {
        clearTimeout(openingNoteTimer);
        if (hinted) return;
        openingNoteTimer = setTimeout(() => {
            void sharedKv.get(VOICE_HINT_KEY).then((stored) => {
                const note = root.querySelector<HTMLElement>('#voice-start-note');
                if (
                    hinted ||
                    (Number(stored) || 0) >= VOICE_HINT_TIMES ||
                    !voiceStart ||
                    micHearing !== 'opening' ||
                    document.body.classList.contains('guide-running') ||
                    (note !== null && !note.classList.contains('hidden'))
                ) {
                    return;
                }
                showVoiceNote(t('Opening the mic…'), true);
            });
        }, MIC_OPENING_NOTE_AFTER_MS);
    }

    /** Take "Opening the mic…" down, with the usual fade, once it isn't so. */
    function dropOpeningNote(): void {
        clearTimeout(openingNoteTimer);
        const opening = t('Opening the mic…');
        root.querySelectorAll<HTMLElement>('.voice-start-note').forEach((el) => {
            if (el.classList.contains('hidden') || el.textContent !== opening) return;
            clearTimeout(voiceNoteTimer);
            el.classList.add('leaving');
            voiceNoteTimer = setTimeout(() => {
                el.classList.add('hidden');
                el.classList.remove('leaving');
            }, VOICE_NOTE_FADE_MS);
        });
    }

    /**
     * Every way a session starts from this screen: Begin, "begin", the welcome
     * card's first session, a resume. Called from the gesture where there is
     * one, with no await before `onBegin` (the mic prompt and the audio
     * unlock need it).
     */
    function beginFromSetup(runSetup: SessionSetup, continueFrom: SessionState | null): void {
        // The mic open on this screen stops listening but stays open until
        // the session's own can hear beside it (holdCaptureForSession), along
        // with any held for a listener being replaced. (When "begin" was
        // heard, the listener has already stopped this way.)
        const handover = holdCaptureForSession();
        const listening = voiceStart;
        voiceStart = null;
        void listening?.handle.stop({ keepMicUntil: handover });
        const replaced = micHandover.take();
        if (replaced) void handover.then(replaced);
        speaker.stop();
        // And none may open while the session comes up: not one still being
        // built, not one a late probe asks for.
        voiceStartGen++;
        beginning = true;
        // Over when the session is up or the attempt was turned back (no mic,
        // sign-in dismissed). Only the second leaves this screen, and then it
        // may listen again, and no session will take the held mic over.
        void Promise.resolve(onBegin(runSetup, continueFrom)).finally(() => {
            beginning = false;
            if (document.body.dataset['sessionActive'] === undefined) endCaptureHandover();
            void syncVoiceStart();
        });
    }

    /** The Begin button: one path for fresh and continued sessions. A
     *  cold-boot resume runs through its modal, so a pending continuation
     *  here is only ever a History "Continue". */
    function beginNow(): void {
        const queued = pendingContinue?.state ?? null;
        if (pendingContinue) {
            pendingContinue = null;
            clearContinueStorage();
        }
        beginFromSetup(setup, queued);
    }

    /** "Begin a twenty minute felt sense session": make the two choices the
     *  request can name, the way doing them by hand would, then begin. */
    async function beginByVoice(request: BeginRequest, beginBtn: HTMLButtonElement): Promise<void> {
        speaker.stop();
        applyActions([
            // A mode tab tap. No-op when a continuation has the mode locked.
            ...(request.mode ? [{ kind: 'mode', mode: request.mode } as const] : []),
            ...(request.minutes !== undefined ? [{ kind: 'length', minutes: request.minutes } as const] : []),
        ]);
        await settingsSaved;
        // The mode switch may have closed the gate (a mode that needs a
        // provider this setup doesn't have): then there is nothing to begin,
        // and nothing to keep the listener's mic for.
        if (!isLiveMount() || !beginBtn.isConnected || beginBtn.disabled) return endCaptureHandover();
        // The same path as the click, queued continue and all. Not a click():
        // the tour's centered cards hold the page inert.
        beginNow();
    }

    // ---- the tour's voice (tour/index-guide.ts TourVoice) ----------------
    let tourHeard: ((text: string) => boolean) | null = null;

    /** Speak with the recognizer stopped, where one is running, and once a
     *  mic it has just opened cold has settled (voice-start.ts hold). */
    function sayHeld(say: () => Promise<void>): Promise<void> {
        const tail = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SPEECH_TAIL_MS));
        const run = voiceStart ? voiceStart.handle.hold(say) : say().then(tail);
        speaking = run.catch(() => undefined);
        quietRingDuring(speaking);
        return speaking;
    }

    // Bumped by the tour's stop(). A held line starts only once the recognizer
    // has stopped (and a mic opened cold has settled, up to a few seconds),
    // and a stop() that lands in between must still stop it: the speaker had
    // nothing playing yet to cut.
    let tourLines = 0;
    const tourVoice: TourVoice = {
        say: (id, as) => {
            const asked = tourLines;
            // Voice mode off: captions only, whatever the tour asks. Asked
            // again as it starts: a tap on the mic may have come meanwhile.
            if (!appSettings.setupVoice) return Promise.resolve();
            return sayHeld(() =>
                asked === tourLines && appSettings.setupVoice
                    ? speaker.sayLine(id, as ? { voice: as } : {})
                    : Promise.resolve()
            );
        },
        stop: () => {
            tourLines++;
            speaker.stop();
        },
        speaks: () => appSettings.setupVoice,
        voicesOnOffer: () => {
            const offered = houseVoices(appSettings.language);
            // Someone who chose a local voice keeps it: the pick is between
            // hosted ones, and would move them off it.
            if (offered.length !== 2 || (stripVoicePrefix(setup.voice) && isLocalVoice(setup.voice))) return [];
            const usable = offered.every(
                ({ name }) =>
                    prefixedVoiceId(findVoice(name)?.engine, name).startsWith('aloud:') &&
                    findVoice(name) !== null &&
                    clipFor(name, 'voice-intro-first', appSettings.language) !== null &&
                    clipFor(name, 'voice-intro-second', appSettings.language) !== null
            );
            return usable ? offered : [];
        },
        pickVoice: (name) => {
            setup.voice = prefixedVoiceId(findVoice(name)?.engine, name);
            appSettings.houseVoice = name;
            void saveAppPatch({ defaultVoice: setup.voice, defaultTtsRate: setup.ttsRate, houseVoice: name });
            updateVoiceButtonLabel();
        },
        mic: () => {
            const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn');
            if (mic === 'denied' || sttNeedsAccount || !beginBtn || beginBtn.disabled) return 'off';
            if (voiceStart) return 'on';
            if (noRecognizer === listenerChoice()) return 'ask';
            // Opening, or asleep (voiceStartClosed with the setting still
            // on): on either way. Switched off is the setting.
            const blocker = voiceStartBlocker({
                enabled: appSettings.setupVoice,
                mic: mic ?? 'ask',
                canBegin: true,
                touched: canSound || pageTouched(),
            });
            return blocker === null ? 'on' : 'ask';
        },
        reopen: () => {
            // Asleep wakes; off (the setting) stays off.
            if (!voiceStartClosed || !appSettings.setupVoice) return;
            voiceStartClosed = false;
            void syncVoiceStart();
        },
        enableMic: () => {
            voiceStartClosed = false;
            setSetupVoice(true);
            // Before any await, like Begin's own: the gesture is still behind it.
            const asked = mic === 'granted' ? Promise.resolve('ok' as const) : acquireMicOnce();
            return asked.then(async (status) => {
                if (status === 'ok') mic = 'granted';
                else if (status === 'denied') mic = 'denied';
                void syncVoiceStart();
                // Not this sync alone: a probe landing meanwhile starts a
                // newer one, and that is the one that lights the mic.
                await voiceSyncSettled();
                return voiceStart !== null;
            });
        },
        listen: (handler) => {
            tourHeard = handler;
            tourChoice = handler ? (voiceStart?.choice ?? sttSetupChoice()) : null;
            // Over: the tab it ended on may want another recognizer.
            if (!handler) void syncVoiceStart();
        },
        keepOpen: () => voiceStart?.handle.keepOpen(),
    };

    // The judge's reading of what the on-device parser could not place, where
    // this setup may ask it at all (setup-judge.ts): the same consent as a
    // session's voice commands, and never a sign-in prompt from this screen.
    const judgedSetupCommand = createSetupJudge({
        provider: () => setup.provider,
        optedIn: () => appSettings.voiceCommandsViaCloud,
        // No judge to ask and a local model picked: that model could read
        // the request (setup-local-reader.ts), and only one that keeps a
        // room out is allowed to.
        local: createLocalSetupReader({
            provider: () => setup.provider,
            model: () => setup.model,
            usable: () => needsLLM() && providerAvailable() && readsSetupLocally(setup.model),
        }),
    });

    function updateBeginButton(): void {
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn');
        if (!beginBtn) return;
        // A known-bad mic blocks Begin outright: aloud has no text-only mode, so
        // there's nothing to start. Only the certain cases reach here (see
        // probeMic); the rest are caught by the Begin handler's own check.
        const disabled =
            (needsLLM() && !providerAvailable()) ||
            micStatus !== 'ok' ||
            whisperStatus.state !== 'ready';
        beginBtn.disabled = disabled;
        beginBtn.classList.toggle('btn-disabled', disabled);
        void syncVoiceStart();
    }

    /**
     * Why the welcome card's "Try right now" can't start yet, in words short
     * enough for the card, or null. The Begin gate above, plus the two async
     * fills a tap on a card that opens with the page can beat: the default
     * model (aloud cloud refuses a session without one) and the default voice
     * (null would speak in the browser's).
     */
    function firstSitBlocker(): string | null {
        const blocked =
            describeMicRequirement(micStatus) ?? describeWhisperWait(whisperStatus);
        if (blocked) return blocked;
        if (!providerAvailable()) {
            return setup.provider === 'aloud'
                ? t('Connecting to aloud cloud…')
                : t('Set up an AI provider first.');
        }
        if (!voicesLoaded || (setup.provider === 'aloud' && !setup.model)) {
            return t('Getting ready…');
        }
        return null;
    }

    // The welcome card's first-sit offer. It runs on a one-off copy of the
    // setup, so neither the form nor the saved setup changes.
    const quickStart: QuickStart = {
        blocker: firstSitBlocker,
        start: () => beginFromSetup(firstSitSetup(setup), null),
    };

    /** Paint the no-mic notice + Begin state from the silent probe. */
    function renderMicNotice(): void {
        const banner = root.querySelector<HTMLElement>('#setup-no-mic');
        const text = root.querySelector<HTMLElement>('#setup-no-mic-text');
        const problem = describeMicRequirement(micStatus);
        if (banner && text) {
            banner.classList.toggle('hidden', !problem);
            text.textContent = problem ?? '';
        }
        updateBeginButton();
    }

    function renderWhisperNotice(): void {
        const banner = root.querySelector<HTMLElement>('#setup-whisper-wait');
        const text = root.querySelector<HTMLElement>('#setup-whisper-wait-text');
        const wait = whisperNotice(whisperStatus);
        if (banner && text) {
            banner.classList.toggle('hidden', !wait);
            text.textContent = wait ?? '';
        }
        updateBeginButton();
    }

    /**
     * Gray out the Provider + Model pickers when no AI will run (a noting circle
     * of only fixed phrases / sounds). They stay legible so the user still sees
     * what would be used. Mirrors the needsLLM() gate on Begin.
     */
    function updateAiNotes(): void {
        const active = needsLLM();
        root.querySelector<HTMLElement>('#ai-provider-group')?.classList.toggle('ai-group-disabled', !active);
        root.querySelector<HTMLElement>('#ai-model-group')?.classList.toggle('ai-group-disabled', !active);
        // Only noting can lack an AI; exploration/felt sense always use the
        // model, so never explain its absence there.
        const showAiNote = !active && setup.meditationType === 'noting';
        root.querySelector<HTMLElement>('#ai-inactive-note')?.classList.toggle('hidden', !showAiNote);

        // Noting uses less AI credits since much less talking
        const showSpendNote = active && setup.meditationType === 'noting';
        root.querySelector<HTMLElement>('#noting-spend-note')?.classList.toggle('hidden', !showSpendNote);
    }

    /**
     * Annotate provider <option>s with ✱ (installed but not running, e.g.
     * Ollama stopped) or ⚙ (not configured at all), reorder available-first,
     * float claude_proxy to the top when it works, and select the saved
     * provider if available, else the first available one.
     */
    function applyProviderIndicators(): void {
        const providerSel = root.querySelector<HTMLSelectElement>('#provider');
        if (!providerSel) return;
        const available: HTMLOptionElement[] = [];
        const unavailable: HTMLOptionElement[] = [];
        for (const opt of Array.from(providerSel.options)) {
            const { suffix, unavailable: isUnavailable } = computeProviderMarker(
                opt.value,
                providerStatus,
                keyPresent
            );
            opt.textContent = stripMarker(opt.textContent ?? '') + suffix;
            // ✱ stays selectable; only ⚙ drops to the unavailable group.
            if (isUnavailable) unavailable.push(opt);
            else available.push(opt);
        }
        available.sort((a, b) => (a.value === 'claude_proxy' ? -1 : b.value === 'claude_proxy' ? 1 : 0));
        for (const opt of [...available, ...unavailable]) providerSel.appendChild(opt);

        // Fall back to the first available provider so a fresh user isn't
        // stranded on an unavailable default with no nudge toward a working one.
        const savedAvailable = available.some((o) => o.value === setup.provider);
        const target = savedAvailable ? setup.provider : (available[0]?.value ?? setup.provider);
        if (target !== setup.provider) {
            // Reuse the change handler so the model picker, hint, and Begin gate
            // all refresh.
            providerSel.value = target;
            providerSel.dispatchEvent(new Event('change'));
            return;
        }
        if (providerSel.value !== target) providerSel.value = target;
        updateProviderHint();
        updateBeginButton();
    }

    function updateProviderHint(): void {
        const hintEl = root.querySelector<HTMLElement>('#provider-hint');
        if (!hintEl) return;
        // aloud cloud unreachable is usually a transient miss, so show a calm
        // "connecting" note rather than an error while the background poll
        // waits for it to answer.
        if (setup.provider === 'aloud' && byokOpts.webMode && !capabilitiesSync().cloud) {
            hintEl.textContent = t('Connecting to aloud cloud…');
            hintEl.classList.remove('hidden');
            return;
        }
        // Same override as the ⚙/Begin gate: a directly-probed running Ollama
        // shows no hint even when the app backend reported it absent, so the
        // install box doesn't linger.
        const info =
            setup.provider === 'ollama' && capabilitiesSync().ollama
                ? { available: true }
                : providerStatus?.[setup.provider];
        if (info && !info.available && info.hint) {
            // Text, as Settings renders the same field: the hint comes from
            // the backend (/app/v1/providers), which on web and mobile is a
            // remote server, and it carries no markup.
            hintEl.textContent = info.hint;
            hintEl.classList.remove('hidden');
        } else {
            hintEl.classList.add('hidden');
        }
    }

    /**
     * The initial capability probe can miss aloud cloud on a flaky connection
     * (cloud=false), stranding Begin behind a "connecting" hint forever. Watch
     * for it to answer, then refresh markers, model picker, and gate so the
     * page heals without a reload. Web/mobile only; no-op once cloud is
     * reachable or a wait is already pending.
     */
    function scheduleCloudWatch(): void {
        if (!byokOpts.webMode || cloudUnwatch !== null) return;
        if (capabilitiesSync().cloud) return;
        cloudUnwatch = watchCloudReachable(() => {
            cloudUnwatch = null;
            void refreshProviderAvailability();
            refreshModelPicker(setup.provider);
        });
    }

    function wireTabBar(): void {
        // The persisted mode drives which panel shows on (re)render.
        applyTabSelection(setup.meditationType);
        root.querySelectorAll<HTMLButtonElement>('.tab-bar .tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset['tab'];
                if (tab !== 'exploration' && tab !== 'noting' && tab !== 'felt_sense') return;
                selectMode(tab);
            });
        });
    }

    /** Grow an intention box to fit its text; CSS caps it (max-height), after
     *  which it scrolls. Skips hidden panels - scrollHeight reads 0 there -
     *  so applyTabSelection re-runs this when a tab becomes visible. */
    function autosizeIntention(el: HTMLTextAreaElement | null): void {
        if (!el || el.offsetParent === null) return;
        el.style.height = 'auto';
        // + border widths: scrollHeight is content+padding only.
        el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
    }

    function applyTabSelection(active: MeditationType): void {
        root.querySelectorAll<HTMLElement>('.tab-bar .tab-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset['tab'] === active);
        });
        // Only the active tab's description: the full three-method text
        // overflows small screens. The tour steps through the tabs to cover all
        // three.
        root.querySelectorAll<HTMLElement>('#info-methods [data-method]').forEach((block) => {
            block.classList.toggle('hidden', block.dataset['method'] !== active);
        });
        for (const [mode, panelId] of MODE_PANELS) {
            root.querySelector(`#${panelId}`)?.classList.toggle('hidden', active !== mode);
        }
        // Now that the active panel is visible, its intention box can measure.
        if (active === 'exploration') {
            autosizeIntention(root.querySelector<HTMLTextAreaElement>('#intention'));
        } else if (active === 'felt_sense') {
            autosizeIntention(root.querySelector<HTMLTextAreaElement>('#felt-sense-intention'));
        }
    }

    /**
     * The `?` info buttons themselves need no wiring: tour/index-guide.ts
     * installs one delegated document-level handler for all
     * `.info-btn[data-info]` clicks (accordion toggle, suppressed while the
     * tour is running). Only the "Take the full tour" link is wired here.
     */
    function wireInfoButtons(): void {
        const guideLink = root.querySelector<HTMLAnchorElement>('#start-guide-link');
        if (guideLink) {
            guideLink.addEventListener('click', (e) => {
                e.preventDefault();
                // The tour walks every mode's tab, which a continuation locks.
                if (continuationMode() !== null) {
                    dropPendingContinue();
                    paintContinuation();
                }
                void resetGuide();
            });
        }
        wireCloudsExplainer(root, 'clouds-help');
    }

    // ---- Noting circle participants ----
    const MAX_PARTICIPANTS = 4;
    const REACTIVE_LEVELS: NotingReactive[] = ['none', 'low', 'high'];
    const REACTIVE_LABELS = ['None', 'Low', 'High'];

    function voiceNameFromId(id: string | null): string {
        const name = stripVoicePrefix(id);
        return name ? voiceLabel(name) : '';
    }
    function participantLabel(p: NotingParticipantConfig, index: number): string {
        if (p.type === 'sound') return t(notingSoundLabel(p.sound));
        return voiceNameFromId(p.voice ?? setup.voice) || t('Participant {n}', { n: index + 1 });
    }
    function newParticipant(type: NotingParticipantConfig['type']): NotingParticipantConfig {
        const timing = 'adaptive' as const;
        const fixedDelaySec = 4;
        if (type === 'sound') return { type, sound: 'crow', timing, fixedDelaySec };
        const voice = setup.voice; // resolved default voice (no bare "Default")
        if (type === 'fixed') return { type, voice, phrase: '', timing, fixedDelaySec };
        return { type, voice, reactive: 'low', timing, fixedDelaySec };
    }

    function renderParticipantList(): void {
        const listEl = root.querySelector<HTMLElement>('#participant-list');
        if (!listEl) return;
        const ps = setup.notingParticipants ?? [];

        listEl.innerHTML = ps
            .map((p, i) => {
                const reactiveIdx = p.type === 'llm' ? Math.max(0, REACTIVE_LEVELS.indexOf(p.reactive)) : 1;
                const voiceText = p.type !== 'sound' ? voiceNameFromId(p.voice ?? setup.voice) || t('Default') : t('Default');
                const soundLabel = p.type === 'sound' ? t(notingSoundLabel(p.sound)) : t('Crow');
                const phraseVal = p.type === 'fixed' ? p.phrase : '';
                const delayVal = p.fixedDelaySec || 4;
                return `<div class="participant-row" data-index="${i}">
                    <div class="participant-row-header">
                        <span class="participant-label">${escapeHtml(participantLabel(p, i))}</span>
                        <button type="button" class="participant-remove" title="${escapeHtml(t('Remove'))}" aria-label="${escapeHtml(t('Remove'))}">&times;</button>
                    </div>
                    <div class="participant-fields">
                        <div class="participant-field">
                            <label>${t('Type')}</label>
                            <select class="participant-type">
                                <option value="llm"${p.type === 'llm' ? ' selected' : ''}>${t('AI')}</option>
                                <option value="fixed"${p.type === 'fixed' ? ' selected' : ''}>${t('Fixed phrase')}</option>
                                <option value="sound"${p.type === 'sound' ? ' selected' : ''}>${t('Sound effect')}</option>
                            </select>
                        </div>
                        <div class="participant-field participant-voice-field${p.type === 'sound' ? ' hidden' : ''}">
                            <label>${t('Voice')}</label>
                            <button type="button" class="setup-voice-btn participant-voice-btn">${escapeHtml(voiceText)}</button>
                        </div>
                        <div class="participant-field">
                            <label>${t('Timing')}</label>
                            <select class="participant-timing">
                                <option value="adaptive"${p.timing === 'adaptive' ? ' selected' : ''}>${t('Adaptive')}</option>
                                <option value="fixed"${p.timing === 'fixed' ? ' selected' : ''}>${t('Fixed')}</option>
                            </select>
                        </div>
                        <div class="participant-field participant-delay-field${p.timing === 'fixed' ? '' : ' hidden'}">
                            <label>${t('Seconds')}</label>
                            <div class="stepper">
                                <button type="button" class="stepper-btn stepper-dec" aria-label="${escapeHtml(t('Decrease'))}">&minus;</button>
                                <input type="number" class="participant-delay stepper-value" value="${delayVal}" min="1" max="30" step="1">
                                <button type="button" class="stepper-btn stepper-inc" aria-label="${escapeHtml(t('Increase'))}">+</button>
                            </div>
                        </div>
                        <div class="participant-field participant-reactive-field${p.type === 'llm' ? '' : ' hidden'}">
                            <label>${t('Responsiveness')}</label>
                            <div class="reactive-slider-wrap">
                                <input type="range" class="participant-reactive slider-stops" min="0" max="2" value="${reactiveIdx}" step="1">
                                <span class="reactive-label">${t(REACTIVE_LABELS[reactiveIdx] ?? 'Low')}</span>
                            </div>
                        </div>
                        <div class="participant-field participant-phrase-field${p.type === 'fixed' ? '' : ' hidden'}">
                            <label>${t('Phrase')}</label>
                            <div class="phrase-input-wrap">
                                <input type="text" class="participant-phrase" placeholder="${escapeHtml(t('e.g. breathing'))}" maxlength="30" value="${escapeHtml(phraseVal)}">
                                <button type="button" class="participant-phrase-preview btn btn-secondary btn-small" title="${escapeHtml(t('Preview phrase'))}">&#9654;</button>
                            </div>
                        </div>
                        <div class="participant-field participant-sound-field${p.type === 'sound' ? '' : ' hidden'}">
                            <label>${t('Sound')}</label>
                            <div class="phrase-input-wrap">
                                <button type="button" class="btn btn-secondary btn-small participant-sound-btn sound-pick-btn">${escapeHtml(soundLabel)}</button>
                                <button type="button" class="participant-sound-preview btn btn-secondary btn-small" title="${escapeHtml(t('Play sound'))}" aria-label="${escapeHtml(t('Play sound'))}">&#9654;</button>
                            </div>
                        </div>
                    </div>
                </div>`;
            })
            .join('');

        listEl.querySelectorAll<HTMLElement>('.participant-row').forEach((row) => {
            const i = Number(row.dataset['index']);
            const ps2 = setup.notingParticipants ?? [];
            const p = ps2[i];
            if (!p) return;

            row.querySelector<HTMLSelectElement>('.participant-type')?.addEventListener('change', (e) => {
                ps2[i] = newParticipant((e.target as HTMLSelectElement).value as NotingParticipantConfig['type']);
                persist();
                renderParticipantList();
            });
            row.querySelector<HTMLButtonElement>('.participant-voice-btn')?.addEventListener('click', () => {
                if (p.type === 'sound') return;
                openVoiceModal({
                    current: () => p.voice ?? setup.voice,
                    onSelect: (id) => {
                        p.voice = id;
                        persist();
                        renderParticipantList();
                    },
                });
            });
            row.querySelector<HTMLSelectElement>('.participant-timing')?.addEventListener('change', (e) => {
                p.timing = (e.target as HTMLSelectElement).value as typeof p.timing;
                row.querySelector('.participant-delay-field')?.classList.toggle('hidden', p.timing !== 'fixed');
                persist();
            });
            const delayInput = row.querySelector<HTMLInputElement>('.participant-delay');
            const commitDelay = () => {
                const v = Math.max(1, Math.min(30, Number(delayInput?.value) || 4));
                if (delayInput) delayInput.value = String(v);
                p.fixedDelaySec = v;
                persist();
            };
            delayInput?.addEventListener('input', commitDelay);
            row.querySelector<HTMLButtonElement>('.stepper-dec')?.addEventListener('click', () => {
                if (delayInput) delayInput.value = String(Math.max(1, (Number(delayInput.value) || 0) - 1));
                commitDelay();
            });
            row.querySelector<HTMLButtonElement>('.stepper-inc')?.addEventListener('click', () => {
                if (delayInput) delayInput.value = String(Math.min(30, (Number(delayInput.value) || 0) + 1));
                commitDelay();
            });
            const reactive = row.querySelector<HTMLInputElement>('.participant-reactive');
            reactive?.addEventListener('input', () => {
                if (p.type !== 'llm') return;
                const idx = Number(reactive.value);
                p.reactive = REACTIVE_LEVELS[idx] ?? 'low';
                const lbl = row.querySelector('.reactive-label');
                if (lbl) lbl.textContent = t(REACTIVE_LABELS[idx] ?? 'Low');
                persist();
            });
            const phraseInput = row.querySelector<HTMLInputElement>('.participant-phrase');
            phraseInput?.addEventListener('input', () => {
                if (p.type === 'fixed') {
                    p.phrase = phraseInput.value;
                    persist();
                }
            });
            row.querySelector<HTMLButtonElement>('.participant-phrase-preview')?.addEventListener('click', () => {
                if (p.type !== 'fixed') return;
                void previewPhrase(phraseInput?.value.trim() || t('breathing'), p.voice ?? setup.voice);
            });
            row.querySelector<HTMLButtonElement>('.participant-sound-btn')?.addEventListener('click', () => {
                if (p.type !== 'sound') return;
                openSoundModal(
                    p.sound,
                    (name) => {
                        if (p.type !== 'sound') return;
                        p.sound = name as NotingSound | 'chime';
                        persist();
                        renderParticipantList();
                    },
                    { includeChime: true }
                );
            });
            row.querySelector<HTMLButtonElement>('.participant-sound-preview')?.addEventListener('click', () => {
                if (p.type === 'sound') previewSoundOrChime(p.sound);
            });
            row.querySelector<HTMLButtonElement>('.participant-remove')?.addEventListener('click', () => {
                ps2.splice(i, 1);
                persist();
                renderParticipantList();
                updateAddBtn();
            });
        });
        updateAddBtn();
        // Participant edits can flip whether an LLM is needed, which also
        // moves the estimate's model and narrator legs.
        updateBeginButton();
        updateAiNotes();
        updateSessionEstimate();
    }

    function updateAddBtn(): void {
        const addBtn = root.querySelector<HTMLButtonElement>('#add-participant-btn');
        if (addBtn) {
            addBtn.classList.toggle('hidden', (setup.notingParticipants?.length ?? 0) >= MAX_PARTICIPANTS);
        }
    }

    // ---- Sound picker modal (sound participants + the user-turn cue) ----
    function openSoundModal(
        current: string | null,
        onSelect: (name: string) => void,
        opts: { includeChime?: boolean } = {}
    ): void {
        const modal = root.querySelector<HTMLElement>('#sound-modal');
        const listEl = root.querySelector<HTMLElement>('#sound-modal-list');
        const closeBtn = root.querySelector<HTMLButtonElement>('#sound-modal-close');
        if (!modal || !listEl || !closeBtn) return;

        const names: string[] = opts.includeChime ? ['chime', ...NOTING_SOUNDS] : [...NOTING_SOUNDS];
        listEl.innerHTML = names
            .map(
                (name) => `<div class="voice-row${name === current ? ' selected' : ''}" data-sound-name="${name}">
                    <span class="voice-row-name">${t(notingSoundLabel(name))}</span>
                    ${name === current ? '<span class="voice-row-check">✓</span>' : ''}
                    <button type="button" class="voice-row-preview" data-sound="${name}" aria-label="${escapeHtml(t('Preview {name}', { name: t(notingSoundLabel(name)) }))}">${t('Preview')}</button>
                </div>`
            )
            .join('');
        modal.classList.remove('hidden');

        const onListClick = (e: MouseEvent) => {
            const t = e.target as HTMLElement;
            const prev = t.closest<HTMLElement>('.voice-row-preview');
            if (prev) {
                previewSoundOrChime(prev.dataset['sound'] || '');
                return;
            }
            const rowEl = t.closest<HTMLElement>('.voice-row');
            const name = rowEl?.dataset['soundName'];
            if (name) {
                onSelect(name);
                close();
            }
        };
        const close = () => {
            modal.classList.add('hidden');
            listEl.removeEventListener('click', onListClick);
            closeBtn.removeEventListener('click', close);
            offBackdrop();
        };
        listEl.addEventListener('click', onListClick);
        closeBtn.addEventListener('click', close);
        const offBackdrop = onBackdropClick(modal, close);
    }

    /** Called from the click, which is what lets the element play (primeSounds). */
    function previewSoundOrChime(name: string): void {
        primeSounds();
        if (!name || name === 'chime') playChime();
        else playCue(name);
    }

    async function previewPhrase(text: string, voiceId: string | null): Promise<void> {
        try {
            const { engine } = await createTtsForVoice(voiceId, {});
            await engine.speak(text, { rate: setup.ttsRate });
        } catch {
            /* preview optional */
        }
    }

    function wireNotingPanel(): void {
        const cue = root.querySelector<HTMLInputElement>('#user-turn-cue');
        if (cue) {
            cue.checked = setup.notingUserTurnCue;
            cue.addEventListener('change', () => {
                setup.notingUserTurnCue = cue.checked;
                persist();
            });
        }
        const cueSoundBtn = root.querySelector<HTMLButtonElement>('#user-turn-cue-sound-btn');
        if (cueSoundBtn) {
            const initial = setup.notingUserTurnCueSound ?? 'chime';
            cueSoundBtn.textContent = t(notingSoundLabel(initial));
            cueSoundBtn.dataset['sound'] = initial;
            cueSoundBtn.addEventListener('click', () => {
                openSoundModal(
                    setup.notingUserTurnCueSound ?? 'chime',
                    (name) => {
                        setup.notingUserTurnCueSound = name === 'chime' ? null : (name as NotingSound);
                        cueSoundBtn.textContent = t(notingSoundLabel(name));
                        cueSoundBtn.dataset['sound'] = name;
                        persist();
                    },
                    { includeChime: true }
                );
            });
        }
        const cueSoundPreview = root.querySelector<HTMLButtonElement>('#user-turn-cue-sound-preview');
        if (cueSoundPreview) {
            cueSoundPreview.addEventListener('click', () => {
                previewSoundOrChime(setup.notingUserTurnCueSound ?? 'chime');
            });
        }
        const addBtn = root.querySelector<HTMLButtonElement>('#add-participant-btn');
        if (addBtn) {
            addBtn.addEventListener('click', () => {
                if ((setup.notingParticipants?.length ?? 0) >= MAX_PARTICIPANTS) return;
                setup.notingParticipants.push(newParticipant('llm'));
                persist();
                renderParticipantList();
            });
        }
        renderParticipantList();
    }

    render();
    // Load any pending continuation (History "Continue" / cold-boot resume) once,
    // after the first render so its tab-select + banner paint hit a live DOM.
    // autoStart short-circuits when the user has already dismissed, completed,
    // or used the app; it follows the load so it knows whether to hold the card.
    void initPendingContinue().finally(
        () => void autoStartGuide(quickStart, continuationMode() !== null, tourVoice)
    );
    void loadVoiceCatalog();
    watchWhisper(sttSetupChoice());

    return {
        async show() {
            render();
            watchWhisper(
                root.querySelector<HTMLSelectElement>('#setup-stt-engine')?.value ??
                    sttSetupChoice()
            );
            await loadVoiceCatalog();
            void autoStartGuide(quickStart, continuationMode() !== null, tourVoice);
        },
        hide() {
            closeGuideIfActive();
            whisperUnwatch?.();
            whisperUnwatch = null;
            if (cloudUnwatch !== null) {
                cloudUnwatch();
                cloudUnwatch = null;
            }
            speaker.stop();
            root.innerHTML = '';
        },
        getSetup() { return setup; },
    };
}

/** How long the line just spoken stays on screen, and how long it then takes
 *  to fade (app-base.css .voice-start-note.leaving runs the same half second). */
const VOICE_NOTE_MS = 6000;
const VOICE_NOTE_FADE_MS = 500;

/** The note in the bar: the gap between it and the mic, the margin kept at
 *  the bar's left edge, and the least room worth using. */
const VOICE_NOTE_GAP_PX = 16;
const VOICE_NOTE_EDGE_PX = 16;
const VOICE_NOTE_MIN_ROOM_PX = 150;

/** Stands for what was heard in the translated `Heard "{text}"`, which
 *  showVoiceNote splits around it. */
const HEARD_SLOT = '\u0001';

/** The fields the app asks for out loud, the next thing said being the answer. */
type AskedField = 'intention' | 'special-request';

/** After "What is your intention?" (and "What's your request?"), how long the
 *  next thing heard is taken as the answer, and how long a pause ends that
 *  answer (base, max). */
const INTENTION_ANSWER_MS = 30_000;
const INTENTION_PAUSE_MS = [2000, 3500] as const;

/** How many times the mic opening on this screen says what it is for. */
const VOICE_HINT_KEY = 'aloud-setup-voice-hints';
const VOICE_HINT_TIMES = 3;
/** On those visits, how long a fresh mic may take to hear before the hint's
 *  place says it is opening. */
const MIC_OPENING_NOTE_AFTER_MS = 400;

/** After the app speaks, how long something heard may still be the end of its
 *  own line. A wireless speaker can run a second or two behind the page, and
 *  the recognizer takes another to hand over what it caught. The check is
 *  only ever the line's last few words, so the wait costs a real request
 *  almost nothing. */
const SETUP_ECHO_WINDOW_MS = 4000;

const MODE_PANELS: ReadonlyArray<readonly [MeditationType, string]> = [
    ['exploration', 'exploration-panel'],
    ['noting', 'noting-panel'],
    ['felt_sense', 'felt-sense-panel'],
];

/**
 * Say a stepped slider's position in the words drawn at its ends, which a
 * screen reader otherwise never hears: it reads a bare "2".
 */
function sayStop(slider: HTMLInputElement, low: string, high: string): void {
    slider.setAttribute('aria-valuetext', stopText(Number(slider.value), Number(slider.max), low, high));
}

/** The numbers drawn over a stepped slider's stops, which can be said
 *  ("guidance three"). Screen readers have the slider's own value text. */
function stopNumbersHTML(count: number): string {
    const numbers = Array.from({ length: count }, (_, i) => `<span>${i + 1}</span>`).join('');
    return `<div class="slider-numbers" aria-hidden="true">${numbers}</div>`;
}

/** Light the number the thumb sits on. */
function markStop(slider: HTMLInputElement): void {
    slider.parentElement
        ?.querySelectorAll('.slider-numbers > span')
        .forEach((n, i) => n.classList.toggle('is-current', i === Number(slider.value)));
}

/** `value` runs 0..max, so a slider has max + 1 stops; they are counted from 1. */
function stopText(value: number, max: number, low: string, high: string): string {
    if (value <= 0) return low;
    if (value >= max) return high;
    return t('{step} of {count}, between {low} and {high}', { step: value + 1, count: max + 1, low, high });
}

/**
 * Bring a just-opened disclosure into view, scrolling no further than it
 * takes: nothing when it already shows whole, to its foot when it fits the
 * screen, and to its top (its toggle) when it is taller. On a phone, and on
 * any screen zoomed to the phone layout, Customize opens under the fixed Begin
 * bar and bottom nav, where it looks like nothing happened.
 */
function revealOpened(section: HTMLElement): void {
    const rect = section.getBoundingClientRect();
    const over = rect.bottom - ((bottomBarsTop() ?? window.innerHeight) - 12);
    const top = Math.min(over, rect.top - getNavHeight());
    if (top <= 0) return;
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    window.scrollBy({ top, behavior: calm ? 'auto' : 'smooth' });
}

/** The focus / vibe grids: one checkbox card per option, grouped by `name`. */
function modifierTogglesHTML(
    name: string,
    items: ReadonlyArray<{ value: string; name: string; description: string }>
): string {
    return items
        .map(
            (item) => `
        <label class="modifier-toggle">
            <input type="checkbox" name="${name}" value="${item.value}">
            <div class="modifier-info">
                <span class="modifier-name">${escapeHtml(t(item.name))}</span>
                <span class="modifier-desc">${escapeHtml(t(item.description))}</span>
            </div>
        </label>`
        )
        .join('');
}

/**
 * The Session clock control, rendered once per mode panel. The face is filled
 * in during wiring (renderSetupHTML has no app settings), and every copy is
 * wired together (data-clock-btn), so the mode tabs stay in sync. `key` keeps
 * each copy's info panel a distinct id - toggleInfo resolves by getElementById,
 * so three panels named `info-clock` would all open the first one, in whichever
 * mode tab happens to be hidden.
 */
function renderClockButton(key: string): string {
    return `
        <div class="form-group setup-clock-group">
            <label>${t('Session Clock')} <button type="button" class="info-btn" data-info="clock-${key}" aria-label="${t('About the session clock')}">?</button></label>
            <div class="info-panel hidden" id="info-clock-${key}">
                <p>${t("A clock or a timer for the session. In Timer mode the facilitator reminds you once when time is nearly up, and again when it's up.")}</p>
                <p>${t("Hiding the readout doesn't disarm the timer; you still get the spoken close.")}</p>
            </div>
            <button type="button" class="setup-clock-btn" data-clock-btn>${t('Time in session')}</button>
        </div>`;
}

function renderSetupHTML(
    byokOpts: ProviderAvailabilityOpts,
    sttSelected: SttEngineChoice
): string {
    const sttSetupOptions = sttEngineOptions(isWebMode())
        .map(
            ({ value, label }) =>
                `<option value="${value}"${value === sttSelected ? ' selected' : ''}>${escapeHtml(t(label))}</option>`
        )
        .join('');

    const focusToggles = modifierTogglesHTML('focus', FOCUSES);
    const qualityToggles = modifierTogglesHTML('quality', QUALITIES);

    const dirTickCount = DIRECTIVENESS_VALUES.length - 1;
    const verbosityOptions = VERBOSITY_OPTIONS.map(
        (v) => `<option value="${v.value}">${escapeHtml(t(v.label))}</option>`
    ).join('');

    return `
    <div id="continue-banner" class="continue-banner hidden">
        <span id="continue-banner-text">${t('Continuing from a previous session')}</span>
        <button type="button" class="continue-banner-close" id="continue-cancel" aria-label="${t('Cancel continuation')}">&times;</button>
    </div>

    <div class="setup-header">
        <div class="tab-bar">
            <button type="button" class="tab-btn active" data-tab="exploration">${t('Exploration')}</button>
            <button type="button" class="tab-btn" data-tab="felt_sense">${t('Felt Sense')}</button>
            <button type="button" class="tab-btn" data-tab="noting">${t('Noting')}</button>
            <button type="button" class="info-btn" data-info="methods" aria-label="${t('About meditation methods')}">?</button>
        </div>
        <div class="info-panel hidden" id="info-methods">
            <div data-method="exploration">
                <p><strong>${t('Exploration')}</strong>: ${t('This is a dyadic meditation format where you speak about what you are experiencing in the moment and the facilitator asks brief questions to help you explore.')}</p>
                <p>${t("In this mode, you optionally set an intention and then mix and match <strong>attention focuses</strong> with <strong>vibes</strong> to build your own style. There's a guidance slider so you can dial in how actively it leads. In my personal experience, this sort of exploration has been helpful in experiencing jhana states if approached with enough openheartedness.")}</p>
                <p>${t('Thanks to')} <a href="https://lovingawakening.net/" target="_blank" rel="noopener">Maija Haavisto</a> ${t('and')} <a href="https://www.jhourney.io/" target="_blank" rel="noopener">Jhourney</a> ${t('for guiding me in similar practices.')}</p>
            </div>
            <div data-method="noting" class="hidden">
                <p><strong>${t('Noting')}</strong>: ${t('You specify what participants you\'d like, if any: AIs, fixed phrases, or sound effects. Then starting with you, each participant notes a sensation in their "awareness" (ideally 1&ndash;2 words) or plays their fixed phrase or sound. This process can be helpful to observe the mental and somatic processes that happen in the cycle of resting -&gt; hearing the cue -&gt; observing -&gt; speaking. If there are no other participants, it\'ll just briefly introduce the method and then record what you note.')}</p>
                <p>${t('Thanks to')} <a href="https://www.buddhistgeeks.org/" target="_blank" rel="noopener">Vince Horn</a> ${t('and again to')} <a href="https://www.jhourney.io/" target="_blank" rel="noopener">Jhourney</a> ${t('for inspiration.')}</p>
            </div>
            <div data-method="felt_sense" class="hidden">
                <p><strong>${t('Felt Sense')}</strong>: ${t('This mode follows a six step process: settling in, letting a vague body-sense of one thing form, finding words that fit it, checking them against the body, asking into it, and receiving whatever comes up. The facilitator keeps track of the steps; you talk and take your time.')}</p>
                <p>${t('Adapted from')} <a href="https://focusing.org/" target="_blank" rel="noopener">${t("Eugene Gendlin's Focusing")}</a>${t(', which deserves the credit for the method.')}</p>
            </div>
            <p class="info-panel-link"><a href="#" id="start-guide-link">${t('Take the full tour')} &rarr;</a></p>
        </div>
    </div>

    <form id="setup-form" class="setup-form setup-container">
        <div class="tab-panel" id="exploration-panel">
            <div class="form-group">
                <label for="intention">${t('Intention')} <span class="optional">${t('(optional)')}</span></label>
                <textarea id="intention" rows="2"
                    placeholder="${escapeHtml(t('e.g. just be present with sensations, drop the need to control, find something that feels good'))}"></textarea>
            </div>

            <div class="customize-section" id="customize-section">
                <button type="button" class="customize-toggle" id="customize-toggle"
                    aria-expanded="false" aria-controls="customize-body">
                    <span class="customize-toggle-label">${t('Customize facilitation')}</span>
                    <span class="customize-toggle-summary" id="customize-summary"></span>
                </button>
                <div class="customize-body" id="customize-body">
                    <div class="form-group">
                        <label>${t('Attention Focus')} <button type="button" class="info-btn" data-info="focus" aria-label="${t('About attention focus')}">?</button></label>
                        <div class="info-panel hidden" id="info-focus">
                            <p>${t('These let the facilitator know where you intend to place your attention.')}</p>
                            <p><strong>${t('Body &amp; sensations:')}</strong> ${t('Physical experience: texture, warmth, movement, pressure. Usually a good starting place.')}</p>
                            <p><strong>${t('Emotions &amp; feeling tone:')}</strong> ${t('More complex collections of sensations and labels - joy, anger, something unnamed.')}</p>
                            <p><strong>${t('Parts &amp; inner world:')}</strong> ${t('Different aspects of yourself that carry their own perspectives: protectors, younger parts, inner critics. Physical body parts can hold emotion as well.')}</p>
                            <p>${t('You can also select multiple, or leave all unchecked to keep things open.')}</p>
                            <p>${t('Some combinations to try: body &amp; emotions with playful and feeling good; emotions with loving and feeling good; parts with compassionate.')}</p>
                        </div>
                        <div class="modifier-toggles">${focusToggles}</div>
                    </div>

                    <div class="form-group">
                        <label>${t('Vibe')} <button type="button" class="info-btn" data-info="vibe" aria-label="${t('About vibes')}">?</button></label>
                        <div class="info-panel hidden" id="info-vibe">
                            <p>${t('Vibes color the tone of facilitation. Select any combination.')}</p>
                            <p>${t("<strong>Playful</strong> keeps it light. <strong>Spacious</strong> leans toward noticing what's already going on. <strong>Effortless</strong> is about letting go rather than trying.")}</p>
                            <p>${t('Pick whatever matches where you are today, or leave them all unchecked for a neutral tone.')}</p>
                        </div>
                        <div class="modifier-toggles">${qualityToggles}</div>
                    </div>
                </div>
            </div>

            <div class="setup-extras-row setup-extras-row-top">
                <details class="advanced-settings">
                    <summary>${t('Special requests')}<span class="requests-dot" aria-hidden="true"></span><span class="requests-preview"></span></summary>
                    <div class="form-group">
                        <textarea id="custom-instructions" rows="3"
                            placeholder="${escapeHtml(t("e.g. keep it slow, don't mention breathing"))}"></textarea>
                    </div>
                </details>
                <div class="form-group setup-guidance-group">
                    <label for="directiveness">${t('Guidance Level')} <button type="button" class="info-btn" data-info="guidance" aria-label="${t('About guidance level')}">?</button></label>
                    <div class="info-panel hidden" id="info-guidance">
                        <p>${t('How actively the facilitator leads. Low end biases towards reflection or open questions; higher end toward direction and suggestions.')}</p>
                        <p>${t('If <a href="#" data-nav="settings" data-nav-anchor="settings-checkins"><strong>check-ins</strong></a> in Settings are set to Smart, this also affects how frequently the facilitator speaks during silence. ~12 minutes on low, <1 min on high.')}</p>
                    </div>
                    <!-- Named here: the label's own name takes in its "?" button. -->
                    <div class="slider-numbered">
                        <input type="range" id="directiveness" class="slider-stops" min="0" max="${dirTickCount}" step="1" value="2" aria-label="${escapeHtml(t('Guidance Level'))}">
                        ${stopNumbersHTML(dirTickCount + 1)}
                    </div>
                    <div class="range-labels">
                        <span>${t('Following')}</span>
                        <span>${t('Directing')}</span>
                    </div>
                </div>
            </div>

            <div class="form-row form-row-thirds">
                ${renderClockButton('exploration')}
                <div class="form-group">
                    <label for="verbosity">${t('Response Length')}</label>
                    <select id="verbosity">${verbosityOptions}</select>
                </div>
                <div class="form-group">
                    <label>${t('Voice')}</label>
                    <button type="button" id="setup-voice-btn" class="setup-voice-btn" data-default-voice>${t('Default')}</button>
                    <div id="setup-no-voices" class="no-voices-banner inline hidden" role="alert" data-no-voices>
                        <p>${t('No speech voices found.')} <a href="#" data-nav="settings" data-nav-anchor="settings-tts">${t('Set up TTS in Settings')}</a>.</p>
                    </div>
                </div>
            </div>
        </div>

        <div class="tab-panel hidden" id="noting-panel">
            <div class="form-group">
                <label>${t('Participants')}</label>
                <div id="participant-list"></div>
                <button type="button" id="add-participant-btn" class="btn btn-secondary btn-small"
                    title="${escapeHtml(t('Add another participant to the noting circle (up to 4)'))}">${t('+ Add participant')}</button>
            </div>

            <div class="setup-extras-row">
                <div class="noting-option-row">
                    <label class="noting-option">
                        <input type="checkbox" id="user-turn-cue">
                        <span>${t('Play a sound on your turn')}</span>
                    </label>
                    <div class="noting-option-sound">
                        <button type="button" id="user-turn-cue-sound-btn" class="btn btn-secondary btn-small sound-pick-btn" data-sound="chime">${t('Chime')}</button>
                        <button type="button" id="user-turn-cue-sound-preview" class="participant-sound-preview btn btn-secondary btn-small" title="${escapeHtml(t('Play sound'))}" aria-label="${escapeHtml(t('Play sound'))}">&#9654;</button>
                    </div>
                </div>
                <!-- The session's voice, as on the other tabs: in a circle it
                     reads the opener (and the timer's notices). -->
                <div class="form-group">
                    <label>${t('Introduction voice')}</label>
                    <button type="button" id="noting-voice-btn" class="setup-voice-btn" data-default-voice>${t('Default')}</button>
                    <div class="no-voices-banner inline hidden" role="alert" data-no-voices>
                        <p>${t('No speech voices found.')} <a href="#" data-nav="settings" data-nav-anchor="settings-tts">${t('Set up TTS in Settings')}</a>.</p>
                    </div>
                </div>
                ${renderClockButton('noting')}
            </div>
        </div>

        <div class="tab-panel hidden" id="felt-sense-panel">
            <div class="form-group">
                <label for="felt-sense-intention">${t('Something to sit with')} <span class="optional">${t('(optional)')}</span></label>
                <textarea id="felt-sense-intention" rows="2"
                    placeholder="${escapeHtml(t('e.g. the job decision, a conversation yesterday, this restless feeling lately...'))}"></textarea>
            </div>

            <div class="form-row form-row-thirds" id="felt-sense-voice-row">
                <div class="form-group">
                    <label class="checkin-pace-label" for="checkin-enabled">
                        <input type="checkbox" id="checkin-enabled" checked>${t("Check in if I'm quiet")}</label>
                    <div class="slider-control" id="checkin-pace-control">
                        <div class="slider-numbered">
                            <input type="range" id="checkin-pace" class="slider-stops" min="0" max="${dirTickCount}" step="1" value="1" aria-label="${escapeHtml(t('Check-in pace'))}">
                            ${stopNumbersHTML(dirTickCount + 1)}
                        </div>
                        <div class="range-labels">
                            <span>${t('Patient')}</span>
                            <span>${t('Attentive')}</span>
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <label>${t('Voice')}</label>
                    <button type="button" id="felt-sense-voice-btn" class="setup-voice-btn" data-default-voice>${t('Default')}</button>
                    <div class="no-voices-banner inline hidden" role="alert" data-no-voices>
                        <p>${t('No speech voices found.')} <a href="#" data-nav="settings" data-nav-anchor="settings-tts">${t('Set up TTS in Settings')}</a>.</p>
                    </div>
                </div>
                ${renderClockButton('felt-sense')}
            </div>
        </div>

        <div class="form-row form-row-thirds" id="ai-shared-row">
            <div class="form-group" id="ai-provider-group">
                <label for="provider">${t('AI Provider')}</label>
                <select id="provider">
                    ${ALL_PROVIDERS.filter((p) => isProviderAvailable(p, capabilitiesSync(), byokOpts))
                        .map(
                            (p) =>
                                `<option value="${p.value}">${escapeHtml(t(p.label))}</option>`
                        )
                        .join('')}
                </select>
            </div>
            <div class="form-group" id="ai-model-group">
                <label for="model-select">${t('Model')}</label>
                <div id="model-picker-slot"></div>
            </div>
            <div class="form-group" id="setup-stt-group">
                <label for="setup-stt-engine">${t('Speech Recognition')}</label>
                <select id="setup-stt-engine">${sttSetupOptions}</select>
                <!-- Phone-only by construction: 'capacitor' is offered nowhere
                     else (sttEngineOptions). A free pick in a facilitated mode:
                     say what it costs in accuracy before the session rather
                     than after (syncSttPicker shows it). -->
                <p id="setup-stt-quality-note" class="credit-rate-legend hidden">
                    ${t("Quality varies by device, and speaking won't interrupt the facilitator. aloud cloud is recommended.")}
                </p>
                <p id="setup-stt-iphone-note" class="credit-rate-legend hidden">
                    ${t("On iOS, speaking interrupts the facilitator only with headphones. We hope to fix this before launch.")}
                </p>
            </div>
        </div>
        <!-- No-mic notice. Painted by probeMic() only when it's certain (it
             never prompts, so it stays silent on browsers that hide the answer);
             Begin's acquireMicOnce is the definitive check. -->
        <div id="setup-no-mic" class="no-voices-banner inline hidden" role="alert">
            <p id="setup-no-mic-text"></p>
        </div>
        <div id="setup-whisper-wait" class="no-voices-banner inline hidden" role="status">
            <p id="setup-whisper-wait-text"></p>
        </div>
        <p class="credit-rate-legend" id="noting-spend-note">${t('Noting mode uses fewer ☁. Participants speak brief labels, not full sentences.')}</p>

        <p id="ai-inactive-note" class="credit-rate-legend hidden">${t("No AI participants in this circle, so the AI model isn't used.")}</p>

        <div id="provider-hint" class="provider-hint hidden"></div>

    </form>

    ${renderVoiceModalHTML({
        modalId: 'setup-voice-modal',
        closeId: 'setup-voice-modal-close',
        listId: 'setup-voice-modal-list',
        speedSliderId: 'setup-speed-slider',
        speedLabelId: 'setup-speed-label',
        speedValue: 110,
    })}

    <!-- Sound picker (sound participants + the user-turn cue). Reuses the
         voice-modal chrome and .voice-row list styling. -->
    <div class="voice-modal-overlay hidden" id="sound-modal">
        <div class="voice-modal">
            <div class="voice-modal-header">
                <span class="voice-modal-title">${t('Choose a sound')}</span>
                <button type="button" class="voice-modal-close" id="sound-modal-close" aria-label="${escapeHtml(t('Close'))}">&times;</button>
            </div>
            <div class="voice-modal-list" id="sound-modal-list"></div>
        </div>
    </div>

    <!-- A sibling of the form, so position: fixed anchors it to the viewport
         bottom; the inner wrapper caps width so Begin doesn't span wide
         screens. -->
    <div class="setup-footer">
        <div class="setup-footer-inner">
            <!-- The line just spoken in answer to a request made by voice,
                 floated above the bar (out of flow, like the mic). Wraps
                 Begin so the mic that listens on this screen
                 (voice-start.ts) can hang off its left edge without taking
                 a place in the row: Begin stays centered and the bar keeps
                 its height. Lit while it listens, unlit while asleep,
                 slashed when voice mode is off (paintVoiceMic). -->
            <p id="voice-start-note" class="voice-start-note hidden" role="status" aria-live="polite"></p>
            <div class="begin-wrap">
                <!-- Voice mode: a mic that also speaks (it listens, and the
                     setup screen talks back). The gap under the slash is
                     drawn in the button's own colour, to cut the glyph. -->
                <button id="voice-start-mic" type="button" class="btn btn-voice voice-start-mic hidden" data-tour-live>
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M8 2a3 3 0 0 0-3 3v5a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"></path>
                        <path d="M2 10v1a6 6 0 0 0 12 0v-1M8 17v4M5 21h6"></path>
                        <path class="voice-waves" d="M17 5.5a4.5 4.5 0 0 1 0 6.5M20 2.5a8.6 8.6 0 0 1 0 12.5"></path>
                        <path class="voice-sleep" d="M16.5 10.5h4l-4 4h4M18 1h5l-5 5.5h5"></path>
                        <line class="mute-gap" x1="3" y1="3" x2="21" y2="21"></line>
                        <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                    </svg>
                </button>
                <button id="begin-btn" type="button" class="btn btn-primary btn-begin">${t('Begin Session')}</button>
            </div>
        </div>
        <!-- The session's cloud-rate estimate, and the way into the "what are
             ☁?" explainer. Absolutely positioned so Begin keeps its centered
             column; hidden when beginning would spend nothing
             (updateSessionEstimate). The "?" carries the button's name: an
             aria-label on the button itself would hide the rate from a
             screen reader. -->
        <button type="button" class="clouds-help hidden" id="clouds-help" title="${escapeHtml(t('What are ☁?'))}">
            <span id="session-estimate"></span>
            <span class="info-btn-glyph" role="img" aria-label="${escapeHtml(t('What are clouds?'))}">?</span>
        </button>
    </div>`;
}

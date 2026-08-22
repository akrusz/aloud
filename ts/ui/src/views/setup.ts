/**
 * Setup view - pre-session configuration.
 *
 * Three mode tabs (exploration / noting / felt sense) over a shared
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
import {
    buildScoredVoiceList,
    downloadPercent,
    downloadVoiceModel,
    fetchServerVoices,
    fetchCloudVoices,
    invalidateServerVoicesCache,
    prefixedVoiceId,
    previewVoice as runPreview,
    previewErrorMessage,
    renderVoiceList,
    renderVoiceModalHTML,
    setModelDownloadsDisabled,
    stopPreview,
    updateVoiceSelection,
    type ScoredVoice,
    type ServerVoice,
} from '../voice-picker.js';
import { rateBadge, MODE_RATE_MULTIPLIER, withCloudOutline } from '../credit-rate.js';
import { fetchMe } from '../cloud-auth.js';
import { getRetreatCovered } from '../cloud-coverage.js';
import { createTtsForVoice } from '../adapters/tts-picker.js';
import { mountModelPicker, cloudUtilityCreditsPerHour } from '../model-picker.js';
import { assetPath } from '../route-base.js';
import { hasApiKey } from '../api-keys.js';
import {
    sttEngineOptions,
    resolveSttChoice,
    sttBackendForChoice,
    cloudSttCreditsPerHour,
} from '../adapters/stt-picker.js';
import { probeMic, describeMicRequirement, type MicStatus } from '../mic-check.js';
import { sessionStore } from '../state.js';
import { clearActiveSession } from '../active-session.js';
import { showResumeModal } from '../resume-modal.js';
import { detectCapabilities, capabilitiesSync, watchCloudReachable } from '../capabilities.js';
import { isWebMode } from '../app-mode.js';
import { appUrl } from '../app-base.js';
import {
    computeProviderMarker,
    stripMarker,
    type ProviderStatusMap,
} from '../provider-markers.js';
import { alertDialog } from '../dialog.js';
import { wireCloudsExplainer } from '../clouds-explainer.js';
import { loadAppSettings, saveAppSettings, type SttEngineChoice } from '../app-settings.js';
import { clockModeLabel, showSessionClockModal } from '../session-clock.js';
import {
    autoStart as autoStartGuide,
    closeIfActive as closeGuideIfActive,
    resetAndStart as resetGuide,
} from '../tour/index-guide.js';

const FOCUSES: ReadonlyArray<{ value: Focus; name: string; description: string }> = [
    {
        value: 'body_sensations',
        name: FOCUS_LABELS.body_sensations,
        description: 'Physical experience: texture, temperature, movement',
    },
    {
        value: 'emotions',
        name: FOCUS_LABELS.emotions,
        description: 'Emotional landscape, warmth, what’s alive underneath',
    },
    {
        value: 'inner_parts',
        name: FOCUS_LABELS.inner_parts,
        description: 'Inner parts, protectors, body parts, speaking to/as parts',
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
        description: 'Meeting what arises with care, tenderness, gentleness',
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

/** Human mode name for the resume banner ("felt sense", "exploration", ...). */
function resumeModeLabel(state: SessionState): string {
    const labels: Record<string, string> = {
        exploration: 'Exploration',
        noting: 'Noting',
        felt_sense: 'Felt sense',
    };
    return labels[state.meditationType ?? ''] ?? 'Session';
}

/** "felt sense · 12 min in" - mode + elapsed for the resume banner. endTime is
 *  the last autosave stamp, so it approximates where the session was cut off. */
function resumeBannerDetail(state: SessionState): string {
    const end = state.endTime ?? Math.floor(state.startTime);
    const mins = Math.max(1, Math.round((end - state.startTime) / 60));
    return `${resumeModeLabel(state)} · ${mins} min in`;
}

export async function mountSetupView(
    root: HTMLElement,
    onBegin: (setup: SessionSetup, continueFrom: SessionState | null) => void
): Promise<SetupViewHandle> {
    const setup = await loadSetup();
    // Before first render so the provider menu shows only what's reachable
    // (also populates the is-desktop cache the env-var hints read).
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
    // Edits the app-level default, same as the Voice control. The select itself
    // is built in renderSetupHTML.
    const sttSetupSelected = resolveSttChoice(appSettings.sttEngine, isWebMode());
    // Warm the Silero VAD while the user configures: whisper-pcm's prime()
    // awaits the same app-lifetime singleton, so the multi-MB download is
    // usually done by the time they click Begin. web-speech and capacitor never
    // load the model.
    if (sttBackendForChoice(sttSetupSelected) === 'server-whisper') {
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
    // Lazy-loaded; the setup form is interactive while voices fetch.
    let scoredVoices: ScoredVoice[] = [];

    // A pending continuation: a History "Continue" (reason 'history') or a
    // cold-boot resume (reason 'resume', meditation-pal-v73p). The history view /
    // boot seeder writes it to sessionStorage and routes here; initPendingContinue
    // loads it once. The banner tracks whether the selected mode still matches it,
    // and Begin follows the selected tab - resume on the paused mode, fresh
    // otherwise (see the Begin handler). The banner stays in the DOM at a constant
    // height throughout, so switching tabs never shifts the layout.
    let pendingContinue: { state: SessionState; reason: 'resume' | 'history' } | null = null;

    function clearContinueStorage(): void {
        if (typeof sessionStorage === 'undefined') return;
        sessionStorage.removeItem('continueFrom');
        sessionStorage.removeItem('continueFromSummary');
        sessionStorage.removeItem('continueReason');
    }

    // Drop the offer entirely: on ✕, or when Begin commits to a fresh session in a
    // different mode. Clears the handoff and, for a cold-boot resume, the durable
    // pointer so the next launch doesn't re-offer it.
    function dropPendingContinue(): void {
        const wasResume = pendingContinue?.reason === 'resume';
        pendingContinue = null;
        clearContinueStorage();
        if (wasResume) void clearActiveSession();
    }

    // Paint the inline banner from the in-memory pendingContinue. This banner is
    // ONLY for a History "Continue" (reason 'history') - a cold-boot resume uses
    // the modal instead, so it never paints here.
    function updateContinueBanner(): void {
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
        text.textContent = `Continuing from: ${summary}`;
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
                    onBegin(setup, resumed);
                },
                onStartFresh: () => dropPendingContinue(),
            });
            return;
        }

        pendingContinue = { state, reason };
        const t = state.meditationType;
        if (
            (t === 'exploration' || t === 'noting' || t === 'felt_sense') &&
            t !== setup.meditationType
        ) {
            selectMode(t); // repaints tabs + banner
        } else {
            updateContinueBanner();
        }
    }

    // Select a meditation mode (from a tab tap or the banner's "Switch back"),
    // keeping the banner and dependent copy/estimates in sync.
    function selectMode(tab: MeditationType): void {
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
            updateSessionEstimate();
        }
        updateContinueBanner();
    }

    function persist(): void {
        void saveSetup(setup);
    }

    /**
     * Voice + rate are app-level defaults, not per-session state (see loadSetup
     * in settings.ts): this picker edits the same global default the Settings
     * page does, so changes propagate to every session. Callers keep the
     * in-memory `setup` in sync for the live form, then write through here.
     */
    async function persistDefaultVoice(voice: string | null, rate: number): Promise<void> {
        const s = await loadAppSettings();
        await saveAppSettings({ ...s, defaultVoice: voice, defaultTtsRate: rate });
    }

    /**
     * Score voices from `/app/v1/voices`, aloud cloud, and the browser's
     * speechSynthesis into scoredVoices. Browser voices are included because
     * preview can drive browser TTS; server voices win any name collision.
     */
    async function loadVoiceCatalog(): Promise<void> {
        // speechSynthesis often loads its list async on first call.
        if (
            typeof speechSynthesis !== 'undefined' &&
            speechSynthesis.getVoices().length === 0
        ) {
            await new Promise<void>((resolve) => {
                const done = () => {
                    speechSynthesis.removeEventListener('voiceschanged', done);
                    resolve();
                };
                speechSynthesis.addEventListener('voiceschanged', done);
                setTimeout(done, 600);
            });
        }
        const [server, hosted] = await Promise.all([fetchServerVoices(), fetchCloudVoices()]);
        scoredVoices = buildScoredVoiceList(server, true, hosted);
        // Never leave the picker on a bare "Default": take the best (list is
        // sorted best-first) voice that doesn't need downloading.
        if (!stripVoicePrefix(setup.voice)) {
            const top = scoredVoices.find((v) => !v.needsDownload);
            if (top) {
                setup.voice = prefixedVoiceId(top.engine, top.name);
                void persistDefaultVoice(setup.voice, setup.ttsRate);
            }
        }
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
    // Wired to the mounted picker so the cloud-reachability watcher can repopulate it
    // once aloud cloud is up.
    let refreshModelPicker: (provider: string) => void = () => {};
    // Cloud-wake watcher unsubscribe (web/mobile only). Called on hide so a
    // pending wait doesn't fire into a torn-down view.
    let cloudUnwatch: (() => void) | null = null;

    function updateVoiceButtonLabel(): void {
        // One button per tab panel (exploration + felt sense), all painting the
        // same app-level default voice.
        const btns = root.querySelectorAll<HTMLButtonElement>('[data-default-voice]');
        if (btns.length === 0) return;
        const selectedName = stripVoicePrefix(setup.voice);
        const entry = findVoice(selectedName);
        // Show a cloud voice's ☁️ rate on the collapsed button too, so a paid
        // pick reads as paid without opening the picker.
        const rate = entry ? rateBadge(entry.creditsPerHour) : '';
        const ratePart = rate ? ` · ${rate}` : '';
        let text: string;
        if (entry) {
            text = `${entry.name}${ratePart} · ${setup.ttsRate} wpm`;
        } else if (selectedName) {
            // Voice id is stored but we haven't loaded its details yet.
            text = `${selectedName} · ${setup.ttsRate} wpm`;
        } else {
            text = scoredVoices.length > 0 ? 'Default' : 'Voice';
        }
        // innerHTML so a paid pick's ☁️ badge gets the legibility outline;
        // voice names are catalog data, so escape before wrapping.
        for (const btn of btns) btn.innerHTML = withCloudOutline(escapeAttr(text));
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
        // The footer's "what are ☁️?" help button rides the estimate's
        // visibility: it only explains badges/spend that exist when something
        // on the page costs credits.
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
        const sttChoice = sttSel?.value ?? sttSetupSelected;

        const llm = setup.provider === 'aloud' ? getModelRate() : 0;
        const stt = cloudSttCreditsPerHour(sttChoice as SttEngineChoice);
        const tts = findVoice(stripVoicePrefix(setup.voice))?.creditsPerHour ?? 0;
        // The background-assistant leg (classifiers, summaries, recap) rides
        // every aloud-cloud session on top of the picked model's badge - so the
        // pill runs a touch above the badges' sum, which its title explains.
        // Outside the mode multiplier: noting leans on it MORE, not less.
        const util = setup.provider === 'aloud' ? cloudUtilityCreditsPerHour() : 0;
        // Noting mode burns far less than the exploration-calibrated legs imply.
        const total = (llm + stt + tts) * (MODE_RATE_MULTIPLIER[setup.meditationType] ?? 1) + util;

        // All-local/BYOK: hide the pill rather than show a bare "0☁️".
        if (total <= 0) {
            el.classList.add('hidden');
            el.innerHTML = '';
            setCloudUi(false);
            return;
        }
        el.classList.remove('hidden');
        setCloudUi(true);
        const rate = `≈${rateBadge(total)}/hr`;
        el.title = util > 0
            ? 'Rough estimate. Includes a small background model for summaries and quick decisions, so it can sit above the badges combined.'
            : 'Rough estimate; varies with how much is said.';
        // Outline each ☁️ (emoji ignore text-stroke, and the light cloud washes
        // out on the white pill). Content is our own numbers + fixed words, safe.
        el.innerHTML = withCloudOutline(rate);
    }

    /**
     * Open the shared voice picker. With no target it edits setup.voice (the
     * narrator voice); pass a target to edit a noting participant's voice.
     * Wiring lives inline because render() would blow the modal away with the
     * rest of the form.
     */
    function openVoiceModal(target?: {
        current: () => string | null;
        onSelect: (voiceId: string) => void;
    }): void {
        const modal = root.querySelector<HTMLElement>('#setup-voice-modal');
        const listEl = root.querySelector<HTMLElement>('#setup-voice-modal-list');
        const closeBtn = root.querySelector<HTMLButtonElement>('#setup-voice-modal-close');
        const speedSlider = root.querySelector<HTMLInputElement>('#setup-speed-slider');
        const speedLabel = root.querySelector<HTMLElement>('#setup-speed-label');
        if (!modal || !listEl || !closeBtn || !speedSlider || !speedLabel) return;

        const currentName = stripVoicePrefix(target ? target.current() : setup.voice);
        renderVoiceList(listEl, scoredVoices, currentName, { showEngine: true });
        speedSlider.value = String(setup.ttsRate);
        speedLabel.textContent = `${setup.ttsRate} wpm`;
        modal.classList.remove('hidden');

        const onListClick = (e: MouseEvent) => {
            const target2 = e.target as HTMLElement;
            const row = target2.closest<HTMLElement>('.voice-row');
            if (!row) return;
            const name = row.dataset['voiceName'];
            if (!name) return;
            // Stream the Piper model down with live percent, then re-render so
            // the voice (and any model-sharing speakers) unlock.
            const downloadBtn = target2.closest<HTMLButtonElement>('.voice-row-download');
            if (downloadBtn) {
                e.preventDefault();
                const entry = findVoice(name);
                const model = row.dataset['model'];
                void (async () => {
                    const original = downloadBtn.textContent;
                    downloadBtn.disabled = true;
                    downloadBtn.textContent = '0%';
                    // Lock sibling speakers (same shared .onnx) while downloading.
                    setModelDownloadsDisabled(listEl, model, true, downloadBtn);
                    try {
                        await downloadVoiceModel(name, entry?.engine, (p) => {
                            downloadBtn.textContent = `${downloadPercent(p)}%`;
                        });
                    } catch (err) {
                        downloadBtn.disabled = false;
                        downloadBtn.textContent = original ?? 'Download';
                        setModelDownloadsDisabled(listEl, model, false, downloadBtn);
                        void alertDialog(`Could not download: ${(err as Error).message}`);
                        return;
                    }
                    invalidateServerVoicesCache();
                    await loadVoiceCatalog();
                    renderVoiceList(listEl, scoredVoices, currentName, { showEngine: true });
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
            speedLabel.textContent = `${rate} wpm`;
            void persistDefaultVoice(setup.voice, setup.ttsRate);
            updateVoiceButtonLabel();
        };
        const closeModal = () => {
            modal.classList.add('hidden');
            stopPreview();
            listEl.removeEventListener('click', onListClick);
            speedSlider.removeEventListener('input', onSpeedInput);
            closeBtn.removeEventListener('click', closeModal);
            modal.removeEventListener('click', onBackdrop);
        };
        const onBackdrop = (e: MouseEvent) => {
            // Click on the overlay (but not the inner panel) closes.
            if (e.target === modal) closeModal();
        };

        listEl.addEventListener('click', onListClick);
        speedSlider.addEventListener('input', onSpeedInput);
        closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', onBackdrop);
    }

    function render(): void {
        root.innerHTML = renderSetupHTML(byokOpts, sttSetupSelected);
        wireTabBar();
        wireInfoButtons();
        wireNotingPanel();

        // Exploration's "intention" and felt sense's "something to sit with"
        // are different inputs, so each textarea binds to its own
        // intentionByMode slot. setup.intention mirrors the ACTIVE mode's value
        // so sessions/prompts downstream stay single-field.
        const intentionEl = root.querySelector<HTMLTextAreaElement>('#intention')!;
        const feltIntentionEl = root.querySelector<HTMLTextAreaElement>('#felt-sense-intention')!;
        const intentionFields: Array<[HTMLTextAreaElement, MeditationType]> = [
            [intentionEl, 'exploration'],
            [feltIntentionEl, 'felt_sense'],
        ];
        for (const [el, mode] of intentionFields) {
            el.value = setup.intentionByMode[mode] ?? '';
            autosizeIntention(el);
            el.addEventListener('input', () => {
                setup.intentionByMode[mode] = el.value;
                if (setup.meditationType === mode) setup.intention = el.value;
                persist();
                autosizeIntention(el);
            });
        }

        // "Customize facilitator" disclosure. On phones the focus + vibe grids
        // are most of the page's scroll, so they collapse behind this toggle;
        // on desktop CSS hides the toggle and always shows the body.
        const customizeSection = root.querySelector<HTMLElement>('#customize-section');
        const customizeToggle = root.querySelector<HTMLButtonElement>('#customize-toggle');
        customizeToggle?.addEventListener('click', () => {
            const open = customizeSection?.classList.toggle('open') ?? false;
            customizeToggle.setAttribute('aria-expanded', String(open));
        });
        // The collapsed toggle still shows what's active, so persisted picks
        // from a previous session aren't invisible.
        function updateCustomizeSummary(): void {
            const el = root.querySelector<HTMLElement>('#customize-summary');
            if (!el) return;
            const names = [
                ...setup.focuses.map((f) => FOCUS_LABELS[f]),
                ...setup.qualities.map((q) => QUALITY_LABELS[q]),
            ].filter(Boolean);
            el.textContent = names.join(', ');
        }
        updateCustomizeSummary();

        // Focus checkboxes
        root.querySelectorAll<HTMLInputElement>('input[name="focus"]').forEach((cb) => {
            cb.checked = setup.focuses.includes(cb.value as Focus);
            cb.addEventListener('change', () => {
                const value = cb.value as Focus;
                setup.focuses = cb.checked
                    ? [...setup.focuses, value]
                    : setup.focuses.filter((f) => f !== value);
                persist();
                updateCustomizeSummary();
                cb.closest('.modifier-toggle')!.classList.toggle('selected', cb.checked);
            });
        });

        // Quality checkboxes
        root.querySelectorAll<HTMLInputElement>('input[name="quality"]').forEach((cb) => {
            cb.checked = setup.qualities.includes(cb.value as Quality);
            cb.addEventListener('change', () => {
                const value = cb.value as Quality;
                setup.qualities = cb.checked
                    ? [...setup.qualities, value]
                    : setup.qualities.filter((q) => q !== value);
                persist();
                updateCustomizeSummary();
                cb.closest('.modifier-toggle')!.classList.toggle('selected', cb.checked);
            });
        });

        // Directiveness
        const dirSlider = root.querySelector<HTMLInputElement>('#directiveness')!;
        dirSlider.value = String(setup.dirStep);
        dirSlider.addEventListener('input', () => {
            setup.dirStep = Number(dirSlider.value);
            persist();
        });

        // Felt-sense check-in pace: same stops as the guidance slider, its own
        // stored value, timing only (SessionSetup.feltSensePaceStep).
        const paceSlider = root.querySelector<HTMLInputElement>('#checkin-pace')!;
        paceSlider.value = String(setup.feltSensePaceStep);
        paceSlider.addEventListener('input', () => {
            setup.feltSensePaceStep = Number(paceSlider.value);
            persist();
        });
        // Felt sense owns whether silence check-ins happen at all, rather than
        // deferring to the Settings-page Check-In Timing radio (unreachable from
        // here). Off greys the pace slider out.
        const checkinToggle = root.querySelector<HTMLInputElement>('#checkin-enabled')!;
        const paceControl = root.querySelector<HTMLElement>('#checkin-pace-control')!;
        function syncCheckinToggle(): void {
            checkinToggle.checked = setup.feltSenseCheckins;
            paceControl.classList.toggle('is-disabled', !setup.feltSenseCheckins);
            paceSlider.disabled = !setup.feltSenseCheckins;
        }
        syncCheckinToggle();
        checkinToggle.addEventListener('change', () => {
            setup.feltSenseCheckins = checkinToggle.checked;
            syncCheckinToggle();
            persist();
        });

        // Verbosity
        const verbositySel = root.querySelector<HTMLSelectElement>('#verbosity')!;
        verbositySel.value = setup.verbosity;
        verbositySel.addEventListener('change', () => {
            setup.verbosity = verbositySel.value as Verbosity;
            persist();
        });

        // Custom instructions
        const customEl = root.querySelector<HTMLTextAreaElement>('#custom-instructions')!;
        customEl.value = setup.customInstructions;
        customEl.addEventListener('input', () => {
            setup.customInstructions = customEl.value;
            persist();
        });

        // Session clock. One control per mode panel, all showing the same
        // app-level choice: picking a 20 minute timer under Exploration and
        // then switching to Felt Sense keeps the timer.
        const clockBtns = [...root.querySelectorAll<HTMLButtonElement>('[data-clock-btn]')];
        function paintClockBtns(): void {
            const face = clockModeLabel(
                appSettings.sessionClockMode,
                appSettings.sessionTimerMin,
                appSettings.showSessionClock
            );
            for (const b of clockBtns) b.textContent = face;
        }
        paintClockBtns();
        for (const btn of clockBtns) {
            btn.addEventListener('click', () => {
                void showSessionClockModal({
                    mode: appSettings.sessionClockMode,
                    timerMin: appSettings.sessionTimerMin,
                    showClock: appSettings.showSessionClock,
                    endOnComplete: appSettings.endSessionOnTimer,
                }).then((choice) => {
                    if (!choice) return;
                    appSettings.sessionClockMode = choice.mode;
                    appSettings.sessionTimerMin = choice.timerMin;
                    appSettings.showSessionClock = choice.showClock;
                    appSettings.endSessionOnTimer = choice.endOnComplete;
                    paintClockBtns();
                    // Re-read before writing, like the voice control: another
                    // control on this page may have saved since we loaded.
                    void loadAppSettings().then((s) =>
                        saveAppSettings({
                            ...s,
                            sessionClockMode: choice.mode,
                            sessionTimerMin: choice.timerMin,
                            showSessionClock: choice.showClock,
                            endSessionOnTimer: choice.endOnComplete,
                        })
                    );
                });
            });
        }

        // Provider
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

        // App-level (like the default voice), so saving here mirrors Settings.
        const sttSel = root.querySelector<HTMLSelectElement>('#setup-stt-engine');
        sttSel?.addEventListener('change', async () => {
            const s = await loadAppSettings();
            await saveAppSettings({ ...s, sttEngine: sttSel.value as SttEngineChoice });
            updateSessionEstimate();
        });

        // API key entry itself lives in Settings, not here.
        void refreshProviderAvailability();

        // One button per tab panel, all opening the same picker modal and all
        // editing the one app-level default voice.
        updateVoiceButtonLabel();
        root.querySelectorAll<HTMLButtonElement>('[data-default-voice]').forEach((btn) => {
            btn.addEventListener('click', () => openVoiceModal());
        });

        // One Begin path handles fresh and continued sessions. A cold-boot resume
        // runs through the modal, so pendingContinue here is only ever a History
        // "Continue" (or null): hand its queued state to onBegin as before.
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn')!;
        beginBtn.addEventListener('click', () => {
            void (async () => {
                const queued = pendingContinue?.state ?? null;
                if (pendingContinue) {
                    pendingContinue = null;
                    clearContinueStorage();
                }
                onBegin(setup, queued);
            })();
        });
        // Initial gate state (recomputed once /providers status arrives).
        updateBeginButton();
        updateAiNotes();
        // Initial estimate; the LLM and voice legs fill in once models/voices
        // load and re-call this.
        updateSessionEstimate();
        // Learn retreat coverage (meditation-pal-414) so the pill can hide for
        // covered attendees. fetchMe is a no-op when signed out.
        void fetchMe().then(() => updateSessionEstimate()).catch(() => {});
        // The rate now renders inside the Begin button as a passive label
        // (pointer-events: none), so it's no longer the old pill's tap-to-buy
        // shortcut. Buying credits lives behind the profile surface.

        // Continuation / resume banner. render() rebuilds the DOM, so re-wire the
        // ✕ and repaint from the in-memory pendingContinue every render (the
        // one-time load lives in initPendingContinue, called at mount). ✕ drops
        // the offer, which also shifts layout - fine, it's an explicit dismiss.
        const bannerCancel = root.querySelector<HTMLButtonElement>('#continue-cancel');
        bannerCancel?.addEventListener('click', () => {
            dropPendingContinue();
            updateContinueBanner();
        });
        updateContinueBanner();
    }

    // Provider status from /app/v1/providers - see provider-markers.ts.
    let providerStatus: ProviderStatusMap | null = null;
    // Which BYOK providers have a key stored. A keyless API provider is marked
    // ✘: it can't run without one.
    let keyPresent: Record<string, boolean> = {};

    async function refreshKeyPresence(): Promise<void> {
        const entries = await Promise.all(
            ALL_PROVIDERS.filter((p) => p.needsKey).map(
                async (p) => [p.value, await hasApiKey(p.value)] as const
            )
        );
        keyPresent = Object.fromEntries(entries);
    }

    async function refreshProviderAvailability(): Promise<void> {
        await refreshKeyPresence();
        try {
            const resp = await fetch(appUrl('/providers'));
            if (resp.ok) providerStatus = (await resp.json()) as ProviderStatusMap;
        } catch {
            // Backend not reachable: leave status unknown. The key-presence ✘
            // marks still apply, and the session view surfaces a real error if
            // a provider call fails later.
        }
        applyProviderIndicators();
        updateProviderHint();
        scheduleCloudWatch();
    }

    /**
     * Whether the chosen flow needs a working LLM. Shared with the cloud gate so
     * the two can't disagree (meditation-pal-vr3w). A solo/empty circle used to
     * count as needing one "for an AI-led intro"; that hasn't been true since
     * the opener became static (NOTING_STATIC_OPENER).
     */
    function needsLLM(): boolean {
        return sessionNeedsLlm(setup.meditationType, setup.notingParticipants);
    }

    /**
     * Whether the selected provider is usable. Unknown status (the /providers
     * probe failed) counts as available so we never block on missing info.
     */
    function providerAvailable(): boolean {
        // A keyless API provider can't run; block Begin so the ✘ and the gate
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
    function updateBeginButton(): void {
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn');
        if (!beginBtn) return;
        // A known-bad mic blocks Begin outright: aloud has no text-only mode, so
        // there's nothing to start. Only the certain cases reach here (see
        // probeMic); the rest are caught by the Begin handler's own check.
        const disabled = (needsLLM() && !providerAvailable()) || micStatus !== 'ok';
        beginBtn.disabled = disabled;
        beginBtn.classList.toggle('btn-disabled', disabled);
    }

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
     * Ollama stopped) or ✘ (not configured at all), reorder available-first,
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
            opt.classList.toggle('provider-unavailable', isUnavailable);
            // ✱ stays selectable; only ✘ drops to the unavailable group.
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
            hintEl.textContent = 'Connecting to aloud cloud…';
            hintEl.classList.remove('hidden');
            return;
        }
        // Same override as the ✘/Begin gate: a directly-probed running Ollama
        // shows no hint even when the app backend reported it absent, so the
        // install box doesn't linger.
        const info =
            setup.provider === 'ollama' && capabilitiesSync().ollama
                ? { available: true }
                : providerStatus?.[setup.provider];
        if (info && !info.available && info.hint) {
            hintEl.innerHTML = info.hint;
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
        // Persisted activeTab drives which panel shows on (re)render.
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
        const exploration = root.querySelector<HTMLElement>('#exploration-panel');
        const noting = root.querySelector<HTMLElement>('#noting-panel');
        const feltSense = root.querySelector<HTMLElement>('#felt-sense-panel');
        if (exploration) exploration.classList.toggle('hidden', active !== 'exploration');
        if (noting) noting.classList.toggle('hidden', active !== 'noting');
        if (feltSense) feltSense.classList.toggle('hidden', active !== 'felt_sense');
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
        if (!id) return '';
        const name = id.replace(/^(browser:|server:|aloud:)/, '');
        const found = scoredVoices.find((v) => v.name === name);
        return found ? found.name : name;
    }
    function participantLabel(p: NotingParticipantConfig, index: number): string {
        if (p.type === 'sound') return capitalize(p.sound);
        return voiceNameFromId(p.voice ?? setup.voice) || `Participant ${index + 1}`;
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
                const voiceLabel = p.type !== 'sound' ? voiceNameFromId(p.voice ?? setup.voice) || 'Default' : 'Default';
                const soundLabel = p.type === 'sound' ? capitalize(p.sound) : 'Crow';
                const phraseVal = p.type === 'fixed' ? p.phrase : '';
                const delayVal = p.fixedDelaySec || 4;
                return `<div class="participant-row" data-index="${i}">
                    <div class="participant-row-header">
                        <span class="participant-label">${escapeAttr(participantLabel(p, i))}</span>
                        <button type="button" class="participant-remove" title="Remove">&times;</button>
                    </div>
                    <div class="participant-fields">
                        <div class="participant-field">
                            <label>Type</label>
                            <select class="participant-type">
                                <option value="llm"${p.type === 'llm' ? ' selected' : ''}>AI</option>
                                <option value="fixed"${p.type === 'fixed' ? ' selected' : ''}>Fixed phrase</option>
                                <option value="sound"${p.type === 'sound' ? ' selected' : ''}>Sound effect</option>
                            </select>
                        </div>
                        <div class="participant-field participant-voice-field${p.type === 'sound' ? ' hidden' : ''}">
                            <label>Voice</label>
                            <button type="button" class="setup-voice-btn participant-voice-btn">${escapeAttr(voiceLabel)}</button>
                        </div>
                        <div class="participant-field">
                            <label>Timing</label>
                            <select class="participant-timing">
                                <option value="adaptive"${p.timing === 'adaptive' ? ' selected' : ''}>Adaptive</option>
                                <option value="fixed"${p.timing === 'fixed' ? ' selected' : ''}>Fixed</option>
                            </select>
                        </div>
                        <div class="participant-field participant-delay-field${p.timing === 'fixed' ? '' : ' hidden'}">
                            <label>Seconds</label>
                            <div class="stepper">
                                <button type="button" class="stepper-btn stepper-dec" aria-label="Decrease">&minus;</button>
                                <input type="number" class="participant-delay stepper-value" value="${delayVal}" min="1" max="30" step="1">
                                <button type="button" class="stepper-btn stepper-inc" aria-label="Increase">+</button>
                            </div>
                        </div>
                        <div class="participant-field participant-reactive-field${p.type === 'llm' ? '' : ' hidden'}">
                            <label>Responsiveness</label>
                            <div class="reactive-slider-wrap">
                                <input type="range" class="participant-reactive slider-stops" min="0" max="2" value="${reactiveIdx}" step="1">
                                <span class="reactive-label">${REACTIVE_LABELS[reactiveIdx]}</span>
                            </div>
                        </div>
                        <div class="participant-field participant-phrase-field${p.type === 'fixed' ? '' : ' hidden'}">
                            <label>Phrase</label>
                            <div class="phrase-input-wrap">
                                <input type="text" class="participant-phrase" placeholder="e.g. breathing" maxlength="30" value="${escapeAttr(phraseVal)}">
                                <button type="button" class="participant-phrase-preview btn btn-secondary btn-small" title="Preview phrase">&#9654;</button>
                            </div>
                        </div>
                        <div class="participant-field participant-sound-field${p.type === 'sound' ? '' : ' hidden'}">
                            <label>Sound</label>
                            <div class="phrase-input-wrap">
                                <button type="button" class="btn btn-secondary btn-small participant-sound-btn sound-pick-btn">${escapeAttr(soundLabel)}</button>
                                <button type="button" class="participant-sound-preview btn btn-secondary btn-small" title="Play sound">&#9654;</button>
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
                if (lbl) lbl.textContent = REACTIVE_LABELS[idx] ?? 'Low';
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
                void previewPhrase(phraseInput?.value.trim() || 'breathing', p.voice ?? setup.voice);
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
        // Participant edits can flip whether an LLM is needed.
        updateBeginButton();
        updateAiNotes();
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
                    <span class="voice-row-name">${capitalize(name)}</span>
                    ${name === current ? '<span class="voice-row-check">✓</span>' : ''}
                    <button type="button" class="voice-row-preview" data-sound="${name}">Preview</button>
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
            modal.removeEventListener('click', onBackdrop);
        };
        const onBackdrop = (e: MouseEvent) => {
            if (e.target === modal) close();
        };
        listEl.addEventListener('click', onListClick);
        closeBtn.addEventListener('click', close);
        modal.addEventListener('click', onBackdrop);
    }

    function previewSoundOrChime(name: string): void {
        if (!name || name === 'chime') {
            previewChime();
            return;
        }
        try {
            // assetPath: the hosted build serves under /app/, where a bare
            // /audio/... 404s.
            const audio = new Audio(assetPath(`/audio/${encodeURIComponent(name)}.mp3`));
            void audio.play().catch(() => {});
        } catch {
            /* preview optional */
        }
    }

    function previewChime(): void {
        try {
            const AC =
                (window as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
                (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
            if (!AC) return;
            const ctx = new AC();
            const now = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.setValueAtTime(554, now + 0.1);
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
            osc.start(now);
            osc.stop(now + 0.2);
            osc.onended = () => void ctx.close().catch(() => {});
        } catch {
            /* preview optional */
        }
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
            cueSoundBtn.textContent = capitalize(initial);
            cueSoundBtn.dataset['sound'] = initial;
            cueSoundBtn.addEventListener('click', () => {
                openSoundModal(
                    setup.notingUserTurnCueSound ?? 'chime',
                    (name) => {
                        setup.notingUserTurnCueSound = name === 'chime' ? null : (name as NotingSound);
                        cueSoundBtn.textContent = capitalize(name);
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

    function capitalize(s: string): string {
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    render();
    // Load any pending continuation (History "Continue" / cold-boot resume) once,
    // after the first render so its tab-select + banner paint hit a live DOM.
    void initPendingContinue();
    // Async so the form is interactive immediately; the picker populates when
    // the voices arrive.
    void loadVoiceCatalog();
    // autoStart short-circuits when the user has already dismissed, completed,
    // or used the app.
    void autoStartGuide();

    return {
        async show() {
            render();
            await loadVoiceCatalog();
            void autoStartGuide();
        },
        hide() {
            closeGuideIfActive();
            if (cloudUnwatch !== null) {
                cloudUnwatch();
                cloudUnwatch = null;
            }
            root.innerHTML = '';
        },
        getSetup() { return setup; },
    };
}

function escapeAttr(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}

/** SessionSetup.voice carries an engine prefix; the picker works with raw
 *  names. */
function stripVoicePrefix(voice: string | null): string | null {
    if (!voice) return null;
    const m = /^(server|browser|aloud):(.*)$/.exec(voice);
    return m ? (m[2] ?? null) : voice;
}

/**
 * The Session clock control, rendered once per mode panel. The face is filled
 * in during wiring (renderSetupHTML has no app settings), and every copy is
 * wired together by class, so the mode tabs stay in sync. `key` keeps each
 * copy's info panel a distinct id - toggleInfo resolves by getElementById, so
 * three panels named `info-clock` would all open the first one, in whichever
 * mode tab happens to be hidden.
 */
function renderClockButton(key: string): string {
    return `
        <div class="form-group setup-clock-group">
            <label>Session Clock <button type="button" class="info-btn" data-info="clock-${key}" aria-label="About the session clock">?</button></label>
            <div class="info-panel hidden" id="info-clock-${key}">
                <p>A clock or a timer for the sit. In Timer mode the facilitator lands it in voice - a quiet notice as the time approaches, and a closing word when it's up.</p>
                <p>Hiding the readout doesn't disarm the timer; you still get the spoken close.</p>
            </div>
            <button type="button" class="setup-clock-btn" data-clock-btn>Time in session</button>
        </div>`;
}

function renderSetupHTML(
    byokOpts: ProviderAvailabilityOpts,
    sttSelected: SttEngineChoice
): string {
    const escapeHtml = escapeAttr;
    const sttSetupOptions = sttEngineOptions(isWebMode())
        .map(
            ({ value, label }) =>
                `<option value="${value}"${value === sttSelected ? ' selected' : ''}>${escapeHtml(label)}</option>`
        )
        .join('');

    const focusToggles = FOCUSES.map(
        (f) => `
        <label class="modifier-toggle">
            <input type="checkbox" name="focus" value="${f.value}">
            <div class="modifier-info">
                <span class="modifier-name">${escapeHtml(f.name)}</span>
                <span class="modifier-desc">${escapeHtml(f.description)}</span>
            </div>
        </label>`
    ).join('');

    const qualityToggles = QUALITIES.map(
        (q) => `
        <label class="modifier-toggle">
            <input type="checkbox" name="quality" value="${q.value}">
            <div class="modifier-info">
                <span class="modifier-name">${escapeHtml(q.name)}</span>
                <span class="modifier-desc">${escapeHtml(q.description)}</span>
            </div>
        </label>`
    ).join('');

    const dirTickCount = DIRECTIVENESS_VALUES.length - 1;
    const verbosityOptions = VERBOSITY_OPTIONS.map(
        (v) => `<option value="${v.value}">${escapeHtml(v.label)}</option>`
    ).join('');

    return `
    <div id="continue-banner" class="continue-banner hidden">
        <span id="continue-banner-text">Continuing from a previous session</span>
        <button type="button" class="continue-banner-close" id="continue-cancel" aria-label="Cancel continuation">&times;</button>
    </div>

    <div class="setup-header">
        <div class="tab-bar">
            <button type="button" class="tab-btn active" data-tab="exploration">Exploration</button>
            <button type="button" class="tab-btn" data-tab="noting">Noting</button>
            <button type="button" class="tab-btn" data-tab="felt_sense">Felt Sense</button>
            <button type="button" class="info-btn" data-info="methods" aria-label="About meditation methods">?</button>
        </div>
        <div class="info-panel hidden" id="info-methods">
            <div data-method="exploration">
                <p><strong>exploration</strong>: this is a dyadic meditation format where the meditator speaks about what they are experiencing in the moment and the facilitator asks brief questions to help the meditator explore.</p>
                <p>in this mode, you optionally set an intention and then mix and match <strong>attention focuses</strong> with <strong>vibes</strong> to build your own style. there's a guidance slider so you can dial in how actively it leads. in my personal experience, this sort of exploration has been helpful in experiencing jhana states if approached with enough openheartedness.</p>
                <p>thanks to <a href="https://lovingawakening.net/" target="_blank" rel="noopener">Maija Haavisto</a> and <a href="https://www.jhourney.io/" target="_blank" rel="noopener">Jhourney</a> for guiding me in similar practices.</p>
            </div>
            <div data-method="noting" class="hidden">
                <p><strong>noting</strong>: you specify what participants you'd like, if any: AIs, fixed phrases, or sound effects. then starting with you, each participant notes a sensation in their "awareness" (ideally 1&ndash;2 words) or plays their fixed phrase or sound. this process can be helpful to observe the mental and somatic processes that happen in the cycle of resting -&gt; hearing the cue -&gt; observing -&gt; speaking. if there are no other participants, it'll just briefly introduce the method and then record what you note.</p>
                <p>thanks to <a href="https://www.buddhistgeeks.org/" target="_blank" rel="noopener">Vince Horn</a> and again to <a href="https://www.jhourney.io/" target="_blank" rel="noopener">Jhourney</a> for inspiration.</p>
            </div>
            <div data-method="felt_sense" class="hidden">
                <p><strong>felt sense</strong>: a gentle six-step process. settling in, letting a vague body-sense of one thing form, finding words that fit it, checking them against the body, asking into it, and receiving whatever comes up. the facilitator holds the arc quietly in the background; you just talk, sense, and take your time.</p>
                <p>adapted from <a href="https://focusing.org/" target="_blank" rel="noopener">Eugene Gendlin's Focusing</a>, which deserves the credit for the method.</p>
            </div>
            <p class="info-panel-link"><a href="#" id="start-guide-link">Take the full tour &rarr;</a></p>
        </div>
    </div>

    <form id="setup-form" class="setup-form setup-container">
        <div class="tab-panel" id="exploration-panel">
            <div class="form-group">
                <label for="intention">Intention <span class="optional">(optional)</span></label>
                <textarea id="intention" rows="2"
                    placeholder="e.g. play with energetic flow, just be present with sensations, drop the need to control"></textarea>
            </div>

            <div class="customize-section" id="customize-section">
                <button type="button" class="customize-toggle" id="customize-toggle"
                    aria-expanded="false" aria-controls="customize-body">
                    <span class="customize-toggle-label">Customize facilitation</span>
                    <span class="customize-toggle-summary" id="customize-summary"></span>
                </button>
                <div class="customize-body" id="customize-body">
                    <div class="form-group">
                        <label>Attention Focus <button type="button" class="info-btn" data-info="focus" aria-label="About attention focus">?</button></label>
                        <div class="info-panel hidden" id="info-focus">
                            <p>These let the facilitator know where you intend to place your attention.</p>
                            <p><strong>Body &amp; sensations:</strong> Physical experience: texture, warmth, movement, pressure. Often the most direct doorway into the present moment.</p>
                            <p><strong>Emotions &amp; feeling tone:</strong> More complex collections of sensations and labels - joy, anger, something unnamed.</p>
                            <p><strong>Parts &amp; inner world:</strong> Different aspects of yourself that carry their own perspectives: protectors, younger parts, inner critics. Physical body parts can hold emotion as well.</p>
                            <p>You can also select multiple, or leave all unchecked to keep things open.</p>
                            <p>Some combinations to try: body &amp; emotions with playful and feeling good; emotions with loving and feeling good; parts with compassionate.</p>
                        </div>
                        <div class="modifier-toggles">${focusToggles}</div>
                    </div>

                    <div class="form-group">
                        <label>Vibe <button type="button" class="info-btn" data-info="vibe" aria-label="About vibes">?</button></label>
                        <div class="info-panel hidden" id="info-vibe">
                            <p>Vibes color the tone of facilitation. Select any combination; they blend naturally.</p>
                            <p><strong>Playful</strong> brings lightness and spontaneity. <strong>Spacious</strong> points towards noticing what's already here. <strong>Effortless</strong> invites letting go rather than trying.</p>
                            <p>Pick whatever matches where you are today, or leave them all unchecked for a neutral tone.</p>
                        </div>
                        <div class="modifier-toggles">${qualityToggles}</div>
                    </div>
                </div>
            </div>

            <div class="setup-extras-row setup-extras-row-top">
                <details class="advanced-settings">
                    <summary>Additional instructions</summary>
                    <div class="form-group">
                        <textarea id="custom-instructions" rows="3"
                            placeholder="Any specific guidance for the facilitator…"></textarea>
                    </div>
                </details>
                <div class="form-group setup-guidance-group">
                    <label for="directiveness">Guidance Level <button type="button" class="info-btn" data-info="guidance" aria-label="About guidance level">?</button></label>
                    <div class="info-panel hidden" id="info-guidance">
                        <p>How actively the facilitator leads. Low end biases towards reflection or open questions; higher end toward direction and suggestions.</p>
                        <p>If <a href="#" data-nav="settings" data-nav-anchor="settings-checkins"><strong>check-ins</strong></a> in Settings are set to Smart, this also affects how frequently the facilitator speaks during silence. ~20 minutes on low, <1 min on high.</p>
                    </div>
                    <input type="range" id="directiveness" class="slider-stops" min="0" max="${dirTickCount}" step="1" value="2">
                    <div class="range-labels">
                        <span>Following</span>
                        <span>Directing</span>
                    </div>
                </div>
            </div>

            <div class="form-row form-row-thirds">
                ${renderClockButton('exploration')}
                <div class="form-group">
                    <label for="verbosity">Response Length</label>
                    <select id="verbosity">${verbosityOptions}</select>
                </div>
                <div class="form-group">
                    <label>Voice</label>
                    <button type="button" id="setup-voice-btn" class="setup-voice-btn" data-default-voice>Default</button>
                    <div id="setup-no-voices" class="no-voices-banner inline hidden" role="alert" data-no-voices>
                        <p>No speech voices found. <a href="#" data-nav="settings" data-nav-anchor="settings-tts">Set up TTS in Settings</a>.</p>
                    </div>
                </div>
            </div>
        </div>

        <div class="tab-panel hidden" id="noting-panel">
            <div class="form-group">
                <label>Participants</label>
                <div id="participant-list"></div>
                <button type="button" id="add-participant-btn" class="btn btn-secondary btn-small"
                    title="Add another participant to the noting circle (up to 4)">+ Add participant</button>
            </div>

            <div class="setup-extras-row">
                <div class="noting-option-row">
                    <label class="noting-option">
                        <input type="checkbox" id="user-turn-cue">
                        <span>Play a sound on your turn</span>
                    </label>
                    <button type="button" id="user-turn-cue-sound-btn" class="btn btn-secondary btn-small sound-pick-btn" data-sound="chime">Chime</button>
                    <button type="button" id="user-turn-cue-sound-preview" class="participant-sound-preview btn btn-secondary btn-small" title="Play sound">&#9654;</button>
                </div>
                ${renderClockButton('noting')}
            </div>
        </div>

        <div class="tab-panel hidden" id="felt-sense-panel">
            <div class="form-group">
                <label for="felt-sense-intention">Something to sit with <span class="optional">(optional)</span></label>
                <textarea id="felt-sense-intention" rows="2"
                    placeholder="e.g. the job decision, a conversation yesterday, this restless feeling lately..."></textarea>
            </div>

            <div class="form-row form-row-thirds" id="felt-sense-voice-row">
                <div class="form-group">
                    <label class="checkin-pace-label" for="checkin-enabled">Check in if I'm quiet
                        <input type="checkbox" id="checkin-enabled" checked></label>
                    <div class="slider-control" id="checkin-pace-control">
                        <input type="range" id="checkin-pace" class="slider-stops" min="0" max="${dirTickCount}" step="1" value="1">
                        <div class="range-labels">
                            <span>Patient</span>
                            <span>Attentive</span>
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <label>Voice</label>
                    <button type="button" id="felt-sense-voice-btn" class="setup-voice-btn" data-default-voice>Default</button>
                    <div class="no-voices-banner inline hidden" role="alert" data-no-voices>
                        <p>No speech voices found. <a href="#" data-nav="settings" data-nav-anchor="settings-tts">Set up TTS in Settings</a>.</p>
                    </div>
                </div>
                ${renderClockButton('felt-sense')}
            </div>
        </div>

        <div class="form-row form-row-thirds" id="ai-shared-row">
            <div class="form-group" id="ai-provider-group">
                <label for="provider">AI Provider</label>
                <select id="provider">
                    ${ALL_PROVIDERS.filter((p) => isProviderAvailable(p, capabilitiesSync(), byokOpts))
                        .map(
                            (p) =>
                                `<option value="${p.value}">${escapeHtml(p.label)}</option>`
                        )
                        .join('')}
                </select>
            </div>
            <div class="form-group" id="ai-model-group">
                <label for="model-select">Model</label>
                <div id="model-picker-slot"></div>
            </div>
            <div class="form-group" id="setup-stt-group">
                <label for="setup-stt-engine">Speech Recognition</label>
                <select id="setup-stt-engine">${sttSetupOptions}</select>
            </div>
        </div>
        <!-- No-mic notice. Painted by probeMic() only when it's certain (it
             never prompts, so it stays silent on browsers that hide the answer);
             Begin's acquireMicOnce is the definitive check. -->
        <div id="setup-no-mic" class="no-voices-banner inline hidden" role="alert">
            <p id="setup-no-mic-text"></p>
        </div>
        <p class="credit-rate-legend" id="noting-spend-note">${withCloudOutline('Noting mode uses fewer ☁️. Participants speak brief labels, not full sentences.')}</p>

        <p id="ai-inactive-note" class="credit-rate-legend hidden">No AI participants in this circle, so the AI model isn't used.</p>

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
                <span class="voice-modal-title">Choose a sound</span>
                <button class="voice-modal-close" id="sound-modal-close">&times;</button>
            </div>
            <div class="voice-modal-list" id="sound-modal-list"></div>
        </div>
    </div>

    <!-- A sibling of the form, so position: fixed anchors it to the viewport
         bottom; the inner wrapper caps width so Begin doesn't span wide
         screens. -->
    <div class="setup-footer">
        <div class="setup-footer-inner">
            <button id="begin-btn" type="button" class="btn btn-primary btn-begin">
                <span class="btn-begin-label">Begin Session</span>
                <!-- Cloud-rate estimate, hidden when the session spends
                     nothing (updateSessionEstimate). -->
                <span class="btn-begin-rate" id="session-estimate"></span>
            </button>
        </div>
        <!-- "What are ☁️?" explainer. Absolutely positioned so Begin keeps its
             centered column; rides the estimate pill's visibility (only shown
             when beginning would spend clouds). -->
        <button type="button" class="clouds-help hidden" id="clouds-help"
            aria-label="What are clouds?" title="What are ☁️?">${withCloudOutline('☁️')}<span class="clouds-help-q">?</span></button>
    </div>`;
}

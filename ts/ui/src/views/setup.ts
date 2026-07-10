/**
 * Setup view — pre-session configuration.
 *
 * Mirrors the existing index.html setup form's Exploration tab: intention,
 * preset cards, focus checkboxes, vibe checkboxes, guidance slider,
 * response length, additional instructions, provider, "Begin Session"
 * button. Noting mode is deferred to a later port.
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
    type ProviderAvailabilityOpts,
    DIRECTIVENESS_VALUES,
    loadSetup,
    saveSetup,
} from '../settings.js';
import type { SessionState } from '../../../src/facilitation/session.js';
import { PRESETS, findPreset } from '../presets.js';
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
import { rateBadge, rateUnits, RATE_EMOJI, MODE_RATE_MULTIPLIER, withCloudOutline } from '../credit-rate.js';
import { fetchMe } from '../cloud-auth.js';
import { getRetreatCovered } from '../cloud-coverage.js';
import { createTtsForVoice } from '../adapters/tts-picker.js';
import { mountModelPicker } from '../model-picker.js';
import { assetPath } from '../route-base.js';
import { hasApiKey } from '../api-keys.js';
import {
    sttEngineOptions,
    resolveSttChoice,
    sttBackendForChoice,
    CLOUD_STT_CREDITS_PER_HOUR,
} from '../adapters/stt-picker.js';
import { sessionStore } from '../state.js';
import { detectCapabilities, capabilitiesSync, watchCloudReachable } from '../capabilities.js';
import { isWebMode } from '../app-mode.js';
import { appUrl } from '../app-base.js';
import {
    computeProviderMarker,
    stripMarker,
    type ProviderStatusMap,
} from '../provider-markers.js';
import { alertDialog } from '../dialog.js';
import { loadAppSettings, saveAppSettings, type SttEngineChoice } from '../app-settings.js';
import {
    autoStart as autoStartGuide,
    closeIfActive as closeGuideIfActive,
    resetAndStart as resetGuide,
} from '../tour/index-guide.js';

const FOCUSES: ReadonlyArray<{ value: Focus; name: string; description: string }> = [
    {
        value: 'body_sensations',
        name: 'Body & sensations',
        description: 'Physical experience: texture, temperature, movement',
    },
    {
        value: 'emotions',
        name: 'Emotions & feeling tone',
        description: 'Emotional landscape, warmth, what’s alive underneath',
    },
    {
        value: 'inner_parts',
        name: 'Parts & inner world',
        description: 'Inner parts, protectors, body parts, speaking to/as parts',
    },
];

const QUALITIES: ReadonlyArray<{ value: Quality; name: string; description: string }> = [
    {
        value: 'playful',
        name: 'Playful & light',
        description: 'Play, spontaneity, delight. Doesn’t have to be serious',
    },
    {
        value: 'compassionate',
        name: 'Compassionate',
        description: 'Meeting what arises with care, tenderness, gentleness',
    },
    {
        value: 'loving',
        name: 'Loving & kind',
        description: 'Generating and radiating love and goodwill',
    },
    {
        value: 'spacious',
        name: 'Spacious',
        description: 'Notice the openness that’s already here',
    },
    {
        value: 'effortless',
        name: 'Effortless',
        description: 'Hands off the wheel, let things unfold',
    },
    {
        value: 'feeling_good',
        name: 'Feeling good',
        description: 'Noticing and cultivating pleasant sensations',
    },
];

const VERBOSITY_OPTIONS: ReadonlyArray<{ value: Verbosity; label: string }> = [
    { value: 'low', label: 'Brief' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'Longer' },
];

export interface SetupViewHandle {
    /** Show the setup view (replaces any current content in `root`). */
    show(): Promise<void>;
    /** Hide the setup view (caller handles what to show next). */
    hide(): void;
    /** Current setup snapshot. */
    getSetup(): SessionSetup;
}

export async function mountSetupView(
    root: HTMLElement,
    onBegin: (setup: SessionSetup, continueFrom: SessionState | null) => void
): Promise<SetupViewHandle> {
    const setup = await loadSetup();
    // Resolve environment capabilities before the first render so the provider
    // menu shows exactly what's reachable (also populates the is-desktop cache
    // for the env-var hints).
    await detectCapabilities();
    const appSettings = await loadAppSettings();
    // BYOK visibility: always in local mode; opt-in in web mode.
    const byokOpts: ProviderAvailabilityOpts = {
        webMode: isWebMode(),
        allowByok: appSettings.enableByok,
    };
    // The shared app default provider is 'ollama' (desktop-only). In web mode a
    // fresh setup must not stay on it before the first render — otherwise a fresh
    // browser mounts the local-model picker and shows a nonsensical "Install
    // Ollama" empty state. applyProviderIndicators reorders the <select>
    // available-first later, but can't rescue us when NO provider is available
    // (e.g. aloud cloud momentarily unreachable) — there'd be nothing to switch
    // to. Resolve a web-valid provider up front instead.
    setup.provider = resolveSetupProvider(setup.provider, capabilitiesSync(), byokOpts);
    // Speech-recognition source, shown alongside provider/model so it's visible
    // (and changeable) before starting a session. Edits the app-level default,
    // same as the Voice control. The select itself is built in renderSetupHTML.
    const sttSetupSelected = resolveSttChoice(appSettings.sttEngine, isWebMode());
    // Warm the Silero VAD while the user configures: the whisper-pcm engine's
    // prime() awaits the same app-lifetime singleton (loadSileroVad), so by the
    // time they click Begin the model download (multi-MB on a cold web cache)
    // is usually done. Only when this mode's STT choice actually uses it -
    // web-speech and capacitor never load the model.
    if (sttBackendForChoice(sttSetupSelected) === 'server-whisper') {
        void import('../adapters/silero-vad.js')
            .then((m) => m.loadSileroVad())
            .catch(() => {
                /* best-effort warmup; the session start surfaces real errors */
            });
    }
    // Scored voice list for the modal. Lazy-loaded; the setup form is
    // interactive while voices fetch in the background.
    let scoredVoices: ScoredVoice[] = [];

    // Pull a queued continuation off sessionStorage — the history view
    // writes 'continueFrom' there and routes back to setup, which picks it
    // up and threads it into onBegin. Returns null when nothing is queued or
    // the referenced session is gone.
    async function loadQueuedContinuation(): Promise<SessionState | null> {
        if (typeof sessionStorage === 'undefined') return null;
        const id = sessionStorage.getItem('continueFrom');
        if (!id) return null;
        const state = await sessionStore.load(id);
        // One-shot — clear so a reload doesn't keep auto-continuing.
        sessionStorage.removeItem('continueFrom');
        sessionStorage.removeItem('continueFromSummary');
        if (!state) return null;
        return state;
    }

    function persist(): void {
        void saveSetup(setup);
    }

    /**
     * Voice + rate are app-level defaults, not per-session state (see
     * loadSetup in settings.ts). The setup picker edits the same global
     * default the Settings page does, so changes here propagate to every
     * session — and to the Settings voice display. We keep the in-memory
     * `setup` in sync for the live form, then write through to app settings.
     */
    async function persistDefaultVoice(voice: string | null, rate: number): Promise<void> {
        const s = await loadAppSettings();
        await saveAppSettings({ ...s, defaultVoice: voice, defaultTtsRate: rate });
    }

    /**
     * Pull voices from `/app/v1/voices` (when the app backend is reachable)
     * and from the browser's speechSynthesis API, score them, and store on
     * scoredVoices. Includes browser voices since the TS preview can
     * also drive browser TTS — when the session view runs server TTS
     * exclusively the picker still shows the right set since server
     * voices win for any overlapping name.
     */
    async function loadVoiceCatalog(): Promise<void> {
        // speechSynthesis voice list often loads async on first call;
        // give it a tick before snapshotting.
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
        // Auto-select the top available voice when the user hasn't chosen one
        // — never leave the picker on a bare "Default". The list is sorted
        // best-first; skip voices that still need downloading.
        if (!stripVoicePrefix(setup.voice)) {
            const top = scoredVoices.find((v) => !v.needsDownload);
            if (top) {
                setup.voice = prefixedVoiceId(top.engine, top.name);
                void persistDefaultVoice(setup.voice, setup.ttsRate);
            }
        }
        updateVoiceButtonLabel();
        // Voices just arrived — repopulate participant voice dropdowns.
        renderParticipantList();
        // Guide a user with zero usable voices toward fixing TTS. Checked only
        // after the catalog finishes loading (server + cloud + browser voices
        // all resolved above) so it doesn't flash during the load — a
        // post-timeout no-voices banner.
        root.querySelectorAll<HTMLElement>('.no-voices-banner').forEach((banner) => {
            banner.classList.toggle('hidden', scoredVoices.length > 0);
        });
    }

    function findVoice(name: string | null): ScoredVoice | null {
        if (!name) return null;
        return scoredVoices.find((v) => v.name === name) ?? null;
    }

    // The selected hosted model's credits/hr, for the session estimate. Wired to
    // the model picker once it mounts (in a deeper scope); 0 until then / for
    // free providers.
    let getModelRate: () => number = () => 0;
    // Re-fetch the model picker for a provider — wired to the mounted picker so
    // the cloud-wake watcher can repopulate it once aloud cloud is up.
    let refreshModelPicker: (provider: string) => void = () => {};
    // Unsubscribe for the shared cloud-wake watcher (web/mobile only). Called on
    // hide so a pending wait doesn't fire into a torn-down view.
    let cloudUnwatch: (() => void) | null = null;

    function updateVoiceButtonLabel(): void {
        // One button per tab panel (exploration + felt sense), all painting
        // the same app-level default voice.
        const btns = root.querySelectorAll<HTMLButtonElement>('[data-default-voice]');
        if (btns.length === 0) return;
        const selectedName = stripVoicePrefix(setup.voice);
        const entry = findVoice(selectedName);
        // Surface the ☁️ rate of a cloud voice on the collapsed button too, so a
        // paid pick reads as paid without opening the picker.
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
        for (const btn of btns) btn.textContent = text;
        // The voice leg feeds the combined estimate; refresh it whenever the
        // voice display does (selection change, or voices finishing loading).
        updateSessionEstimate();
    }

    /**
     * Combined estimated cloud burn for the configured session, shown on the
     * setup footer (estimate only, per the dev's call — a live in-session
     * countdown would be distracting with eyes closed; account balance lives
     * behind the profile button, meditation-pal-e3e). Sums the hosted legs at a
     * typical talk profile: LLM (only when the provider is the aloud cloud) +
     * cloud STT (only when picked) + cloud voice. All three rates come from the
     * same pricing the meter bills with, so the estimate can't drift from real
     * charges — only the assumed usage profile can. Local/BYOK legs are free and
     * contribute 0.
     */
    function updateSessionEstimate(): void {
        const el = root.querySelector<HTMLElement>('#session-estimate');
        if (!el) return;

        // Retreat attendees aren't metered (meditation-pal-414) — drop the
        // cloud-rate estimate and its buy-credits tap target entirely.
        if (getRetreatCovered()) {
            el.classList.add('hidden');
            el.innerHTML = '';
            return;
        }

        const sttSel = root.querySelector<HTMLSelectElement>('#setup-stt-engine');
        const sttChoice = sttSel?.value ?? sttSetupSelected;

        const llm = setup.provider === 'aloud' ? getModelRate() : 0;
        const stt = sttChoice === 'aloud' ? CLOUD_STT_CREDITS_PER_HOUR : 0;
        const tts = findVoice(stripVoicePrefix(setup.voice))?.creditsPerHour ?? 0;
        // Noting mode burns far less than the exploration-calibrated legs imply.
        const total = (llm + stt + tts) * (MODE_RATE_MULTIPLIER[setup.meditationType] ?? 1);

        // No cloud spend (local/BYOK across every leg) → hide the pill entirely
        // rather than show a bare "0☁️". There's nothing to meter and nothing to
        // buy, so the indicator (and its buy-credits tap target) has no purpose.
        if (total <= 0) {
            el.classList.add('hidden');
            el.innerHTML = '';
            return;
        }
        el.classList.remove('hidden');
        // Compact for the floating pill; the "≈" carries the estimate/per-hour
        // caveat.
        const rate = `≈ ${rateUnits(total)}${RATE_EMOJI}/hr`;
        // Outline each ☁️ (emoji ignore text-stroke, and the light cloud washes
        // out on the white pill). Content is our own numbers + fixed words, safe.
        el.innerHTML = withCloudOutline(rate);
    }

    /**
     * Open the voice modal — renders the scored list, wires up row
     * clicks (select), preview clicks, the speed slider, and the close
     * button. Re-running render() blows the modal away with the rest of
     * the form, so the wiring lives inline here instead of in render().
     */
    /**
     * Open the shared voice picker. With no target it edits setup.voice (the
     * exploration/narrator voice); pass a target to edit a noting participant's
     * voice with the exact same modal + previews.
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
            // Download button — stream the Piper model down with live percent,
            // then re-render so the voice (and any model-sharing speakers)
            // unlock.
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
            // Select the voice. Persist with engine prefix so createTtsForVoice
            // picks the right backend.
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

        // Intention — exploration's "intention" and felt sense's "something
        // to sit with" are different inputs, so each textarea binds to its
        // own intentionByMode slot. setup.intention mirrors the ACTIVE
        // mode's value (syncIntentionForMode keeps it fresh on tab switch)
        // so sessions/prompts downstream stay single-field.
        const intentionEl = root.querySelector<HTMLTextAreaElement>('#intention')!;
        const feltIntentionEl = root.querySelector<HTMLTextAreaElement>('#felt-sense-intention')!;
        const intentionFields: Array<[HTMLTextAreaElement, MeditationType]> = [
            [intentionEl, 'exploration'],
            [feltIntentionEl, 'felt_sense'],
        ];
        for (const [el, mode] of intentionFields) {
            el.value = setup.intentionByMode[mode] ?? '';
            el.addEventListener('input', () => {
                setup.intentionByMode[mode] = el.value;
                if (setup.meditationType === mode) setup.intention = el.value;
                persist();
            });
        }

        // Presets
        root.querySelectorAll<HTMLElement>('.style-card').forEach((card) => {
            const id = card.dataset['preset']!;
            const isSelected = id === setup.preset;
            card.classList.toggle('selected', isSelected);
            const radio = card.querySelector<HTMLInputElement>('input[type="radio"]');
            if (radio) radio.checked = isSelected;
            card.addEventListener('click', () => {
                const preset = findPreset(id);
                if (!preset) return;
                setup.preset = preset.id;
                setup.focuses = [...preset.focuses];
                setup.qualities = [...preset.qualities];
                setup.dirStep = preset.dirStep;
                persist();
                render();
            });
        });

        // Focus checkboxes
        root.querySelectorAll<HTMLInputElement>('input[name="focus"]').forEach((cb) => {
            cb.checked = setup.focuses.includes(cb.value as Focus);
            cb.addEventListener('change', () => {
                const value = cb.value as Focus;
                setup.focuses = cb.checked
                    ? [...setup.focuses, value]
                    : setup.focuses.filter((f) => f !== value);
                setup.preset = null; // manual change leaves preset state
                persist();
                updatePresetHighlights();
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
                setup.preset = null;
                persist();
                updatePresetHighlights();
                cb.closest('.modifier-toggle')!.classList.toggle('selected', cb.checked);
            });
        });

        // Directiveness
        const dirSlider = root.querySelector<HTMLInputElement>('#directiveness')!;
        dirSlider.value = String(setup.dirStep);
        dirSlider.addEventListener('input', () => {
            setup.dirStep = Number(dirSlider.value);
            setup.preset = null;
            persist();
            updatePresetHighlights();
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
        // Model picker — fetches /app/v1/models/<provider>,
        // falls back to a free-form text input when the endpoint isn't
        // available.
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

        // Speech-recognition source — app-level (like the default voice), so
        // saving it here mirrors Settings. The visible options are already
        // mode-aware (rendered above); persist the explicit pick.
        const sttSel = root.querySelector<HTMLSelectElement>('#setup-stt-engine');
        sttSel?.addEventListener('change', async () => {
            const s = await loadAppSettings();
            await saveAppSettings({ ...s, sttEngine: sttSel.value as SttEngineChoice });
            updateSessionEstimate();
        });

        // Provider availability — fetch /app/v1/providers, annotate the
        // provider <option>s with ✱ (installed but not running) or
        // ✘ (not installed/configured), and surface a hint below for
        // the active provider. API key entry itself lives in Settings,
        // not here.
        void refreshProviderAvailability();

        // Voice — a button per tab panel, each opening the same picker modal
        // (which also has the speed slider). All edit the one app-level
        // default voice.
        updateVoiceButtonLabel();
        root.querySelectorAll<HTMLButtonElement>('[data-default-voice]').forEach((btn) => {
            btn.addEventListener('click', () => openVoiceModal());
        });

        // Begin session — uses any queued continuation from sessionStorage
        // (set by the history view's "Continue" button) so the same Begin
        // path handles both fresh and continued sessions.
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn')!;
        beginBtn.addEventListener('click', () => {
            void (async () => {
                const queued = await loadQueuedContinuation();
                onBegin(setup, queued);
            })();
        });
        // Initial gate state (recomputed once /providers status arrives).
        updateBeginButton();
        updateAiNotes();
        // Initial estimate (the LLM leg fills in once models load; the voice
        // leg once voices load — both re-call updateSessionEstimate).
        updateSessionEstimate();
        // Learn retreat coverage (meditation-pal-414) so the pill can hide for
        // covered attendees. fetchMe is a no-op when signed out; repaint once it
        // resolves (it populates the coverage store synchronously before then).
        void fetchMe().then(() => updateSessionEstimate()).catch(() => {});
        // NOTE (cost-in-button prototype): the cloud-rate estimate now renders
        // inside the Begin button as a passive label (pointer-events: none), so
        // it's no longer a tap target. That drops the old pill's tap-to-buy-
        // credits shortcut — buying credits still lives behind the account/
        // profile surface. If we keep this treatment, decide whether the setup
        // screen still needs its own buy-credits entry point.

        // Continuation banner — shown when the history view has queued a
        // session for continuation.
        void (async () => {
            if (typeof sessionStorage === 'undefined') return;
            const id = sessionStorage.getItem('continueFrom');
            if (!id) return;
            const state = await sessionStore.load(id);
            if (!state) return;
            // Resuming re-enters the session's own mode — a felt-sense
            // session must come back staged (and in its saved phase), not as
            // whatever tab happened to be active. Unknown/legacy types keep
            // the current tab.
            const t = state.meditationType;
            if (
                (t === 'exploration' || t === 'noting' || t === 'felt_sense') &&
                t !== setup.meditationType
            ) {
                setup.meditationType = t;
                persist();
                applyTabSelection(t);
                updateBeginButton();
                updateAiNotes();
                updateSessionEstimate();
            }
            const banner = root.querySelector<HTMLElement>('#continue-banner');
            const text = root.querySelector<HTMLElement>('#continue-banner-text');
            const cancel = root.querySelector<HTMLButtonElement>('#continue-cancel');
            if (!banner || !text || !cancel) return;
            const summary =
                sessionStorage.getItem('continueFromSummary') ||
                new Date(state.startTime * 1000).toLocaleString();
            text.textContent = `Continuing from: ${summary}`;
            // Use the .hidden class (sets display:none !important via the
            // lifted CSS). Toggling the HTML hidden attribute loses to
            // .continue-banner's `display: flex`.
            banner.classList.remove('hidden');
            cancel.addEventListener('click', () => {
                sessionStorage.removeItem('continueFrom');
                sessionStorage.removeItem('continueFromSummary');
                banner.classList.add('hidden');
            });
        })();
    }

    // Provider status from /app/v1/providers — see provider-markers.ts.
    let providerStatus: ProviderStatusMap | null = null;
    // Whether a BYOK provider has a key stored. A keyless API provider is
    // marked ✘ (unavailable) — you can't run it without a key. Populated from
    // the localStorage BYOK store on each availability refresh.
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
            // Backend not reachable — leave provider status unknown; the
            // key-presence ✘ marks below still apply, and the session view
            // surfaces a real error if a provider call fails later.
        }
        applyProviderIndicators();
        updateProviderHint();
        // If aloud cloud reads unreachable (cold start), keep re-probing so the
        // page comes alive on its own once the machine boots.
        scheduleCloudWakePoll();
    }

    /**
     * Whether the chosen flow needs a working LLM. Exploration always does;
     * a noting circle only does if at least one participant is an AI (or it's
     * a solo/empty circle, which falls back to an AI-led intro).
     */
    function needsLLM(): boolean {
        if (setup.meditationType !== 'noting') return true;
        const ps = setup.notingParticipants ?? [];
        if (ps.length === 0) return true;
        return ps.some((p) => p.type === 'llm');
    }

    /**
     * Whether the currently selected provider is usable. Unknown status
     * (e.g. the /providers probe failed) counts as available so we never
     * block on missing information.
     */
    function providerAvailable(): boolean {
        // An API provider with no stored key can't run — treat as unavailable
        // so Begin is blocked and the ✘ is consistent with the gate.
        if (providerNeedsKey(setup.provider) && keyPresent[setup.provider] === false) return false;
        // Ollama: a running local daemon (direct probe) is usable even when the
        // app backend can't see it (browser dev preview against Hono).
        if (setup.provider === 'ollama' && capabilitiesSync().ollama) return true;
        // aloud cloud on web: the app backend (/app/v1/providers, Hono) reports it
        // available unconditionally — it can't see the hosted service's health —
        // so gate on the real reachability probe (capabilities.cloud) instead.
        // A cold machine reads unavailable until the wake poll confirms it's up,
        // so Begin stays blocked (with a "waking" hint) rather than starting a
        // session that would stall on its first turn.
        if (setup.provider === 'aloud' && byokOpts.webMode) return capabilitiesSync().cloud;
        const info = providerStatus?.[setup.provider];
        return !info || info.available;
    }

    /**
     * Disable "Begin session" when an LLM is needed but the selected provider
     * isn't available, so a user with (say) Ollama stopped sees a blocked
     * button instead of a session that dies on the first turn.
     */
    function updateBeginButton(): void {
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn');
        if (!beginBtn) return;
        const disabled = needsLLM() && !providerAvailable();
        beginBtn.disabled = disabled;
        beginBtn.classList.toggle('btn-disabled', disabled);
    }

    /**
     * Gray out the Provider + Model pickers when no AI will run — i.e. a noting
     * circle whose participants are all fixed phrases / sounds. The picker stays
     * legible (so the user sees what would be used) but reads as inactive, with
     * a one-line note saying why. Exploration, and any circle that leans on an
     * AI (an llm participant, or an empty/solo circle's AI-led intro), keep it
     * live. Mirrors the needsLLM() gate the Begin button already uses.
     */
    function updateAiNotes(): void {
        const active = needsLLM();
        root.querySelector<HTMLElement>('#ai-provider-group')?.classList.toggle('ai-group-disabled', !active);
        root.querySelector<HTMLElement>('#ai-model-group')?.classList.toggle('ai-group-disabled', !active);
        // The "AI isn't used" note only makes sense inside a noting circle —
        // exploration/focusing always use the model, so never explain its absence there.
        const showAiNote = !active && setup.meditationType === 'noting';
        root.querySelector<HTMLElement>('#ai-inactive-note')?.classList.toggle('hidden', !showAiNote);

        // Noting uses less AI credits since much less talking
        const showSpendNote = active && setup.meditationType === 'noting';
        root.querySelector<HTMLElement>('#noting-spend-note')?.classList.toggle('hidden', !showSpendNote);
    }

    /**
     * Annotate provider <option>s with ✱ / ✘, reorder available-first, float
     * claude_proxy to the top when it's working, and auto-select the saved
     * provider if available (else the first available one). ✱ means installed
     * but not running (Ollama stopped), ✘ means not configured at all.
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
            // ✘ providers can't run (no key / not installed) → unavailable group;
            // ✱ (installed but not running, e.g. Ollama stopped) stays selectable.
            if (isUnavailable) unavailable.push(opt);
            else available.push(opt);
        }
        available.sort((a, b) => (a.value === 'claude_proxy' ? -1 : b.value === 'claude_proxy' ? 1 : 0));
        for (const opt of [...available, ...unavailable]) providerSel.appendChild(opt);

        // Prefer the persisted provider when it's available, else the first
        // available one, so a fresh user isn't stranded on an unavailable
        // default with no nudge toward a working one.
        const savedAvailable = available.some((o) => o.value === setup.provider);
        const target = savedAvailable ? setup.provider : (available[0]?.value ?? setup.provider);
        if (target !== setup.provider) {
            // Auto-switch to an available provider; reuse the select's change
            // handler so the model picker, hint, and begin gate all refresh.
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
        // aloud cloud on web, not yet reachable: it's almost always a cold start
        // (the service scales to zero when idle). Say so — reassuring, not an
        // error — while the background poll waits for it to boot.
        if (setup.provider === 'aloud' && byokOpts.webMode && !capabilitiesSync().cloud) {
            hintEl.textContent = 'aloud cloud is waking up - one moment…';
            hintEl.classList.remove('hidden');
            return;
        }
        // A running Ollama (direct probe) has no "unavailable" hint to show even
        // when the app backend reported it absent — same override as the ✘/Begin
        // gate, so the "Ollama runs on your own machine" box doesn't linger.
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
     * aloud cloud scales to zero when idle, so a fresh web/mobile visit can land
     * while the machine is still cold. The initial capability probe may have
     * given up before it booted (leaving cloud=false), which would strand Begin
     * behind a "waking" hint forever. Subscribe to the shared cloud-wake watcher;
     * the moment the machine answers, refresh the provider markers, model picker,
     * and Begin gate so the page heals itself without a reload. Web/mobile-only
     * (desktop shows aloud alongside local providers), and a no-op once cloud is
     * reachable or a wait is already pending.
     */
    function scheduleCloudWakePoll(): void {
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
                if (setup.meditationType === tab) return;
                setup.meditationType = tab;
                // setup.intention follows the active mode (noting has no
                // intention field, so its slot is always empty).
                setup.intention = setup.intentionByMode[tab] ?? '';
                persist();
                applyTabSelection(tab);
                // Switching to/from noting changes whether an LLM is needed.
                updateBeginButton();
                updateAiNotes();
                // ...and changes the estimate (noting applies the 0.4 multiplier).
                updateSessionEstimate();
            });
        });
    }

    function applyTabSelection(active: MeditationType): void {
        root.querySelectorAll<HTMLElement>('.tab-bar .tab-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset['tab'] === active);
        });
        // The methods info panel shows only the active tab's description —
        // the full three-method text overflows small screens. The guided
        // tour steps through the tabs to cover all three.
        root.querySelectorAll<HTMLElement>('#info-methods [data-method]').forEach((block) => {
            block.classList.toggle('hidden', block.dataset['method'] !== active);
        });
        const exploration = root.querySelector<HTMLElement>('#exploration-panel');
        const noting = root.querySelector<HTMLElement>('#noting-panel');
        const feltSense = root.querySelector<HTMLElement>('#felt-sense-panel');
        if (exploration) exploration.classList.toggle('hidden', active !== 'exploration');
        if (noting) noting.classList.toggle('hidden', active !== 'noting');
        if (feltSense) feltSense.classList.toggle('hidden', active !== 'felt_sense');
        // Felt sense lays the controls out two-and-two: Voice + Speech
        // Recognition in the panel row, Provider + Model on the shared row
        // below. The STT group is one DOM node re-parented between the rows,
        // so its select keeps its wiring, options, and value either way.
        const sttGroup = root.querySelector<HTMLElement>('#setup-stt-group');
        const feltVoiceRow = root.querySelector<HTMLElement>('#felt-sense-voice-row');
        const sharedRow = root.querySelector<HTMLElement>('#ai-shared-row');
        if (sttGroup && feltVoiceRow && sharedRow) {
            (active === 'felt_sense' ? feltVoiceRow : sharedRow).appendChild(sttGroup);
        }
    }

    /**
     * Wire the `?` info buttons. The tour module (./tour/index-guide.ts)
     * installs a single delegated document-level handler that drives all
     * `.info-btn[data-info]` clicks with the accordion-style toggle
     * (clicking one info button closes any other open panels). It also
     * suppresses the toggle while the guided tour is active so the tour
     * controls the open panel.
     *
     * The "Take the full tour" link inside the methods info panel goes
     * here too — it resets the dismissed state and jumps straight to the
     * first section.
     */
    function wireInfoButtons(): void {
        const guideLink = root.querySelector<HTMLAnchorElement>('#start-guide-link');
        if (guideLink) {
            guideLink.addEventListener('click', (e) => {
                e.preventDefault();
                void resetGuide();
            });
        }
    }

    // ---- Noting circle participants ----
    // The lifted .participant-* CSS keeps layout, sizing, and the
    // stepper/slider/phrase widths matching the original exactly.
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
                                <input type="range" class="participant-reactive" min="0" max="2" value="${reactiveIdx}" step="1">
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
        // Participant edits (type/add/remove) can flip whether an LLM is needed.
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
            // assetPath: the hosted build serves under /app/, so a bare
            // /audio/... 404s there.
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

    function updatePresetHighlights(): void {
        root.querySelectorAll<HTMLElement>('.style-card').forEach((card) => {
            card.classList.toggle('selected', card.dataset['preset'] === setup.preset);
        });
    }

    render();
    // Load voices asynchronously so the rest of the form is interactive
    // immediately; server-side voices fetch in the background and the
    // dropdown populates when ready.
    void loadVoiceCatalog();
    // Kick off the welcome tour on first visit. autoStart short-circuits
    // when the user has already dismissed, completed, or used the app.
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

/** SessionSetup.voice carries a 'server:' or 'browser:' prefix; the voice
 *  picker works with raw names. Strip the prefix on the way in. */
function stripVoicePrefix(voice: string | null): string | null {
    if (!voice) return null;
    const m = /^(server|browser|aloud):(.*)$/.exec(voice);
    return m ? (m[2] ?? null) : voice;
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

    // Presets are radio inputs wrapped in labels styled as cards. The radio
    // is visually hidden by the CSS
    // (.style-card input { display: none }), and the .selected class
    // on the label drives the active border.
    const presetCards = PRESETS.map(
        (p) => `
        <label class="style-card" data-preset="${p.id}">
            <input type="radio" name="preset" value="${p.id}">
            <div class="style-card-inner">
                <span class="style-name">${escapeHtml(p.name)}</span>
                <span class="style-desc">${escapeHtml(p.description)}</span>
            </div>
        </label>`
    ).join('');

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
                <p>in this mode, you optionally set an intention and then mix and match <strong>attention focuses</strong> (body, emotions, parts work) with <strong>vibes</strong> (playful, compassionate, loving, spacious, effortless, feel-good). presets give you quick starting points, or you can build your own style. there's a directiveness slider so you can dial in how much guidance you want. in my personal experience, this sort of exploration has been helpful in experiencing jhana states if approached with enough openheartedness.</p>
                <p>thanks to <a href="https://lovingawakening.net/" target="_blank" rel="noopener">Maija Haavisto</a> and <a href="https://www.jhourney.io/" target="_blank" rel="noopener">Jhourney</a> for guiding me in similar practices.</p>
            </div>
            <div data-method="noting" class="hidden">
                <p><strong>noting</strong>: you specify what participants you'd like, if any: AIs, fixed phrases, or sound effects. then starting with you, each participant notes a sensation in their "awareness" (ideally 1&ndash;2 words) or plays their fixed phrase or sound. yes, AIs noting their experience seems kind of silly, but I've actually found it helpful to observe the mental and somatic processes that happen in the cycle of resting -&gt; hearing my cue -&gt; observing -&gt; speaking. if there are no other participants, it'll just briefly introduce the method and then record what you note.</p>
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

            <div class="form-group">
                <label>Suggested Presets</label>
                <div class="style-cards">${presetCards}</div>
            </div>

            <div class="form-group">
                <label>Attention Focus <button type="button" class="info-btn" data-info="focus" aria-label="About attention focus">?</button></label>
                <div class="info-panel hidden" id="info-focus">
                    <p>These let the facilitator know where you intend to place your attention.</p>
                    <p><strong>Body &amp; sensations</strong> &mdash; Physical experience: texture, warmth, movement, pressure. Often the most direct doorway into the present moment.</p>
                    <p><strong>Emotions &amp; feeling tone</strong> &mdash; The emotional landscape underneath: what's warm, contracted, alive, or wanting to move.</p>
                    <p><strong>Parts &amp; inner world</strong> &mdash; Different aspects of yourself that carry their own perspectives: protectors, younger parts, inner critics. Physical body parts can hold emotion as well.</p>
                    <p>You can also select multiple, or leave all unchecked to keep things open.</p>
                </div>
                <div class="modifier-toggles">${focusToggles}</div>
            </div>

            <div class="form-group">
                <label>Vibe <button type="button" class="info-btn" data-info="vibe" aria-label="About vibes">?</button></label>
                <div class="info-panel hidden" id="info-vibe">
                    <p>Vibes color the tone of facilitation. Select any combination &mdash; they blend naturally.</p>
                    <p><strong>Playful</strong> brings lightness and spontaneity. <strong>Spacious</strong> leaves more breathing room and silence. <strong>Effortless</strong> invites letting go rather than trying.</p>
                    <p>There's no wrong choice. Pick whatever matches where you are today, or leave them all unchecked for a neutral tone.</p>
                </div>
                <div class="modifier-toggles">${qualityToggles}</div>
            </div>

            <div class="form-row form-row-thirds">
                <div class="form-group">
                    <label for="directiveness">Guidance Level</label>
                    <input type="range" id="directiveness" min="0" max="${dirTickCount}" step="1" value="1">
                    <div class="range-labels">
                        <span>Following</span>
                        <span>Directing</span>
                    </div>
                </div>
                <div class="form-group">
                    <label for="verbosity">Response Length</label>
                    <select id="verbosity">${verbosityOptions}</select>
                </div>
                <div class="form-group">
                    <label>Voice</label>
                    <button type="button" id="setup-voice-btn" class="setup-voice-btn" data-default-voice>Default</button>
                    <div id="setup-no-voices" class="no-voices-banner inline hidden" role="alert">
                        <p>No speech voices found. <a href="#" data-nav="settings">Set up TTS in Settings</a>.</p>
                    </div>
                </div>
            </div>

            <details class="advanced-settings">
                <summary>Additional instructions</summary>
                <div class="form-group">
                    <textarea id="custom-instructions" rows="3"
                        placeholder="Any specific guidance for the facilitator…"></textarea>
                </div>
            </details>
        </div>

        <div class="tab-panel hidden" id="noting-panel">
            <div class="form-group">
                <label>Participants</label>
                <div id="participant-list"></div>
                <button type="button" id="add-participant-btn" class="btn btn-secondary btn-small"
                    title="Add another participant to the noting circle (up to 4)">+ Add participant</button>
            </div>

            <div class="noting-option-row">
                <label class="noting-option">
                    <input type="checkbox" id="user-turn-cue">
                    <span>Play a sound when it's your turn</span>
                </label>
                <button type="button" id="user-turn-cue-sound-btn" class="btn btn-secondary btn-small sound-pick-btn" data-sound="chime">Chime</button>
                <button type="button" id="user-turn-cue-sound-preview" class="participant-sound-preview btn btn-secondary btn-small" title="Play sound">&#9654;</button>
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
                    <label>Voice</label>
                    <button type="button" id="felt-sense-voice-btn" class="setup-voice-btn" data-default-voice>Default</button>
                    <div class="no-voices-banner inline hidden" role="alert">
                        <p>No speech voices found. <a href="#" data-nav="settings">Set up TTS in Settings</a>.</p>
                    </div>
                </div>
            </div>
        </div>

        <div class="form-row form-row-thirds" id="ai-shared-row">
            <div class="form-group" id="ai-provider-group">
                <label for="provider">Provider</label>
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
        <p class="credit-rate-legend" id="noting-spend-note">AI uses fewer ☁️ in noting mode. Participants speak brief labels, not full sentences.</p>

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

    <!-- Sound picker (noting sound participants + the user-turn cue). Reuses
         the voice-modal chrome + .voice-row list styling. -->
    <div class="voice-modal-overlay hidden" id="sound-modal">
        <div class="voice-modal">
            <div class="voice-modal-header">
                <span class="voice-modal-title">Choose a sound</span>
                <button class="voice-modal-close" id="sound-modal-close">&times;</button>
            </div>
            <div class="voice-modal-list" id="sound-modal-list"></div>
        </div>
    </div>

    <!-- setup-footer is a sibling of the form so position: fixed (from
         the lifted CSS) anchors it to the viewport bottom; the inner
         wrapper caps width to 640 px so the Begin button doesn't span
         the whole page on wide screens. Matches the original index.html. -->
    <div class="setup-footer">
        <!-- Cloud-rate pill sits in the bar beside (a narrower) Begin button;
             tap toggles it to your cloud balance. At very narrow widths it pops
             out above the bar instead (see .session-estimate media query). -->
        <div class="setup-footer-inner">
            <button id="begin-btn" type="button" class="btn btn-primary btn-begin">
                <span class="btn-begin-label">Begin Session</span>
                <!-- Cloud-rate estimate, rendered inside the CTA (hidden when the
                     session spends nothing — see updateSessionEstimate). -->
                <span class="btn-begin-rate" id="session-estimate"></span>
            </button>
        </div>
    </div>`;
}

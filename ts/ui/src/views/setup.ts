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
    type Provider,
    type NotingParticipantConfig,
    type NotingReactive,
    type NotingSound,
    NOTING_SOUNDS,
    ALL_PROVIDERS,
    isProviderAvailable,
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
    renderVoiceList,
    renderVoiceModalHTML,
    setModelDownloadsDisabled,
    stopPreview,
    updateVoiceSelection,
    type ScoredVoice,
    type ServerVoice,
} from '../voice-picker.js';
import { rateBadge, rateUnits, RATE_EMOJI, creditAmount, MODE_RATE_MULTIPLIER } from '../credit-rate.js';
import { fetchMe, devSignIn } from '../cloud-auth.js';
import { createTtsForVoice } from '../adapters/tts-picker.js';
import { mountModelPicker } from '../model-picker.js';
import { hasApiKey } from '../api-keys.js';
import { sttEngineOptions, resolveSttChoice, CLOUD_STT_CREDITS_PER_HOUR } from '../adapters/stt-picker.js';
import { sessionStore } from '../state.js';
import { detectCapabilities, capabilitiesSync } from '../capabilities.js';
import { isWebMode } from '../app-mode.js';
import { appUrl } from '../app-base.js';
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
        description: 'Physical experience — texture, temperature, movement',
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
    // Speech-recognition source, shown alongside provider/model so it's visible
    // (and changeable) before starting a session. Edits the app-level default,
    // same as the Voice control. The select itself is built in renderSetupHTML.
    const sttSetupSelected = resolveSttChoice(appSettings.sttEngine, isWebMode());
    // Scored voice list for the modal. Lazy-loaded; the setup form is
    // interactive while voices fetch in the background.
    let scoredVoices: ScoredVoice[] = [];

    // Pull a queued continuation off sessionStorage. Mirrors the Python
    // app — history view writes 'continueFrom' there and redirects to /,
    // setup view picks it up and threads it into onBegin. Returns null
    // when nothing is queued or the referenced session is gone.
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
     * Pull voices from `/api/voices` (when Flask is reachable) and from
     * the browser's speechSynthesis API, score them, and store on
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
    }

    function findVoice(name: string | null): ScoredVoice | null {
        if (!name) return null;
        return scoredVoices.find((v) => v.name === name) ?? null;
    }

    // The selected hosted model's credits/hr, for the session estimate. Wired to
    // the model picker once it mounts (in a deeper scope); 0 until then / for
    // free providers.
    let getModelRate: () => number = () => 0;

    function updateVoiceButtonLabel(): void {
        const btn = root.querySelector<HTMLButtonElement>('#setup-voice-btn');
        if (!btn) return;
        const selectedName = stripVoicePrefix(setup.voice);
        const entry = findVoice(selectedName);
        // Surface the ☁️ rate of a cloud voice on the collapsed button too, so a
        // paid pick reads as paid without opening the picker.
        const rate = entry ? rateBadge(entry.creditsPerHour) : '';
        const ratePart = rate ? ` · ${rate}` : '';
        if (entry) {
            btn.textContent = `${entry.name}${ratePart} · ${setup.ttsRate} wpm`;
        } else if (selectedName) {
            // Voice id is stored but we haven't loaded its details yet.
            btn.textContent = `${selectedName} · ${setup.ttsRate} wpm`;
        } else {
            btn.textContent = scoredVoices.length > 0 ? 'Default' : 'Voice';
        }
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
        const sttSel = root.querySelector<HTMLSelectElement>('#setup-stt-engine');
        const sttChoice = sttSel?.value ?? sttSetupSelected;

        const llm = setup.provider === 'aloud' ? getModelRate() : 0;
        const stt = sttChoice === 'aloud' ? CLOUD_STT_CREDITS_PER_HOUR : 0;
        const tts = findVoice(stripVoicePrefix(setup.voice))?.creditsPerHour ?? 0;
        // Noting mode burns far less than the exploration-calibrated legs imply.
        const total = (llm + stt + tts) * (MODE_RATE_MULTIPLIER[setup.meditationType] ?? 1);

        // Compact for the floating pill; the "≈" carries the estimate/per-hour
        // caveat. Zero (local/BYOK) needs no prose.
        const rate = total > 0 ? `≈ ${rateUnits(total)}${RATE_EMOJI}/hr` : `0${RATE_EMOJI}`;

        // Tapped (and signed in): stack the live balance ABOVE the rate, so the
        // pill grows to two lines. Otherwise just the rate. (white-space:
        // pre-line in the CSS renders the newline.)
        // Tapped (and signed in): just the balance, one line. Otherwise the rate.
        const plain = pillShowsBalance && cloudBalanceText ? `balance: ${cloudBalanceText}` : rate;
        // Wrap each ☁️ so .cloud-glyph can outline it (emoji ignore text-stroke,
        // and the light cloud washes out on the white pill). Content is all our
        // own numbers + fixed words, so building this HTML directly is safe.
        el.innerHTML = plain.split(RATE_EMOJI).join(`<span class="cloud-glyph">${RATE_EMOJI}</span>`);
    }

    // The pill toggles between the rate estimate and a peek at your actual cloud
    // balance on tap — a lightweight stand-in until the full profile button
    // (meditation-pal-e3e) lands. Balance is fetched lazily; a null (signed-out
    // / non-cloud) balance just leaves the rate showing.
    let cloudBalanceText: string | null = null;
    let pillShowsBalance = false;
    async function refreshBalance(): Promise<void> {
        let me = await fetchMe().catch(() => null);
        if (!me) {
            // Balance-peek fallback. On the setup screen no session has run yet,
            // so there may be no token; and when the server advertises Google
            // sign-in, a stale token (e.g. after a dev-server restart rotates
            // its JWT secret) can't be re-minted by fetchMe's self-heal — it
            // refuses the dev route when Google is configured. Mint a dev token
            // directly: works locally, and is a no-op in production where
            // /auth/dev is disabled (404 → throws → caught), so the pill just
            // shows no balance there rather than a forced sign-in.
            try {
                await devSignIn();
                me = await fetchMe().catch(() => null);
            } catch {
                /* production / offline — nothing to peek */
            }
        }
        cloudBalanceText = me ? creditAmount(me.creditsRemaining) : null;
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
                void runPreview(name, setup.ttsRate, entry?.engine);
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

        // Intention
        const intentionEl = root.querySelector<HTMLTextAreaElement>('#intention')!;
        intentionEl.value = setup.intention;
        intentionEl.addEventListener('input', () => {
            setup.intention = intentionEl.value;
            persist();
        });

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
        // Model picker — fetches /api/models/<provider> (Flask-backed),
        // falls back to a free-form text input when the endpoint isn't
        // available. Same behavior as Python's setup.js dropdown.
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

        // Speech-recognition source — app-level (like the default voice), so
        // saving it here mirrors Settings. The visible options are already
        // mode-aware (rendered above); persist the explicit pick.
        const sttSel = root.querySelector<HTMLSelectElement>('#setup-stt-engine');
        sttSel?.addEventListener('change', async () => {
            const s = await loadAppSettings();
            await saveAppSettings({ ...s, sttEngine: sttSel.value as SttEngineChoice });
            updateSessionEstimate();
        });

        // Provider availability — fetch /api/providers, annotate the
        // provider <option>s with ✱ (installed but not running) or
        // ✘ (not installed/configured), and surface a hint below for
        // the active provider. API key entry itself lives in Settings,
        // not here. Mirrors Python's setup.js applyProviderAvailability
        // + updateProviderHint.
        void refreshProviderAvailability();

        // Voice — single button opens the picker modal which also has
        // the speed slider. Matches Python's index.html setup-voice-btn.
        const voiceBtn = root.querySelector<HTMLButtonElement>('#setup-voice-btn')!;
        updateVoiceButtonLabel();
        voiceBtn.addEventListener('click', () => openVoiceModal());

        // Begin session — uses any queued continuation from sessionStorage
        // (set by the history view's "Continue" button) so the same Begin
        // path handles both fresh and continued sessions, matching the
        // Python setup.js behavior.
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn')!;
        beginBtn.addEventListener('click', () => {
            void (async () => {
                const queued = await loadQueuedContinuation();
                onBegin(setup, queued);
            })();
        });
        // Initial gate state (recomputed once /providers status arrives).
        updateBeginButton();
        updateAiAvailability();
        // Initial estimate (the LLM leg fills in once models load; the voice
        // leg once voices load — both re-call updateSessionEstimate).
        updateSessionEstimate();
        // Pill = peek at your cloud balance on hover/tap. Prime the tooltip and
        // wire the tap reveal.
        const estimateEl = root.querySelector<HTMLElement>('#session-estimate');
        if (estimateEl) {
            void refreshBalance();
            // Tap toggles the pill between the rate estimate and the balance.
            estimateEl.addEventListener('click', () => {
                pillShowsBalance = !pillShowsBalance;
                if (pillShowsBalance) void refreshBalance().then(updateSessionEstimate);
                updateSessionEstimate();
            });
        }

        // Continuation banner — shown when the history view has queued a
        // session for continuation. Matches Python's #continue-banner.
        void (async () => {
            if (typeof sessionStorage === 'undefined') return;
            const id = sessionStorage.getItem('continueFrom');
            if (!id) return;
            const state = await sessionStore.load(id);
            if (!state) return;
            const banner = root.querySelector<HTMLElement>('#continue-banner');
            const text = root.querySelector<HTMLElement>('#continue-banner-text');
            const cancel = root.querySelector<HTMLButtonElement>('#continue-cancel');
            if (!banner || !text || !cancel) return;
            const summary =
                sessionStorage.getItem('continueFromSummary') ||
                new Date(state.startTime * 1000).toLocaleString();
            text.textContent = `Continuing from: ${summary}`;
            // Use the .hidden class (matches Python — sets display:none
            // !important via the lifted CSS). Toggling the HTML hidden
            // attribute loses to .continue-banner's `display: flex`.
            banner.classList.remove('hidden');
            cancel.addEventListener('click', () => {
                sessionStorage.removeItem('continueFrom');
                sessionStorage.removeItem('continueFromSummary');
                banner.classList.add('hidden');
            });
        })();
    }

    // Provider status from /api/providers — same shape Python uses.
    interface ProviderInfo {
        available: boolean;
        installed?: boolean;
        hint?: string;
    }
    let providerStatus: Record<string, ProviderInfo> | null = null;
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
            if (resp.ok) providerStatus = (await resp.json()) as Record<string, ProviderInfo>;
        } catch {
            // Backend not reachable — leave provider status unknown; the
            // key-presence ✘ marks below still apply, and the session view
            // surfaces a real error if a provider call fails later.
        }
        applyProviderIndicators();
        updateProviderHint();
    }

    /**
     * Whether the chosen flow needs a working LLM. Exploration always does;
     * a noting circle only does if at least one participant is an AI (or it's
     * a solo/empty circle, which falls back to an AI-led intro). Mirrors
     * Python's setup.js needsLLM.
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
     * block on missing information. Mirrors Python's providerAvailable.
     */
    function providerAvailable(): boolean {
        // An API provider with no stored key can't run — treat as unavailable
        // so Begin is blocked and the ✘ is consistent with the gate.
        if (providerNeedsKey(setup.provider) && keyPresent[setup.provider] === false) return false;
        // Ollama: a running local daemon (direct probe) is usable even when the
        // app backend can't see it (browser dev preview against Hono).
        if (setup.provider === 'ollama' && capabilitiesSync().ollama) return true;
        const info = providerStatus?.[setup.provider];
        return !info || info.available;
    }

    /**
     * Disable "Begin session" when an LLM is needed but the selected provider
     * isn't available, so a user with (say) Ollama stopped sees a blocked
     * button instead of a session that dies on the first turn. Mirrors
     * Python's updateBeginButton.
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
    function updateAiAvailability(): void {
        const active = needsLLM();
        root.querySelector<HTMLElement>('#ai-provider-group')?.classList.toggle('ai-group-disabled', !active);
        root.querySelector<HTMLElement>('#ai-model-group')?.classList.toggle('ai-group-disabled', !active);
        // The "AI isn't used" note only makes sense inside a noting circle —
        // exploration always uses the model, so never explain its absence there.
        const showNote = !active && setup.meditationType === 'noting';
        root.querySelector<HTMLElement>('#ai-inactive-note')?.classList.toggle('hidden', !showNote);
    }

    /**
     * Annotate provider <option>s with ✱ / ✘, reorder available-first, float
     * claude_proxy to the top when it's working, and auto-select the saved
     * provider if available (else the first available one). ✱ means installed
     * but not running (Ollama stopped), ✘ means not configured at all. Mirrors
     * Python's setup.js applyProviderAvailability.
     */
    function applyProviderIndicators(): void {
        const providerSel = root.querySelector<HTMLSelectElement>('#provider');
        if (!providerSel) return;
        const available: HTMLOptionElement[] = [];
        const unavailable: HTMLOptionElement[] = [];
        for (const opt of Array.from(providerSel.options)) {
            let info = providerStatus?.[opt.value];
            // Ollama: trust the direct /ollama probe (capabilities) over the app
            // backend's report. A browser dev preview talks to Hono, which
            // hardcodes ollama-unavailable; but a local daemon reached via the
            // /ollama proxy is genuinely usable, so don't ✘ a running Ollama.
            // (Web mode hides Ollama upstream, so this only bites in local mode.)
            if (opt.value === 'ollama' && capabilitiesSync().ollama) info = { available: true };
            opt.textContent = (opt.textContent ?? '').replace(/ [✘✱]$/, '');
            opt.classList.remove('provider-unavailable');
            const needsKeyMissing =
                providerNeedsKey(opt.value as Provider) && keyPresent[opt.value] === false;
            if (needsKeyMissing) {
                // API provider with no key stored — not runnable until a key is
                // added (in Settings). Mark ✘ and sort to the unavailable group.
                opt.classList.add('provider-unavailable');
                opt.textContent += ' ✘';
                unavailable.push(opt);
            } else if (info && !info.available) {
                if (info.installed) {
                    // Installed but not running — still selectable; sorts with
                    // the available group under a subtle marker.
                    opt.textContent += ' ✱';
                    available.push(opt);
                } else {
                    opt.classList.add('provider-unavailable');
                    opt.textContent += ' ✘';
                    unavailable.push(opt);
                }
            } else {
                available.push(opt);
            }
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

    function wireTabBar(): void {
        // Persisted activeTab drives which panel shows on (re)render.
        applyTabSelection(setup.meditationType);
        root.querySelectorAll<HTMLButtonElement>('.tab-bar .tab-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const tab = btn.dataset['tab'];
                if (tab !== 'exploration' && tab !== 'noting') return;
                if (setup.meditationType === tab) return;
                setup.meditationType = tab;
                persist();
                applyTabSelection(tab);
                // Switching to/from noting changes whether an LLM is needed.
                updateBeginButton();
                updateAiAvailability();
                // ...and changes the estimate (noting applies the 0.4 multiplier).
                updateSessionEstimate();
            });
        });
    }

    function applyTabSelection(active: 'exploration' | 'noting'): void {
        root.querySelectorAll<HTMLElement>('.tab-bar .tab-btn').forEach((btn) => {
            btn.classList.toggle('active', btn.dataset['tab'] === active);
        });
        const exploration = root.querySelector<HTMLElement>('#exploration-panel');
        const noting = root.querySelector<HTMLElement>('#noting-panel');
        if (exploration) exploration.classList.toggle('hidden', active !== 'exploration');
        if (noting) noting.classList.toggle('hidden', active !== 'noting');
    }

    /**
     * Wire the `?` info buttons. The tour module (./tour/index-guide.ts)
     * installs a single delegated document-level handler that drives all
     * `.info-btn[data-info]` clicks with the accordion-style toggle
     * (clicking one info button closes any other open panels). It also
     * suppresses the toggle while the guided tour is active so the tour
     * controls the open panel. Matches Python's setup.js delegation.
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
    // Lifted from setup.js + the lifted .participant-* CSS so layout, sizing,
    // and the stepper/slider/phrase widths match the original exactly.
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
        updateAiAvailability();
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
            const audio = new Audio(`/audio/${encodeURIComponent(name)}.mp3`);
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
    // when the user has already dismissed, completed, or used the app —
    // matches Python's setup.js bottom-of-file call.
    void autoStartGuide();

    return {
        async show() {
            render();
            await loadVoiceCatalog();
            void autoStartGuide();
        },
        hide() {
            closeGuideIfActive();
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

    // Mirror Python's index.html: presets are radio inputs wrapped in
    // labels styled as cards. The radio is visually hidden by the CSS
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
            <button type="button" class="info-btn" data-info="methods" aria-label="About meditation methods">?</button>
        </div>
        <div class="info-panel hidden" id="info-methods">
            <p><strong>exploration</strong>: this is a dyadic meditation format where the meditator speaks about what they are experiencing in the moment and the facilitator asks brief questions to help the meditator explore.</p>
            <p>in this mode, you optionally set an intention and then mix and match <strong>attention focuses</strong> (body, emotions, parts work) with <strong>vibes</strong> (playful, compassionate, loving, spacious, effortless, feel-good). presets give you quick starting points, or you can build your own style. there's a directiveness slider so you can dial in how much guidance you want. in my personal experience, this sort of exploration has been helpful in experiencing jhana states if approached with enough openheartedness.</p>
            <p>thanks to <a href="https://lovingawakening.net/" target="_blank" rel="noopener">Maija Haavisto</a> and <a href="https://www.jhourney.io/" target="_blank" rel="noopener">Jhourney</a> for guiding me in similar practices.</p>
            <p><strong>noting</strong>: you specify what participants you'd like, if any &mdash; AIs, fixed phrases, or sound effects. then starting with you, each participant notes a sensation in their "awareness" (ideally 1&ndash;2 words) or plays their fixed phrase or sound. yes, AIs noting their experience seems kind of silly, but I've actually found it helpful to observe the mental and somatic processes that happen in the cycle of resting -&gt; hearing my cue -&gt; observing -&gt; speaking. if there are no other participants, it'll just briefly introduce the method and then record what you note.</p>
            <p>thanks to <a href="https://www.buddhistgeeks.org/" target="_blank" rel="noopener">Vince Horn</a> and again to <a href="https://www.jhourney.io/" target="_blank" rel="noopener">Jhourney</a> for inspiration.</p>
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
                    <button type="button" id="setup-voice-btn" class="setup-voice-btn">Default</button>
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
                <p class="credit-rate-legend">Voices use fewer ☁️ in noting mode — participants speak brief labels, not full sentences.</p>
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

        <div class="form-row form-row-thirds">
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
            <div class="form-group">
                <label for="setup-stt-engine">Speech Recognition</label>
                <select id="setup-stt-engine">${sttSetupOptions}</select>
            </div>
        </div>

        <p id="ai-inactive-note" class="credit-rate-legend hidden">No AI participants in this circle — the AI model isn't used.</p>

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
         the voice-modal chrome + .voice-row list styling. Lifted from the
         Flask sound-modal. -->
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
            <p class="session-estimate" id="session-estimate"></p>
            <button id="begin-btn" type="button"
                class="btn btn-primary btn-begin">Begin Session</button>
        </div>
    </div>`;
}

/**
 * Settings view: LLM provider + BYOK keys, language & speech recognition,
 * text-to-speech, display, pacing, session history, a collapsed Advanced shelf
 * for expert toggles, updates, and a dev-mode-only Developer section.
 *
 * Every control auto-applies and persists (Display is the exception - see
 * wireDisplaySection). Keys persist into the same api-keys store the setup
 * view reads.
 */

import {
    type AppSettings,
    type ThemeMode,
    type TtsEngineChoice,
    type SttEngineChoice,
    LANGUAGES,
    applyChromeSettings,
    loadAppSettings,
    saveAppSettings,
} from '../app-settings.js';
import { sttEngineOptions, resolveSttChoice, isHostedSttChoice } from '../adapters/stt-picker.js';
import { t, setUiLang, LANGUAGE_CHANGED_EVENT } from '../i18n.js';
import { ALL_PROVIDERS, isProviderAvailable, providerNeedsKey, type Provider } from '../settings.js';
import { isCapacitor, isDesktopSync, isTauri } from '../is-desktop.js';
import { detectCapabilities, capabilitiesSync } from '../capabilities.js';
import {
    isWebMode,
    isDevBypass,
    devGetModeOverride,
    devSetModeOverride,
    devSetCloudBypass,
    type AppMode,
} from '../app-mode.js';
import {
    isDevMode,
    getCheckinDebugSetting,
    setCheckinDebug,
    isAecOffDebug,
    setAecOffDebug,
    getJevClassifierMode,
    setJevClassifierMode,
    type JevClassifierMode,
} from '../dev-mode.js';
import {
    CLOUD_FAULT_NAMES,
    STT_FAULTS,
    getCloudFault,
    setCloudFault,
    getSttFault,
    setSttFault,
    getNoVoices,
    setNoVoices,
    renderSimBanner,
    type CloudFault,
    type SttFault,
} from '../dev-sim.js';
import { MIC_SIM_STATUSES, getSimMic, setSimMic, type MicStatus } from '../mic-check.js';
import { appUrl } from '../app-base.js';
import { openAbout, PREVIEW_UPDATE_KEY } from '../about.js';
import {
    computeProviderMarker,
    fetchKeyPresence,
    fetchProviderStatus,
    stripMarker,
    type ProviderStatusMap,
} from '../provider-markers.js';
import { getApiKey, setApiKey } from '../api-keys.js';
import { mountModelPicker } from '../model-picker.js';
import { mountOllamaSettings } from '../settings-ollama.js';
import {
    downloadVoiceFromRow,
    invalidateServerVoicesCache,
    loadScoredVoices,
    prefixedVoiceId,
    previewVoice as runPreview,
    previewErrorMessage,
    renderVoiceList,
    renderVoiceModalHTML,
    stripVoicePrefix,
    syncSpeedControlForVoice,
    voiceRateLabel,
    stopPreview,
    uninstallVoiceModel,
    updateVoiceSelection,
    type ScoredVoice,
} from '../voice-picker.js';
import { escapeHtml } from '../escape-html.js';
import { readNdjson } from '../ndjson.js';
import { browserVoicesSettled } from '../voices.js';
import { resetAndStart as resetSettingsTour } from '../tour/settings-tour.js';
import { confirmDialog, alertDialog } from '../dialog.js';
import {
    VOICE_COMMANDS_ALWAYS_ON,
    VOICE_COMMANDS_CONSENT,
    VOICE_COMMANDS_NEEDS_ACCOUNT,
    canReachJudge,
    privacyPolicyLink,
    showVoiceCommandExamples,
} from '../voice-commands.js';
import { showSavedTick } from '../toast.js';

export interface SettingsViewHandle {
    show(): Promise<void>;
}

export async function mountSettingsView(root: HTMLElement): Promise<SettingsViewHandle> {
    const settings = await loadAppSettings();
    // Before first render so the provider menu shows only what's reachable
    // (also populates the is-desktop cache the env-var hints + config-folder
    // link read).
    await detectCapabilities();
    let scoredVoices: ScoredVoice[] = [];

    // There's no global Save; controls auto-apply. Display is the exception -
    // live-resizing the UI mid-drag is disorienting, so those stay in the
    // preview pane until "Apply". The bottom-bar button is Undo, reverting to
    // the state at view open.
    const pendingChrome = pickChrome(settings);

    // Backs the ⚙/✱ markers and the status hint, from /app/v1/providers plus
    // the BYOK key store (see provider-markers.ts). Unlike setup, settings only
    // annotates: it never reorders or auto-switches the saved default.
    let providerStatus: ProviderStatusMap | null = null;
    let keyPresent: Record<string, boolean> = {};

    const ELEVENLABS_KEY_STORE = 'apikey:elevenlabs';

    /**
     * Serialized view of everything Undo reverts: AppSettings except ttsEngine
     * ("Manage TTS Engines" picks which engine to configure, not a change worth
     * undoing), plus the ElevenLabs key, which lives in its own store.
     */
    function undoSnapshot(): string {
        const comparable: Partial<AppSettings> = { ...settings };
        delete comparable.ttsEngine;
        return JSON.stringify({
            s: comparable,
            elevenKey: localStorage.getItem(ELEVENLABS_KEY_STORE),
        });
    }

    // Entry snapshot for Undo. Safe to take here: unlike setup's, this
    // loadVoiceCatalog doesn't mutate settings.
    const baseline = undoSnapshot();

    // A debounced tick acknowledges each settled change, since there's no Save
    // button. Quiet during mount/refresh (self-repair persists aren't the user
    // saving anything) and during Display Apply, which has its own flash.
    let announceSaves = false;
    let savedTickTimer: number | undefined;

    function persist(): void {
        void saveAppSettings(settings);
        updateUndoState();
        if (announceSaves) {
            clearTimeout(savedTickTimer);
            savedTickTimer = window.setTimeout(() => showSavedTick(), 400);
        }
    }

    /** Has anything Undo reverts drifted from the entry snapshot? */
    function isUndoable(): boolean {
        return undoSnapshot() !== baseline;
    }

    /** Reflect Undo availability on the bottom-bar button. */
    function updateUndoState(): void {
        const undoBtn = root.querySelector<HTMLButtonElement>('#s-undo');
        if (undoBtn) undoBtn.disabled = !isUndoable();
    }

    /** Are the Display controls showing an un-applied change? */
    function isDisplayDirty(): boolean {
        return (Object.keys(pendingChrome) as Array<keyof ChromePrefs>).some(
            (k) => pendingChrome[k] !== settings[k]
        );
    }

    /** Enable the Display "Apply" button only when there's a pending change. */
    function updateApplyDisplayState(): void {
        const applyBtn = root.querySelector<HTMLButtonElement>('#s-apply-display');
        if (applyBtn) applyBtn.disabled = !isDisplayDirty();
    }

    async function refresh(): Promise<void> {
        announceSaves = false;
        root.innerHTML = renderHTML(settings);
        wire();
        await loadVoiceCatalog();
        await refreshApiKeyRows();
        await refreshProviderMarkers();
        // The grace period covers stragglers like the browser-voices repair
        // (async, can persist() after this resolves) so view-open self-repairs
        // never toast.
        setTimeout(() => {
            announceSaves = true;
        }, 1000);
    }

    function wire(): void {
        wireProviderSection();
        wireLanguageSection();
        wireTtsSection();
        wireDisplaySection();
        wirePacingSection();
        wireSessionLogsSection();
        wireUpdatesSection();
        wireAdvancedReveal();
        wireDeveloperSection();
        wireFooter();
    }

    function wireInfoToggle(btnId: string, panelId: string): void {
        const panel = root.querySelector<HTMLElement>(`#${panelId}`);
        root.querySelector(`#${btnId}`)?.addEventListener('click', () => {
            panel?.classList.toggle('hidden');
        });
    }

    // ---- Provider section ----------------------------------------------

    function wireProviderSection(): void {
        const providerSel = root.querySelector<HTMLSelectElement>('#s-provider')!;
        providerSel.value = settings.defaultProvider;
        // The saved default may not exist in this mode (a fresh web build
        // defaults to 'ollama', filtered out of the web menu), and setting
        // .value to a missing option leaves the <select> blank. Fall back to
        // the first available provider and persist.
        if (providerSel.value !== settings.defaultProvider) {
            settings.defaultProvider = (providerSel.options[0]?.value ??
                settings.defaultProvider) as Provider;
            providerSel.value = settings.defaultProvider;
            persist();
        }
        providerSel.addEventListener('change', () => {
            settings.defaultProvider = providerSel.value as Provider;
            persist();
            void refreshApiKeyRows();
            void modelPicker.refresh(settings.defaultProvider);
            syncOllamaSection();
            updateNonstreamVisibility();
            void syncVoiceCommandsRow();
            // Markers don't change on a mere selection, but the status hint
            // tracks the newly-selected provider.
            updateProviderStatusHint();
        });

        // Same /app/v1/models/<provider> backing as setup; falls back to a text
        // input when the app backend isn't there.
        const modelContainer = root.querySelector<HTMLElement>('#s-model-slot')!;
        const modelPicker = mountModelPicker(
            modelContainer,
            settings.defaultProvider,
            settings.defaultModel,
            (value) => {
                settings.defaultModel = value;
                persist();
            }
        );

        // Ollama recommendation + installed-model management, mounted once and
        // shown only while Ollama is selected. On web it must never mount at
        // all (a harder guarantee than hiding it): Ollama is a local daemon and
        // is filtered out of the web menu entirely.
        const recEl = isWebMode() ? null : root.querySelector<HTMLElement>('#s-ollama-recommendation');
        const ollamaHandle = recEl
            ? mountOllamaSettings(recEl, {
                  // A pull/remove leaves the model dropdown stale.
                  onModelsChanged: () => modelPicker.refresh(settings.defaultProvider),
              })
            : null;
        const syncOllamaSection = (): void => {
            if (!ollamaHandle) return;
            if (settings.defaultProvider === 'ollama') void ollamaHandle.refresh();
            else ollamaHandle.hide();
        };
        syncOllamaSection();

        // Per-provider API key rows: input, "Get a key" link, and a Paste
        // button when the browser exposes the clipboard API.
        for (const p of ALL_PROVIDERS) {
            if (!p.needsKey) continue;
            const cfg = API_KEY_INFO[p.value];
            if (!cfg) continue;
            attachApiKeyHelpers(p.value, cfg.url, cfg.prefix);
        }

        wireInfoToggle('llm-info-btn', 'llm-info-panel');

        // BYOK opt-in (hosted build only): rebuild the menu live so key-based
        // providers appear/disappear without a reload.
        const byokToggle = root.querySelector<HTMLInputElement>('#s-enable-byok');
        byokToggle?.addEventListener('change', () => {
            settings.enableByok = byokToggle.checked;
            persist();
            providerSel.innerHTML = providerOptionsHTML(settings);
            // If the selected default was a BYOK provider that just vanished,
            // fall back to whatever's now first.
            if (providerSel.value !== settings.defaultProvider && providerSel.value) {
                settings.defaultProvider = providerSel.value as Provider;
                persist();
                void refreshApiKeyRows();
                void modelPicker.refresh(settings.defaultProvider);
            }
            // Newly-shown BYOK providers get ⚙ until a key is entered.
            applyProviderMarkers();
        });
    }

    /**
     * Fetch provider availability + BYOK key presence, then annotate the menu
     * and status hint. Called on mount and after anything that can flip
     * availability. Network failures leave the menu unmarked, never blocked.
     */
    async function refreshProviderMarkers(): Promise<void> {
        const [statusResult, keys] = await Promise.all([
            fetchProviderStatus(),
            fetchKeyPresence(),
        ]);
        keyPresent = keys;
        if (statusResult) providerStatus = statusResult;
        applyProviderMarkers();
    }

    /**
     * Annotate the <option>s with ⚙/✱ from cached status and refresh the hint.
     * Pure DOM + cached state, so it's safe after a menu rebuild. Unlike
     * setup's applyProviderIndicators it does NOT reorder or auto-select: a
     * settings default shouldn't change out from under the user.
     */
    function applyProviderMarkers(): void {
        const sel = root.querySelector<HTMLSelectElement>('#s-provider');
        if (sel) {
            for (const opt of Array.from(sel.options)) {
                const { suffix } = computeProviderMarker(
                    opt.value,
                    providerStatus,
                    keyPresent
                );
                opt.textContent = stripMarker(opt.textContent ?? '') + suffix;
            }
        }
        updateProviderStatusHint();
    }

    /**
     * Surface why the selected default provider can't run: missing BYOK key,
     * claude_proxy without the `claude` CLI logged in, stopped Ollama. Reuses
     * each provider's backend hint (claude_proxy's comes from the Rust
     * /providers handler). Hidden when the provider is usable.
     */
    function updateProviderStatusHint(): void {
        const statusEl = root.querySelector<HTMLElement>('#s-provider-status');
        if (!statusEl) return;
        const p = settings.defaultProvider;
        const { suffix } = computeProviderMarker(p, providerStatus, keyPresent);
        let msg = '';
        if (suffix) {
            if (providerNeedsKey(p) && keyPresent[p] === false) {
                msg = t('Selected provider has no API key. Paste one above before starting a session.');
            } else {
                msg = providerStatus?.[p]?.hint ?? '';
            }
        }
        statusEl.textContent = msg;
        statusEl.classList.toggle('hidden', !msg);
    }

    /**
     * Unhide only the active provider's .api-key-group row and refresh its
     * saved/empty status text.
     */
    async function refreshApiKeyRows(): Promise<void> {
        const active = settings.defaultProvider;
        for (const p of ALL_PROVIDERS) {
            const row = root.querySelector<HTMLElement>(`#s-key-row-${p.value}`);
            if (!row) continue;
            const isActiveBYOK = p.needsKey && p.value === active;
            row.classList.toggle('hidden', !isActiveBYOK);
            if (!isActiveBYOK) continue;
            const status = row.querySelector<HTMLElement>('.api-key-status');
            const existing = await getApiKey(p.value);
            // Masked rather than a bare "Saved", so the user can recognize
            // which key is stored without exposing it.
            if (status)
                status.textContent = existing
                    ? t('key saved ({masked})', { masked: maskKey(existing) })
                    : '';
            const removeBtn = row.querySelector<HTMLButtonElement>('.api-key-remove-btn');
            if (removeBtn) removeBtn.hidden = !existing;
        }
        // An added/removed key flips a provider's ⚙ marker and the hint. Cheap:
        // re-reads the local key store, no network.
        keyPresent = await fetchKeyPresence();
        applyProviderMarkers();
    }

    // ---- API key helpers (Get a key + Paste) ---------------------------

    /**
     * The helper strip every key row gets: a "Get a key" link (an <a>, so the
     * desktop webview routes it to the system browser) and a status line,
     * appended after the input. Callers add their own buttons to `actions`.
     */
    function mountKeyHelpers(
        input: HTMLInputElement,
        url: string
    ): { actions: HTMLElement; status: HTMLElement } | null {
        const row = input.parentElement;
        if (!row) return null;
        row.classList.add('has-key-helper');

        const actions = document.createElement('div');
        actions.className = 'api-key-actions';
        const getBtn = document.createElement('a');
        getBtn.href = url;
        getBtn.target = '_blank';
        getBtn.rel = 'noopener noreferrer';
        getBtn.className = 'btn btn-small btn-secondary api-key-open-btn';
        getBtn.textContent = t('Get a key ↗');
        getBtn.title = url;
        actions.appendChild(getBtn);

        const status = document.createElement('span');
        status.className = 'api-key-paste-status';
        row.append(actions, status);
        return { actions, status };
    }

    function addKeyButton(actions: HTMLElement, className: string, label: string): HTMLButtonElement {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn btn-small btn-secondary ${className}`;
        btn.textContent = label;
        actions.appendChild(btn);
        return btn;
    }

    /**
     * A provider key row: "Get a key", Paste (when the browser exposes the
     * clipboard API), and Remove, each saving into the api-keys store.
     */
    function attachApiKeyHelpers(provider: Provider, url: string, prefix: string): void {
        const input = root.querySelector<HTMLInputElement>(`#s-key-${provider}`);
        if (!input) return;
        const strip = mountKeyHelpers(input, url);
        if (!strip) return;
        const { actions, status } = strip;
        const shortcut = pasteShortcut();

        // Reads can still fail at runtime (some Safari, the desktop WKWebView),
        // in which case we fall back to a manual ⌘V/Ctrl+V placeholder hint.
        if (hasClipboard()) {
            const paste = addKeyButton(actions, 'api-key-paste-btn', t('Paste'));
            paste.title = t('Paste from clipboard');

            const markPasteUnavailable = (): void => {
                if (paste.dataset['unavailable']) return;
                paste.dataset['unavailable'] = '1';
                paste.disabled = true;
                paste.textContent = t('Paste failed!');
                paste.title = t(
                    'This browser blocked clipboard access. Click the field and press {shortcut} to paste.',
                    { shortcut }
                );
                paste.classList.add('is-unavailable');
                showManualPasteHint(input, shortcut);
            };

            // Chromium exposes clipboard-read via the Permissions API; when
            // it's denied we can mark the button dead up front.
            if (navigator.permissions && 'query' in navigator.permissions) {
                navigator.permissions
                    .query({ name: 'clipboard-read' as PermissionName })
                    .then((r) => {
                        if (r.state === 'denied') markPasteUnavailable();
                    })
                    .catch(() => {
                        /* permission name unsupported; leave active */
                    });
            }

            paste.addEventListener('click', async () => {
                status.textContent = '';
                status.classList.remove('is-warn', 'is-ok');
                try {
                    const text = (await navigator.clipboard.readText()).trim();
                    if (!text) {
                        status.textContent = t('Clipboard is empty.');
                        status.classList.add('is-warn');
                        return;
                    }
                    input.value = text;
                    await setApiKey(provider, text);
                    if (prefix && !text.startsWith(prefix)) {
                        status.textContent = t(
                            'Pasted, but didn\'t start with "{prefix}". Double-check.',
                            { prefix }
                        );
                        status.classList.add('is-warn');
                    } else {
                        status.textContent = t('Pasted ✓');
                        status.classList.add('is-ok');
                    }
                    await refreshApiKeyRows();
                } catch {
                    markPasteUnavailable();
                    status.textContent = '';
                }
            });
        } else {
            showManualPasteHint(input, shortcut);
        }

        // Clearing the field alone doesn't delete (the change handler below
        // only saves non-empty values), hence a Remove button, shown only
        // while a key is stored.
        const remove = addKeyButton(actions, 'api-key-remove-btn', t('Remove'));
        remove.title = t('Delete this stored key');
        remove.hidden = true;
        remove.addEventListener('click', async () => {
            await setApiKey(provider, ''); // empty → backend.delete()
            input.value = '';
            status.textContent = t('Removed');
            status.classList.remove('is-warn', 'is-ok');
            await refreshApiKeyRows();
        });
        void getApiKey(provider).then((k) => {
            remove.hidden = !k;
        });

        // Manual typing keeps the input contents, so the user still sees the
        // key they typed.
        input.addEventListener('change', async () => {
            const raw = input.value.trim();
            if (raw) await setApiKey(provider, raw);
            await refreshApiKeyRows();
        });
    }

    function showManualPasteHint(input: HTMLInputElement, shortcut: string): void {
        if (input.dataset['pasteHintApplied']) return;
        const current = input.placeholder || '';
        input.placeholder = current
            ? `${current} · ${t('{shortcut} to paste', { shortcut })}`
            : t('{shortcut} to paste', { shortcut });
        input.dataset['pasteHintApplied'] = '1';
    }

    // ---- Language & STT ------------------------------------------------

    function updateSttHint(): void {
        const hintEl = root.querySelector<HTMLElement>('#s-stt-engine-hint');
        if (!hintEl) return;
        const hints: Record<SttEngineChoice, string> = {
            whisper: 'Transcribed on this device. Free and private.',
            capacitor: 'Transcribed on your phone. Free, and your speech stays on the device.',
            'web-speech': "Uses your browser's built-in speech recognition. Free.",
            'aloud-gpt-transcribe':
                "Audio is transcribed by aloud's hosted provider and spends credits.",
        };
        hintEl.textContent = t(hints[resolveSttChoice(settings.sttEngine, isWebMode())]);
    }

    /** Model size only matters for on-device Whisper; hide its column for
     *  browser/hosted STT (slot kept, see renderLanguageSection). */
    function updateWhisperVisibility(): void {
        root.querySelector<HTMLElement>('#s-whisper-model-group')?.classList.toggle(
            'slot-hidden',
            resolveSttChoice(settings.sttEngine, isWebMode()) !== 'whisper'
        );
    }

    /** The mic picker and the speculation toggle only apply to the PCM engines
     *  (see pcmSttChosen); Web Speech and the native recognizer own their
     *  capture and have no speculative pass. */
    function updateMicDeviceVisibility(): void {
        const micPickApplies = pcmSttChosen(settings);
        root.querySelector<HTMLElement>('#s-stt-speculation-group')?.classList.toggle('hidden', !micPickApplies);
        const canEnumerate = !!navigator.mediaDevices?.enumerateDevices;
        // `.slot-hidden` (style.css) keeps the column's empty slot at wide
        // widths so Language/Recognition stay at a third each rather than
        // stretching to halves as you toggle STT, and collapses to
        // display:none once the row stacks.
        root.querySelector<HTMLElement>('#s-mic-device-group')?.classList.toggle(
            'slot-hidden',
            !micPickApplies || !canEnumerate
        );
    }

    /** Fill the mic select with the current audio inputs. Device labels are
     *  blank until the page has held mic permission, so `withPermission` (set
     *  when the user actually opens the picker) briefly requests the mic to
     *  unlock them - never on plain page load. */
    async function populateMicDevices(withPermission: boolean): Promise<void> {
        const sel = root.querySelector<HTMLSelectElement>('#s-mic-device');
        if (!sel || !navigator.mediaDevices?.enumerateDevices) return;
        const inputs = async (): Promise<MediaDeviceInfo[]> =>
            (await navigator.mediaDevices.enumerateDevices()).filter(
                // Chrome adds 'default'/'communications' pseudo-devices that
                // shadow a real one; the "System default" option covers those.
                (d) =>
                    d.kind === 'audioinput' &&
                    d.deviceId !== 'default' &&
                    d.deviceId !== 'communications'
            );
        let devices: MediaDeviceInfo[] = [];
        try {
            devices = await inputs();
            if (withPermission && devices.some((d) => !d.label)) {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                for (const t of stream.getTracks()) t.stop();
                devices = await inputs();
            }
        } catch {
            // enumeration failed or permission denied - keep what we have
        }
        const stored = settings.micDeviceId ?? '';
        sel.innerHTML =
            `<option value="">${t('System default')}</option>` +
            devices
                .map(
                    (d, i) =>
                        `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || t('Microphone {n}', { n: i + 1 }))}</option>`
                )
                .join('');
        // Show the stored pick when its device is present; otherwise display
        // the default WITHOUT persisting a repair - the mic may just be
        // unplugged right now, and capture uses `ideal` so nothing breaks.
        sel.value = devices.some((d) => d.deviceId === stored) ? stored : '';
    }

    function wireMicDeviceRow(): void {
        const sel = root.querySelector<HTMLSelectElement>('#s-mic-device');
        if (!sel) return;
        updateMicDeviceVisibility();
        void populateMicDevices(false);
        // Unlock real labels only on user intent (opening the picker).
        const unlock = (): void => void populateMicDevices(true);
        sel.addEventListener('pointerdown', unlock, { once: true });
        sel.addEventListener('change', () => {
            settings.micDeviceId = sel.value || null;
            persist();
        });
    }

    interface WhisperModelInfo {
        size: string;
        installed: boolean;
        approx_download_mb: number;
    }
    let whisperModels: WhisperModelInfo[] = [];
    let whisperDownloadBusy = false;

    /** Badge each Whisper size with its on-disk state for the current
     *  language ("downloaded" / download size) and point the action button at
     *  the selected size. Desktop only (the local shell owns the models dir);
     *  plain labels + no button when the backend is down. */
    async function refreshWhisperModelBadges(): Promise<void> {
        const sel = root.querySelector<HTMLSelectElement>('#s-whisper-model');
        if (!sel || !isTauri()) return;
        try {
            const res = await fetch(
                appUrl(`/stt/whisper/models?lang=${encodeURIComponent(settings.language)}`)
            );
            if (!res.ok) return;
            ({ models: whisperModels } = (await res.json()) as { models: WhisperModelInfo[] });
            for (const m of whisperModels) {
                const opt = sel.querySelector<HTMLOptionElement>(`option[value="${m.size}"]`);
                if (!opt) continue;
                // Stash the plain label once so re-badging (language change)
                // replaces the suffix instead of stacking suffixes.
                const label = (opt.dataset['label'] ??= opt.textContent ?? '');
                opt.textContent = m.installed
                    ? t('{label} - downloaded', { label })
                    : t('{label} - {mb} MB download', { label, mb: m.approx_download_mb });
            }
        } catch {
            return; // backend down - keep plain labels, leave the button hidden
        }
        updateWhisperModelAction();
    }

    /** Point the Download/Remove button at the currently selected size. */
    function updateWhisperModelAction(): void {
        const btn = root.querySelector<HTMLButtonElement>('#s-whisper-model-action');
        if (!btn || whisperDownloadBusy) return;
        const info = whisperModels.find((m) => m.size === settings.sttWhisperModel);
        if (!info) {
            btn.classList.add('hidden');
            return;
        }
        btn.classList.remove('hidden');
        btn.disabled = false;
        btn.textContent = info.installed
            ? t('Remove download')
            : t('Download now ({mb} MB)', { mb: info.approx_download_mb });
        btn.dataset['action'] = info.installed ? 'remove' : 'download';
    }

    /** Pre-fetch the selected model, showing progress on the button. */
    async function downloadWhisperModel(btn: HTMLButtonElement): Promise<void> {
        const statusEl = root.querySelector<HTMLElement>('#s-whisper-model-status');
        whisperDownloadBusy = true;
        btn.disabled = true;
        btn.textContent = t('Downloading…');
        try {
            const resp = await fetch(appUrl('/stt/whisper/download-model'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ size: settings.sttWhisperModel, lang: settings.language }),
            });
            if (!resp.ok || !resp.body) throw new Error(`server returned ${resp.status}`);
            await readNdjson(
                resp.body,
                (msg) => {
                    if (msg.status === 'downloading' && msg.total) {
                        btn.textContent = t('Downloading… {pct}%', {
                            pct: Math.round(((msg.completed ?? 0) / msg.total) * 100),
                        });
                    }
                },
                'download failed'
            );
            statusEl?.classList.add('hidden');
        } catch (err) {
            if (statusEl) {
                statusEl.textContent =
                    err instanceof Error ? err.message : t('Download failed.');
                statusEl.classList.remove('hidden');
            }
        } finally {
            whisperDownloadBusy = false;
            void refreshWhisperModelBadges();
        }
    }

    async function removeWhisperModel(): Promise<void> {
        const ok = await confirmDialog(
            t('Remove this speech model from disk? It re-downloads if a session needs it.'),
            { okLabel: t('Remove'), danger: true }
        );
        if (!ok) return;
        try {
            await fetch(appUrl('/stt/whisper/remove-model'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ size: settings.sttWhisperModel, lang: settings.language }),
            });
        } catch {
            // refresh below shows the real state either way
        }
        void refreshWhisperModelBadges();
    }

    function wireLanguageSection(): void {
        const langSel = root.querySelector<HTMLSelectElement>('#s-language')!;
        langSel.value = settings.language;
        langSel.addEventListener('change', () => {
            settings.language = langSel.value;
            persist();
            // The UI follows the session language. app.ts hears this event,
            // re-translates the chrome, and remounts this view - so nothing
            // after the dispatch should touch the DOM being replaced.
            setUiLang(settings.language);
            window.dispatchEvent(new Event(LANGUAGE_CHANGED_EVENT));
        });

        const sttSel = root.querySelector<HTMLSelectElement>('#s-stt-engine');
        if (sttSel) {
            // resolveSttChoice handles a null or stale-for-this-mode value.
            sttSel.value = resolveSttChoice(settings.sttEngine, isWebMode());
            updateSttHint();
            updateWhisperVisibility();
            sttSel.addEventListener('change', () => {
                settings.sttEngine = sttSel.value as SttEngineChoice;
                persist();
                updateSttHint();
                updateWhisperVisibility();
                updateMicDeviceVisibility();
            });
        }
        wireMicDeviceRow();

        const whisperSel = root.querySelector<HTMLSelectElement>('#s-whisper-model')!;
        whisperSel.value = settings.sttWhisperModel;
        whisperSel.addEventListener('change', () => {
            settings.sttWhisperModel = whisperSel.value as AppSettings['sttWhisperModel'];
            persist();
            updateWhisperModelAction();
        });
        const actionBtn = root.querySelector<HTMLButtonElement>('#s-whisper-model-action');
        actionBtn?.addEventListener('click', () => {
            if (actionBtn.dataset['action'] === 'remove') void removeWhisperModel();
            else void downloadWhisperModel(actionBtn);
        });
        void refreshWhisperModelBadges();
    }

    // ---- TTS section ---------------------------------------------------

    function wireTtsSection(): void {
        const engineSel = root.querySelector<HTMLSelectElement>('#s-tts-engine')!;
        engineSel.value = settings.ttsEngine;
        // A stored engine this platform doesn't offer (e.g. 'macos' persisted
        // before the list was platform-gated) leaves the select blank - snap
        // to the first offered engine and persist the repair. Safe: the field
        // only drives this management UI, not which voice speaks.
        if (engineSel.value !== settings.ttsEngine) {
            engineSel.selectedIndex = 0;
            settings.ttsEngine = engineSel.value as TtsEngineChoice;
            persist();
        }
        // Browser speechSynthesis with zero voices (typical in the Android
        // WebView) is a dead engine - drop the option once the async voice
        // list settles, snapping the selection off it if needed.
        void browserVoicesSettled().then((voices) => {
            if (voices.length > 0) return;
            engineSel.querySelector('option[value="browser"]')?.remove();
            if (settings.ttsEngine === 'browser' && engineSel.options.length > 0) {
                engineSel.selectedIndex = 0;
                settings.ttsEngine = engineSel.value as TtsEngineChoice;
                persist();
                refreshElevenLabsRow();
                updateTtsEngineHint();
            }
        });
        engineSel.addEventListener('change', () => {
            settings.ttsEngine = engineSel.value as TtsEngineChoice;
            persist();
            refreshElevenLabsRow();
            updateTtsEngineHint();
        });
        updateTtsEngineHint();

        const voiceBtn = root.querySelector<HTMLButtonElement>('#s-voice-btn')!;
        updateVoiceButtonLabel(voiceBtn);
        voiceBtn.addEventListener('click', () => openVoiceModal(voiceBtn));

        wireInfoToggle('tts-info-btn', 'tts-info-panel');

        // Visible only when TTS = elevenlabs.
        attachElevenLabsKeyHelpers();
        refreshElevenLabsRow();
    }

    /**
     * Engine-specific hint below the TTS dropdown. On a Mac with macOS TTS it
     * carries the "Download Premium voices" CTA, the main route to good voices
     * on Apple Silicon.
     */
    function updateTtsEngineHint(): void {
        const hintEl = root.querySelector<HTMLElement>('#s-tts-engine-hint');
        if (!hintEl) return;
        const openSettingsLink = isDesktopSync()
            ? ` <a href="#" data-open-voice-settings>${t('Download Premium voices')}</a>. ${t('In the System Voice row, click the <b>ⓘ</b> then click Voice.')}`
            : '';
        const hints: Record<TtsEngineChoice, string> = {
            cloud: t('Natural hosted voices, metered from your credit balance. Pick one in Manage Voices - the ☁️ entries.'),
            macos:
                t('Built-in macOS voices. Zero latency, works offline.') +
                (isMacPlatform() ? openSettingsLink : ''),
            browser:
                t("Uses your browser's built-in speech synthesis. On Windows, Edge and the desktop app include high-quality natural voices."),
            elevenlabs:
                t('Cloud neural TTS with natural, expressive voices. Requires an API key and internet.'),
            piper:
                t('Fast local neural TTS. Download voice models (~60–100 MB each) from the voice picker.') +
                ` <a href="https://rhasspy.github.io/piper-samples/" target="_blank" rel="noopener">${t('Listen to samples')}</a>`,
        };
        hintEl.innerHTML = hints[settings.ttsEngine];
        // /app/v1/open-voice-settings opens macOS System Settings straight to
        // Accessibility → Spoken Content.
        const link = hintEl.querySelector<HTMLAnchorElement>('[data-open-voice-settings]');
        if (link) {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                void fetch(appUrl('/open-voice-settings'), { method: 'POST' });
            });
        }
    }

    function refreshElevenLabsRow(): void {
        const row = root.querySelector<HTMLElement>('#s-elevenlabs-key-row');
        if (!row) return;
        row.classList.toggle('hidden', settings.ttsEngine !== 'elevenlabs');
    }

    /**
     * The ElevenLabs key row. Same helpers as the LLM key rows, but the key
     * isn't a Provider, so it lives straight in localStorage (and in Undo).
     */
    function attachElevenLabsKeyHelpers(): void {
        const input = root.querySelector<HTMLInputElement>('#s-elevenlabs-key');
        if (!input) return;
        const strip = mountKeyHelpers(input, ELEVENLABS_KEY_INFO.url);
        if (!strip) return;
        const { actions, status } = strip;
        const { prefix } = ELEVENLABS_KEY_INFO;

        if (hasClipboard()) {
            const paste = addKeyButton(actions, 'api-key-paste-btn', t('Paste'));
            const shortcut = pasteShortcut();
            paste.addEventListener('click', async () => {
                try {
                    const text = (await navigator.clipboard.readText()).trim();
                    if (!text) {
                        status.textContent = t('Clipboard is empty.');
                        status.classList.add('is-warn');
                        return;
                    }
                    input.value = text;
                    localStorage.setItem(ELEVENLABS_KEY_STORE, text);
                    updateUndoState();
                    if (prefix && !text.startsWith(prefix)) {
                        status.textContent = t('Pasted, but didn\'t start with "{prefix}".', { prefix });
                        status.classList.add('is-warn');
                    } else {
                        status.textContent = t('Pasted ✓');
                        status.classList.add('is-ok');
                    }
                } catch {
                    paste.disabled = true;
                    paste.textContent = t('Paste failed!');
                    paste.title = t('Click the field and press {shortcut} to paste.', { shortcut });
                    if (!input.dataset['pasteHintApplied']) {
                        input.placeholder = t('{shortcut} to paste', { shortcut });
                        input.dataset['pasteHintApplied'] = '1';
                    }
                }
            });
        }

        input.addEventListener('change', () => {
            const raw = input.value.trim();
            if (raw) localStorage.setItem(ELEVENLABS_KEY_STORE, raw);
            else localStorage.removeItem(ELEVENLABS_KEY_STORE);
            updateUndoState();
        });

        if (localStorage.getItem(ELEVENLABS_KEY_STORE)) input.placeholder = t('Saved, type to replace');
    }

    /**
     * Uninstall a downloaded Piper voice, then re-fetch so the row flips back
     * to "Download".
     */
    async function uninstallVoice(
        btn: HTMLButtonElement,
        name: string,
        engine: string | undefined
    ): Promise<void> {
        if (!(await confirmDialog(t('Uninstall the voice "{name}"?', { name }), { okLabel: t('Uninstall'), danger: true })))
            return;
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = t('Removing…');
        try {
            await uninstallVoiceModel(name, engine);
        } catch (err) {
            btn.disabled = false;
            btn.textContent = original ?? t('Uninstall');
            void alertDialog(t('Could not uninstall: {message}', { message: (err as Error).message }));
            return;
        }
        await refreshVoiceList();
    }

    /**
     * Download a Piper voice model with live percent on the button. On success
     * the list re-renders, so the voice and any speakers sharing its model flip
     * to a selectable, uninstallable state.
     */
    async function downloadVoice(
        btn: HTMLButtonElement,
        name: string,
        engine: string | undefined
    ): Promise<void> {
        const listEl = root.querySelector<HTMLElement>('#settings-voice-modal-list');
        if (await downloadVoiceFromRow(listEl, btn, name, engine)) await refreshVoiceList();
    }

    /** Drop the cached voice list, re-fetch, and re-render the modal list. */
    async function refreshVoiceList(): Promise<void> {
        invalidateServerVoicesCache();
        await loadVoiceCatalog();
        const listEl = root.querySelector<HTMLElement>('#settings-voice-modal-list');
        if (listEl) {
            renderVoiceList(listEl, scoredVoices, stripVoicePrefix(settings.defaultVoice), {
                showEngine: true,
                showUninstall: true,
            });
        }
    }

    async function loadVoiceCatalog(): Promise<void> {
        // App-level language here: this picker edits the app default voice.
        scoredVoices = await loadScoredVoices(settings.language);
        const btn = root.querySelector<HTMLButtonElement>('#s-voice-btn');
        if (btn) updateVoiceButtonLabel(btn);
    }

    function updateVoiceButtonLabel(btn: HTMLButtonElement): void {
        const name = stripVoicePrefix(settings.defaultVoice);
        if (name) btn.textContent = `${name} · ${voiceRateLabel(name, scoredVoices, settings.defaultTtsRate)}`;
        else btn.textContent = scoredVoices.length > 0 ? t('Choose voice') : t('Default');
    }

    function openVoiceModal(voiceBtn: HTMLButtonElement): void {
        const modal = root.querySelector<HTMLElement>('#settings-voice-modal');
        const listEl = root.querySelector<HTMLElement>('#settings-voice-modal-list');
        const closeBtn = root.querySelector<HTMLButtonElement>('#settings-voice-modal-close');
        const speedSlider = root.querySelector<HTMLInputElement>('#s-tts-rate');
        const speedLabel = root.querySelector<HTMLElement>('#s-tts-rate-label');
        if (!modal || !listEl || !closeBtn || !speedSlider || !speedLabel) return;

        const currentName = stripVoicePrefix(settings.defaultVoice);
        // Settings is the manage-voices surface, so downloaded Piper voices get
        // an Uninstall action here (setup's picker doesn't).
        renderVoiceList(listEl, scoredVoices, currentName, {
            showEngine: true,
            showUninstall: true,
        });
        speedSlider.value = String(settings.defaultTtsRate);
        syncSpeedControlForVoice(speedSlider, speedLabel, currentName, scoredVoices, settings.defaultTtsRate);
        modal.classList.remove('hidden');

        const onListClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const row = target.closest<HTMLElement>('.voice-row');
            if (!row) return;
            const name = row.dataset['voiceName'];
            if (!name) return;
            const entry = scoredVoices.find((v) => v.name === name);
            if (target.closest('.voice-row-preview')) {
                if (row.classList.contains('voice-row-locked')) return;
                runPreview(name, settings.defaultTtsRate, entry?.engine).catch((err) => {
                    void alertDialog(previewErrorMessage(err));
                });
                return;
            }
            const downloadBtn = target.closest<HTMLButtonElement>('.voice-row-download');
            if (downloadBtn) {
                e.preventDefault();
                void downloadVoice(downloadBtn, name, entry?.engine);
                return;
            }
            // The voice flips back to downloadable after this, or disappears if
            // it was a multi-speaker model whose shared .onnx got removed.
            const uninstallBtn = target.closest<HTMLButtonElement>('.voice-row-uninstall');
            if (uninstallBtn) {
                e.preventDefault();
                void uninstallVoice(uninstallBtn, name, entry?.engine);
                return;
            }
            if (row.classList.contains('voice-row-locked')) return;
            settings.defaultVoice = prefixedVoiceId(entry?.engine, name);
            persist();
            updateVoiceSelection(listEl, name);
            syncSpeedControlForVoice(speedSlider, speedLabel, name, scoredVoices, settings.defaultTtsRate);
            updateVoiceButtonLabel(voiceBtn);
        };
        const onSpeedInput = () => {
            const rate = Number(speedSlider.value);
            settings.defaultTtsRate = rate;
            speedLabel.textContent = t('{rate} wpm', { rate });
            persist();
            updateVoiceButtonLabel(voiceBtn);
        };
        const close = () => {
            modal.classList.add('hidden');
            stopPreview();
            listEl.removeEventListener('click', onListClick);
            speedSlider.removeEventListener('input', onSpeedInput);
            closeBtn.removeEventListener('click', close);
            modal.removeEventListener('click', backdrop);
        };
        const backdrop = (e: MouseEvent) => {
            if (e.target === modal) close();
        };
        listEl.addEventListener('click', onListClick);
        speedSlider.addEventListener('input', onSpeedInput);
        closeBtn.addEventListener('click', close);
        modal.addEventListener('click', backdrop);
    }

    // ---- Display -------------------------------------------------------

    function wireDisplaySection(): void {
        // Preview-only: the slider and theme select update the preview pane and
        // pendingChrome, and only #s-apply-display touches the live page.
        // Applying a size change mid-drag would yank the whole UI around, so
        // unlike every other setting these don't auto-apply.
        const textScale = root.querySelector<HTMLInputElement>('#s-text-scale')!;
        const textScaleLabel = root.querySelector<HTMLElement>('#s-text-scale-label')!;
        const previewInner = root.querySelector<HTMLElement>('#text-scale-preview-inner');
        const previewBox = root.querySelector<HTMLElement>('#text-scale-preview');
        const applyBtn = root.querySelector<HTMLButtonElement>('#s-apply-display');
        const appliedEl = root.querySelector<HTMLElement>('#display-applied');
        textScale.value = String(pendingChrome.textScale);
        // The platform base size (18px desktop, 15px phone) times the PENDING
        // scale. Derived from the live root font (base × applied scale) rather
        // than hardcoding the base, so the preview always matches what Apply
        // would produce.
        const paintTextScale = (): void => {
            textScaleLabel.textContent = `${Math.round(pendingChrome.textScale * 100)}%`;
            if (!previewInner) return;
            const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
            const basePx = rootPx / (settings.textScale || 1);
            previewInner.style.fontSize = `${basePx * pendingChrome.textScale}px`;
        };
        paintTextScale();
        textScale.addEventListener('input', () => {
            pendingChrome.textScale = Number(textScale.value);
            paintTextScale();
            updateApplyDisplayState();
        });

        const themeSel = root.querySelector<HTMLSelectElement>('#s-theme-mode')!;
        themeSel.value = pendingChrome.themeMode;
        const paintPreviewTheme = (): void =>
            previewBox?.setAttribute('data-preview-theme', resolvePreviewTheme(pendingChrome.themeMode));
        paintPreviewTheme();
        themeSel.addEventListener('change', () => {
            pendingChrome.themeMode = themeSel.value as ThemeMode;
            paintPreviewTheme();
            updateApplyDisplayState();
        });

        // After applying there's nothing pending (this button disables), but the
        // settings now differ from the entry snapshot, so Undo lights up via
        // persist() → updateUndoState().
        applyBtn?.addEventListener('click', () => {
            Object.assign(settings, pendingChrome);
            applyChromeSettings(settings);
            // The "Applied" flash below is this button's acknowledgment; the
            // auto-save tick on top would be a double signal.
            const announce = announceSaves;
            announceSaves = false;
            persist();
            announceSaves = announce;
            updateApplyDisplayState();
            if (appliedEl) {
                appliedEl.classList.remove('hidden');
                setTimeout(() => appliedEl.classList.add('hidden'), 1200);
            }
        });
        updateApplyDisplayState();

        // A display preference, so it rides the same preview-then-Apply flow as
        // text scale/theme. Only meaningful signed in.
        const balanceToggle = root.querySelector<HTMLInputElement>('#s-show-session-balance');
        const balancePreview = root.querySelector<HTMLElement>('#preview-balance-field');
        if (balanceToggle) {
            balanceToggle.checked = pendingChrome.showSessionBalance;
            balancePreview?.classList.toggle('hidden', !pendingChrome.showSessionBalance);
            balanceToggle.addEventListener('change', () => {
                pendingChrome.showSessionBalance = balanceToggle.checked;
                balancePreview?.classList.toggle('hidden', !balanceToggle.checked);
                updateApplyDisplayState();
            });
        }

        // Hides the readout only. The clock's mode and any timer length are set
        // by tapping it (or the setup screen's Session Clock button), and a
        // hidden clock still runs its timer.
        const clockToggle = root.querySelector<HTMLInputElement>('#s-show-session-clock');
        if (clockToggle) {
            clockToggle.checked = pendingChrome.showSessionClock;
            clockToggle.addEventListener('change', () => {
                pendingChrome.showSessionClock = clockToggle.checked;
                updateApplyDisplayState();
            });
        }
    }

    function resolvePreviewTheme(mode: ThemeMode): 'dark' | 'light' {
        if (mode === 'dark' || mode === 'light') return mode;
        // Auto: match the FOUC logic the index.html script uses.
        if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
        if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
        const hour = new Date().getHours();
        return hour >= 7 && hour < 19 ? 'light' : 'dark';
    }

    // ---- Pacing --------------------------------------------------------

    /** One line for whoever is looking: aloud cloud has it regardless (checked,
     *  locked), everyone else is choosing whether their words may go through
     *  our server, and signed out there is nothing to choose yet. The stored
     *  opt-in is never touched here, only how the box is shown. */
    async function syncVoiceCommandsRow(): Promise<void> {
        const box = root.querySelector<HTMLInputElement>('#s-voice-commands');
        const hint = root.querySelector<HTMLElement>('#s-voice-commands-hint');
        if (!box || !hint) return;
        const hosted = settings.defaultProvider === 'aloud';
        const signedIn = hosted || (await canReachJudge());
        box.disabled = hosted || !signedIn;
        box.checked = hosted || (signedIn && settings.voiceCommandsViaCloud);
        if (hosted) hint.textContent = t(VOICE_COMMANDS_ALWAYS_ON);
        else if (signedIn) hint.innerHTML = `${t(VOICE_COMMANDS_CONSENT)}<br>${privacyPolicyLink()}`;
        else
            hint.innerHTML = `${t(VOICE_COMMANDS_CONSENT)}<br><a href="#" data-nav="account">${t(VOICE_COMMANDS_NEEDS_ACCOUNT)}</a> ${privacyPolicyLink()}`;
    }

    /** The non-streaming pause pair is Claude-subscription plumbing; showing
     *  it to everyone else is pure noise. Render gates it; this keeps it live
     *  when the default provider changes without a re-render. */
    function updateNonstreamVisibility(): void {
        root.querySelector<HTMLElement>('#s-nonstream-group')?.classList.toggle(
            'hidden',
            settings.defaultProvider !== 'claude_proxy'
        );
    }

    function wirePacingSection(): void {
        // The named-stop preset and the Advanced steppers edit the SAME pair,
        // so each side reflects the other: a stepper tweak flips the preset to
        // "Custom (…)", a preset pick rewrites the stepper values.
        const presetSel = root.querySelector<HTMLSelectElement>('#s-pause-preset');
        const syncPausePreset = (): void => {
            if (!presetSel) return;
            presetSel.querySelector('option[value="custom"]')?.remove();
            const match = matchPausePreset(settings);
            if (match) {
                presetSel.value = match;
            } else {
                presetSel.insertAdjacentHTML(
                    'beforeend',
                    `<option value="custom">${customPauseLabel(settings)}</option>`
                );
                presetSel.value = 'custom';
            }
        };
        presetSel?.addEventListener('change', () => {
            const pick = PAUSE_PRESETS[presetSel.value as PausePresetKey] as
                | (typeof PAUSE_PRESETS)[PausePresetKey]
                | undefined;
            if (!pick) return; // "custom" is a state, not a command
            settings.silenceBaseMs = pick.baseMs;
            settings.silenceMaxMs = pick.maxMs;
            const baseInput = root.querySelector<HTMLInputElement>('#s-silence-base');
            const maxInput = root.querySelector<HTMLInputElement>('#s-silence-max');
            if (baseInput) baseInput.value = String(pick.baseMs / 1000);
            if (maxInput) maxInput.value = String(pick.maxMs / 1000);
            persist();
            syncPausePreset(); // drops a stale Custom entry
        });

        bindStepper('s-silence-base', 'silenceBaseMs', 1000, syncPausePreset);
        bindStepper('s-silence-max', 'silenceMaxMs', 1000, syncPausePreset);
        bindStepper('s-nonstream-base', 'nonStreamingSilenceBaseMs', 1000);
        bindStepper('s-nonstream-max', 'nonStreamingSilenceMaxMs', 1000);
        bindStepper('s-silence-sec', 'silenceCheckinSec', 1);

        // One three-way control writing BOTH stored halves: timing follows the
        // pick, and content matches it ('simple' interval says the stock
        // phrase, Smart writes the line too). The stored fields stay split for
        // the session code; the mixed combos just aren't offered. The interval
        // stepper only means anything for 'simple', so it greys out otherwise.
        const checkinWrap = root
            .querySelector<HTMLInputElement>('#s-silence-sec')
            ?.closest<HTMLElement>('.stepper');
        const syncCheckinStepper = (): void => {
            if (!checkinWrap) return;
            const on = settings.checkinTiming === 'simple';
            checkinWrap.classList.toggle('is-disabled', !on);
            checkinWrap
                .querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')
                .forEach((el) => {
                    el.disabled = !on;
                });
        };
        syncCheckinStepper();
        for (const radio of root.querySelectorAll<HTMLInputElement>(
            'input[name="s-checkin-mode"]'
        )) {
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                const mode = radio.value as AppSettings['checkinTiming'];
                settings.checkinTiming = mode;
                if (mode !== 'none') settings.checkinContent = mode;
                persist();
                syncCheckinStepper();
            });
        }
        bindCheckbox('s-stt-speculation', 'sttSpeculation');
        const voiceCommands = root.querySelector<HTMLInputElement>('#s-voice-commands');
        if (voiceCommands) {
            voiceCommands.addEventListener('change', () => {
                settings.voiceCommandsViaCloud = voiceCommands.checked;
                persist();
            });
            // preventDefault also keeps the click from toggling the checkbox
            // the link sits inside.
            root.querySelector('#s-voice-commands-examples')?.addEventListener('click', (e) => {
                e.preventDefault();
                void showVoiceCommandExamples(settings.saveSessionLogs);
            });
            void syncVoiceCommandsRow();
        }
        bindCheckbox('s-silence-mode-enabled', 'silenceModeEnabled');
    }

    function wireSessionLogsSection(): void {
        bindCheckbox('s-save-session-logs', 'saveSessionLogs');
        bindCheckbox('s-resume-from-summary', 'resumeFromSummary');
        bindCheckbox('s-keep-model-off-shortlist', 'keepModelOffShortlist');
        bindCheckbox('s-auto-quit', 'autoQuitAfterSilence');
        wireStepper('s-auto-quit-min', settings.autoQuitSilenceMin, (v) => {
            settings.autoQuitSilenceMin = v;
            persist();
        });
    }

    /** A checkbox mirroring one boolean setting. */
    function bindCheckbox(id: string, key: BooleanSettingKey): void {
        const box = root.querySelector<HTMLInputElement>(`#${id}`);
        if (!box) return;
        box.checked = settings[key];
        box.addEventListener('change', () => {
            settings[key] = box.checked;
            persist();
        });
    }

    /** A stepper mirroring one numeric setting, shown in units of `scale`
     *  (1000 displays a millisecond setting in seconds); stores rounded. */
    function bindStepper(
        id: string,
        key: NumericSettingKey,
        scale: number,
        after?: () => void
    ): void {
        wireStepper(id, settings[key] / scale, (v) => {
            settings[key] = Math.round(v * scale);
            persist();
            after?.();
        });
    }

    function wireStepper(
        id: string,
        initialValue: number,
        onChange: (v: number) => void
    ): void {
        const input = root.querySelector<HTMLInputElement>(`#${id}`);
        if (!input) return;
        input.value = String(initialValue);
        const wrapper = input.closest<HTMLElement>('.stepper');
        const dec = wrapper?.querySelector<HTMLButtonElement>('.stepper-dec');
        const inc = wrapper?.querySelector<HTMLButtonElement>('.stepper-inc');
        const step = Number(input.step) || 1;
        const min = input.min === '' ? -Infinity : Number(input.min);
        const max = input.max === '' ? Infinity : Number(input.max);
        const clamp = (v: number) => Math.max(min, Math.min(max, v));
        const emit = () => onChange(Number(input.value));
        input.addEventListener('change', emit);
        dec?.addEventListener('click', () => {
            input.value = String(clamp(Number(input.value) - step));
            emit();
        });
        inc?.addEventListener('click', () => {
            input.value = String(clamp(Number(input.value) + step));
            emit();
        });
    }

    // ---- Updates -------------------------------------------------------

    // The About box is the single update surface (check, version, desktop
    // one-click update); this button just opens it.
    function wireUpdatesSection(): void {
        const btn = root.querySelector<HTMLButtonElement>('#s-check-update');
        btn?.addEventListener('click', () => openAbout());
    }

    // ---- Developer (hidden unless dev mode; see dev-mode.ts) -----------
    // Debug switches, not user settings: they write straight to their storage
    // keys, outside the settings object and undo machinery.
    function wireDeveloperSection(): void {
        const hud = root.querySelector<HTMLInputElement>('#s-dev-checkin-hud');
        hud?.addEventListener('change', () => setCheckinDebug(hud.checked));
        const aec = root.querySelector<HTMLInputElement>('#s-dev-aec-off');
        aec?.addEventListener('change', () => setAecOffDebug(aec.checked));
        const jev = root.querySelector<HTMLSelectElement>('#s-dev-jev');
        jev?.addEventListener('change', () => setJevClassifierMode(jev.value as JevClassifierMode));
        const preview = root.querySelector<HTMLInputElement>('#s-dev-preview-update');
        preview?.addEventListener('change', () => {
            try {
                const v = preview.value.trim();
                if (v) localStorage.setItem(PREVIEW_UPDATE_KEY, v);
                else localStorage.removeItem(PREVIEW_UPDATE_KEY);
            } catch {
                /* ignore */
            }
        });
        // Same compile-time flag as the markup, so release bundles carry none
        // of this.
        if (import.meta.env.DEV) {
            const modeSel = root.querySelector<HTMLSelectElement>('#s-dev-mode-override');
            modeSel?.addEventListener('change', () => {
                devSetModeOverride(modeSel.value as AppMode | 'auto');
            });
            const bypass = root.querySelector<HTMLInputElement>('#s-dev-cloud-bypass');
            bypass?.addEventListener('change', () => devSetCloudBypass(bypass.checked));

            // '' is the "working" option, i.e. no simulation.
            const simSelect = <T>(id: string, set: (v: T | null) => void): void => {
                const sel = root.querySelector<HTMLSelectElement>(`#${id}`);
                sel?.addEventListener('change', () => {
                    set((sel.value || null) as T | null);
                    renderSimBanner();
                });
            };
            simSelect<MicStatus>('s-dev-sim-mic', setSimMic);
            simSelect<SttFault>('s-dev-sim-stt', setSttFault);
            simSelect<CloudFault>('s-dev-sim-cloud', setCloudFault);
            const noVoices = root.querySelector<HTMLInputElement>('#s-dev-sim-no-voices');
            noVoices?.addEventListener('change', () => {
                setNoVoices(noVoices.checked);
                renderSimBanner();
            });
        }
    }

    // ---- Advanced section (expert controls shelf) ----------------------
    // Same reveal pattern; the controls inside are wired by their own sections.
    function wireAdvancedReveal(): void {
        const toggle = root.querySelector<HTMLButtonElement>('#s-advanced-toggle');
        const body = root.querySelector<HTMLElement>('#s-advanced-body');
        toggle?.addEventListener('click', () => {
            const shown = body?.classList.toggle('hidden') === false;
            toggle.textContent = shown ? t('Hide advanced settings') : t('Show advanced settings');
            toggle.setAttribute('aria-expanded', String(shown));
        });
    }

    // ---- Footer --------------------------------------------------------

    function wireFooter(): void {
        // Everything auto-applies, so the bottom button is Undo: revert the
        // whole settings object to the entry snapshot. Applied Display changes
        // are part of that diff and revert too; un-applied preview tweaks reset
        // as the view re-renders.
        const undoBtn = root.querySelector<HTMLButtonElement>('#s-undo');
        const revertedEl = root.querySelector<HTMLElement>('#settings-saved');
        undoBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            if (!isUndoable()) return;
            const restored = JSON.parse(baseline) as {
                s: Partial<AppSettings>;
                elevenKey: string | null;
            };
            // s omits ttsEngine, so Object.assign leaves the current engine
            // selection untouched (engine changes aren't undoable).
            Object.assign(settings, restored.s);
            if (restored.elevenKey === null) localStorage.removeItem(ELEVENLABS_KEY_STORE);
            else localStorage.setItem(ELEVENLABS_KEY_STORE, restored.elevenKey);
            Object.assign(pendingChrome, pickChrome(settings));
            applyChromeSettings(settings);
            void saveAppSettings(settings);
            if (revertedEl) {
                revertedEl.classList.remove('hidden');
                setTimeout(() => revertedEl.classList.add('hidden'), 1200);
            }
            // Re-render from the restored settings so every control snaps back.
            void refresh().then(() => {
                updateUndoState();
                updateApplyDisplayState();
            });
        });
        updateUndoState();

        // Relaunch the onboarding tour: reset the dismiss flags and walk the
        // wizard from the welcome step.
        // Piper is provided by the desktop (Rust) shell; the hosted web app has
        // no local TTS, so the tour must not recommend it there.
        root.querySelector('#btn-show-tour')?.addEventListener('click', () => {
            void resetSettingsTour({ piperAvailable: isDesktopSync(), isMac: isMacPlatform() });
        });

        // Only shown when the app backend actually answers: the browser preview
        // reaches it, a standalone hosted tab doesn't. Never probed on native
        // mobile - there's no folder to open, and Capacitor's local static
        // server answers any /app path with the SPA fallback, fooling the probe.
        const openConfigBtn = root.querySelector<HTMLButtonElement>('#btn-open-config-folder');
        if (openConfigBtn && !isCapacitor()) {
            void (async () => {
                try {
                    const resp = await fetch(appUrl('/open-config-folder'), { method: 'OPTIONS' });
                    // Even a 405 (POST-only) confirms the route exists.
                    if (resp.status === 200 || resp.status === 405) {
                        openConfigBtn.classList.remove('hidden');
                    }
                } catch {
                    /* app backend down: leave hidden */
                }
            })();
            openConfigBtn.addEventListener('click', () => {
                void fetch(appUrl('/open-config-folder'), { method: 'POST' });
            });
        }
    }

    await refresh();
    applyChromeSettings(settings);

    return {
        async show() {
            await refresh();
        },
    };
}

// ---------------------------------------------------------------------------
// API key URLs / prefixes
// ---------------------------------------------------------------------------

const API_KEY_INFO: Record<Provider, { url: string; prefix: string } | undefined> = {
    anthropic: {
        url: 'https://console.anthropic.com/settings/keys',
        prefix: 'sk-ant-',
    },
    openai: {
        url: 'https://platform.openai.com/api-keys',
        prefix: 'sk-',
    },
    groq: {
        url: 'https://console.groq.com/keys',
        prefix: 'gsk_',
    },
    openrouter: {
        url: 'https://openrouter.ai/keys',
        prefix: 'sk-or-',
    },
    venice: {
        url: 'https://venice.ai/settings/api',
        prefix: '',
    },
    opencode_go: {
        url: 'https://opencode.ai/auth',
        prefix: 'sk-',
    },
    ollama: undefined,
    // claude_proxy uses the local `claude` CLI's existing login.
    claude_proxy: undefined,
    // aloud cloud holds keys server-side; the user signs in, never pastes a key.
    aloud: undefined,
};

const ELEVENLABS_KEY_INFO = {
    url: 'https://elevenlabs.io/app/settings/api-keys',
    prefix: 'sk_',
};

function hasClipboard(): boolean {
    return (
        typeof navigator !== 'undefined' &&
        !!navigator.clipboard &&
        typeof navigator.clipboard.readText === 'function'
    );
}

function pasteShortcut(): string {
    return /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘V' : 'Ctrl+V';
}

function isMacPlatform(): boolean {
    return /Mac/.test(typeof navigator !== 'undefined' ? navigator.platform || '' : '');
}

type BooleanSettingKey = {
    [K in keyof AppSettings]: AppSettings[K] extends boolean ? K : never;
}[keyof AppSettings];
type NumericSettingKey = {
    [K in keyof AppSettings]: AppSettings[K] extends number ? K : never;
}[keyof AppSettings];

/** The Display settings that preview before "Apply" instead of auto-applying. */
type ChromePrefs = Pick<
    AppSettings,
    'textScale' | 'themeMode' | 'showSessionBalance' | 'showSessionClock'
>;

function pickChrome(s: AppSettings): ChromePrefs {
    return {
        textScale: s.textScale,
        themeMode: s.themeMode,
        showSessionBalance: s.showSessionBalance,
        showSessionClock: s.showSessionClock,
    };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** `<option>`s for [value, label] pairs, marking `selected`. Labels are
 *  escaped here, so pass them already translated. */
function optionsHTML(opts: ReadonlyArray<readonly [string, string]>, selected: string | null): string {
    return opts
        .map(
            ([v, label]) =>
                `<option value="${escapeHtml(v)}"${v === selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
        )
        .join('');
}

/** The default-provider menu: only providers this environment can reach.
 *  Capabilities are cached at app boot and read false while unresolved, so a
 *  source stays hidden until the next render; in practice the probe finishes
 *  before first paint. */
function providerOptionsHTML(s: AppSettings): string {
    const byokOpts = { webMode: isWebMode(), allowByok: s.enableByok };
    return optionsHTML(
        ALL_PROVIDERS.filter((p) => isProviderAvailable(p, capabilitiesSync(), byokOpts)).map(
            (p) => [p.value, t(p.label)] as const
        ),
        s.defaultProvider
    );
}

function renderHTML(s: AppSettings): string {
    return `
    <div class="setup-container">
        <h1 class="settings-title">${t('Settings')}</h1>

        <form id="settings-form" class="setup-form">
            ${renderLanguageSection(s)}
            ${renderProviderSection(s)}
            ${renderTtsSection(s)}
            ${renderDisplaySection(s)}
            ${renderPacingSection(s)}
            ${renderSessionLogsSection(s)}
            ${renderAdvancedSettingsSection(s)}
            ${
                // The auto-updater only applies to desktop / self-host builds.
                isWebMode() ? '' : renderUpdatesSection()
            }
            ${
                // Dev mode = tap the About-box version line 7 times (dev-mode.ts).
                isDevMode() ? renderDeveloperSection() : ''
            }
        </form>
    </div>

    <div class="settings-footer">
        <div class="settings-footer-inner">
            <button id="s-undo" type="button" class="btn btn-secondary btn-begin" disabled>
                ${t('Undo')}<span class="settings-word">&nbsp;${t('Changes')}</span>
            </button>
            <span class="settings-saved hidden" id="settings-saved">${t('Reverted')}</span>
            <div class="settings-footer-spacer"></div>
            <div class="settings-footer-secondary">
                <button type="button" class="tour-show-btn" id="btn-show-tour">${t('Setup guide')}</button>
                <button type="button" class="btn-config-path hidden" id="btn-open-config-folder">${t('Open config folder')}</button>
            </div>
        </div>
    </div>

    ${renderVoiceModalHTML({
        modalId: 'settings-voice-modal',
        closeId: 'settings-voice-modal-close',
        listId: 'settings-voice-modal-list',
        title: t('Manage Voices'),
        speedSliderId: 's-tts-rate',
        speedLabelId: 's-tts-rate-label',
        speedValue: s.defaultTtsRate,
    })}`;
}

function renderProviderSection(s: AppSettings): string {
    const keyRows = ALL_PROVIDERS.filter((p) => p.needsKey)
        .map(
            (p) => `
        <div class="form-group api-key-group hidden" id="s-key-row-${p.value}">
            <label for="s-key-${p.value}">${t('{provider} API Key', { provider: escapeHtml(p.label) })}
                <span class="optional api-key-status"></span>
            </label>
            <input type="password" id="s-key-${p.value}" autocomplete="off"
                spellcheck="false" placeholder="${t('Paste your key')}">
        </div>`
        )
        .join('');

    return `
    <section class="settings-section">
        <h2>${t('LLM Provider')} <button type="button" class="info-btn" id="llm-info-btn" aria-label="${t('LLM provider info')}">?</button></h2>
        <div class="info-panel hidden" id="llm-info-panel">
            <p><strong>${t('What is an LLM?')}</strong> - ${t('A large language model is the AI that listens to what you say and generates thoughtful responses to guide your meditation.')}</p>
            <p><strong>${t('Anthropic (Subscription)')}</strong> - ${t('Uses your existing Claude Pro/Max subscription via the locally-installed <code>claude</code> command-line tool (install with <code>npm install -g @anthropic-ai/claude-code</code> - the CLI, not the Claude desktop app). Desktop only.')}</p>
            <p><strong>${t('Ollama (Local)')}</strong> - ${t('Free and private. Runs the AI entirely on your computer.')}</p>
            <p><strong>${t('API Key providers')}</strong> - ${t('Pay-per-use cloud AI. Sign up with the provider, paste the key here.')}</p>
        </div>
        <p class="settings-desc">${t('Choose how aloud connects to a language model.')}</p>

        <div class="form-row provider-row">
            <div class="form-group form-group-half">
                <label for="s-provider">${t('Default AI Provider')}</label>
                <select id="s-provider" name="provider">${providerOptionsHTML(s)}</select>
            </div>
            <div class="form-group form-group-half">
                <label>${t('Default Model')}</label>
                <div id="s-model-slot"></div>
            </div>
        </div>

        ${keyRows}

        <div id="s-provider-status" class="provider-hint hidden"></div>

        <!-- Per-machine recommendation + installed-model management. Visible
             only when provider == "ollama"; populated by settings-ollama.ts
             from /app/v1/providers's ollama.recommendation. -->
        <div id="s-ollama-recommendation" class="ollama-rec-section hidden"></div>
    </section>`;
}

// Web-only BYOK opt-in: device-scoped keys and a footgun, so it lives in the
// collapsed Advanced shelf. The checkbox is wired in wireProviderSection by id.
function renderByokOptIn(s: AppSettings): string {
    return `
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-enable-byok"${s.enableByok ? ' checked' : ''}>
                    <span>${t('Enable providers that require API keys')}</span>
                </label>
                <span class="form-hint">${t('Enter your own keys for providers such as Anthropic, OpenAI, and OpenRouter. Keys are stored only on this device and never saved on our servers. Sessions call each provider directly; only the model list is fetched through our servers, key included.')}${
                    isCapacitor()
                        ? ''
                        : ` ${t('The downloadable desktop app can also help you install your own AI and speech software, enabling completely free and private sessions.')}`
                }</span>
            </div>`;
}

function renderLanguageSection(s: AppSettings): string {
    const langOptions = optionsHTML(LANGUAGES, s.language);
    // Mode-aware sources: Whisper is local-only, browser speech appears when
    // the API exists, hosted is always offered. The value is the resolved
    // choice; there's no "automatic" entry.
    const sttSelected = resolveSttChoice(s.sttEngine, isWebMode());
    const sttOptions = optionsHTML(
        sttEngineOptions(isWebMode()).map(({ value, label }) => [value, t(label)] as const),
        sttSelected
    );

    // Two half-width rows: Language | Microphone, then Speech Recognition |
    // Whisper Model. The conditional columns (mic: only when the STT source
    // captures through us; whisper model: only for local Whisper) start/toggle
    // slot-hidden - the empty slot keeps its row-mate at half width on wide
    // layouts, and collapses once the row stacks (narrow/mobile).
    return `
    <section class="settings-section">
        <h2>${escapeHtml(t('Language & Speech Recognition'))}</h2>
        <div class="form-row">
            <div class="form-group">
                <!-- "(A/文)" on the control's label so someone who can't read
                     the UI's language can still find it; this section leads
                     the page for the same reason. -->
                <label for="s-language">${t('Language')} (A/文)</label>
                <select id="s-language" name="language">${langOptions}</select>
                <span class="form-hint">${t('The language you and the facilitator speak in sessions.')}</span>
            </div>
            <div class="form-group slot-hidden" id="s-mic-device-group">
                <label for="s-mic-device">${t('Microphone')}</label>
                <select id="s-mic-device" name="mic_device">
                    <option value="">${t('System default')}</option>
                </select>
                <span class="form-hint">${t('Which mic aloud listens to.')}</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label for="s-stt-engine">${t('Speech Recognition')}</label>
                <select id="s-stt-engine" name="stt_engine">${sttOptions}</select>
                <span class="form-hint" id="s-stt-engine-hint"></span>
            </div>
            <div class="form-group${sttSelected === 'whisper' ? '' : ' slot-hidden'}" id="s-whisper-model-group">
                <label for="s-whisper-model">${t('Whisper Model')}</label>
                <select id="s-whisper-model" name="whisper_model">
                    <option value="tiny">${t('Tiny (fastest)')}</option>
                    <option value="base">${t('Base (recommended)')}</option>
                    <option value="small">${t('Small')}</option>
                    <option value="medium">${t('Medium')}</option>
                    <option value="large">${t('Large (most accurate)')}</option>
                </select>
                <span class="form-hint">${t('Larger = more accurate but slower. Downloads on use.')}</span>
                <div class="whisper-model-actions">
                    <button type="button" class="btn btn-small btn-secondary hidden" id="s-whisper-model-action"></button>
                    <span class="form-hint hidden" id="s-whisper-model-status"></span>
                </div>
            </div>
        </div>
    </section>`;
}

/** The engine selector + ElevenLabs key row. Inlined in the TTS section on
 *  desktop (where the selector manages real installs); shelved under Advanced
 *  on web (renderAdvancedSettingsSection). One source, so ids/wiring match. */
function renderTtsEngineControls(s: AppSettings): string {
    // aloud cloud is on every platform; macOS `say` and Piper live in the
    // desktop shell's loopback backend - offering them anywhere else (web,
    // phone) gives a silent voice. Mirrors sttEngineOptions' platform gating.
    const engines: ReadonlyArray<[TtsEngineChoice, string]> = [
        ['cloud', 'aloud cloud'],
        ...(isTauri()
            ? ([
                  ['macos', "macOS (built-in 'say')"],
                  ['piper', 'Piper (local neural TTS)'],
              ] as ReadonlyArray<[TtsEngineChoice, string]>)
            : []),
        ['browser', 'Browser (speechSynthesis)'],
        ['elevenlabs', 'ElevenLabs (API)'],
    ];
    const opts = optionsHTML(
        engines.map(([v, label]) => [v, t(label)] as const),
        s.ttsEngine
    );
    return `
            <div class="form-group form-group-half" id="s-tts-engine-group">
                <label for="s-tts-engine">${t('Manage TTS Engines')}</label>
                <select id="s-tts-engine" name="tts_engine">${opts}</select>
                <span class="form-hint" id="s-tts-engine-hint"></span>
            </div>
            <!-- Full-width row; a CSS "order" rule (style.css) places it per
                 width. Wide: engine + voices share the top row, key drops
                 below. Narrow: the key sits between them, since you need a key
                 before the voice picker is useful. -->
            <div class="form-group api-key-group form-group-fullrow hidden" id="s-elevenlabs-key-row">
                <label for="s-elevenlabs-key">${t('{provider} API Key', { provider: 'ElevenLabs' })}
                    <span class="optional api-key-status"></span>
                </label>
                <input type="password" id="s-elevenlabs-key" placeholder="sk_..." autocomplete="off">
            </div>`;
}

function renderTtsSection(s: AppSettings): string {
    // Web: no local engines to install or manage, so the one decision that
    // matters - the voice - is the whole section. The engine selector lives
    // under Advanced (renderAdvancedSettingsSection).
    if (isWebMode()) {
        return `
    <section class="settings-section" id="settings-tts">
        <h2>${t('Text-to-Speech')}</h2>
        <!-- Plain form-row, NOT form-row-tts: its order rules place
             #s-voice-group after the (unordered) spacer, i.e. after a blank
             half-row. With one real child there's nothing to order. -->
        <div class="form-row">
            <div class="form-group form-group-half" id="s-voice-group">
                <label>${t('Manage Voices')}</label>
                <button type="button" id="s-voice-btn" class="setup-voice-btn">${t('Choose voice')}</button>
            </div>
            <!-- Empty slot: a lone flex child stretches to the full row.
                 Collapses when the row stacks (mobile). -->
            <div class="form-group form-group-half slot-hidden" aria-hidden="true"></div>
        </div>
    </section>`;
    }
    return `
    <section class="settings-section" id="settings-tts">
        <h2>${t('Text-to-Speech')} <button type="button" class="info-btn" id="tts-info-btn" aria-label="${t('TTS engine info')}">?</button></h2>
        <div class="info-panel hidden" id="tts-info-panel">
            <p><strong>aloud cloud</strong> - ${t('Natural hosted voices, metered from your credit balance. No setup.')}</p>
            ${
                isTauri()
                    ? `<p><strong>macOS</strong> - ${t('Built-in system voices. Zero latency, works offline.')}</p>
            <p><strong>Piper</strong> - ${t('Fast local neural TTS, ~60–100 MB per voice.')}</p>`
                    : ''
            }
            <p><strong>${t('Browser')}</strong> - ${t("Uses your browser's speechSynthesis. No install needed.")}</p>
            <p><strong>ElevenLabs</strong> - ${t('Cloud TTS with the most natural voices. Requires an API key.')}</p>
        </div>
        <div class="form-row form-row-tts">
            ${renderTtsEngineControls(s)}
            <div class="form-group form-group-half" id="s-voice-group">
                <label>${t('Manage Voices')}</label>
                <button type="button" id="s-voice-btn" class="setup-voice-btn">${t('Choose voice')}</button>
            </div>
        </div>
    </section>`;
}

function renderDisplaySection(s: AppSettings): string {
    const themes: ReadonlyArray<[ThemeMode, string]> = [
        ['auto', 'Auto (follow system)'],
        ['dark', 'Always dark'],
        ['light', 'Always light'],
    ];
    const themeOpts = optionsHTML(
        themes.map(([v, label]) => [v, t(label)] as const),
        s.themeMode
    );
    return `
    <section class="settings-section">
        <h2>${t('Display')}</h2>
        <div class="display-layout" id="text-scale-group">
            <div class="display-controls">
                <div class="form-group">
                    <label>${t('Text Size')}</label>
                    <div class="text-scale-control">
                        <input type="range" id="s-text-scale" class="slider-stops" min="0.8" max="1.4" step="0.05" value="${s.textScale}">
                        <span class="text-scale-value" id="s-text-scale-label">${Math.round(s.textScale * 100)}%</span>
                    </div>
                </div>
                <div class="form-group">
                    <label for="s-theme-mode">${t('Theme')}</label>
                    <select id="s-theme-mode">${themeOpts}</select>
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="s-show-session-balance"${s.showSessionBalance ? ' checked' : ''}>
                        <span>${t('Show live balance during sessions that use credits')}</span>
                    </label>
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="s-show-session-clock"${s.showSessionClock ? ' checked' : ''}>
                        <span>${t('Show the clock during sessions')}</span>
                    </label>
                    <span class="form-hint">${t('Timers speak up when finished, even if hidden.')}</span>
                </div>
                <div class="display-apply-row">
                    <button type="button" id="s-apply-display" class="btn btn-primary" disabled>${t('Apply display changes')}</button>
                    <span class="settings-saved hidden" id="display-applied">${t('Applied')}</span>
                </div>
            </div>
            <div class="display-preview">
                <div class="text-scale-preview" id="text-scale-preview">
                    <div class="text-scale-preview-inner" id="text-scale-preview-inner">
                        <p class="preview-label">${t('Style Preview')}</p>
                        <p class="preview-heading">${t('Header Text')}</p>
                        <p class="preview-body">${t('This is what regular text will look like.')}</p>
                        <p class="preview-small">${t('This is how small text will appear.')}</p>
                        <div class="preview-field">
                            <label class="preview-field-label">${t('Dropdown')}</label>
                            <select class="preview-select" tabindex="-1">
                                <option>${t('Option {n}', { n: 1 })}</option>
                                <option>${t('Option {n}', { n: 2 })}</option>
                                <option>${t('Option {n}', { n: 3 })}</option>
                            </select>
                        </div>
                        <div class="preview-field">
                            <label class="preview-field-label">${t('Slider')}</label>
                            <input type="range" class="preview-range slider-stops" min="0" max="10" value="7" tabindex="-1">
                        </div>
                        <div class="preview-field">
                            <label class="checkbox-label preview-checkbox">
                                <input type="checkbox" checked tabindex="-1">
                                <span>${t('Checkbox')}</span>
                            </label>
                        </div>
                        <div class="preview-field${s.showSessionBalance ? '' : ' hidden'}" id="preview-balance-field">
                            <span class="preview-pill">18<span class="cloud-glyph">☁️</span></span>
                        </div>
                        <div class="preview-field preview-btn-row">
                            <button type="button" class="btn btn-small btn-primary preview-btn" tabindex="-1">${t('Button {n}', { n: 1 })}</button>
                            <button type="button" class="btn btn-small btn-secondary preview-btn" tabindex="-1">${t('Button {n}', { n: 2 })}</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>`;
}

function stepperHTML(id: string, value: number, min: number, max: number, step: number): string {
    return `
        <div class="stepper">
            <button type="button" class="stepper-btn stepper-dec" data-target="${id}" aria-label="${t('Decrease')}">−</button>
            <input type="number" id="${id}" class="stepper-value" min="${min}" max="${max}" step="${step}" value="${value}">
            <button type="button" class="stepper-btn stepper-inc" data-target="${id}" aria-label="${t('Increase')}">+</button>
        </div>`;
}

function pauseGroupHTML(prefix: string, base: number, max: number): string {
    return `
        <div class="form-row">
            <div class="form-group form-group-half">
                <label>${t('Minimum Pause (s)')}</label>
                ${stepperHTML(`${prefix}-base`, base, 1, 15, 0.5)}
                <span class="form-hint">${t('Pause before your speech is submitted.')}</span>
            </div>
            <div class="form-group form-group-half">
                <label>${t('Extended Pause (s)')}</label>
                ${stepperHTML(`${prefix}-max`, max, 1, 20, 0.5)}
                <span class="form-hint">${t('Pause tolerance after longer speech.')}</span>
            </div>
        </div>`;
}

/** Named stops for the pause-before-submit pair. Robin thinks "it cuts me
 *  off" / "it waits too long", not in milliseconds; the exact steppers live
 *  under Advanced. 'relaxed' is the shipped default pair. */
const PAUSE_PRESETS = {
    quick: { label: 'Quick', baseMs: 2000, maxMs: 3500 },
    relaxed: { label: 'Relaxed', baseMs: 3000, maxMs: 5000 },
    spacious: { label: 'Spacious', baseMs: 5000, maxMs: 8000 },
} as const;
type PausePresetKey = keyof typeof PAUSE_PRESETS;

function matchPausePreset(s: AppSettings): PausePresetKey | null {
    for (const [key, p] of Object.entries(PAUSE_PRESETS) as [
        PausePresetKey,
        (typeof PAUSE_PRESETS)[PausePresetKey],
    ][]) {
        if (s.silenceBaseMs === p.baseMs && s.silenceMaxMs === p.maxMs) return key;
    }
    return null;
}

function customPauseLabel(s: AppSettings): string {
    return t('Custom ({base}s / {max}s)', {
        base: s.silenceBaseMs / 1000,
        max: s.silenceMaxMs / 1000,
    });
}

function renderPacingSection(s: AppSettings): string {
    const active = matchPausePreset(s);
    const presetOpts =
        (Object.entries(PAUSE_PRESETS) as [PausePresetKey, (typeof PAUSE_PRESETS)[PausePresetKey]][])
            .map(
                ([key, p]) =>
                    `<option value="${key}"${key === active ? ' selected' : ''}>${t(p.label)} (${p.baseMs / 1000}s)</option>`
            )
            .join('') +
        (active ? '' : `<option value="custom" selected>${customPauseLabel(s)}</option>`);
    return `
    <section class="settings-section">
        <h2>${t('Pacing')}</h2>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label for="s-pause-preset">${t('Pause before responding')}</label>
                <select id="s-pause-preset">${presetOpts}</select>
                <span class="form-hint">${t('How long a pause in your speech ends your turn. Exact values under Advanced.')}</span>
            </div>
            <!-- Empty slot: keeps the select at half width on wide layouts
                 (a lone flex child stretches to the full row); collapses once
                 the row stacks. Same trick as the mic/whisper columns. -->
            <div class="form-group form-group-half slot-hidden" aria-hidden="true"></div>
        </div>
        <h3 class="pacing-subhead" id="settings-checkins">${t('Check-Ins After Silence (Exploration Mode)')}</h3>
        <div class="form-row">
            <div class="form-group" id="s-checkin-timing-group">
                <div class="radio-group">
                    <label class="radio-label">
                        <input type="radio" name="s-checkin-mode" value="none"${s.checkinTiming === 'none' ? ' checked' : ''}>
                        <span>${t('Off')}</span>
                    </label>
                    <div class="radio-inline">
                        <label class="radio-label">
                            <input type="radio" name="s-checkin-mode" value="simple"${s.checkinTiming === 'simple' ? ' checked' : ''}>
                            <span>${t('Every')}</span>
                            ${stepperHTML('s-silence-sec', s.silenceCheckinSec, 30, 3600, 30)}
                            <span>${t('seconds')}</span>
                        </label>
                    </div>
                    <label class="radio-label">
                        <input type="radio" name="s-checkin-mode" value="smart"${s.checkinTiming === 'smart' ? ' checked' : ''}>
                        <span>${t('Smart')}</span>
                    </label>
                </div>
                <span class="form-hint">${t('Whether the facilitator speaks up during silence. "Every" says a stock phrase on a fixed interval; Smart lets the AI pick the timing and the words, as per the session\'s guidance level.')}</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-auto-quit"${s.autoQuitAfterSilence ? ' checked' : ''}>
                    <span>${t('Auto-save and quit after silence (min)')}</span>
                </label>
                ${stepperHTML('s-auto-quit-min', s.autoQuitSilenceMin, 10, 300, 5)}
                <span class="form-hint">${t('An open session keeps listening and checking in, which can slowly consume cloud credits if in use.')}</span>
            </div>
        </div>
    </section>`;
}

function renderSessionLogsSection(s: AppSettings): string {
    return `
    <section class="settings-section">
        <h2>${t('Session History')}</h2>
        <div class="form-row">
          <div class="form-group">
              <label class="checkbox-label">
                  <input type="checkbox" id="s-save-session-logs"${s.saveSessionLogs ? ' checked' : ''}>
                  <span>${t('Save session logs (locally)')}</span>
              </label>
              <span class="form-hint">${t("A local transcript of each session, autosaved every turn. When off, nothing's saved unless you save it from the end dialog.")}</span>
          </div>
        </div>
    </section>`;
}

/** True when the resolved STT choice is one of the PCM engines that capture
 *  through us (local Whisper / aloud cloud): the only ones the mic picker and
 *  the speculation toggle can affect. */
function pcmSttChosen(s: AppSettings): boolean {
    const choice = resolveSttChoice(s.sttEngine, isWebMode());
    return choice === 'whisper' || isHostedSttChoice(choice);
}

/**
 * Collapsed shelf for the rarely-touched expert controls, so the main page
 * stays readable: the exact pause steppers behind the Pacing preset, the web
 * build's TTS engine selector (no install work to manage there, unlike
 * desktop), and the expert toggles. Controls keep their ids: their section's
 * wiring finds them here just the same.
 */
function renderAdvancedSettingsSection(s: AppSettings): string {
    return `
    <section class="settings-section">
        <h2>${t('Advanced')}</h2>
        <button type="button" class="btn btn-secondary settings-advanced-toggle" id="s-advanced-toggle"
            aria-expanded="false" aria-controls="s-advanced-body">${t('Show advanced settings')}</button>
        <div class="settings-advanced-body hidden" id="s-advanced-body">
            <h3 class="pacing-subhead">${t('Pause before submitting user response')}</h3>
            ${pauseGroupHTML('s-silence', s.silenceBaseMs / 1000, s.silenceMaxMs / 1000)}
            <!-- The non-streaming pair applies to exactly one provider (the
                 Claude subscription can't speak until fully generated), so it
                 only shows while that provider is the default. Kept in the DOM
                 so the steppers stay wired across toggles. -->
            <div id="s-nonstream-group"${s.defaultProvider === 'claude_proxy' ? '' : ' class="hidden"'}>
                <h3 class="pacing-subhead">${t('Pause before submitting (Anthropic subscription)')}</h3>
                <p class="form-hint pacing-subhead-note">${t("This provider doesn't stream, so a shorter pause cuts latency.")}</p>
                ${pauseGroupHTML('s-nonstream', s.nonStreamingSilenceBaseMs / 1000, s.nonStreamingSilenceMaxMs / 1000)}
            </div>
            ${
                // Web-only shelf residents: the BYOK opt-in and the TTS engine
                // selector, which on web only swaps hints + the ElevenLabs key
                // row. Desktop's selector does real management (Piper installs,
                // macOS voice settings) and stays in the TTS section.
                isWebMode()
                    ? `${renderByokOptIn(s)}
            <div class="form-row form-row-tts">${renderTtsEngineControls(s)}
                <!-- Empty slot: without a row-mate the selector stretches to
                     full width. Dropped by CSS while the ElevenLabs key row is
                     showing, since that's the real row-mate. -->
                <div class="form-group form-group-half slot-hidden" id="s-tts-engine-slot" aria-hidden="true"></div>
            </div>`
                    : ''
            }
            <div class="form-row">
                <div class="form-group form-group-half">
                    <label class="checkbox-label">
                        <input type="checkbox" id="s-silence-mode-enabled"${s.silenceModeEnabled ? ' checked' : ''}>
                        <span>${t('Enable holding-space mode')}</span>
                    </label>
                    <span class="form-hint">${t('If requested, the facilitator goes silent until you ask it back.')}</span>
                </div>
                <div class="form-group form-group-half">
                    <label class="checkbox-label">
                        <input type="checkbox" id="s-resume-from-summary"${s.resumeFromSummary ? ' checked' : ''}>
                        <span>${t('Resume long sessions from a recap')}</span>
                    </label>
                    <span class="form-hint">${t('Save tokens when resuming long sessions by sending the facilitator a recap plus your recent turns instead of the whole transcript. You always see the complete history.')}</span>
                </div>
            </div>
            <div class="form-row">
                <div class="form-group form-group-half">
                    <!-- State and hint are painted by syncVoiceCommandsRow: they
                         depend on the provider and on being signed in. -->
                    <label class="checkbox-label">
                        <input type="checkbox" id="s-voice-commands">
                        <span>${t('Voice commands')} · <a href="#" id="s-voice-commands-examples">${t('what can I say?')}</a></span>
                    </label>
                    <span class="form-hint" id="s-voice-commands-hint"></span>
                </div>
                <div class="form-group form-group-half">
                    <label class="checkbox-label">
                        <input type="checkbox" id="s-keep-model-off-shortlist"${s.keepModelOffShortlist ? ' checked' : ''}>
                        <span>${t('Keep my model when it leaves the shortlist')}</span>
                    </label>
                    <span class="form-hint">${t('Otherwise you move to the default model.')}</span>
                </div>
            </div>
            <div class="form-row${pcmSttChosen(s) ? '' : ' hidden'}" id="s-stt-speculation-group">
                <div class="form-group form-group-half">
                    <label class="checkbox-label">
                        <input type="checkbox" id="s-stt-speculation"${s.sttSpeculation ? ' checked' : ''}>
                        <span>${t('Transcribe during speech pauses')}</span>
                    </label>
                    <span class="form-hint">${t('Shows your words as you speak and waits through mid-thought pauses. Smoother experience, but uses more transcription calls (more ☁️ if using aloud cloud).')}</span>
                </div>
            </div>
        </div>
    </section>`;
}

/**
 * Rendered only in developer mode (dev-mode.ts). Homes the debug switches that
 * otherwise need query params, which the desktop webview has no URL bar for.
 * The mode-override and cloud-bypass rows are dev-build only (import.meta.env
 * .DEV, the same gate as their readers in app-mode.ts), so a release build's
 * section carries only the harmless conveniences.
 */
/** Developer-section options labelled by their own value. */
function simOptionsHTML(values: readonly string[], selected: string | null): string {
    return optionsHTML(values.map((v) => [v, v] as const), selected);
}

function renderDeveloperSection(): string {
    const preview = (() => {
        try {
            return localStorage.getItem(PREVIEW_UPDATE_KEY) ?? '';
        } catch {
            return '';
        }
    })();
    const devBuildRows = import.meta.env.DEV
        ? `
        <div class="form-row">
            <div class="form-group form-group-half">
                <label for="s-dev-mode-override">App mode override</label>
                <select id="s-dev-mode-override">
                    ${optionsHTML(
                        [
                            ['auto', 'auto (build default)'],
                            ['web', 'web'],
                            ['local', 'local'],
                        ],
                        devGetModeOverride()
                    )}
                </select>
                <span class="form-hint">Same as ?mode=. Dev builds only; reload to apply.</span>
            </div>
            <div class="form-group form-group-half">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-dev-cloud-bypass"${isDevBypass() ? ' checked' : ''}>
                    <span>Cloud sign-in bypass</span>
                </label>
                <span class="form-hint">Same as ?dev. Uses the local /auth/dev account; reload to apply.</span>
            </div>
        </div>
        <h3 class="settings-subhead">Simulate failures</h3>
        <p class="form-hint">States that are painful to reach on purpose. Each one travels the real code path, so the handling under test is the shipping handling. Session-scoped: all four reset when the tab closes, and a banner shows while any is on.</p>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label for="s-dev-sim-mic">Microphone</label>
                <select id="s-dev-sim-mic">
                    <option value="">working</option>
                    ${simOptionsHTML(MIC_SIM_STATUSES, getSimMic())}
                </select>
                <span class="form-hint">Blocks Begin with the setup notice. 'error' is invisible until Begin, like the real thing. Same as ?nomic=.</span>
            </div>
            <div class="form-group form-group-half">
                <label for="s-dev-sim-stt">Speech recognition</label>
                <select id="s-dev-sim-stt">
                    <option value="">working</option>
                    ${simOptionsHTML(STT_FAULTS, getSttFault())}
                </select>
                <span class="form-hint">Every capture errors: status line, toast, and the trouble banner after two.</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label for="s-dev-sim-cloud">aloud cloud</label>
                <select id="s-dev-sim-cloud">
                    <option value="">working</option>
                    ${simOptionsHTML(CLOUD_FAULT_NAMES, getCloudFault())}
                </select>
                <span class="form-hint">Fails the LLM and TTS legs both. insufficient_credits drives the spoken apology and buy prompt.</span>
            </div>
            <div class="form-group form-group-half">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-dev-sim-no-voices"${getNoVoices() ? ' checked' : ''}>
                    <span>Empty voice catalog</span>
                </label>
                <span class="form-hint">Raises the no-voices banners. Reload to apply.</span>
            </div>
        </div>`
        : '';
    return `
    <section class="settings-section">
        <h2>Developer</h2>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-dev-checkin-hud"${getCheckinDebugSetting() ? ' checked' : ''}>
                    <span>Check-in debug HUD</span>
                </label>
                <span class="form-hint">Live check-in/[WAIT] pacing readout in sessions. Same as ?debug=checkin.</span>
            </div>
            <div class="form-group form-group-half">
                <label for="s-dev-preview-update">Preview update banner</label>
                <input type="text" id="s-dev-preview-update" value="${escapeHtml(preview)}" placeholder="empty = off; 1 or a version">
                <span class="form-hint">Fakes an available release (nothing installs). Same as ?previewUpdate.</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-dev-aec-off"${isAecOffDebug() ? ' checked' : ''}>
                    <span>Cloud mic without echo cancellation</span>
                </label>
                <span class="form-hint">Next session's capture opens with echoCancellation off (Android call-stream experiment). Expect echo in the [vad] tts window lines.</span>
            </div>
            <div class="form-group form-group-half">
                <label for="s-dev-jev">Jev silence classifiers</label>
                <select id="s-dev-jev">
                    ${simOptionsHTML(['on', 'shadow', 'off'], getJevClassifierMode())}
                </select>
                <span class="form-hint">aloud cloud sessions only. On (default): Jev decides, Haiku is the fallback. Shadow: both run, Haiku decides. Every call logs a [judge] console line.</span>
            </div>
        </div>
        ${devBuildRows}
    </section>`;
}

function renderUpdatesSection(): string {
    return `
    <section class="settings-section">
        <h2>${t('Updates')}</h2>
        <div class="form-group">
            <div class="settings-update-row">
                <span class="settings-update-status" id="s-update-status">${t('Version {v}', { v: escapeHtml(__APP_VERSION__) })}</span>
                <button type="button" class="btn btn-small btn-secondary" id="s-check-update">${t('Check for Updates')}</button>
            </div>
        </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mask a stored key for display: first 4 + … + last 4, e.g. sk-a…wxyz. */
function maskKey(key: string): string {
    const k = key.trim();
    if (k.length <= 8) return '••••';
    return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

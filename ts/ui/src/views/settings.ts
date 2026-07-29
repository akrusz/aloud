/**
 * Settings view: LLM provider + BYOK keys, language & speech recognition,
 * text-to-speech, display, pacing, session history, updates, and a
 * dev-mode-only Developer section.
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
    DEFAULT_APP_SETTINGS,
    LANGUAGES,
    applyChromeSettings,
    loadAppSettings,
    saveAppSettings,
} from '../app-settings.js';
import { sttEngineOptions, resolveSttChoice } from '../adapters/stt-picker.js';
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
import { isDevMode, getCheckinDebugSetting, setCheckinDebug } from '../dev-mode.js';
import { appUrl } from '../app-base.js';
import { openAbout, PREVIEW_UPDATE_KEY } from '../about.js';
import {
    computeProviderMarker,
    stripMarker,
    type ProviderStatusMap,
} from '../provider-markers.js';
import { getApiKey, hasApiKey, setApiKey } from '../api-keys.js';
import { mountModelPicker } from '../model-picker.js';
import { mountOllamaSettings } from '../settings-ollama.js';
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
    uninstallVoiceModel,
    updateVoiceSelection,
    type ScoredVoice,
} from '../voice-picker.js';
import { browserVoicesSettled } from '../voices.js';
import { resetAndStart as resetSettingsTour } from '../tour/settings-tour.js';
import { confirmDialog, alertDialog } from '../dialog.js';

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

    // There's no global Save; controls auto-apply. Display (text scale, theme,
    // balance pill) is the exception - live-resizing the UI mid-drag is
    // disorienting, so those stay in the preview pane until "Apply". The
    // bottom-bar button is Undo, reverting to the state at view open.
    // (meditation-pal-odw)
    const pendingChrome = {
        textScale: settings.textScale,
        themeMode: settings.themeMode,
        showSessionBalance: settings.showSessionBalance,
    };

    // Backs the ✘/✱ markers and the status hint, from /app/v1/providers plus
    // the BYOK key store (see provider-markers.ts). Unlike setup, settings only
    // annotates: it never reorders or auto-switches the saved default.
    let providerStatus: ProviderStatusMap | null = null;
    let keyPresent: Record<string, boolean> = {};

    const ELEVENLABS_KEY_STORE = 'apikey:elevenlabs';

    /**
     * Serialized view of everything Undo reverts: AppSettings except ttsEngine,
     * plus the ElevenLabs API key.
     *
     * ttsEngine is excluded because "Manage TTS Engines" is a
     * which-engine-am-I-configuring selector, not a change worth undoing.
     * The ElevenLabs key IS a real change but lives in a separate store, so
     * it's folded in explicitly. (meditation-pal-odw)
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

    function persist(): void {
        void saveAppSettings(settings);
        updateUndoState();
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

    /** Are the Display controls showing an un-applied change (text scale, theme,
     *  or the in-session balance toggle)? */
    function isDisplayDirty(): boolean {
        return (
            pendingChrome.textScale !== settings.textScale ||
            pendingChrome.themeMode !== settings.themeMode ||
            pendingChrome.showSessionBalance !== settings.showSessionBalance
        );
    }

    /** Enable the Display "Apply" button only when there's a pending change. */
    function updateApplyDisplayState(): void {
        const applyBtn = root.querySelector<HTMLButtonElement>('#s-apply-display');
        if (applyBtn) applyBtn.disabled = !isDisplayDirty();
    }

    async function refresh(): Promise<void> {
        root.innerHTML = renderHTML(settings);
        wire();
        await loadVoiceCatalog();
        await refreshApiKeyRows();
        await refreshProviderMarkers();
    }

    function wire(): void {
        wireProviderSection();
        wireLanguageSection();
        wireTtsSection();
        wireDisplaySection();
        wirePacingSection();
        wireSessionLogsSection();
        wireUpdatesSection();
        wireAdvancedSection();
        wireDeveloperSection();
        wireFooter();
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

        const infoBtn = root.querySelector<HTMLButtonElement>('#llm-info-btn');
        const infoPanel = root.querySelector<HTMLElement>('#llm-info-panel');
        infoBtn?.addEventListener('click', () => {
            infoPanel?.classList.toggle('hidden');
        });

        // BYOK opt-in (hosted build only): rebuild the menu live so key-based
        // providers appear/disappear without a reload.
        const byokToggle = root.querySelector<HTMLInputElement>('#s-enable-byok');
        byokToggle?.addEventListener('change', () => {
            settings.enableByok = byokToggle.checked;
            persist();
            const opts = { webMode: isWebMode(), allowByok: settings.enableByok };
            providerSel.innerHTML = ALL_PROVIDERS.filter((p) =>
                isProviderAvailable(p, capabilitiesSync(), opts)
            )
                .map(
                    (p) =>
                        `<option value="${p.value}"${p.value === settings.defaultProvider ? ' selected' : ''}>${escape(p.label)}</option>`
                )
                .join('');
            // If the selected default was a BYOK provider that just vanished,
            // fall back to whatever's now first.
            if (providerSel.value !== settings.defaultProvider && providerSel.value) {
                settings.defaultProvider = providerSel.value as Provider;
                persist();
                void refreshApiKeyRows();
                void modelPicker.refresh(settings.defaultProvider);
            }
            // Newly-shown BYOK providers get ✘ until a key is entered.
            applyProviderMarkers();
        });
    }

    /**
     * Fetch provider availability + BYOK key presence, then annotate the menu
     * and status hint. Called on mount and after anything that can flip
     * availability. Network failures leave the menu unmarked, never blocked.
     */
    async function refreshProviderMarkers(): Promise<void> {
        const [statusResult] = await Promise.all([
            fetch(appUrl('/providers'))
                .then((r) => (r.ok ? (r.json() as Promise<ProviderStatusMap>) : null))
                .catch(() => null),
            refreshKeyPresence(),
        ]);
        if (statusResult) providerStatus = statusResult;
        applyProviderMarkers();
    }

    async function refreshKeyPresence(): Promise<void> {
        const entries = await Promise.all(
            ALL_PROVIDERS.filter((p) => p.needsKey).map(
                async (p) => [p.value, await hasApiKey(p.value)] as const
            )
        );
        keyPresent = Object.fromEntries(entries);
    }

    /**
     * Annotate the <option>s with ✘/✱ from cached status and refresh the hint.
     * Pure DOM + cached state, so it's safe after a menu rebuild. Unlike
     * setup's applyProviderIndicators it does NOT reorder or auto-select: a
     * settings default shouldn't change out from under the user.
     */
    function applyProviderMarkers(): void {
        const sel = root.querySelector<HTMLSelectElement>('#s-provider');
        if (sel) {
            for (const opt of Array.from(sel.options)) {
                const { suffix, unavailable } = computeProviderMarker(
                    opt.value,
                    providerStatus,
                    keyPresent
                );
                opt.textContent = stripMarker(opt.textContent ?? '') + suffix;
                opt.classList.toggle('provider-unavailable', unavailable);
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
                msg = 'Selected provider has no API key. Paste one above before starting a session.';
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
            if (status) status.textContent = existing ? `key saved (${maskKey(existing)})` : '';
            const removeBtn = row.querySelector<HTMLButtonElement>('.api-key-remove-btn');
            if (removeBtn) removeBtn.hidden = !existing;
        }
        // An added/removed key flips a provider's ✘ marker and the hint. Cheap:
        // re-reads the local key store, no network.
        await refreshKeyPresence();
        applyProviderMarkers();
    }

    // ---- API key helpers (Get a key + Paste) ---------------------------

    /**
     * Attach a "Get a key" link and (when the browser exposes Web Clipboard) a
     * Paste button that fills and saves the provider's key input.
     */
    function attachApiKeyHelpers(provider: Provider, url: string, prefix: string): void {
        const inputEl = root.querySelector<HTMLInputElement>(`#s-key-${provider}`);
        if (!inputEl) return;
        const row = inputEl.parentElement;
        if (!row) return;
        // A non-null binding so nested function decls keep the narrowed type;
        // TS doesn't propagate the early return's narrowing into them.
        const input: HTMLInputElement = inputEl;
        row.classList.add('has-key-helper');

        const actions = document.createElement('div');
        actions.className = 'api-key-actions';

        // An <a> rather than a button so the desktop webview routes it to the
        // system browser.
        const getBtn = document.createElement('a');
        getBtn.href = url;
        getBtn.target = '_blank';
        getBtn.rel = 'noopener noreferrer';
        getBtn.className = 'btn btn-small btn-secondary api-key-open-btn';
        getBtn.textContent = 'Get a key ↗';
        getBtn.title = url;
        actions.appendChild(getBtn);

        const status = document.createElement('span');
        status.className = 'api-key-paste-status';

        // Paste is rendered only when the clipboard API exists. Reads can still
        // fail at runtime (some Safari, the desktop WKWebView), in which case
        // we fall back to a manual ⌘V/Ctrl+V placeholder hint.
        const hasClipboard =
            typeof navigator !== 'undefined' &&
            !!navigator.clipboard &&
            typeof navigator.clipboard.readText === 'function';

        if (hasClipboard) {
            const paste = document.createElement('button');
            paste.type = 'button';
            paste.className = 'btn btn-small btn-secondary api-key-paste-btn';
            paste.textContent = 'Paste';
            paste.title = 'Paste from clipboard';
            actions.appendChild(paste);

            const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
            const shortcut = isMac ? '⌘V' : 'Ctrl+V';

            function markPasteUnavailable(): void {
                if (paste.dataset['unavailable']) return;
                paste.dataset['unavailable'] = '1';
                paste.disabled = true;
                paste.textContent = 'Paste failed!';
                paste.title = `This browser blocked clipboard access. Click the field and press ${shortcut} to paste.`;
                paste.classList.add('is-unavailable');
                showManualPasteHint(input, shortcut);
            }

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
                        status.textContent = 'Clipboard is empty.';
                        status.classList.add('is-warn');
                        return;
                    }
                    input.value = text;
                    await setApiKey(provider, text);
                    if (prefix && !text.startsWith(prefix)) {
                        status.textContent = `Pasted, but didn't start with "${prefix}". Double-check.`;
                        status.classList.add('is-warn');
                    } else {
                        status.textContent = 'Pasted ✓';
                        status.classList.add('is-ok');
                    }
                    await refreshApiKeyRows();
                } catch {
                    markPasteUnavailable();
                    status.textContent = '';
                }
            });
        } else {
            showManualPasteHint(input, /Mac/.test(navigator.platform || '') ? '⌘V' : 'Ctrl+V');
        }

        // Needed because clearing the field alone doesn't delete: the change
        // handler below only saves non-empty values. Hidden when no key is
        // stored.
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-small btn-secondary api-key-remove-btn';
        remove.textContent = 'Remove';
        remove.title = 'Delete this stored key';
        remove.hidden = true;
        remove.addEventListener('click', async () => {
            await setApiKey(provider, ''); // empty → backend.delete()
            input.value = '';
            status.textContent = 'Removed';
            status.classList.remove('is-warn', 'is-ok');
            await refreshApiKeyRows();
        });
        actions.appendChild(remove);
        void getApiKey(provider).then((k) => {
            remove.hidden = !k;
        });

        row.appendChild(actions);
        row.appendChild(status);

        // Manual-typing save. Keeps the input contents rather than clearing, so
        // the user still sees the key they typed.
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
            ? `${current} · ${shortcut} to paste`
            : `${shortcut} to paste`;
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
            aloud: "Audio is transcribed by aloud's selected provider and spends credits.",
        };
        hintEl.textContent = hints[resolveSttChoice(settings.sttEngine, isWebMode())];
    }

    /** Model size only matters for on-device Whisper; hide its column for
     *  browser/hosted STT (slot kept, see renderLanguageSection). */
    function updateWhisperVisibility(): void {
        root.querySelector<HTMLElement>('#s-whisper-model-group')?.classList.toggle(
            'slot-hidden',
            resolveSttChoice(settings.sttEngine, isWebMode()) !== 'whisper'
        );
    }

    /** The mic picker only applies where WE open the capture stream (the PCM
     *  engines: local Whisper / aloud cloud). Web Speech and the native
     *  recognizer own their capture, so the pick couldn't take effect. */
    function micPickApplies(): boolean {
        const choice = resolveSttChoice(settings.sttEngine, isWebMode());
        return choice === 'whisper' || choice === 'aloud';
    }

    function updateMicDeviceVisibility(): void {
        const canEnumerate = !!navigator.mediaDevices?.enumerateDevices;
        // `.slot-hidden` (style.css) keeps the column's empty slot at wide
        // widths so Language/Recognition stay at a third each rather than
        // stretching to halves as you toggle STT, and collapses to
        // display:none once the row stacks.
        root.querySelector<HTMLElement>('#s-mic-device-group')?.classList.toggle(
            'slot-hidden',
            !micPickApplies() || !canEnumerate
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
            `<option value="">System default</option>` +
            devices
                .map(
                    (d, i) =>
                        `<option value="${escape(d.deviceId)}">${escape(d.label || `Microphone ${i + 1}`)}</option>`
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
                    ? `${label} - downloaded`
                    : `${label} - ${m.approx_download_mb} MB download`;
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
            ? 'Remove download'
            : `Download now (${info.approx_download_mb} MB)`;
        btn.dataset['action'] = info.installed ? 'remove' : 'download';
    }

    /** Pre-fetch the selected model, showing ndjson progress on the button
     *  (mirrors the Piper voice download flow). */
    async function downloadWhisperModel(btn: HTMLButtonElement): Promise<void> {
        const statusEl = root.querySelector<HTMLElement>('#s-whisper-model-status');
        whisperDownloadBusy = true;
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        try {
            const resp = await fetch(appUrl('/stt/whisper/download-model'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ size: settings.sttWhisperModel, lang: settings.language }),
            });
            if (!resp.ok || !resp.body) throw new Error(`server returned ${resp.status}`);
            const reader = resp.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                let nl: number;
                while ((nl = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, nl).trim();
                    buffer = buffer.slice(nl + 1);
                    if (!line) continue;
                    let msg: { status?: string; error?: string; completed?: number; total?: number };
                    try {
                        msg = JSON.parse(line);
                    } catch {
                        continue; // partial/garbled line
                    }
                    if (msg.status === 'error') throw new Error(msg.error || 'download failed');
                    if (msg.status === 'downloading' && msg.total) {
                        btn.textContent = `Downloading… ${Math.round(((msg.completed ?? 0) / msg.total) * 100)}%`;
                    }
                }
            }
            statusEl?.classList.add('hidden');
        } catch (err) {
            if (statusEl) {
                statusEl.textContent =
                    err instanceof Error ? err.message : 'Download failed.';
                statusEl.classList.remove('hidden');
            }
        } finally {
            whisperDownloadBusy = false;
            void refreshWhisperModelBadges();
        }
    }

    async function removeWhisperModel(): Promise<void> {
        const ok = await confirmDialog(
            'Remove this speech model from disk? It re-downloads if a session needs it.',
            { okLabel: 'Remove', danger: true }
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
            // The language picks .en vs multilingual model files, so the
            // on-disk state per size can change with it.
            void refreshWhisperModelBadges();
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

        const infoBtn = root.querySelector<HTMLButtonElement>('#tts-info-btn');
        const infoPanel = root.querySelector<HTMLElement>('#tts-info-panel');
        infoBtn?.addEventListener('click', () => {
            infoPanel?.classList.toggle('hidden');
        });

        // Same Get-a-key / Paste affordances as the LLM provider rows; visible
        // only when TTS = elevenlabs.
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
        const isMac = /Mac/.test(
            typeof navigator !== 'undefined' ? navigator.platform || '' : ''
        );
        const openSettingsLink = isDesktopSync()
            ? ' <a href="#" data-open-voice-settings>Download Premium voices</a>. In the System Voice row, click the <b>ⓘ</b> then click Voice.'
            : '';
        const hints: Record<TtsEngineChoice, string> = {
            cloud: 'Natural hosted voices, metered from your credit balance. Pick one in Manage Voices - the ☁️ entries.',
            macos:
                'Built-in macOS voices. Zero latency, works offline.' +
                (isMac ? openSettingsLink : ''),
            browser:
                "Uses your browser's built-in speech synthesis. On Windows, Edge and the desktop app include high-quality natural voices.",
            elevenlabs:
                'Cloud neural TTS with natural, expressive voices. Requires an API key and internet.',
            piper:
                'Fast local neural TTS. Download voice models (~60–100 MB each) from the voice picker. <a href="https://rhasspy.github.io/piper-samples/" target="_blank" rel="noopener">Listen to samples</a>',
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
     * Wire the ElevenLabs API key input. Its own slot in the same api-keys
     * store the LLM keys use.
     */
    function attachElevenLabsKeyHelpers(): void {
        const input = root.querySelector<HTMLInputElement>('#s-elevenlabs-key');
        if (!input) return;
        const row = input.parentElement;
        if (!row) return;
        row.classList.add('has-key-helper');

        // Same structure as the LLM key rows, inlined: attachApiKeyHelpers()
        // types its keyId as Provider, and 'elevenlabs' isn't one.
        const actions = document.createElement('div');
        actions.className = 'api-key-actions';

        const getBtn = document.createElement('a');
        getBtn.href = ELEVENLABS_KEY_INFO.url;
        getBtn.target = '_blank';
        getBtn.rel = 'noopener noreferrer';
        getBtn.className = 'btn btn-small btn-secondary api-key-open-btn';
        getBtn.textContent = 'Get a key ↗';
        actions.appendChild(getBtn);

        const status = document.createElement('span');
        status.className = 'api-key-paste-status';

        const hasClipboard =
            typeof navigator !== 'undefined' &&
            !!navigator.clipboard &&
            typeof navigator.clipboard.readText === 'function';

        if (hasClipboard) {
            const paste = document.createElement('button');
            paste.type = 'button';
            paste.className = 'btn btn-small btn-secondary api-key-paste-btn';
            paste.textContent = 'Paste';
            actions.appendChild(paste);
            const isMac = /Mac|iPhone|iPad/.test(navigator.platform || '');
            const shortcut = isMac ? '⌘V' : 'Ctrl+V';
            paste.addEventListener('click', async () => {
                try {
                    const text = (await navigator.clipboard.readText()).trim();
                    if (!text) {
                        status.textContent = 'Clipboard is empty.';
                        status.classList.add('is-warn');
                        return;
                    }
                    input.value = text;
                    localStorage.setItem('apikey:elevenlabs', text);
                    updateUndoState();
                    if (
                        ELEVENLABS_KEY_INFO.prefix &&
                        !text.startsWith(ELEVENLABS_KEY_INFO.prefix)
                    ) {
                        status.textContent = `Pasted, but didn't start with "${ELEVENLABS_KEY_INFO.prefix}".`;
                        status.classList.add('is-warn');
                    } else {
                        status.textContent = 'Pasted ✓';
                        status.classList.add('is-ok');
                    }
                } catch {
                    paste.disabled = true;
                    paste.textContent = 'Paste failed!';
                    paste.title = `Click the field and press ${shortcut} to paste.`;
                    if (!input.dataset['pasteHintApplied']) {
                        input.placeholder = `${shortcut} to paste`;
                        input.dataset['pasteHintApplied'] = '1';
                    }
                }
            });
        }

        input.addEventListener('change', () => {
            const raw = input.value.trim();
            if (raw) localStorage.setItem('apikey:elevenlabs', raw);
            else localStorage.removeItem('apikey:elevenlabs');
            updateUndoState();
        });

        const existing = localStorage.getItem('apikey:elevenlabs');
        if (existing) input.placeholder = 'Saved, type to replace';

        row.appendChild(actions);
        row.appendChild(status);
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
        if (!(await confirmDialog(`Uninstall the voice "${name}"?`, { okLabel: 'Uninstall', danger: true })))
            return;
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
            await uninstallVoiceModel(name, engine);
        } catch (err) {
            btn.disabled = false;
            btn.textContent = original ?? 'Uninstall';
            void alertDialog(`Could not uninstall: ${(err as Error).message}`);
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
        const model = btn.closest<HTMLElement>('.voice-row')?.dataset['model'];
        const original = btn.textContent;
        btn.disabled = true;
        btn.textContent = '0%';
        // Lock sibling speakers (same shared .onnx) while downloading.
        if (listEl) setModelDownloadsDisabled(listEl, model, true, btn);
        try {
            await downloadVoiceModel(name, engine, (p) => {
                btn.textContent = `${downloadPercent(p)}%`;
            });
        } catch (err) {
            btn.disabled = false;
            btn.textContent = original ?? 'Download';
            if (listEl) setModelDownloadsDisabled(listEl, model, false, btn);
            void alertDialog(`Could not download: ${(err as Error).message}`);
            return;
        }
        await refreshVoiceList();
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
        const btn = root.querySelector<HTMLButtonElement>('#s-voice-btn');
        if (btn) updateVoiceButtonLabel(btn);
    }

    function updateVoiceButtonLabel(btn: HTMLButtonElement): void {
        const name = stripVoicePrefix(settings.defaultVoice);
        if (name) btn.textContent = `${name} · ${settings.defaultTtsRate} wpm`;
        else btn.textContent = scoredVoices.length > 0 ? 'Choose voice' : 'Default';
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
        speedLabel.textContent = `${settings.defaultTtsRate} wpm`;
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
            updateVoiceButtonLabel(voiceBtn);
        };
        const onSpeedInput = () => {
            const rate = Number(speedSlider.value);
            settings.defaultTtsRate = rate;
            speedLabel.textContent = `${rate} wpm`;
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
        textScaleLabel.textContent = `${Math.round(pendingChrome.textScale * 100)}%`;
        // The platform base size (18px desktop, 15px phone) times the PENDING
        // scale. Derived from the live root font (base × applied scale) rather
        // than hardcoding the base, so the preview always matches what Apply
        // would produce.
        const previewFontSize = (): string => {
            const rootPx = parseFloat(getComputedStyle(document.documentElement).fontSize);
            const basePx = rootPx / (settings.textScale || 1);
            return `${basePx * pendingChrome.textScale}px`;
        };
        if (previewInner) {
            previewInner.style.fontSize = previewFontSize();
        }
        textScale.addEventListener('input', () => {
            pendingChrome.textScale = Number(textScale.value);
            textScaleLabel.textContent = `${Math.round(pendingChrome.textScale * 100)}%`;
            if (previewInner) {
                previewInner.style.fontSize = previewFontSize();
            }
            updateApplyDisplayState();
        });

        const themeSel = root.querySelector<HTMLSelectElement>('#s-theme-mode')!;
        themeSel.value = pendingChrome.themeMode;
        if (previewBox) {
            previewBox.setAttribute('data-preview-theme', resolvePreviewTheme(pendingChrome.themeMode));
        }
        themeSel.addEventListener('change', () => {
            pendingChrome.themeMode = themeSel.value as ThemeMode;
            if (previewBox) {
                previewBox.setAttribute(
                    'data-preview-theme',
                    resolvePreviewTheme(pendingChrome.themeMode)
                );
            }
            updateApplyDisplayState();
        });

        // After applying there's nothing pending (this button disables), but the
        // settings now differ from the entry snapshot, so Undo lights up via
        // persist() → updateUndoState().
        applyBtn?.addEventListener('click', () => {
            settings.textScale = pendingChrome.textScale;
            settings.themeMode = pendingChrome.themeMode;
            settings.showSessionBalance = pendingChrome.showSessionBalance;
            applyChromeSettings(settings);
            persist();
            updateApplyDisplayState();
            if (appliedEl) {
                appliedEl.classList.remove('hidden');
                setTimeout(() => appliedEl.classList.add('hidden'), 1200);
            }
        });
        updateApplyDisplayState();

        // A display preference, so it rides the same preview-then-Apply flow as
        // text scale/theme (meditation-pal-14s). Only meaningful signed in.
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

    function wirePacingSection(): void {
        wireStepper('s-silence-base', settings.silenceBaseMs / 1000, (v) => {
            settings.silenceBaseMs = Math.round(v * 1000);
            persist();
        });
        wireStepper('s-silence-max', settings.silenceMaxMs / 1000, (v) => {
            settings.silenceMaxMs = Math.round(v * 1000);
            persist();
        });
        wireStepper('s-nonstream-base', settings.nonStreamingSilenceBaseMs / 1000, (v) => {
            settings.nonStreamingSilenceBaseMs = Math.round(v * 1000);
            persist();
        });
        wireStepper('s-nonstream-max', settings.nonStreamingSilenceMaxMs / 1000, (v) => {
            settings.nonStreamingSilenceMaxMs = Math.round(v * 1000);
            persist();
        });
        wireStepper('s-silence-sec', settings.silenceCheckinSec, (v) => {
            settings.silenceCheckinSec = Math.round(v);
            persist();
        });

        // The interval stepper only means anything for 'simple' timing, so it
        // greys out on the other picks.
        const timingRadios = Array.from(
            root.querySelectorAll<HTMLInputElement>('input[name="s-checkin-timing"]')
        );
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
        for (const radio of timingRadios) {
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                settings.checkinTiming = radio.value as AppSettings['checkinTiming'];
                persist();
                syncCheckinStepper();
            });
        }
        for (const radio of root.querySelectorAll<HTMLInputElement>(
            'input[name="s-checkin-content"]'
        )) {
            radio.addEventListener('change', () => {
                if (!radio.checked) return;
                settings.checkinContent = radio.value as AppSettings['checkinContent'];
                persist();
            });
        }
        const silenceModeEnabled = root.querySelector<HTMLInputElement>('#s-silence-mode-enabled');
        if (silenceModeEnabled) {
            silenceModeEnabled.checked = settings.silenceModeEnabled;
            silenceModeEnabled.addEventListener('change', () => {
                settings.silenceModeEnabled = silenceModeEnabled.checked;
                persist();
            });
        }
    }

    function wireSessionLogsSection(): void {
        const saveLogs = root.querySelector<HTMLInputElement>('#s-save-session-logs');
        if (saveLogs) {
            saveLogs.checked = settings.saveSessionLogs;
            saveLogs.addEventListener('change', () => {
                settings.saveSessionLogs = saveLogs.checked;
                persist();
            });
        }
        const resumeSummary = root.querySelector<HTMLInputElement>('#s-resume-from-summary');
        if (resumeSummary) {
            resumeSummary.checked = settings.resumeFromSummary;
            resumeSummary.addEventListener('change', () => {
                settings.resumeFromSummary = resumeSummary.checked;
                persist();
            });
        }
        const autoQuit = root.querySelector<HTMLInputElement>('#s-auto-quit');
        if (autoQuit) {
            autoQuit.checked = settings.autoQuitAfterSilence;
            autoQuit.addEventListener('change', () => {
                settings.autoQuitAfterSilence = autoQuit.checked;
                persist();
            });
        }
        wireStepper('s-auto-quit-min', settings.autoQuitSilenceMin, (v) => {
            settings.autoQuitSilenceMin = v;
            persist();
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
        }
    }

    // ---- Advanced (BYOK reveal) ----------------------------------------
    // The BYOK toggle itself is wired in wireProviderSection (by id); here we
    // just expand/collapse the section.
    function wireAdvancedSection(): void {
        const toggle = root.querySelector<HTMLButtonElement>('#advanced-toggle');
        const advBody = root.querySelector<HTMLElement>('#advanced-body');
        toggle?.addEventListener('click', () => {
            const shown = advBody?.classList.toggle('hidden') === false;
            toggle.textContent = shown ? 'Hide advanced settings' : 'Show advanced settings';
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
            pendingChrome.textScale = settings.textScale;
            pendingChrome.themeMode = settings.themeMode;
            pendingChrome.showSessionBalance = settings.showSessionBalance;
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
        const tourBtn = root.querySelector<HTMLButtonElement>('#btn-show-tour');
        if (tourBtn) {
            tourBtn.addEventListener('click', () => {
                const isMac = /Mac/.test(
                    typeof navigator !== 'undefined' ? navigator.platform || '' : ''
                );
                // Piper is provided by the desktop (Rust) shell; the hosted web
                // app has no local TTS, so the tour must not recommend it
                // there. isDesktopSync is populated by the detectCapabilities()
                // await above.
                void resetSettingsTour({
                    piperAvailable: isDesktopSync(),
                    isMac,
                });
            });
        }

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

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHTML(s: AppSettings): string {
    return `
    <div class="setup-container">
        <h1 class="settings-title">Settings</h1>

        <form id="settings-form" class="setup-form">
            ${renderProviderSection(s)}
            ${renderLanguageSection(s)}
            ${renderTtsSection(s)}
            ${renderDisplaySection(s)}
            ${renderPacingSection(s)}
            ${renderSessionLogsSection(s)}
            ${
                // The auto-updater only applies to desktop / self-host builds.
                isWebMode() ? '' : renderUpdatesSection(s)
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
                Undo<span class="settings-word">&nbsp;Changes</span>
            </button>
            <span class="settings-saved hidden" id="settings-saved">Reverted</span>
            <div class="settings-footer-spacer"></div>
            <div class="settings-footer-secondary">
                <button type="button" class="tour-show-btn" id="btn-show-tour">Setup guide</button>
                <button type="button" class="btn-config-path hidden" id="btn-open-config-folder">Open config folder</button>
            </div>
        </div>
    </div>

    ${renderVoiceModalHTML({
        modalId: 'settings-voice-modal',
        closeId: 'settings-voice-modal-close',
        listId: 'settings-voice-modal-list',
        title: 'Manage Voices',
        speedSliderId: 's-tts-rate',
        speedLabelId: 's-tts-rate-label',
        speedValue: s.defaultTtsRate,
    })}`;
}

function renderProviderSection(s: AppSettings): string {
    // Show only providers the environment can reach. Capabilities are cached at
    // app boot and read false while unresolved, so a source stays hidden until
    // the next render; in practice the probe finishes before first paint.
    const caps = capabilitiesSync();
    const byokOpts = { webMode: isWebMode(), allowByok: s.enableByok };
    const providerOptions = ALL_PROVIDERS.filter((p) => isProviderAvailable(p, caps, byokOpts))
        .map(
            (p) =>
                `<option value="${p.value}"${p.value === s.defaultProvider ? ' selected' : ''}>${escape(p.label)}</option>`
        )
        .join('');

    const keyRows = ALL_PROVIDERS.filter((p) => p.needsKey)
        .map(
            (p) => `
        <div class="form-group api-key-group" id="s-key-row-${p.value}" hidden>
            <label for="s-key-${p.value}">${escape(p.label)} API Key
                <span class="optional api-key-status"></span>
            </label>
            <input type="password" id="s-key-${p.value}" autocomplete="off"
                spellcheck="false" placeholder="Paste your key">
        </div>`
        )
        .join('');

    return `
    <section class="settings-section">
        <h2>LLM Provider <button type="button" class="info-btn" id="llm-info-btn" aria-label="LLM provider info">?</button></h2>
        <div class="info-panel hidden" id="llm-info-panel">
            <p><strong>What is an LLM?</strong> - A large language model is the AI that listens to what you say and generates thoughtful responses to guide your meditation.</p>
            <p><strong>Anthropic (Subscription)</strong> - Uses your existing Claude Pro/Max subscription via the locally-installed <code>claude</code> command-line tool (install with <code>npm install -g @anthropic-ai/claude-code</code> - the CLI, not the Claude desktop app). Desktop only.</p>
            <p><strong>Ollama (Local)</strong> - Free and private. Runs the AI entirely on your computer.</p>
            <p><strong>API Key providers</strong> - Pay-per-use cloud AI. Sign up with the provider, paste the key here.</p>
        </div>
        <p class="settings-desc">Choose how aloud connects to a language model.</p>

        <div class="form-row provider-row">
            <div class="form-group form-group-half">
                <label for="s-provider">Default AI Provider</label>
                <select id="s-provider" name="provider">${providerOptions}</select>
            </div>
            <div class="form-group form-group-half">
                <label>Default Model</label>
                <div id="s-model-slot"></div>
            </div>
            ${
                // Web only. A label-height spacer lines the button up with the
                // dropdowns (top-packed, so the model column's caption can't
                // drag it down); matching the select padding gives it the same
                // height. meditation-pal-8jc.
                isWebMode()
                    ? `<div class="form-group provider-advanced-col">
                <label class="form-label-spacer" aria-hidden="true">&nbsp;</label>
                <button type="button" class="btn btn-secondary settings-advanced-toggle" id="advanced-toggle"
                    aria-expanded="false" aria-controls="advanced-body">Show advanced settings</button>
            </div>`
                    : ''
            }
        </div>

        ${isWebMode() ? renderAdvancedBody(s) : ''}

        ${keyRows}

        <div id="s-provider-status" class="provider-hint hidden"></div>

        <!-- Per-machine recommendation + installed-model management. Visible
             only when provider == "ollama"; populated by settings-ollama.ts
             from /app/v1/providers's ollama.recommendation. -->
        <div id="s-ollama-recommendation" class="ollama-rec-section hidden"></div>
    </section>`;
}

// Collapsed BYOK opt-in body (web build only), revealed by the inline "Show
// advanced settings" toggle. Device-scoped keys and a footgun, so it stays
// tucked away by default. The checkbox is wired in wireProviderSection by id.
// meditation-pal-8jc.
function renderAdvancedBody(s: AppSettings): string {
    return `
        <div class="settings-advanced-body hidden" id="advanced-body">
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-enable-byok"${s.enableByok ? ' checked' : ''}>
                    <span>Enable providers that require API keys</span>
                </label>
                <span class="form-hint">Enter your own keys for providers such as Anthropic, OpenAI, and OpenRouter. Keys are stored only on this device and never saved on our servers. Most providers are called directly; Anthropic blocks direct browser calls, so those requests (key included) relay through our servers.${
                    isCapacitor()
                        ? ''
                        : ' The downloadable desktop app calls every provider directly.'
                }</span>
            </div>
        </div>`;
}

function renderLanguageSection(s: AppSettings): string {
    const langOptions = LANGUAGES.map(
        ([v, label]) =>
            `<option value="${v}"${v === s.language ? ' selected' : ''}>${escape(label)}</option>`
    ).join('');
    // Mode-aware sources: Whisper is local-only, browser speech appears when
    // the API exists, hosted is always offered. The value is the resolved
    // choice; there's no "automatic" entry.
    const sttSelected = resolveSttChoice(s.sttEngine, isWebMode());
    const sttOptions = sttEngineOptions(isWebMode())
        .map(
            ({ value, label }) =>
                `<option value="${value}"${value === sttSelected ? ' selected' : ''}>${escape(label)}</option>`
        )
        .join('');

    // Two half-width rows: Language | Microphone, then Speech Recognition |
    // Whisper Model. The conditional columns (mic: only when the STT source
    // captures through us; whisper model: only for local Whisper) start/toggle
    // slot-hidden - the empty slot keeps its row-mate at half width on wide
    // layouts, and collapses once the row stacks (narrow/mobile).
    return `
    <section class="settings-section">
        <h2>Language &amp; Speech Recognition</h2>
        <div class="form-row">
            <div class="form-group">
                <label for="s-language">Language</label>
                <select id="s-language" name="language">${langOptions}</select>
                <span class="form-hint">Affects speech recognition and voice previews</span>
            </div>
            <div class="form-group slot-hidden" id="s-mic-device-group">
                <label for="s-mic-device">Microphone</label>
                <select id="s-mic-device" name="mic_device">
                    <option value="">System default</option>
                </select>
                <span class="form-hint">Which mic aloud listens to.</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label for="s-stt-engine">Speech Recognition</label>
                <select id="s-stt-engine" name="stt_engine">${sttOptions}</select>
                <span class="form-hint" id="s-stt-engine-hint"></span>
            </div>
            <div class="form-group${sttSelected === 'whisper' ? '' : ' slot-hidden'}" id="s-whisper-model-group">
                <label for="s-whisper-model">Whisper Model</label>
                <select id="s-whisper-model" name="whisper_model">
                    <option value="tiny">Tiny (fastest)</option>
                    <option value="base">Base (recommended)</option>
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large (most accurate)</option>
                </select>
                <span class="form-hint">Larger = more accurate but slower. Downloads on first use.</span>
                <div class="whisper-model-actions">
                    <button type="button" class="btn btn-small btn-secondary hidden" id="s-whisper-model-action"></button>
                    <span class="form-hint hidden" id="s-whisper-model-status"></span>
                </div>
            </div>
        </div>
    </section>`;
}

function renderTtsSection(s: AppSettings): string {
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
    const opts = engines
        .map(
            ([v, label]) =>
                `<option value="${v}"${v === s.ttsEngine ? ' selected' : ''}>${escape(label)}</option>`
        )
        .join('');
    return `
    <section class="settings-section" id="settings-tts">
        <h2>Text-to-Speech <button type="button" class="info-btn" id="tts-info-btn" aria-label="TTS engine info">?</button></h2>
        <div class="info-panel hidden" id="tts-info-panel">
            <p><strong>aloud cloud</strong> - Natural hosted voices, metered from your credit balance. No setup.</p>
            ${
                isTauri()
                    ? `<p><strong>macOS</strong> - Built-in system voices. Zero latency, works offline.</p>
            <p><strong>Piper</strong> - Fast local neural TTS, ~60–100 MB per voice.</p>`
                    : ''
            }
            <p><strong>Browser</strong> - Uses your browser's speechSynthesis. No install needed.</p>
            <p><strong>ElevenLabs</strong> - Cloud TTS with the most natural voices. Requires an API key.</p>
        </div>
        <div class="form-row form-row-tts">
            <div class="form-group form-group-half" id="s-tts-engine-group">
                <label for="s-tts-engine">Manage TTS Engines</label>
                <select id="s-tts-engine" name="tts_engine">${opts}</select>
                <span class="form-hint" id="s-tts-engine-hint"></span>
            </div>
            <!-- Full-width row; a CSS "order" rule (style.css) places it per
                 width. Wide: engine + voices share the top row, key drops
                 below. Narrow: the key sits between them, since you need a key
                 before the voice picker is useful. -->
            <div class="form-group api-key-group form-group-fullrow hidden" id="s-elevenlabs-key-row">
                <label for="s-elevenlabs-key">ElevenLabs API Key
                    <span class="optional api-key-status"></span>
                </label>
                <input type="password" id="s-elevenlabs-key" placeholder="sk_..." autocomplete="off">
            </div>
            <div class="form-group form-group-half" id="s-voice-group">
                <label>Manage Voices</label>
                <button type="button" id="s-voice-btn" class="setup-voice-btn">Choose voice</button>
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
    const themeOpts = themes
        .map(
            ([v, label]) =>
                `<option value="${v}"${v === s.themeMode ? ' selected' : ''}>${escape(label)}</option>`
        )
        .join('');
    return `
    <section class="settings-section">
        <h2>Display</h2>
        <div class="display-layout" id="text-scale-group">
            <div class="display-controls">
                <div class="form-group">
                    <label>Text Size</label>
                    <div class="text-scale-control">
                        <input type="range" id="s-text-scale" min="0.8" max="1.4" step="0.05" value="${s.textScale}">
                        <span class="text-scale-value" id="s-text-scale-label">${Math.round(s.textScale * 100)}%</span>
                    </div>
                </div>
                <div class="form-group">
                    <label for="s-theme-mode">Theme</label>
                    <select id="s-theme-mode">${themeOpts}</select>
                </div>
                <div class="form-group">
                    <label class="checkbox-label">
                        <input type="checkbox" id="s-show-session-balance"${s.showSessionBalance ? ' checked' : ''}>
                        <span>Show live credit balance during sessions (when signed in)</span>
                    </label>
                </div>
                <div class="display-apply-row">
                    <button type="button" id="s-apply-display" class="btn btn-primary" disabled>Apply display changes</button>
                    <span class="settings-saved hidden" id="display-applied">Applied</span>
                </div>
            </div>
            <div class="display-preview">
                <div class="text-scale-preview" id="text-scale-preview">
                    <div class="text-scale-preview-inner" id="text-scale-preview-inner">
                        <p class="preview-label">Style Preview</p>
                        <p class="preview-heading">Header Text</p>
                        <p class="preview-body">This is what regular text will look like.</p>
                        <p class="preview-small">This is how small text will appear.</p>
                        <div class="preview-field">
                            <label class="preview-field-label">Dropdown</label>
                            <select class="preview-select" tabindex="-1">
                                <option>Option 1</option>
                                <option>Option 2</option>
                                <option>Option 3</option>
                            </select>
                        </div>
                        <div class="preview-field">
                            <label class="preview-field-label">Slider</label>
                            <input type="range" class="preview-range" min="0" max="10" value="7" tabindex="-1">
                        </div>
                        <div class="preview-field">
                            <label class="checkbox-label preview-checkbox">
                                <input type="checkbox" checked tabindex="-1">
                                <span>Checkbox</span>
                            </label>
                        </div>
                        <div class="preview-field${s.showSessionBalance ? '' : ' hidden'}" id="preview-balance-field">
                            <span class="preview-pill">18<span class="cloud-glyph">☁️</span></span>
                        </div>
                        <div class="preview-field preview-btn-row">
                            <button type="button" class="btn btn-small btn-primary preview-btn" tabindex="-1">Button 1</button>
                            <button type="button" class="btn btn-small btn-secondary preview-btn" tabindex="-1">Button 2</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </section>`;
}

function renderPacingSection(s: AppSettings): string {
    const stepper = (id: string, value: number, min: number, max: number, step: number) => `
        <div class="stepper">
            <button type="button" class="stepper-btn stepper-dec" data-target="${id}" aria-label="Decrease">−</button>
            <input type="number" id="${id}" class="stepper-value" min="${min}" max="${max}" step="${step}" value="${value}">
            <button type="button" class="stepper-btn stepper-inc" data-target="${id}" aria-label="Increase">+</button>
        </div>`;
    const pauseGroup = (
        prefix: string,
        base: number,
        max: number
    ) => `
        <div class="form-row">
            <div class="form-group form-group-half">
                <label>Minimum Pause (s)</label>
                ${stepper(`${prefix}-base`, base, 1, 15, 0.5)}
                <span class="form-hint">Pause before your speech is submitted.</span>
            </div>
            <div class="form-group form-group-half">
                <label>Extended Pause (s)</label>
                ${stepper(`${prefix}-max`, max, 1, 20, 0.5)}
                <span class="form-hint">Pause tolerance after longer speech.</span>
            </div>
        </div>`;
    return `
    <section class="settings-section">
        <h2>Pacing</h2>
        <h3 class="pacing-subhead">Pause before submitting user response (streaming providers)</h3>
        <p class="form-hint pacing-subhead-note">For providers that return text in realtime. Most providers do this.</p>
        ${pauseGroup('s-silence', s.silenceBaseMs / 1000, s.silenceMaxMs / 1000)}
        <h3 class="pacing-subhead">Pause before submitting user response (non-streaming providers)</h3>
        <p class="form-hint pacing-subhead-note">For providers that don't send a response until fully generated - currently just Claude subscriptions. Lower delay recommended because responses are slower.</p>
        ${pauseGroup('s-nonstream', s.nonStreamingSilenceBaseMs / 1000, s.nonStreamingSilenceMaxMs / 1000)}
        <h3 class="pacing-subhead">Check-Ins After Silence</h3>
        <div class="form-row">
            <div class="form-group form-group-half" id="s-checkin-timing-group">
                <label>Timing</label>
                <div class="radio-group">
                    <label class="radio-label">
                        <input type="radio" name="s-checkin-timing" value="none"${s.checkinTiming === 'none' ? ' checked' : ''}>
                        <span>None</span>
                    </label>
                    <div class="radio-inline">
                        <label class="radio-label">
                            <input type="radio" name="s-checkin-timing" value="simple"${s.checkinTiming === 'simple' ? ' checked' : ''}>
                            <span>Simple (s)</span>
                        </label>
                        ${stepper('s-silence-sec', s.silenceCheckinSec, 30, 3600, 30)}
                    </div>
                    <label class="radio-label">
                        <input type="radio" name="s-checkin-timing" value="smart"${s.checkinTiming === 'smart' ? ' checked' : ''}>
                        <span>Smart</span>
                    </label>
                </div>
                <span class="form-hint">When to speak up during silence. Smart lets the model set the wait each turn, biased by your guidance level.</span>
            </div>
            <div class="form-group form-group-half" id="s-checkin-content-group">
                <label>Content</label>
                <div class="radio-group">
                    <label class="radio-label">
                        <input type="radio" name="s-checkin-content" value="simple"${s.checkinContent === 'simple' ? ' checked' : ''}>
                        <span>Simple</span>
                    </label>
                    <label class="radio-label">
                        <input type="radio" name="s-checkin-content" value="smart"${s.checkinContent === 'smart' ? ' checked' : ''}>
                        <span>Smart</span>
                    </label>
                </div>
                <span class="form-hint">Simple says a stock phrase. Smart asks the model for a line that fits the session, or stays quiet.</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-auto-quit"${s.autoQuitAfterSilence ? ' checked' : ''}>
                    <span>Auto-save and quit after silence (min)</span>
                </label>
                ${stepper('s-auto-quit-min', s.autoQuitSilenceMin, 10, 300, 5)}
                <span class="form-hint">An open session keeps listening and checking in, which can slowly consume cloud credits if in use.</span>
            </div>
            <div class="form-group form-group-half">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-silence-mode-enabled"${s.silenceModeEnabled ? ' checked' : ''}>
                    <span>Enable holding-space mode</span>
                </label>
                <span class="form-hint">If requested, the facilitator goes silent until you ask it back. Smaller models are over-eager to enter this mode.</span>
            </div>
        </div>
    </section>`;
}

function renderSessionLogsSection(s: AppSettings): string {
    const stepper = (id: string, value: number, min: number, max: number, step: number) => `
        <div class="stepper">
            <button type="button" class="stepper-btn stepper-dec" data-target="${id}" aria-label="Decrease">−</button>
            <input type="number" id="${id}" class="stepper-value" min="${min}" max="${max}" step="${step}" value="${value}">
            <button type="button" class="stepper-btn stepper-inc" data-target="${id}" aria-label="Increase">+</button>
        </div>`;
    return `
    <section class="settings-section">
        <h2>Session History</h2>
        <div class="form-row">
          <div class="form-group">
              <label class="checkbox-label">
                  <input type="checkbox" id="s-save-session-logs"${s.saveSessionLogs ? ' checked' : ''}>
                  <span>Save session logs (locally)</span>
              </label>
              <span class="form-hint">A local transcript of each session, autosaved every turn. When off, nothing's saved unless you save it from the end dialog.</span>
          </div>
          <div class="form-group">
              <label class="checkbox-label">
                  <input type="checkbox" id="s-resume-from-summary"${s.resumeFromSummary ? ' checked' : ''}>
                  <span>Resume long sessions from a recap</span>
              </label>
              <span class="form-hint">Save tokens when resuming long sessions by sending the facilitator a recap plus your recent turns instead of the whole transcript. You always see the complete history.</span>
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
                    <option value="auto"${devGetModeOverride() === 'auto' ? ' selected' : ''}>auto (build default)</option>
                    <option value="web"${devGetModeOverride() === 'web' ? ' selected' : ''}>web</option>
                    <option value="local"${devGetModeOverride() === 'local' ? ' selected' : ''}>local</option>
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
                <input type="text" id="s-dev-preview-update" value="${escape(preview)}" placeholder="empty = off; 1 or a version">
                <span class="form-hint">Fakes an available release (nothing installs). Same as ?previewUpdate.</span>
            </div>
        </div>
        ${devBuildRows}
    </section>`;
}

function renderUpdatesSection(_s: AppSettings): string {
    return `
    <section class="settings-section">
        <h2>Updates</h2>
        <div class="form-group">
            <div class="settings-update-row">
                <span class="settings-update-status" id="s-update-status">Version ${escape(__APP_VERSION__)}</span>
                <button type="button" class="btn btn-small btn-secondary" id="s-check-update">Check for Updates</button>
            </div>
        </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripVoicePrefix(voice: string | null): string | null {
    if (!voice) return null;
    const m = /^(server|browser|aloud):(.*)$/.exec(voice);
    return m ? (m[2] ?? null) : voice;
}

function escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}

/** Mask a stored key for display: first 4 + … + last 4, e.g. sk-a…wxyz. */
function maskKey(key: string): string {
    const k = key.trim();
    if (k.length <= 8) return '••••';
    return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// Keep DEFAULT_APP_SETTINGS referenced so tree-shaking doesn't drop it
// from the bundle when the only consumer of app-settings.ts is this file.
void DEFAULT_APP_SETTINGS;

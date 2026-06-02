/**
 * Settings view — desktop-shell parity with src/web/templates/settings.html.
 *
 * Sections (matching Python's order):
 *   1. LLM Provider     — default provider, model, per-provider API keys
 *   2. Language & STT   — language, Whisper model size (stub)
 *   3. Text-to-Speech   — engine selector, voice picker, ElevenLabs key
 *   4. Display          — text scale, theme mode, window mode (stub)
 *   5. Pacing           — silence base/max, response delay, check-in, hold
 *   6. Network          — host (stub)
 *   7. Updates          — version + check (stub)
 *
 * "Stub" rows render the same layout as Python but their controls
 * either no-op or display a small "desktop only" hint. The user's call:
 * "if there are settings page elements that we can't hook up yet
 *  because of what needs to be decided still that's fine. But we could
 *  at least have the page there with most of the elements functional."
 *
 * The chrome-level settings (theme, text scale) and the pacing knobs
 * are live and persist. Provider/key entry persists into the same
 * api-keys backend the setup view uses, so settings → setup flow works
 * end-to-end.
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
import { isDesktopSync } from '../is-desktop.js';
import { detectCapabilities, capabilitiesSync } from '../capabilities.js';
import { isWebMode } from '../app-mode.js';
import { appUrl } from '../app-base.js';
import { fetchMe, clearCloudToken, deleteAccount } from '../cloud-auth.js';
import { clearKnownBalance } from '../cloud-balance.js';
import { showBuyCreditsModal } from '../buy-credits-modal.js';
import { creditAmount, RATE_EMOJI } from '../credit-rate.js';
import { showSignInModal } from '../sign-in-modal.js';
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
    renderVoiceList,
    renderVoiceModalHTML,
    setModelDownloadsDisabled,
    stopPreview,
    uninstallVoiceModel,
    updateVoiceSelection,
    type ScoredVoice,
} from '../voice-picker.js';
import { resetAndStart as resetSettingsTour } from '../tour/settings-tour.js';
import { confirmDialog, alertDialog } from '../dialog.js';

export interface SettingsViewHandle {
    show(): Promise<void>;
}

export async function mountSettingsView(root: HTMLElement): Promise<SettingsViewHandle> {
    const settings = await loadAppSettings();
    // Resolve environment capabilities before the first render so the provider
    // menu shows exactly what's reachable (also populates the is-desktop cache
    // the env-var hints + config-folder link read).
    await detectCapabilities();
    let scoredVoices: ScoredVoice[] = [];

    // Every control auto-applies on change (provider, voice, language, pacing…)
    // — there's no global Save. The one exception is Display (text scale +
    // theme): live-resizing the whole UI while you drag the slider is
    // disorienting, so those apply only to the preview pane until you click the
    // Display section's own "Apply" button. The bottom-bar button is "Undo",
    // which reverts the whole settings object to how it was when this view was
    // opened. (meditation-pal-odw)
    const pendingChrome = {
        textScale: settings.textScale,
        themeMode: settings.themeMode,
    };

    const ELEVENLABS_KEY_STORE = 'apikey:elevenlabs';

    /**
     * Serialized view of everything Undo reverts: the AppSettings object
     * EXCEPT ttsEngine, plus the ElevenLabs API key.
     *
     * ttsEngine is excluded on purpose — the "Manage TTS Engines" dropdown is a
     * which-engine-am-I-configuring selector, not a change worth undoing, so
     * switching it doesn't dirty the page. Entering an ElevenLabs key, though,
     * is a real change; it lives in a separate key store, so we fold it in here
     * explicitly. (meditation-pal-odw, dev follow-up.)
     */
    function undoSnapshot(): string {
        const comparable: Partial<AppSettings> = { ...settings };
        delete comparable.ttsEngine;
        return JSON.stringify({
            s: comparable,
            elevenKey: localStorage.getItem(ELEVENLABS_KEY_STORE),
        });
    }

    // Entry snapshot for Undo, taken after loadAppSettings (settings' own
    // loadVoiceCatalog doesn't mutate settings, unlike setup's).
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

    /** Are the Display controls showing an un-applied text-scale/theme change? */
    function isDisplayDirty(): boolean {
        return (
            pendingChrome.textScale !== settings.textScale ||
            pendingChrome.themeMode !== settings.themeMode
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
    }

    function wire(): void {
        wireProviderSection();
        wireLanguageSection();
        wireTtsSection();
        wireDisplaySection();
        wirePacingSection();
        wireNetworkSection();
        wireUpdatesSection();
        wireDangerZoneSection();
        wireFooter();
        void wireAccountSection();
    }

    // ---- Account section (hosted sign-in, meditation-pal-rfb) -----------
    // The shell always renders; this fills or removes it. Shown whenever an aloud
    // cloud server is REACHABLE — not gated on Google specifically: email/password
    // sign-in is always available on any server, and Google/Apple buttons appear
    // when their ids are advertised. So local installs that can reach the cloud
    // get sign-in too; the only case we hide it is a genuinely offline / no-cloud
    // install (caps.cloud === false). We await the probe before deciding rather
    // than gating the sync template. Async also because the balance comes from
    // /me; re-renders just its own body on sign-in/out so unsaved settings
    // elsewhere in the form survive. (meditation-pal-8jc)
    async function wireAccountSection(): Promise<void> {
        const body = root.querySelector<HTMLElement>('#account-body');
        if (!body) return; // section not present in this build
        const caps = await detectCapabilities();
        if (!caps.cloud) {
            // Cloud unreachable — outage, offline, or a stale install whose server
            // is long gone ("hit by a bus"). Don't vanish the section silently:
            // say so and point at the still-working alternatives, so the app
            // degrades gracefully instead of looking broken. meditation-pal-8jc.
            body.innerHTML = `<p class="provider-hint">aloud cloud is unreachable right now — you can still use your own API keys or a local model. Sign-in and credits return when it's back.</p>`;
            return;
        }
        const account = await fetchMe();
        if (account) {
            // An email-only account hasn't claimed its free grant — nudge it to
            // connect a trusted identity (meditation-pal-116). Connecting from a
            // signed-in state links to THIS account (cloud-auth sends the bearer).
            // Only nudge when we POSITIVELY know the account has identities but
            // none trusted; an empty/absent list (e.g. an older server that
            // doesn't report providers) shouldn't nag a Google/Apple user.
            const providers = account.providers ?? [];
            const needsConnect =
                providers.length > 0 && !providers.some((p) => p === 'google' || p === 'apple');
            const connectPrompt = needsConnect
                ? `<button type="button" class="account-connect-prompt provider-hint" id="account-connect">
                       Connect Google or Apple to claim your free credits →
                   </button>`
                : '';
            body.innerHTML = `
                <div class="account-row">
                    <div class="account-info">
                        <div class="account-email">${escape(account.email)}</div>
                        <div class="account-credits provider-hint">${creditAmount(account.creditsRemaining)} remaining</div>
                    </div>
                    <div class="account-actions">
                        <label class="checkbox-label account-balance-toggle">
                            <input type="checkbox" id="account-show-session-balance"${settings.showSessionBalance ? ' checked' : ''}>
                            <span>Show live credit balance during sessions</span>
                        </label>
                        <button type="button" class="btn btn-primary" id="account-buy-credits">Buy ${RATE_EMOJI}</button>
                        <button type="button" class="btn btn-secondary" id="account-signout">Sign out</button>
                    </div>
                </div>
                ${connectPrompt}`;
            body.querySelector('#account-buy-credits')?.addEventListener('click', () => {
                // Refresh the balance when the modal closes (dismiss path); the
                // purchase path redirects to Stripe and returns via ?purchase=.
                void showBuyCreditsModal().then(() => wireAccountSection());
            });
            const balanceToggle = body.querySelector<HTMLInputElement>('#account-show-session-balance');
            balanceToggle?.addEventListener('change', () => {
                settings.showSessionBalance = balanceToggle.checked;
                persist();
            });
            body.querySelector('#account-connect')?.addEventListener('click', () => {
                void showSignInModal({
                    title: 'Claim your free credits',
                    subtitle: 'Connect Google or Apple to unlock free credits on this account.',
                }).then(() => wireAccountSection());
            });
            body.querySelector('#account-signout')?.addEventListener('click', () => {
                clearKnownBalance();
                void clearCloudToken().then(() => wireAccountSection());
            });
            return;
        }
        body.innerHTML = `
            <p class="provider-hint">Sign in to use the aloud cloud, which connects to text-to-speech, speech-to-text, and LLMs to power your session with no additional setup. Connect Google or Apple for free credits.</p>
            <button type="button" class="btn btn-primary" id="account-signin">Sign in or create account</button>`;
        body.querySelector('#account-signin')?.addEventListener('click', () => {
            void showSignInModal().then(() => wireAccountSection());
        });
    }

    // ---- Provider section ----------------------------------------------

    function wireProviderSection(): void {
        const providerSel = root.querySelector<HTMLSelectElement>('#s-provider')!;
        providerSel.value = settings.defaultProvider;
        // The saved default may not be available in this mode — e.g. a fresh web
        // build defaults to 'ollama', which is filtered out of the web menu.
        // Setting .value to a missing option leaves the <select> blank; fall
        // back to the first available provider (the hosted 'aloud' option on
        // web) and persist so the menu never renders empty.
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
        });

        // Model picker — same /api/models/<provider> backing as the
        // setup view. Falls back to text input when Flask isn't there.
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

        // Ollama recommendation + installed-model management. Hooked once
        // here; we only show + refresh it when the selected provider is
        // Ollama, so users on other providers don't see the tier card stack.
        // Ollama is a local-daemon provider — it's filtered out of the menu on
        // the web build, so its install/recommendation card must never mount
        // there either (a harder guarantee than just hiding it when a non-Ollama
        // provider is selected).
        const recEl = isWebMode() ? null : root.querySelector<HTMLElement>('#s-ollama-recommendation');
        const ollamaHandle = recEl
            ? mountOllamaSettings(recEl, {
                  // After a pull/remove the standard model dropdown is stale;
                  // re-fetch so the new option shows up (or removed one disappears).
                  onModelsChanged: () => modelPicker.refresh(settings.defaultProvider),
              })
            : null;
        const syncOllamaSection = (): void => {
            if (!ollamaHandle) return;
            if (settings.defaultProvider === 'ollama') void ollamaHandle.refresh();
            else ollamaHandle.hide();
        };
        syncOllamaSection();

        // Per-provider API key inputs. Each row carries the input, a
        // "Get a key ↗" link to the provider's console, and a Paste
        // button when the browser exposes the clipboard API. Matches
        // src/web/static/js/settings.js::attachKeyHelper.
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

        // BYOK opt-in (hosted build only). Rebuild the provider menu live so the
        // key-based providers appear/disappear without a reload.
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
        });
    }

    /**
     * Show only the active provider's API key row — matches Python's
     * settings.js behavior (each provider has its own .api-key-group
     * and only the matching one is unhidden when the provider select
     * changes). Updates the saved/empty status text per row.
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
            // Show a masked confirmation (key saved (sk-a…wxyz)) rather than a
            // bare "Saved", so the user can tell a key is stored without
            // exposing it. Mirrors Python's masked-key indicator.
            if (status) status.textContent = existing ? `key saved (${maskKey(existing)})` : '';
            const removeBtn = row.querySelector<HTMLButtonElement>('.api-key-remove-btn');
            if (removeBtn) removeBtn.hidden = !existing;
        }
    }

    // ---- API key helpers (Get a key + Paste) ---------------------------

    /**
     * For each provider's API key input, attach a "Get a key ↗" link
     * pointing at the provider's key page and (when the browser exposes
     * Web Clipboard) a Paste button that fills the input and saves.
     * Lifted from src/web/static/js/settings.js::attachKeyHelper.
     */
    function attachApiKeyHelpers(provider: Provider, url: string, prefix: string): void {
        const inputEl = root.querySelector<HTMLInputElement>(`#s-key-${provider}`);
        if (!inputEl) return;
        const row = inputEl.parentElement;
        if (!row) return;
        // Capture into a non-null binding so nested closures (the Paste
        // handler) keep the narrowed type — TS doesn't propagate the
        // `if (!input) return` narrowing into nested function decls.
        const input: HTMLInputElement = inputEl;
        row.classList.add('has-key-helper');

        const actions = document.createElement('div');
        actions.className = 'api-key-actions';

        // "Get a key" anchor — opens in a new tab. Lives as an <a>
        // rather than a button so pywebview/Electron route it to the
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

        // Paste button — only rendered when the clipboard API exists.
        // If clipboard reads fail at runtime (some Safari, pywebview
        // WKWebView), mark the button unavailable and fold a manual
        // ⌘V/Ctrl+V hint into the input placeholder.
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

            // If the Permissions API exposes clipboard-read (Chromium),
            // mark unavailable up front when denied.
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
                        status.textContent = `Pasted — but didn't start with "${prefix}". Double-check.`;
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

        // Remove button — deletes the stored key. Necessary because clearing
        // the field alone doesn't delete (the change handler below only saves
        // non-empty values). Hidden when no key is stored; refreshApiKeyRows()
        // and the initial probe below keep its visibility honest.
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

        // Manual-typing save handler — matches the original 'change'
        // behavior. We keep the input contents instead of clearing so
        // the user sees their pasted/typed key (the existing-key check
        // covers the "Saved" badge update on the next refresh).
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
            'web-speech': "Uses your browser's built-in speech recognition. Free.",
            aloud: "Audio is transcribed by aloud's server and spends credits.",
        };
        hintEl.textContent = hints[resolveSttChoice(settings.sttEngine, isWebMode())];
    }

    /** The Whisper model size only matters for the on-device Whisper backend —
     *  hide it for browser/hosted STT. */
    function updateWhisperVisibility(): void {
        const group = root.querySelector<HTMLElement>('#s-whisper-model-group');
        // `.whisper-slot-hidden` (style.css) keeps the column's slot at wide
        // widths so Language/Recognition stay at a third each instead of
        // stretching to halves as you toggle STT; it collapses to display:none
        // once the row stacks, so narrow widths show no dead space.
        group?.classList.toggle(
            'whisper-slot-hidden',
            resolveSttChoice(settings.sttEngine, isWebMode()) !== 'whisper'
        );
    }

    function wireLanguageSection(): void {
        const langSel = root.querySelector<HTMLSelectElement>('#s-language')!;
        langSel.value = settings.language;
        langSel.addEventListener('change', () => {
            settings.language = langSel.value;
            persist();
        });

        const sttSel = root.querySelector<HTMLSelectElement>('#s-stt-engine');
        if (sttSel) {
            // Show the resolved choice (stored pick or the mode's flow default);
            // resolveSttChoice handles a null or stale-for-this-mode value.
            sttSel.value = resolveSttChoice(settings.sttEngine, isWebMode());
            updateSttHint();
            updateWhisperVisibility();
            sttSel.addEventListener('change', () => {
                settings.sttEngine = sttSel.value as SttEngineChoice;
                persist();
                updateSttHint();
                updateWhisperVisibility();
            });
        }

        const whisperSel = root.querySelector<HTMLSelectElement>('#s-whisper-model')!;
        whisperSel.value = settings.whisperModel;
        whisperSel.addEventListener('change', () => {
            settings.whisperModel = whisperSel.value as AppSettings['whisperModel'];
            persist();
        });
    }

    // ---- TTS section ---------------------------------------------------

    function wireTtsSection(): void {
        const engineSel = root.querySelector<HTMLSelectElement>('#s-tts-engine')!;
        engineSel.value = settings.ttsEngine;
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

        // ElevenLabs key row — same Get-a-key / Paste affordances as
        // the LLM provider rows. Only visible when TTS = elevenlabs.
        attachElevenLabsKeyHelpers();
        refreshElevenLabsRow();
    }

    /**
     * Engine-specific hint text below the TTS engine dropdown. Mirrors
     * src/web/static/js/settings.js::TTS_ENGINE_HINTS, including the
     * "Download Premium voices" call-to-action when the user is on a
     * Mac with macOS TTS — that's the key surface for getting good
     * voices on Apple Silicon.
     */
    function updateTtsEngineHint(): void {
        const hintEl = root.querySelector<HTMLElement>('#s-tts-engine-hint');
        if (!hintEl) return;
        const isMac = /Mac/.test(
            typeof navigator !== 'undefined' ? navigator.platform || '' : ''
        );
        const openSettingsLink = isDesktopSync()
            ? ' <a href="#" data-open-voice-settings>Download Premium voices</a> — in the System Voice row, click the <b>ⓘ</b> then click Voice.'
            : '';
        const hints: Record<TtsEngineChoice, string> = {
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
        // Wire the "Download Premium voices" link to the Flask
        // /api/open-voice-settings route — opens macOS System Settings
        // straight to Accessibility → Spoken Content.
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
     * Wire the ElevenLabs API key input. Uses a separate keyId
     * ("elevenlabs") in the same api-keys backing store the LLM keys
     * use — Python keeps them in two slots (s-elevenlabs-key vs
     * s-anthropic-key etc.) but the storage is conceptually one map.
     */
    function attachElevenLabsKeyHelpers(): void {
        const input = root.querySelector<HTMLInputElement>('#s-elevenlabs-key');
        if (!input) return;
        const row = input.parentElement;
        if (!row) return;
        row.classList.add('has-key-helper');

        // Re-use the same UI as the LLM key rows via a thin shim — we
        // can't call attachApiKeyHelpers() directly because its keyId
        // is typed Provider and 'elevenlabs' isn't one. Inline the
        // same structure with the elevenlabs URL + prefix.
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
                        status.textContent = `Pasted — but didn't start with "${ELEVENLABS_KEY_INFO.prefix}".`;
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

        // Pre-populate placeholder if a key is already stored.
        const existing = localStorage.getItem('apikey:elevenlabs');
        if (existing) input.placeholder = 'Saved — type to replace';

        row.appendChild(actions);
        row.appendChild(status);
    }

    /**
     * Uninstall a downloaded Piper voice via Flask's
     * /api/tts/uninstall-model endpoint. Mirrors Python's settings.js
     * behavior — confirmation, POST, then re-fetch voices so the row
     * flips to "Download" state.
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
        // Drop the cached /api/voices response so the re-fetch sees
        // the Piper model as un-downloaded again.
        await refreshVoiceList();
    }

    /**
     * Download a Piper voice model, showing live percent on the button. On
     * success the voices cache is dropped and the list re-rendered, so the
     * voice (and any speakers sharing its model) flip to a selectable,
     * uninstallable state.
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
        // Lock sibling speakers (same shared .onnx) for the duration.
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
        // Settings is the "manage voices" surface — show Uninstall on
        // downloaded Piper voices so users can free up space.
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
                void runPreview(name, settings.defaultTtsRate, entry?.engine);
                return;
            }
            // Download button — stream the model down (live percent on the
            // button), then re-render so the voice unlocks.
            const downloadBtn = target.closest<HTMLButtonElement>('.voice-row-download');
            if (downloadBtn) {
                e.preventDefault();
                void downloadVoice(downloadBtn, name, entry?.engine);
                return;
            }
            // Uninstall button — remove the model and re-render the list so the
            // voice flips back to a downloadable state (or disappears entirely
            // if it was a multi-speaker model whose shared .onnx got removed).
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
        // Text scale + theme are preview-only: dragging the slider or changing
        // the theme select updates the preview pane and the pending state, but
        // the live page only changes when the user clicks this section's
        // "Apply" button (#s-apply-display). Applying the size change mid-drag
        // would yank the whole UI around, so unlike every other setting these
        // don't auto-apply.
        const textScale = root.querySelector<HTMLInputElement>('#s-text-scale')!;
        const textScaleLabel = root.querySelector<HTMLElement>('#s-text-scale-label')!;
        const previewInner = root.querySelector<HTMLElement>('#text-scale-preview-inner');
        const previewBox = root.querySelector<HTMLElement>('#text-scale-preview');
        const applyBtn = root.querySelector<HTMLButtonElement>('#s-apply-display');
        const appliedEl = root.querySelector<HTMLElement>('#display-applied');
        textScale.value = String(pendingChrome.textScale);
        textScaleLabel.textContent = `${Math.round(pendingChrome.textScale * 100)}%`;
        if (previewInner) {
            previewInner.style.fontSize = `${18 * pendingChrome.textScale}px`;
        }
        textScale.addEventListener('input', () => {
            pendingChrome.textScale = Number(textScale.value);
            textScaleLabel.textContent = `${Math.round(pendingChrome.textScale * 100)}%`;
            if (previewInner) {
                previewInner.style.fontSize = `${18 * pendingChrome.textScale}px`;
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

        // Apply commits the pending text-scale/theme to the live document and
        // persists. After applying, there's nothing pending (button disables)
        // but the settings now differ from the entry snapshot, so Undo lights
        // up via persist() → updateUndoState().
        applyBtn?.addEventListener('click', () => {
            settings.textScale = pendingChrome.textScale;
            settings.themeMode = pendingChrome.themeMode;
            applyChromeSettings(settings);
            persist();
            updateApplyDisplayState();
            if (appliedEl) {
                appliedEl.classList.remove('hidden');
                setTimeout(() => appliedEl.classList.add('hidden'), 1200);
            }
        });
        updateApplyDisplayState();
    }

    function resolvePreviewTheme(mode: ThemeMode): 'dark' | 'light' {
        if (mode === 'dark' || mode === 'light') return mode;
        // Auto — match the same FOUC logic the index.html script uses.
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
        wireStepper('s-response-delay', settings.responseDelayMs / 1000, (v) => {
            settings.responseDelayMs = Math.round(v * 1000);
            persist();
        });
        wireStepper('s-silence-sec', settings.silenceCheckinSec, (v) => {
            settings.silenceCheckinSec = Math.round(v);
            persist();
        });

        const checkinsEnabled = root.querySelector<HTMLInputElement>('#s-silence-checkins-enabled');
        if (checkinsEnabled) {
            // Grey out the check-in interval stepper when check-ins are off,
            // so it's clear the value is inert. Mirrors Python's
            // updateCheckinSecState (.is-disabled).
            const checkinWrap = root
                .querySelector<HTMLInputElement>('#s-silence-sec')
                ?.closest<HTMLElement>('.stepper');
            const syncCheckinStepper = (): void => {
                if (!checkinWrap) return;
                const on = checkinsEnabled.checked;
                checkinWrap.classList.toggle('is-disabled', !on);
                checkinWrap
                    .querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input')
                    .forEach((el) => {
                        el.disabled = !on;
                    });
            };
            checkinsEnabled.checked = settings.silenceCheckinsEnabled;
            syncCheckinStepper();
            checkinsEnabled.addEventListener('change', () => {
                settings.silenceCheckinsEnabled = checkinsEnabled.checked;
                persist();
                syncCheckinStepper();
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

    // ---- Network -------------------------------------------------------

    function wireNetworkSection(): void {
        // Network host is a Flask-server concern; in the TS-on-mobile
        // world it doesn't apply. Render the control but disable + note.
        const host = root.querySelector<HTMLSelectElement>('#s-host');
        if (host) host.disabled = true;
    }

    // ---- Updates -------------------------------------------------------

    function wireUpdatesSection(): void {
        // The Python updater works against a desktop-app distribution
        // (git pull or DMG/AppImage download). Not yet applicable here.
        const btn = root.querySelector<HTMLButtonElement>('#s-check-update');
        if (btn) btn.disabled = true;
    }

    // ---- Danger zone (web-only; meditation-pal-8jc) --------------------
    // The BYOK toggle here is wired by wireProviderSection (it lives by id, and
    // toggling it rebuilds the provider menu). This only wires deletion.
    function wireDangerZoneSection(): void {
        const del = root.querySelector<HTMLButtonElement>('#s-delete-account');
        del?.addEventListener('click', () => {
            void (async () => {
                const account = await fetchMe();
                if (!account) {
                    await alertDialog("You're not signed in, so there's no account to delete.");
                    return;
                }
                const ok = await confirmDialog(
                    `Permanently delete the account for ${account.email}? Any remaining credits are forfeited, and this can't be undone. You can sign up again later, but won't get the free credits a second time.`,
                    { okLabel: 'Delete account', danger: true }
                );
                if (!ok) return;
                del.disabled = true;
                try {
                    await deleteAccount();
                } catch (err) {
                    del.disabled = false;
                    await alertDialog(
                        err instanceof Error ? err.message : 'Could not delete the account.'
                    );
                    return;
                }
                await alertDialog('Your account has been deleted.');
                // Reflect the now-signed-out state in the Account section.
                await wireAccountSection();
            })();
        });
    }

    // ---- Footer --------------------------------------------------------

    function wireFooter(): void {
        // Everything auto-applies, so the bottom button is Undo: it reverts the
        // whole settings object to the entry snapshot. Disabled when nothing
        // has changed. (Display changes you've Applied are part of the snapshot
        // diff and get reverted too; un-applied preview tweaks are reset as the
        // view re-renders.)
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
            applyChromeSettings(settings);
            void saveAppSettings(settings);
            if (revertedEl) {
                revertedEl.classList.remove('hidden');
                setTimeout(() => revertedEl.classList.add('hidden'), 1200);
            }
            // Re-render from the restored settings so every control snaps back,
            // then refresh the Undo/Apply states (now clean).
            void refresh().then(() => {
                updateUndoState();
                updateApplyDisplayState();
            });
        });
        updateUndoState();

        // "Setup guide" — relaunches the onboarding tour. Same flow as
        // Python's settings.js btn-show-tour handler: reset the dismiss
        // flags and walk through the wizard from the welcome step.
        const tourBtn = root.querySelector<HTMLButtonElement>('#btn-show-tour');
        if (tourBtn) {
            tourBtn.addEventListener('click', () => {
                const isMac = /Mac/.test(
                    typeof navigator !== 'undefined' ? navigator.platform || '' : ''
                );
                // TODO(post-port): piper availability comes from a Flask
                // template flag in the Python UI (`data-piper-available`
                // on #settings-data). Plumb the same signal into the TS
                // settings view (likely via /api/providers or a new
                // /api/tts-engines endpoint) so the Piper option appears
                // when the engine is installed.
                void resetSettingsTour({
                    piperAvailable: true,
                    isMac,
                });
            });
        }

        // "Open config folder" — Python opens the user's config dir
        // via /api/open-config-folder. Browser preview reaches Flask;
        // standalone shells don't. Show the button only when Flask
        // responds.
        const openConfigBtn = root.querySelector<HTMLButtonElement>('#btn-open-config-folder');
        if (openConfigBtn) {
            void (async () => {
                try {
                    const resp = await fetch(appUrl('/open-config-folder'), { method: 'OPTIONS' });
                    // Even a 405 (POST-only) confirms the route exists.
                    if (resp.status === 200 || resp.status === 405) {
                        openConfigBtn.classList.remove('hidden');
                    }
                } catch {
                    /* Flask down → leave hidden */
                }
            })();
            openConfigBtn.addEventListener('click', () => {
                void fetch(appUrl('/open-config-folder'), { method: 'POST' });
            });
        }
    }

    await refresh();
    applyChromeSettings(settings);

    // Surface the BYOK-needs-key warning at the top of the page if a
    // BYOK provider is selected but no key is stored.
    void (async () => {
        const p = settings.defaultProvider;
        if (providerNeedsKey(p) && !(await hasApiKey(p))) {
            const status = root.querySelector<HTMLElement>('#s-provider-status');
            if (status) {
                status.textContent =
                    'Selected provider has no API key. Paste one above before starting a session.';
                status.classList.remove('hidden');
            }
        }
    })();

    return {
        async show() {
            await refresh();
        },
    };
}

// ---------------------------------------------------------------------------
// API key URLs / prefixes — matches settings.js::providerKeyInfo
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
    // claude_proxy uses the local `claude` CLI's existing login —
    // no API key entered through this page.
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
            ${renderAccountSection()}
            ${renderProviderSection(s)}
            ${renderLanguageSection(s)}
            ${renderTtsSection(s)}
            ${renderDisplaySection(s)}
            ${renderPacingSection(s)}
            ${
                // Network (host binding) and Updates (desktop auto-updater) are
                // meaningless in a hosted browser tab — they only apply to the
                // desktop / self-host builds.
                isWebMode() ? '' : renderNetworkSection(s) + renderUpdatesSection(s)
            }
            ${
                // Danger zone lives last. Shown on the hosted build (for the BYOK
                // opt-in) and whenever aloud cloud is reachable (for account
                // deletion — local installs included). Each control inside
                // self-gates, so the section is never empty. meditation-pal-8jc.
                isWebMode() || capabilitiesSync().cloud ? renderDangerZoneSection(s) : ''
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

function renderAccountSection(): string {
    // Shell only — wireAccountSection() fills #account-body asynchronously
    // (signed-in email + balance, or the Google sign-in button).
    return `
    <section class="settings-section" id="account-section">
        <h2>Account</h2>
        <div class="account-body" id="account-body">
            <p class="provider-hint">Loading…</p>
        </div>
    </section>`;
}

function renderProviderSection(s: AppSettings): string {
    // Show only providers the environment can reach (hosted needs the server,
    // Ollama a local daemon, claude_proxy Flask). Capabilities are cached at app
    // boot; if unresolved they read false, so an unreachable source is hidden
    // until the next render — in practice the probe finishes before first paint.
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
            <p><strong>What is an LLM?</strong> — A large language model is the AI that listens to what you say and generates thoughtful responses to guide your meditation.</p>
            <p><strong>Anthropic (Subscription)</strong> — Uses your existing Claude Pro/Max subscription via the locally-installed <code>claude</code> CLI. Desktop only.</p>
            <p><strong>Ollama (Local)</strong> — Free and private. Runs the AI entirely on your computer.</p>
            <p><strong>API Key providers</strong> — Pay-per-use cloud AI. Sign up with the provider, paste the key here.</p>
        </div>
        <p class="settings-desc">Choose how aloud connects to a language model.</p>

        <div class="form-row">
            <div class="form-group form-group-half">
                <label for="s-provider">Default Provider</label>
                <select id="s-provider" name="provider">${providerOptions}</select>
            </div>
            <div class="form-group form-group-half">
                <label>Default Model</label>
                <div id="s-model-slot"></div>
            </div>
        </div>

        ${keyRows}

        <div id="s-provider-status" class="provider-hint hidden"></div>

        <!-- Ollama-specific: per-machine recommendation + installed-model
             management. Visible only when provider == "ollama"; populated by
             settings-ollama.ts from /api/providers's ollama.recommendation. -->
        <div id="s-ollama-recommendation" class="ollama-rec-section hidden"></div>
    </section>`;
}

function renderLanguageSection(s: AppSettings): string {
    const langOptions = LANGUAGES.map(
        ([v, label]) =>
            `<option value="${v}"${v === s.language ? ' selected' : ''}>${escape(label)}</option>`
    ).join('');
    // Mode-aware STT sources: Whisper is local-only, browser speech appears when
    // the API exists, the hosted option is always offered (and labeled as
    // credit-using). The selected value is the resolved choice (stored pick or
    // the mode's flow default) — there's no "automatic" entry.
    const sttSelected = resolveSttChoice(s.sttEngine, isWebMode());
    const sttOptions = sttEngineOptions(isWebMode())
        .map(
            ({ value, label }) =>
                `<option value="${value}"${value === sttSelected ? ' selected' : ''}>${escape(label)}</option>`
        )
        .join('');

    return `
    <section class="settings-section">
        <h2>Language &amp; Speech Recognition</h2>
        <div class="form-row form-row-thirds">
            <div class="form-group form-group-third">
                <label for="s-language">Language</label>
                <select id="s-language" name="language">${langOptions}</select>
                <span class="form-hint">Affects speech recognition and voice previews</span>
            </div>
            <div class="form-group form-group-third">
                <label for="s-stt-engine">Speech Recognition</label>
                <select id="s-stt-engine" name="stt_engine">${sttOptions}</select>
                <span class="form-hint" id="s-stt-engine-hint"></span>
            </div>
            <div class="form-group form-group-third${
                sttSelected === 'whisper' ? '' : ' whisper-slot-hidden'
            }" id="s-whisper-model-group">
                <label for="s-whisper-model">Whisper Model</label>
                <select id="s-whisper-model" name="whisper_model">
                    <option value="tiny">Tiny (fastest)</option>
                    <option value="base">Base</option>
                    <option value="small">Small (recommended)</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large (most accurate)</option>
                </select>
                <span class="form-hint">Larger = more accurate but slower.</span>
            </div>
        </div>
    </section>`;
}

function renderTtsSection(s: AppSettings): string {
    const engines: ReadonlyArray<[TtsEngineChoice, string]> = [
        ['macos', "macOS (built-in 'say')"],
        ['piper', 'Piper (local neural TTS)'],
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
    <section class="settings-section">
        <h2>Text-to-Speech <button type="button" class="info-btn" id="tts-info-btn" aria-label="TTS engine info">?</button></h2>
        <div class="info-panel hidden" id="tts-info-panel">
            <p><strong>macOS</strong> — Built-in system voices. Zero latency, works offline.</p>
            <p><strong>Piper</strong> — Fast local neural TTS, ~60–100 MB per voice.</p>
            <p><strong>Browser</strong> — Uses your browser's speechSynthesis. No install needed.</p>
            <p><strong>ElevenLabs</strong> — Cloud TTS with the most natural voices. Requires an API key.</p>
        </div>
        <div class="form-row form-row-tts">
            <div class="form-group form-group-half" id="s-tts-engine-group">
                <label for="s-tts-engine">Manage TTS Engines</label>
                <select id="s-tts-engine" name="tts_engine">${opts}</select>
                <span class="form-hint" id="s-tts-engine-hint"></span>
            </div>
            <!-- The ElevenLabs key row is full-width (.form-row-tts wraps). A CSS
                 "order" rule places it differently per width (see style.css): wide —
                 engine + voices share the top row and the key drops full-width
                 below; narrow (stacked) — the key sits between engine and voices,
                 since you need a key before the voice picker is useful. The two
                 half-width inputs don't sequence cleanly the same way at both
                 widths, hence the order swap. -->
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
    return `
    <section class="settings-section">
        <h2>Pacing</h2>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label>Pause Detection (s)</label>
                ${stepper('s-silence-base', s.silenceBaseMs / 1000, 1, 15, 0.5)}
                <span class="form-hint">Minimum pause before your speech is submitted</span>
            </div>
            <div class="form-group form-group-half">
                <label>Extended Pause (s)</label>
                ${stepper('s-silence-max', s.silenceMaxMs / 1000, 2, 20, 0.5)}
                <span class="form-hint">Maximum pause tolerance after longer speech</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label>Response Delay (s)</label>
                ${stepper('s-response-delay', s.responseDelayMs / 1000, 0.5, 10, 0.5)}
                <span class="form-hint">Wait after transcription before LLM responds</span>
            </div>
            <div class="form-group form-group-half" id="s-silence-sec-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-silence-checkins-enabled"${s.silenceCheckinsEnabled ? ' checked' : ''}>
                    <span>Check-in After Silence (s)</span>
                </label>
                ${stepper('s-silence-sec', s.silenceCheckinSec, 30, 3600, 30)}
                <span class="form-hint">Proactive check-ins after this much silence.</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-silence-mode-enabled"${s.silenceModeEnabled ? ' checked' : ''}>
                    <span>Enable holding-space mode</span>
                </label>
                <span class="form-hint">If requested, the facilitator goes silent until you ask it back. Some smaller models are over-eager to enter this mode.</span>
            </div>
        </div>
    </section>`;
}

function renderNetworkSection(_s: AppSettings): string {
    return `
    <section class="settings-section">
        <h2>Network</h2>
        <div class="form-group">
            <label for="s-host">Network Access</label>
            <select id="s-host" style="max-width:280px" disabled>
                <option value="127.0.0.1">Local only (127.0.0.1)</option>
                <option value="0.0.0.0">LAN access (0.0.0.0)</option>
            </select>
            <span class="form-hint">LAN access lets other devices on your network connect. Requires restart.</span>
        </div>
    </section>`;
}

function renderUpdatesSection(_s: AppSettings): string {
    return `
    <section class="settings-section">
        <h2>Updates</h2>
        <div class="form-group">
            <div class="settings-update-row">
                <span class="settings-update-status" id="s-update-status">Current version</span>
                <button type="button" class="btn btn-small btn-secondary" id="s-check-update" disabled>Check for Updates</button>
            </div>
        </div>
    </section>`;
}

// The genuinely consequential controls, set apart in red (.settings-danger).
// Each self-gates: the BYOK opt-in is web-only (a footgun on the hosted build;
// local always shows keys, so the checkbox is pointless there), and account
// deletion shows wherever there's a cloud account — including locally, for
// managing test accounts. meditation-pal-8jc.
function renderDangerZoneSection(s: AppSettings): string {
    const byok = isWebMode()
        ? `<div class="form-group">
            <label class="checkbox-label">
                <input type="checkbox" id="s-enable-byok"${s.enableByok ? ' checked' : ''}>
                <span>Use my own API keys</span>
            </label>
            <span class="form-hint">aloud's hosted models need no key. Turn this on to use your own provider keys instead; we don't store user keys, but only enable this if you understand the risks.</span>
        </div>`
        : '';
    const del = capabilitiesSync().cloud
        ? `<div class="form-group">
            <div class="settings-danger-row">
                <div>
                    <div class="settings-danger-label">Delete account</div>
                    <span class="form-hint">Permanently deletes your account and frees your sign-in to start over. Any remaining credits are forfeited and can't be refunded. This can't be undone.</span>
                </div>
                <button type="button" class="btn btn-danger" id="s-delete-account">Delete account</button>
            </div>
        </div>`
        : '';
    return `
    <section class="settings-section settings-danger" id="danger-zone">
        <h2>Danger zone</h2>
        ${byok}
        ${del}
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

/** Mask a stored API key for display: first few + … + last 4, e.g. sk-a…wxyz. */
function maskKey(key: string): string {
    const k = key.trim();
    if (k.length <= 8) return '••••';
    return `${k.slice(0, 4)}…${k.slice(-4)}`;
}

// Keep DEFAULT_APP_SETTINGS referenced so tree-shaking doesn't drop it
// from the bundle when the only consumer of app-settings.ts is this file.
void DEFAULT_APP_SETTINGS;

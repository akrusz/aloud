/**
 * Session view — the actual meditation conversation.
 *
 * Takes a configured SessionSetup, builds the PromptBuilder + session
 * manager + LLM provider, then runs the conversation loop until the
 * user ends it. Calls back to the parent when the user wants to return
 * to setup.
 */

import {
    PromptBuilder,
    SessionManager,
    PacingController,
    TurnDecision,
    parseHoldSignal,
    generateSessionSummary,
    defaultPacingConfig,
} from '../../../src/facilitation/index.js';
import type { SessionState } from '../../../src/facilitation/session.js';
import {
    AnthropicProvider,
    OllamaProvider,
    OpenAIProvider,
    OpenRouterProvider,
    VeniceProvider,
    GroqProvider,
    type LLMProvider,
} from '../../../src/llm/index.js';
import type { SttEngine, TtsEngine } from '../../../src/platform/index.js';
import { isNonSpeechOnly } from '../../../src/platform/index.js';
import { streamCompletionWithChunkedTts } from '../streaming-tts.js';
import { wrapTtsWithBargeIn } from '../barge-in.js';
import { ClaudeProxyHttpProvider } from '../adapters/claude-proxy-http.js';
import { CloudLlmProvider, type CloudProviderId } from '../adapters/cloud-llm.js';
import { ensureCloudToken, fetchMe } from '../cloud-auth.js';
import { getKnownBalance, subscribeBalance } from '../cloud-balance.js';
import { getRetreatCovered } from '../cloud-coverage.js';
import { creditAmount, RATE_EMOJI } from '../credit-rate.js';

import {
    createSttForChoice,
    sttBackendForChoice,
    resolveSttChoice,
    invalidateSttBackendCache,
    type SttBackend,
} from '../adapters/stt-picker.js';
import { isWebMode } from '../app-mode.js';
import { createTtsForVoice, createCloudAloudTts } from '../adapters/tts-picker.js';
import { CloudWhisperSttEngine } from '../adapters/cloud-whisper-stt.js';
import { startCloudSession, clearCloudSession } from '../cloud-session.js';
import { type SessionSetup, dirStepToBackend } from '../settings.js';
import { loadAppSettings } from '../app-settings.js';
import { sessionStore } from '../state.js';
import { showEndConfirm as wireEndConfirm } from './end-confirm.js';
import { getApiKey } from '../api-keys.js';
import {
    mountEmberContainer,
    unmountEmberContainer,
    wireEmberControls,
} from '../embers.js';
import { initKasinaMode } from '../kasina.js';
import { initThemeToggle } from '../theme.js';
import { showErrorToast } from '../toast.js';
import { showBuyCreditsModal } from '../buy-credits-modal.js';
import { playCannedApology } from '../canned-apology.js';
import { OUT_OF_CREDITS_MESSAGE, BILLING_PAUSED_FINISH } from '../billing-messages.js';
import { startMicMeter, type MicMeter } from '../mic-meter.js';
import { isTauri } from '../is-desktop.js';
import { acquireWakeLock, releaseWakeLock } from '../wakelock.js';
import { appUrl } from '../app-base.js';
import {
    buildScoredVoiceList,
    fetchServerVoices,
    fetchCloudVoices,
    prefixedVoiceId,
    previewVoice as runVoicePreview,
    previewErrorMessage,
    renderVoiceList,
    renderVoiceModalHTML,
    stopPreview as stopVoicePreview,
    updateVoiceSelection,
    type ScoredVoice,
} from '../voice-picker.js';

// Anthropic blocks browser-origin requests outright; the others (OpenAI,
// OpenRouter, Venice, Groq) accept browser CORS. So Anthropic always
// routes through the Flask proxy in browser preview; the rest go BYOK
// direct from the browser. Mobile (Capacitor) will need a different
// path for Anthropic — either @capacitor/http or a hosted proxy.
const ANTHROPIC_PROXY_URL = appUrl('/llm/anthropic/messages');
const OLLAMA_PROXY_URL = '/ollama';

export async function buildProvider(setup: SessionSetup): Promise<LLMProvider> {
    const modelOpt = setup.model ? { model: setup.model } : {};
    switch (setup.provider) {
        case 'aloud': {
            // Hosted, metered proxy. Sign in (dev flow until OAuth lands) so the
            // request carries a bearer token. setup.model is "provider/model";
            // the model id itself may contain a slash (openrouter), so split once.
            await ensureCloudToken();
            const slash = setup.model.indexOf('/');
            const sub = slash > 0 ? setup.model.slice(0, slash) : '';
            const model = slash > 0 ? setup.model.slice(slash + 1) : '';
            if (!sub || !model) {
                throw new Error('Pick a model for the aloud cloud in Settings.');
            }
            return new CloudLlmProvider({ provider: sub as CloudProviderId, model });
        }
        case 'ollama':
            return new OllamaProvider({ baseUrl: OLLAMA_PROXY_URL, ...modelOpt });
        case 'anthropic': {
            // Anthropic blocks browser-origin requests (no CORS), so we always
            // go through the app backend's proxy. On desktop that proxy has no
            // server-side key, so forward the user's BYOK key — it only travels
            // to the local loopback server. The proxy falls back to a
            // server-side ANTHROPIC_API_KEY in dev when no key is sent.
            const anthropicKey = await getApiKey('anthropic');
            return new AnthropicProvider({
                baseUrl: ANTHROPIC_PROXY_URL,
                ...(anthropicKey ? { apiKey: anthropicKey } : {}),
                ...modelOpt,
            });
        }
        case 'claude_proxy':
            // The `claude` CLI is a subprocess — the app backend runs it on our
            // behalf and exposes the result over /app/v1/llm/claude_proxy.
            return new ClaudeProxyHttpProvider(modelOpt);
        case 'openai':
        case 'openrouter':
        case 'venice':
        case 'groq': {
            // BYOK direct from the browser — these accept CORS.
            const apiKey = await getApiKey(setup.provider);
            if (!apiKey) {
                throw new Error(
                    `No API key set for ${setup.provider}. ` +
                        `Add it in Settings, or pick a different provider.`
                );
            }
            const opts = { apiKey, ...modelOpt };
            if (setup.provider === 'openai') return new OpenAIProvider(opts);
            if (setup.provider === 'openrouter') return new OpenRouterProvider(opts);
            if (setup.provider === 'venice') return new VeniceProvider(opts);
            return new GroqProvider(opts);
        }
    }
}


export interface SessionViewHandle {
    /** Tear down the running session and release resources. */
    teardown(): void;
    /**
     * Open the standard end-session confirmation overlay for a navigation
     * request that originated outside the session UI (e.g. browser/hardware
     * Back). The view picks an appropriate message for `destination` and, on
     * confirm, tears down and routes the user there via onEnd.
     */
    requestLeave(destination?: SessionEndDestination): void;
}

export type SessionEndDestination = 'setup' | 'history' | 'settings' | 'account';

export async function mountSessionView(
    root: HTMLElement,
    setup: SessionSetup,
    onEnd: (destination?: SessionEndDestination) => void,
    continueFrom: SessionState | null = null
): Promise<SessionViewHandle> {
    root.innerHTML = renderSessionHTML();

    const builder = new PromptBuilder({
        config: {
            focuses: setup.focuses,
            qualities: setup.qualities,
            directiveness: dirStepToBackend(setup.dirStep),
            verbosity: setup.verbosity,
            customInstructions: setup.customInstructions,
        },
    });
    const session = new SessionManager({ contextStrategy: 'full' });
    session.startSession();
    // Tag every metered cloud call this session makes with one opaque grouping
    // id, so the server's cost report attributes them to one session exactly
    // (cloud-session.ts). Carries no content/PII; cleared at endSession().
    startCloudSession();

    // If continuing from a previous session, hydrate the new session
    // with the old exchanges so the LLM has context.
    if (continueFrom && continueFrom.exchanges.length > 0) {
        session.loadExchanges(continueFrom.exchanges);
    }

    // Pacing config — read from persisted app settings so the values the
    // user tunes in the settings page actually affect the running
    // session. Falls back to defaults when nothing is persisted.
    const appSettings = await loadAppSettings();
    const pacingConfig = {
        ...defaultPacingConfig,
        responseDelayMs: appSettings.responseDelayMs,
        silenceCheckinSec: appSettings.silenceCheckinSec,
        silenceCheckinsEnabled: appSettings.silenceCheckinsEnabled,
        silenceModeEnabled: appSettings.silenceModeEnabled,
        silenceBaseMs: appSettings.silenceBaseMs,
        silenceMaxMs: appSettings.silenceMaxMs,
    };
    const pacing = new PacingController({ config: pacingConfig });
    pacing.startSession();

    let provider: LLMProvider;
    try {
        provider = await buildProvider(setup);
    } catch (err) {
        root.innerHTML = `
            <section class="session-stage">
                <div class="status">
                    <div id="status">${(err as Error).message}</div>
                </div>
            </section>
            <section class="controls">
                <button id="back" type="button" data-nav="setup">Back to setup</button>
            </section>`;
        return {
            teardown() {
                /* nothing to tear down */
            },
            requestLeave() {
                /* no live session to guard */
            },
        };
    }
    // Build a TTS engine for a voice id, wrapped with a barge-in listener so
    // the user can interrupt the facilitator mid-sentence by speaking. The
    // listener opens its own mic stream during speak() — separate from the STT
    // adapter — and calls cancel() when energy crosses the threshold for a few
    // consecutive frames.
    const onBargeIn = () => {
        // Visual cue: drop the holding-orb if it was up. The listen loop will
        // pick up the user's next utterance naturally.
        setOrbHolding(false);
    };

    // Re-probe each time the user starts a session: Flask may have come up
    // (or gone down) since the last detection.
    invalidateSttBackendCache();
    const vadOpts = {
        silenceBaseMs: pacingConfig.silenceBaseMs,
        silenceMaxMs: pacingConfig.silenceMaxMs,
        silenceRampRate: pacingConfig.silenceRampRate,
        minSpeechDurationMs: pacingConfig.minSpeechDurationMs,
    };
    // On the hosted provider, route STT through the server (Groq) too, so the
    // whole pipeline runs against @aloud/server. The hosted adapter is the
    // server-Whisper engine pointed at /v1/stt, so it behaves identically —
    // report it as 'server-whisper' downstream. Fall back to the best local
    // option if hosted STT can't initialize (e.g. no mic).
    // The STT source is an explicit, mode-resolved choice (Settings / setup) —
    // Whisper locally, browser speech, or the aloud cloud (credits). No
    // hidden automatic; resolveSttChoice falls back to the mode's flow default
    // when nothing's been chosen.
    const sttChoice = resolveSttChoice(appSettings.sttEngine, isWebMode());
    const stt: SttEngine | null = await createSttForChoice(sttChoice, vadOpts);
    const sttBackend: SttBackend = sttBackendForChoice(sttChoice);

    // server-Whisper detects barge-in on its own continuous capture stream, so
    // we DON'T wrap TTS with the separate-stream detector there (a second mic
    // stream doesn't get the OS echo-cancellation and trips on the
    // facilitator's own voice — the self-barge-in bug). Other STT backends
    // (web-speech, capacitor) have no such stream, so they keep the wrapper.
    const engineDrivenBargeIn = sttBackend === 'server-whisper';
    async function buildTts(voiceId: string | null) {
        // Server-side synthesis is billable compute — fold chars into usage.
        const ttsOpts = { onServerSynthesize: (chars: number) => session.recordTts(chars) };
        let engine;
        if (setup.provider === 'aloud' && !voiceId?.startsWith('browser:')) {
            // Hosted pipeline: synthesize via the server (Google Cloud TTS).
            // `aloud:<name>` selects a Google voice; a null/unset voice uses the
            // server's default. A `browser:<name>` voice is the user explicitly
            // picking a client-side speechSynthesis voice (e.g. a macOS system
            // voice) — honor it by falling through to the normal picker instead
            // of overriding it with the hosted default (the Ava→Leda bug).
            const v = voiceId?.startsWith('aloud:') ? voiceId.slice('aloud:'.length) : '';
            engine = createCloudAloudTts(v, ttsOpts);
        } else {
            ({ engine } = await createTtsForVoice(voiceId, ttsOpts));
        }
        return engineDrivenBargeIn ? engine : wrapTtsWithBargeIn(engine, { onBargeIn });
    }
    // `let` so an in-session voice change can swap the engine (see the voice
    // modal). Reassigning here is picked up by the outer `tts` wrapper.
    let activeTts = await buildTts(setup.voice);

    /** Rebuild the live engine when the user picks a new voice mid-session. */
    async function rebuildTts(voiceId: string | null): Promise<void> {
        const next = await buildTts(voiceId);
        try {
            await activeTts.cancel();
        } catch {
            /* ignore */
        }
        activeTts = next;
    }

    // Outer wrapper: respect the TTS toggle button. When the user mutes
    // TTS, speak() becomes a no-op and any in-flight playback is
    // cancelled. Cheaper than tearing down the whole barge-in wrapper.
    const tts = {
        async speak(text: string, options?: import('../../../src/platform/index.js').TtsOptions): Promise<void> {
            if (!ttsEnabled) return;
            return activeTts.speak(text, options);
        },
        cancel(): Promise<void> {
            return activeTts.cancel();
        },
        listVoices() {
            return activeTts.listVoices();
        },
    } satisfies TtsEngine;
    // For the server-Whisper STT path, barge-in is detected on its continuous
    // (echo-cancelled) capture stream — see setBargeInHandler below. Wiring it
    // up here, after the tts wrapper exists; the engine cancels the live TTS.
    if (sttBackend === 'server-whisper' && stt instanceof CloudWhisperSttEngine) {
        stt.setBargeInHandler(() => {
            void tts.cancel();
            onBargeIn();
        });
    }

    // The session view also injects an orb into the global nav's
    // .nav-center slot and overrides the nav links to End / History.
    // Both are restored on teardown so swapping back to setup doesn't
    // leave stale chrome.
    const navCenter = document.getElementById('navCenter');
    const navLinks = document.getElementById('navLinks');
    const savedNavLinks = navLinks ? navLinks.innerHTML : null;
    if (navCenter) {
        navCenter.innerHTML = `
            <div class="nav-session-info">
                <div class="orb orb-breathing orb-nav" id="orb"></div>
                <button type="button" class="session-hamburger" id="sessionHamburger" aria-label="Session menu" aria-haspopup="true" aria-controls="mobileMoreSheet" data-mobile-more-open>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
                </button>
            </div>`;
    }
    if (navLinks) {
        navLinks.innerHTML = `
            <a href="#" id="end-btn" class="nav-end-link">End<span class="nav-word-session"> Session</span></a>
            <a href="#" data-nav="history">History</a>
            <button type="button" class="theme-toggle"
                data-theme-toggle aria-label="Toggle theme"></button>`;
        // Re-init the theme toggle since we just replaced its DOM node.
        const themeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
        if (themeBtn) initThemeToggle(themeBtn);
    }

    const conversation = root.querySelector<HTMLElement>('#conversation')!;
    const typingIndicator = root.querySelector<HTMLElement>('#typing-indicator')!;
    const statusEl = root.querySelector<HTMLElement>('#voice-status')!;
    const timerEl = root.querySelector<HTMLElement>('#timer')!;
    const ttsToggle = root.querySelector<HTMLButtonElement>('#tts-toggle')!;
    const micBtn = root.querySelector<HTMLButtonElement>('#voice-btn')!;
    const listenBtn = root.querySelector<HTMLButtonElement>('#listen-btn')!;
    const voicePickerBtn = root.querySelector<HTMLButtonElement>('#voice-picker-btn')!;
    const kasinaToggle = root.querySelector<HTMLInputElement>('#kasina-toggle')!;
    const orbEl = document.getElementById('orb');
    const endBtn = document.getElementById('end-btn') as HTMLAnchorElement | null;

    // Orb states mirror the existing app's behavior: always breathing,
    // with `orb-holding` layered on during silence mode. Richer states
    // (listening / thinking / speaking variants) are tracked in
    // meditation-pal-1au.
    function setOrbHolding(holding: boolean): void {
        if (orbEl) orbEl.classList.toggle('orb-holding', holding);
    }

    function setStatus(text: string): void {
        statusEl.textContent = text;
    }

    function appendMessage(
        role: 'user' | 'assistant',
        text: string,
        partial = false
    ): HTMLElement {
        const el = document.createElement('div');
        el.className = `message ${role === 'assistant' ? 'facilitator' : 'user'}${partial ? ' partial' : ''}`;
        // Match Python: text wrapped in .message-content for styling.
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = text;
        el.appendChild(content);
        // Insert before the typing indicator so it stays at the bottom.
        conversation.insertBefore(el, typingIndicator);
        conversation.scrollTop = conversation.scrollHeight;
        return el;
    }

    /** Render a billing apology (paused / out-of-credits) as a transient
     *  facilitator bubble. It is deliberately NOT added to session history, so
     *  the saved transcript — and the next LLM call's context — resume from the
     *  last real turn once the user tops up or switches to a local/BYOK
     *  provider. With showBuy, an inline button opens the top-up modal right in
     *  the conversation (only useful out-of-credits; a top-up can't lift a
     *  soft-launch pause). */
    function appendBillingApology(text: string, showBuy: boolean): void {
        const el = appendMessage('assistant', text);
        if (!showBuy) return;
        // A retreat attendee (meditation-pal-414) shouldn't be nudged to buy —
        // their cap reset is what restores access, not a top-up.
        if (getRetreatCovered()) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'buy-clouds-inline';
        btn.textContent = 'Buy clouds to continue';
        btn.addEventListener('click', () => {
            void showBuyCreditsModal({
                title: "You're out of clouds",
                subtitle: 'Top up to keep going, or switch to a local/BYOK provider in Settings.',
            });
        });
        el.appendChild(btn);
    }

    /** The voice name to voice a canned apology in. Strips the `aloud:` prefix
     *  for the hosted endpoint; returns null (server default, then browser
     *  fallback) for a browser-side voice or non-hosted provider. */
    function cannedVoice(): string | null {
        const v = setup.voice;
        if (setup.provider === 'aloud' && v?.startsWith('aloud:')) return v.slice('aloud:'.length);
        return null;
    }

    // The lifted CSS hides the bubble with `.typing-bubble { display: none }`
    // and reveals it via `.typing-bubble.visible` — so toggle the class, not
    // the `hidden` attribute (which that display rule overrides). Matches
    // src/web/static/js/ui.js showTyping/hideTyping.
    function showTyping(): void {
        typingIndicator.classList.add('visible');
        conversation.scrollTop = conversation.scrollHeight;
    }
    function hideTyping(): void {
        typingIndicator.classList.remove('visible');
        setFacilitatorHint(null);
    }

    // Transient hint shown next to the typing dots (e.g. Ollama "Loading
    // model into memory…" on first hit). Mirrors ui.js setFacilitatorStatus —
    // a .facilitator-status-hint inserted right after the typing indicator.
    function setFacilitatorHint(message: string | null): void {
        let el = document.getElementById('facilitator-status-hint');
        if (!message) {
            el?.classList.remove('visible');
            return;
        }
        if (!el) {
            el = document.createElement('div');
            el.id = 'facilitator-status-hint';
            el.className = 'facilitator-status-hint';
            typingIndicator.insertAdjacentElement('afterend', el);
        }
        el.textContent = message;
        el.classList.add('visible');
        conversation.scrollTop = conversation.scrollHeight;
    }

    // Session timer — counts since mount, formatted m:ss or h:mm:ss.
    const sessionStartMs = Date.now();

    // Keep the screen on for the duration of the session. The wake lock
    // module also re-acquires on visibility change while
    // body[data-session-active] is set.
    document.body.dataset['sessionActive'] = 'true';
    void acquireWakeLock();
    function updateTimer(): void {
        const elapsed = Math.floor((Date.now() - sessionStartMs) / 1000);
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
        timerEl.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }
    updateTimer();
    const timerInterval = setInterval(updateTimer, 1000);

    // Initial mic / status hint.
    if (stt === null) {
        micBtn.disabled = true;
        micBtn.classList.add('disabled');
        const hint =
            'No microphone available. Try Chrome or Edge for built-in speech ' +
            'recognition, or check your microphone permissions.';
        micBtn.title = hint;
        setStatus('Mic unavailable');
    } else {
        setStatus('Listening…');
    }

    function insertDivider(text: string): void {
        const divider = document.createElement('div');
        divider.className = 'message divider';
        divider.textContent = text;
        conversation.insertBefore(divider, typingIndicator);
    }

    // If continuing, render the old exchanges in the transcript with a
    // "continuing from earlier" divider above them.
    if (continueFrom && continueFrom.exchanges.length > 0) {
        const oldDate = new Date(continueFrom.startTime * 1000).toLocaleString();
        insertDivider(`continuing from ${oldDate}`);
        for (const ex of continueFrom.exchanges) {
            if (ex.role === 'user' || ex.role === 'assistant') {
                appendMessage(ex.role, ex.content);
            }
        }
        insertDivider('resumed');
    }

    // Show the intention as a faint first line of context, if set.
    if (setup.intention.trim()) {
        insertDivider(`intention: ${setup.intention}`);
    }

    let busy = false;
    let muted = false;
    let listenLoopRunning = false;
    let torn = false;
    let silenceMode = false;
    // True while the voice-picker modal is open: pause listening so the
    // mic doesn't transcribe a voice preview's own audio and "respond" to it.
    let voiceModalOpen = false;
    let currentPartial: HTMLElement | null = null;
    let scoredVoices: ScoredVoice[] = [];

    // Live in-session balance (opt-in; meditation-pal-14s). Off by default — a
    // ticking credit count is distracting mid-meditation — so this stays hidden
    // unless the user enabled it. When on, it reads the shared balance store the
    // LLM proxy feeds every turn, so it updates live without extra round-trips.
    let unsubscribeBalance: (() => void) | null = null;
    const balanceEl = root.querySelector<HTMLElement>('#session-balance');
    // Covered retreat attendees have no meaningful balance to tick down, so the
    // live readout would only show a frozen number — skip it (meditation-pal-414).
    if (balanceEl && appSettings.showSessionBalance && !getRetreatCovered()) {
        const paintBalance = (b: number | null): void => {
            balanceEl.textContent = b == null ? '' : `${creditAmount(b)}${RATE_EMOJI}`;
            balanceEl.classList.toggle('hidden', b == null);
        };
        paintBalance(getKnownBalance());
        unsubscribeBalance = subscribeBalance(paintBalance);
        // Seed from /me if we haven't observed a balance yet this load (fetchMe
        // publishes into the store, which repaints via the subscription).
        if (getKnownBalance() == null) void fetchMe();
    }

    async function respondTo(userText: string): Promise<void> {
        if (busy) return;
        // Drop transcriptions that are only non-speech markers (e.g. "[cough]",
        // "[BLANK_AUDIO]", "(wind blowing)", "*sighs*") or otherwise carry no
        // words — a cough, breath, or background noise shouldn't take the user's
        // turn or wake us from a silence hold. (Ports the Python app's
        // isNonSpeechOnly guard; the partial bubble is already cleared by the
        // listen loop before this runs.)
        if (isNonSpeechOnly(userText)) return;
        busy = true;
        try {
            // Speech-end event into the pacing controller — auto-exits
            // silence mode if we were in it, returns RESPOND.
            pacing.onSpeechEnd();
            pacing.onTranscription(userText);
            if (silenceMode) {
                silenceMode = false;
                setOrbHolding(false);
            }
            appendMessage('user', userText);
            session.addUserMessage(userText);
            // Show the "…" bubble the instant we submit, before any network
            // round-trips, so the user sees their turn was received.
            showTyping();
            setStatus('Thinking…');

            // For Ollama: if the model isn't currently loaded into memory,
            // surface that next to the dots so the user knows why the first
            // response is slow. Cheap (one HTTP call), and Ollama-only.
            if (provider instanceof OllamaProvider) {
                setFacilitatorHint(await provider.coldLoadMessage());
            }

            const systemPrompt = builder.buildSystemPrompt();
            // Streaming + sentence-chunked TTS — falls back to non-streaming
            // when the provider doesn't implement completeStream. The
            // facilitator's first sentence starts speaking before the
            // remainder finishes generating.
            //
            // We don't render the partial text into the transcript here
            // because the [HOLD] prefix (if any) hasn't been stripped from
            // the early deltas. Render the cleaned full text at the end.
            setStatus('Speaking…');
            const { text: rawText, ttsDone, usage, finishReason } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                session.getContextMessages(),
                { system: systemPrompt, ttsOptions: { rate: setup.ttsRate } }
            );
            const { signal, cleanText } = parseHoldSignal(rawText);
            hideTyping();
            // A soft-launch-pause canned turn (proxy spoke a graceful apology,
            // charged nothing): show it transiently but keep it OUT of session
            // history/logs, so we resume from the last real turn. No buy prompt
            // and no silence mode — a top-up can't lift the pause.
            const ephemeral = finishReason === BILLING_PAUSED_FINISH;
            if (!ephemeral) session.addAssistantMessage(cleanText, undefined, usage);
            appendMessage('assistant', cleanText);

            // Wait for any in-flight TTS chunks to finish so the next
            // turn doesn't pile on top.
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            // Honor pacingConfig.silenceModeEnabled — when false, the
            // [HOLD] signal is dropped and we treat the response as a
            // normal one.
            const enterHold = !ephemeral && signal === 'hold' && pacingConfig.silenceModeEnabled;
            if (enterHold) {
                silenceMode = true;
                pacing.enterSilenceMode();
                setStatus('Holding space, anything you say resumes');
                setOrbHolding(true);
            } else {
                setStatus(stt ? 'Listening…' : 'Mic unavailable');
            }
            pacing.onResponseEnd();
        } catch (err) {
            hideTyping();
            const msg = (err as Error).message;
            // Running out of credits is a graceful stop, not an error. Show the
            // same ephemeral apology (NOT saved to history — we resume from the
            // last real turn once topped up or switched to local/BYOK), voice it
            // via the free canned endpoint, and offer a one-tap top-up right in
            // the transcript. (meditation-pal-44o, meditation-pal-4l5)
            if (/insufficient_credits|out of credits|endpoint 402/i.test(msg)) {
                appendBillingApology(OUT_OF_CREDITS_MESSAGE, true);
                void playCannedApology('insufficient_credits', cannedVoice(), OUT_OF_CREDITS_MESSAGE);
            } else {
                // Other failures: a transient toast is more visible than the
                // small status line, and the loop resumes listening so the
                // session isn't wedged.
                showErrorToast(describeCloudError(msg) ?? `Something went wrong: ${msg}`);
            }
            setStatus(stt ? 'Listening…' : 'Mic unavailable');
        } finally {
            busy = false;
            // Persist the turn (user message + whatever response or error)
            // every round, so an offline LLM call or a crash still leaves the
            // transcript recoverable. No-op unless logging is on.
            void autosaveSession();
        }
    }

    /**
     * Always-on listening loop — matches the existing app's behavior.
     * Each iteration runs a single STT utterance; when speech ends, we
     * dispatch the transcription to respondTo() (which awaits TTS),
     * then loop back. Pauses while busy (LLM call + TTS playback) so
     * the mic doesn't pick up the speaker output as user input.
     *
     * Barge-in handling — interrupting TTS by speaking — is the real
     * app's behavior and lives in meditation-pal-1au for a separate
     * lift-first pass.
     */
    async function listenLoop(): Promise<void> {
        if (!stt || listenLoopRunning) return;
        listenLoopRunning = true;
        // Toast a mic error only when it first appears (the loop re-checks
        // every 2s) so a persistent fault doesn't spam toasts; reset on a
        // successful capture so a later recurrence surfaces again.
        let lastMicErrorToast: string | null = null;
        try {
            while (!torn && !muted) {
                while ((busy || voiceModalOpen) && !torn && !muted) {
                    await new Promise<void>((r) => setTimeout(r, 100));
                }
                if (torn || muted) break;

                let finalText = '';
                let micError: string | null = null;
                try {
                    for await (const event of stt.start()) {
                        if (event.type === 'partial') {
                            if (!currentPartial) {
                                currentPartial = appendMessage('user', event.text, true);
                            } else {
                                // Update the inner .message-content, not the
                                // bubble itself — setting textContent on the
                                // bubble would wipe that wrapper element.
                                const content =
                                    currentPartial.querySelector('.message-content');
                                if (content) content.textContent = event.text;
                            }
                        } else if (event.type === 'final') {
                            finalText = event.text;
                            // Billable server-side STT compute (Whisper) reports
                            // audio seconds; on-device engines omit it.
                            if (event.seconds) session.recordStt(event.seconds);
                        } else if (event.type === 'error') {
                            micError = describeSttError(event.error);
                        }
                    }
                } catch (err) {
                    micError = describeSttError(err);
                }
                if (currentPartial) {
                    currentPartial.remove();
                    currentPartial = null;
                }
                if (torn || muted) break;
                // The voice modal opened mid-capture — discard whatever was
                // heard (likely a voice preview) and wait it out.
                if (voiceModalOpen) continue;

                if (finalText.trim()) {
                    lastMicErrorToast = null;
                    await respondTo(finalText.trim());
                } else if (micError) {
                    setStatus(micError);
                    if (micError !== lastMicErrorToast) {
                        showErrorToast(micError);
                        lastMicErrorToast = micError;
                    }
                    // Brief backoff so a broken mic doesn't tight-loop us.
                    await new Promise<void>((r) => setTimeout(r, 2000));
                }
                // Empty utterance with no error: just loop and listen again.
            }
        } finally {
            listenLoopRunning = false;
        }
    }

    function setMicButtonState(): void {
        if (!stt) return;
        // The mic button's mute-line is driven by `.btn-voice.active` in the
        // CSS (active = mic on, line hidden); .active off shows the line. Mute
        // = remove .active. Also desaturate the orb while muted (.orb-muted).
        micBtn.classList.toggle('active', !muted);
        orbEl?.classList.toggle('orb-muted', muted);
        micBtn.setAttribute(
            'aria-label',
            muted ? 'Unmute microphone' : 'Mute microphone'
        );
    }

    // Mic input-level ring (the .btn-voice.active --mic-level box-shadow). Its
    // own small analyser stream, since Web Speech hides its audio. Cosmetic —
    // failures are swallowed. Web-Speech only: the server-Whisper adapter
    // already holds its own mic stream + AudioContext, and stacking a second
    // pair was a likely contributor to the Firefox/WebRender instability.
    // (A server-Whisper meter can later reuse that adapter's existing energy.)
    let micMeter: MicMeter | null = null;
    function startMeter(): void {
        if (micMeter) return;
        // Web Speech hides its audio, so it always needs the dedicated meter.
        // server-Whisper holds its own stream; stacking a second meter stream
        // was implicated in Firefox/WebRender instability, so we only add it in
        // the Tauri desktop shell (WKWebView, where that concern doesn't apply
        // and server-Whisper is the default STT path).
        const wantMeter =
            sttBackend === 'web-speech' || (sttBackend === 'server-whisper' && isTauri());
        if (!wantMeter) return;
        void startMicMeter(micBtn)
            .then((m) => {
                if (torn || muted) m.stop(); // raced with teardown/mute
                else micMeter = m;
            })
            .catch(() => {});
    }
    function stopMeter(): void {
        micMeter?.stop();
        micMeter = null;
    }

    micBtn.addEventListener('click', () => {
        if (!stt) return;
        if (muted) {
            muted = false;
            setMicButtonState();
            // Clear the 'Muted' status — the listen loop resumes but doesn't
            // re-announce, so without this the status line stays "Muted".
            setStatus(silenceMode ? 'Holding space, anything you say resumes' : stt ? 'Listening…' : 'Ready');
            startMeter();
            void listenLoop();
        } else {
            muted = true;
            void stt.stop();
            stopMeter();
            setMicButtonState();
            setStatus('Muted');
        }
    });

    // TTS toggle — when off, we cancel any in-flight speech and skip
    // subsequent speak() calls. Visual state: the active class shows the
    // wave icons; without it, the mute-line crosses through.
    let ttsEnabled = true;
    ttsToggle.addEventListener('click', () => {
        ttsEnabled = !ttsEnabled;
        ttsToggle.classList.toggle('active', ttsEnabled);
        if (!ttsEnabled) void tts.cancel();
    });

    // Listen mode — local silence mode toggle. Matches the Python
    // listen-btn behavior: announces "holding space", orb gets the
    // holding class, anything the user says next exits the mode.
    listenBtn.addEventListener('click', () => {
        if (silenceMode) {
            silenceMode = false;
            listenBtn.classList.remove('active');
            pacing.exitSilenceMode();
            setOrbHolding(false);
            setStatus(stt ? 'Listening…' : 'Ready');
        } else {
            silenceMode = true;
            listenBtn.classList.add('active');
            pacing.enterSilenceMode();
            setOrbHolding(true);
            setStatus('Holding space, anything you say resumes');
        }
    });

    // Window/document-level listeners (kasina drag, beforeunload) outlive the
    // view's own elements, so (unlike the Flask MPA, which reloaded per
    // navigation) we must remove them on teardown or they leak across
    // sessions. One AbortController covers them all; endSession() aborts it,
    // and it's handed to initKasinaMode() so its document listeners detach too.
    const viewCleanup = new AbortController();

    // Guard against accidentally closing/reloading the tab mid-session —
    // mirrors the Flask beforeunload in src/web/static/js/chrome.js. The
    // browser shows its native "Leave site?" prompt. (In-app nav away from a
    // live session is already guarded by showEndConfirm on the End/History
    // links below.)
    window.addEventListener(
        'beforeunload',
        (e) => {
            e.preventDefault();
            e.returnValue = '';
        },
        { signal: viewCleanup.signal }
    );

    // Kasina gazing mode — shared with the noting session view. Document-level
    // listeners are tied to viewCleanup so they don't leak across sessions.
    if (orbEl) {
        initKasinaMode({
            orb: orbEl,
            root,
            toggle: kasinaToggle,
            signal: viewCleanup.signal,
        });
    }

    // Voice picker — opens the same modal layout as the setup view's
    // picker, but selecting a voice here also rebuilds the live tts
    // engine so the next utterance uses the new voice.
    void initVoicePicker();

    async function initVoicePicker(): Promise<void> {
        const [server, hosted] = await Promise.all([fetchServerVoices(), fetchCloudVoices()]);
        scoredVoices = buildScoredVoiceList(server, true, hosted);
        updateVoicePickerLabel();
    }

    function updateVoicePickerLabel(): void {
        const name = stripVoicePrefix(setup.voice);
        if (name) voicePickerBtn.textContent = `${name} · ${setup.ttsRate} wpm`;
        else voicePickerBtn.textContent = 'Voice';
    }

    voicePickerBtn.addEventListener('click', () => openSessionVoiceModal());

    function openSessionVoiceModal(): void {
        const modal = root.querySelector<HTMLElement>('#voice-modal');
        const listEl = root.querySelector<HTMLElement>('#voice-modal-list');
        const closeBtn = root.querySelector<HTMLButtonElement>('#voice-modal-close');
        const speedSlider = root.querySelector<HTMLInputElement>('#modal-speed-slider');
        const speedLabel = root.querySelector<HTMLElement>('#modal-speed-label');
        if (!modal || !listEl || !closeBtn || !speedSlider || !speedLabel) return;

        const currentName = stripVoicePrefix(setup.voice);
        renderVoiceList(listEl, scoredVoices, currentName, { showEngine: true });
        speedSlider.value = String(setup.ttsRate);
        speedLabel.textContent = `${setup.ttsRate} wpm`;
        modal.classList.remove('hidden');
        // Pause listening while the modal is open and stop any in-flight
        // capture, so voice previews aren't transcribed as user turns.
        voiceModalOpen = true;
        void stt?.stop();

        const onListClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const row = target.closest<HTMLElement>('.voice-row');
            if (!row) return;
            const name = row.dataset['voiceName'];
            if (!name) return;
            const entry = scoredVoices.find((v) => v.name === name);
            if (target.closest('.voice-row-preview')) {
                if (row.classList.contains('voice-row-locked')) return;
                runVoicePreview(name, setup.ttsRate, entry?.engine).catch((err) => {
                    showErrorToast(previewErrorMessage(err));
                });
                return;
            }
            if (row.classList.contains('voice-row-locked')) return;
            setup.voice = prefixedVoiceId(entry?.engine, name);
            updateVoiceSelection(listEl, name);
            updateVoicePickerLabel();
            // Rebuild the live engine so the next utterance uses the new
            // voice (previously only the label updated — browser/server
            // voice changes silently kept the old engine).
            void rebuildTts(setup.voice);
        };
        const onSpeedInput = () => {
            const rate = Number(speedSlider.value);
            setup.ttsRate = rate;
            speedLabel.textContent = `${rate} wpm`;
            updateVoicePickerLabel();
        };
        const closeModal = () => {
            modal.classList.add('hidden');
            stopVoicePreview();
            // Resume listening — the loop is parked in its busy/modal wait and
            // picks back up on its own; restart it if it had exited.
            voiceModalOpen = false;
            if (stt && !muted && !torn && !listenLoopRunning) void listenLoop();
            listEl.removeEventListener('click', onListClick);
            speedSlider.removeEventListener('input', onSpeedInput);
            closeBtn.removeEventListener('click', closeModal);
            modal.removeEventListener('click', onBackdrop);
        };
        const onBackdrop = (e: MouseEvent) => {
            if (e.target === modal) closeModal();
        };
        listEl.addEventListener('click', onListClick);
        speedSlider.addEventListener('input', onSpeedInput);
        closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', onBackdrop);
    }

    // Open the session with a facilitator greeting before the listen loop
    // starts. Mark busy so the mic loop doesn't hear input until the opener
    // finishes. Resuming → a warm welcome-back; fresh → a normal opener.
    {
        busy = true;
        void (async () => {
            try {
                // Prime the STT capture graph BEFORE the greeting so its onset
                // pre-buffer is already filling while the facilitator talks.
                // Without this the graph is created lazily on the first
                // start(), so a barge-in during the opening greeting has an
                // empty buffer and clips the first word(s). (d35)
                await stt?.prime?.();
                if (continueFrom && continueFrom.exchanges.length > 0) {
                    await generateContinuationOpener();
                } else {
                    await generateOpener();
                }
            } finally {
                busy = false;
            }
        })();
    }

    /**
     * Fresh-session opener — mirrors meditation_session.py::generate_opener.
     * Asks the LLM for a brief welcome via buildOpenerPrompt (the prompt is
     * a one-shot instruction, NOT kept in history), falling back to the
     * static opener pool on any error.
     */
    async function generateOpener(): Promise<void> {
        const openerPrompt = builder.buildOpenerPrompt(setup.intention.trim());
        try {
            setStatus('Speaking…');
            showTyping();
            // The opener is the first LLM call, so it's where Ollama pays the
            // cold-load cost — surface that wait like the Python app does on
            // session start (session_handlers.py).
            if (provider instanceof OllamaProvider) {
                setFacilitatorHint(await provider.coldLoadMessage());
            }
            const messages = [
                ...session.getContextMessages(),
                { role: 'user' as const, content: openerPrompt },
            ];
            const { text: rawText, ttsDone, usage } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                messages,
                { system: builder.buildSystemPrompt(), ttsOptions: { rate: setup.ttsRate } }
            );
            const { cleanText } = parseHoldSignal(rawText);
            hideTyping();
            // The opener prompt was a one-shot instruction — don't persist it;
            // record only the assistant greeting (with its usage).
            session.addAssistantMessage(cleanText, undefined, usage);
            appendMessage('assistant', cleanText);
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Mic unavailable');
        } catch (err) {
            console.warn('LLM opener failed, using static fallback', err);
            hideTyping();
            const fallback = builder.getSessionOpener();
            session.addAssistantMessage(fallback);
            appendMessage('assistant', fallback);
            try {
                await tts.speak(fallback, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Mic unavailable');
        }
    }

    async function generateContinuationOpener(): Promise<void> {
        const continuationNote =
            'The meditator is returning to continue from a previous session. ' +
            "Offer a brief, warm welcome back and gently acknowledge they're " +
            'picking up where they left off.';
        try {
            setStatus('Welcoming you back…');
            // Build the message list as: previous exchanges + the synthetic
            // continuation note. Don't write the note to session history —
            // it's a one-shot instruction, not a conversational turn.
            const messages = [
                ...session.getContextMessages(),
                { role: 'user' as const, content: continuationNote },
            ];
            setStatus('Speaking…');
            showTyping();
            const { text: rawText, ttsDone, usage } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                messages,
                {
                    system: builder.buildSystemPrompt(),
                    ttsOptions: { rate: setup.ttsRate },
                }
            );
            const { cleanText } = parseHoldSignal(rawText);
            hideTyping();
            session.addAssistantMessage(cleanText, undefined, usage);
            appendMessage('assistant', cleanText);
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Mic unavailable');
        } catch (err) {
            console.warn('Continuation opener failed', err);
            hideTyping();
            // Fall back to a static welcome — better than nothing.
            const fallback = 'Welcome back. Let’s continue.';
            session.addAssistantMessage(fallback);
            appendMessage('assistant', fallback);
            try {
                await tts.speak(fallback, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Mic unavailable');
        }
    }

    // Kick off always-on listening when the view mounts.
    if (stt) {
        setMicButtonState();
        startMeter();
        void listenLoop();
    }

    // Background check-in loop — polls the PacingController on a fixed
    // cadence. When the controller decides it's been long enough since
    // anything happened, we fire a gentle check-in ("I'm still here…")
    // to remind the user the facilitator hasn't gone anywhere. Disabled
    // when the user is in silence mode or has check-ins turned off.
    const CHECK_IN_POLL_MS = 10_000;
    const checkInTimer: ReturnType<typeof setInterval> | null = pacingConfig.silenceCheckinsEnabled
        ? setInterval(() => {
              if (torn || busy || muted) return;
              const decision = pacing.shouldRespond();
              if (decision !== TurnDecision.CheckIn) return;
              const text = builder.getCheckInPrompt();
              void respondWithFacilitatorLine(text);
          }, CHECK_IN_POLL_MS)
        : null;

    /**
     * Speak a facilitator-initiated line (check-in, not response to user
     * input). Adds it to the transcript + session history + plays TTS.
     * Does not call the LLM — the text is decided by the caller.
     */
    async function respondWithFacilitatorLine(text: string): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            session.addAssistantMessage(text);
            appendMessage('assistant', text);
            setStatus('Speaking…');
            try {
                await tts.speak(text, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Mic unavailable');
        } finally {
            busy = false;
            // Capture facilitator-initiated lines (check-ins) too, so a crash
            // between turns doesn't lose them. No-op unless logging is on.
            void autosaveSession();
        }
    }

    // End button + History link both live in the global nav (we
    // injected them on mount). Clicks during an active session go
    // through showEndConfirm() — losing a meditation to a stray tap
    // is bad UX.
    if (endBtn) {
        endBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showEndConfirm('End this session?', undefined);
        });
    }
    const historyLink = navLinks?.querySelector<HTMLAnchorElement>('[data-nav="history"]');
    if (historyLink) {
        historyLink.addEventListener('click', (e) => {
            e.preventDefault();
            // Stop the global app-level data-nav handler so it doesn't
            // also dispatch — we want our confirm to be the only entry
            // into a nav-away from the live session.
            e.stopImmediatePropagation();
            showEndConfirm(
                'Leave session to view history? This will end your current session.',
                'history'
            );
        });
    }

    /**
     * Show the End-Session confirmation overlay. After a successful
     * confirm/skip-save, the session ends and onEnd is called with
     * `destination` so the app router knows where to land the user.
     * Wires fresh handlers each call so a re-open doesn't carry the
     * previous click's destination.
     */
    function showEndConfirm(
        message: string,
        destination: SessionEndDestination | undefined
    ): void {
        wireEndConfirm(root, message, {
            saveByDefault: appSettings.saveSessionLogs,
            onBeforeSave: () => showSavingOverlay(),
            end: (skipSave) => void endSession(destination, skipSave),
        });
    }

    function showSavingOverlay(): void {
        const overlay = root.querySelector<HTMLElement>('#session-saving');
        overlay?.classList.remove('hidden');
    }

    mountEmberContainer();
    wireEmberControls(root);

    async function endSession(
        destination?: SessionEndDestination,
        skipSave = false
    ): Promise<void> {
        if (torn) return;
        torn = true;
        unsubscribeBalance?.();
        if (checkInTimer) clearInterval(checkInTimer);
        clearInterval(timerInterval);
        pacing.endSession();
        const finalState = session.endSession();
        void stt?.stop();
        stopMeter();
        void tts.cancel();
        // Relax the Ollama keep_alive to the short default so the model idles
        // out soon (not the full 30m) but stays warm for an immediate restart.
        if (provider instanceof OllamaProvider) void provider.relaxKeepAlive();
        // Release the wake lock and clear the session-active flag so the
        // visibility-change handler stops re-acquiring it.
        releaseWakeLock();
        delete document.body.dataset['sessionActive'];
        // Drop the ember container — embers are session-only.
        unmountEmberContainer();
        // Exit kasina if active — runs the toggle's exit branch, which
        // restores the pre-kasina theme and moves the orb back into the nav
        // (about to be cleared) rather than orphaning it in <body>.
        if (kasinaToggle.checked) {
            kasinaToggle.checked = false;
            kasinaToggle.dispatchEvent(new Event('change'));
        }
        // Remove the window/document-level listeners (kasina drag, beforeunload).
        viewCleanup.abort();
        // Restore the global nav slots we replaced on mount.
        if (navCenter) navCenter.innerHTML = '';
        if (navLinks && savedNavLinks !== null) {
            navLinks.innerHTML = savedNavLinks;
            // Re-init the theme toggle since its DOM node was just
            // replaced by the restore.
            const restoredThemeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
            if (restoredThemeBtn) initThemeToggle(restoredThemeBtn);
        }

        if (!skipSave && finalState && hasUserContent(finalState.exchanges)) {
            // Try to generate an LLM summary for the history row;
            // fall back to intention (or empty) if the LLM call fails.
            setStatus('Saving session…');
            let summary = '';
            try {
                // The summary is an off-transcript completion — fold its token
                // usage into the session tally before we persist finalState
                // (same object reference as session.state, so recording still
                // mutates it after endSession()).
                summary = await generateSessionSummary(provider, finalState.exchanges, {
                    onUsage: (u) => session.recordLlmUsage(u),
                });
            } catch {
                /* fall through to fallback */
            }
            finalState.meditationType = 'exploration';
            finalState.notes = summary || setup.intention.trim();
            try {
                await sessionStore.save(finalState);
            } catch (err) {
                console.warn('Failed to save session', err);
            }
        }

        // Done after the summary completion above (an off-transcript LLM turn we
        // want grouped with this session), so the next session starts a new group.
        clearCloudSession();
        onEnd(destination);
    }

    function hasUserContent(exchanges: ReadonlyArray<{ role: string }>): boolean {
        // At least one real user turn — skip saving empty sessions
        // started and immediately ended by an accidental click.
        return exchanges.some((e) => e.role === 'user');
    }

    /**
     * Persist the in-progress session to local storage without an LLM summary,
     * so a crash or going offline still leaves a recoverable transcript. No-op
     * when the user has turned off "Save session logs", or before any user turn
     * exists. The detailed summary is generated only on a clean end (see
     * endSession); until then the "Exploration" type label stands in for it in
     * the history list.
     */
    async function autosaveSession(): Promise<void> {
        if (!appSettings.saveSessionLogs) return;
        const state = session.state;
        if (!state || !hasUserContent(state.exchanges)) return;
        // Snapshot with a provisional endTime so an interrupted session still
        // shows a sensible duration in history; the live state stays active
        // (endTime null) so the running loop is unaffected. A clean end
        // overwrites this row with the real endTime + summary.
        const snapshot: SessionState = {
            ...state,
            endTime: Math.floor(Date.now() / 1000),
            meditationType: 'exploration',
        };
        try {
            await sessionStore.save(snapshot);
        } catch (err) {
            console.warn('Session autosave failed', err);
        }
    }

    return {
        teardown(): void { void endSession(); },
        requestLeave(destination?: SessionEndDestination): void {
            showEndConfirm(leaveMessage(destination), destination);
        },
    };
}

/** Message shown in the end-session confirm for an external nav request
 *  (browser Back). Matches the wording the in-session links use. */
function leaveMessage(destination?: SessionEndDestination): string {
    if (destination === 'history') {
        return 'Leave session to view history? This will end your current session.';
    }
    if (destination === 'settings') {
        return 'Leave session to view settings? This will end your current session.';
    }
    if (destination === 'account') {
        return 'Leave session to view your account? This will end your current session.';
    }
    return 'Leave your session?';
}

/** SessionSetup.voice carries a 'server:' or 'browser:' prefix; the voice
 *  picker works with raw names. Strip the prefix on the way in. */
function stripVoicePrefix(voice: string | null): string | null {
    if (!voice) return null;
    const m = /^(server|browser|aloud):(.*)$/.exec(voice);
    return m ? (m[2] ?? null) : voice;
}

/**
 * Map an error from the hosted ('aloud') server to a clear, actionable
 * message. On the hosted provider the whole pipeline (LLM, STT, TTS) runs
 * against the credit-metered server, which returns structured errors
 * ({error:{code}}, see ts/server/src/contract.ts) — but by the time they reach
 * the client they're flattened to a status + message string, so we match on
 * both the code names and the embedded HTTP status. Returns null when the error
 * isn't a recognized hosted condition, so callers keep their own phrasing.
 */
function describeCloudError(msg: string): string | null {
    if (/insufficient_credits|out of credits|endpoint 402/i.test(msg)) {
        return 'aloud cloud requires credits. Purchase more, or choose a different provider in Settings.';
    }
    if (/unauthenticated|endpoint 401/i.test(msg)) {
        return 'aloud cloud needs you to sign in again. Check Settings.';
    }
    if (/email_unverified|endpoint 403/i.test(msg)) {
        return 'Verify your email to use aloud cloud, then try again.';
    }
    if (/quota_exceeded|endpoint 429/i.test(msg)) {
        return "You've hit aloud's rate limit. Wait a moment and try again.";
    }
    return null;
}

function describeSttError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    // Hosted (aloud) conditions — credits / auth — get a clear, actionable line
    // instead of a raw "Whisper endpoint 402: {json}".
    const hosted = describeCloudError(msg);
    if (hosted) return hosted;
    // Common cases that benefit from plain-English status text.
    if (/Whisper endpoint 5\d\d/.test(msg) || /failed to fetch/i.test(msg)) {
        return 'Speech-recognition backend unreachable. Check your connection.';
    }
    if (/Whisper endpoint 503/.test(msg)) {
        return 'Whisper model still loading. Try again in a moment.';
    }
    if (/permission/i.test(msg) || /denied/i.test(msg) || /NotAllowed/.test(msg)) {
        return 'Mic permission denied. Allow microphone access and try again.';
    }
    return `Mic error: ${msg}`;
}

function renderSessionHTML(): string {
    return `
    <div class="session-container">
        <div class="conversation" id="conversation">
            <div class="message facilitator typing-bubble" id="typing-indicator">
                <div class="message-content">
                    <span></span><span></span><span></span>
                </div>
            </div>
        </div>

        <div class="input-area">
            <div class="input-row">
                <div id="voice-status" class="voice-status">Connecting…</div>
                <!-- Live cloud balance — hidden unless the user opts in
                     (Settings → "Show credit balance during sessions"). -->
                <span class="session-balance hidden" id="session-balance" title="Cloud credits remaining"></span>
                <span class="session-timer" id="timer">0:00</span>
                <button id="tts-toggle" class="btn btn-tts active" title="Read responses aloud" aria-label="Toggle text-to-speech">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                        <path class="tts-waves" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        <path class="tts-waves" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                        <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                    </svg>
                </button>
                <button id="voice-btn" class="btn btn-voice" title="Toggle microphone" aria-label="Toggle microphone">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                        <line x1="12" y1="19" x2="12" y2="23"></line>
                        <line x1="8" y1="23" x2="16" y2="23"></line>
                        <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                    </svg>
                </button>
                <button id="listen-btn" class="btn btn-listen"
                    title="Hold space. The facilitator stays quiet. Anything you say resumes the conversation.">
                    Just Listen
                </button>
            </div>
            <div class="input-controls">
                <div class="ember-level" title="Floating ember particles">
                    <span class="toggle-text">Embers</span>
                    <button class="ember-btn" id="ember-minus" type="button">−</button>
                    <div class="ember-blocks" id="ember-blocks">
                        <span class="ember-block filled" data-level="1"></span>
                        <span class="ember-block" data-level="2"></span>
                        <span class="ember-block" data-level="3"></span>
                        <span class="ember-block" data-level="4"></span>
                    </div>
                    <button class="ember-btn" id="ember-plus" type="button">+</button>
                </div>
                <label class="toggle-label" title="Kasina gazing mode">
                    <input type="checkbox" id="kasina-toggle">
                    <span class="toggle-text">Kasina</span>
                </label>
                <div class="voice-control">
                    <button type="button" id="voice-picker-btn" class="voice-picker-btn">Voice</button>
                </div>
            </div>
        </div>
    </div>

    <div class="ember-container" id="ember-container"></div>

    ${renderVoiceModalHTML({
        modalId: 'voice-modal',
        closeId: 'voice-modal-close',
        listId: 'voice-modal-list',
        speedSliderId: 'modal-speed-slider',
        speedLabelId: 'modal-speed-label',
        speedValue: 110,
    })}

    <div class="session-ended-overlay hidden" id="session-confirm">
        <div class="session-ended-content">
            <p id="confirm-text"></p>
            <div class="session-ended-actions">
                <button id="confirm-yes" type="button" class="btn btn-primary">End Session</button>
                <button id="confirm-no" type="button" class="btn btn-secondary">Cancel</button>
            </div>
            <button id="confirm-skip-save" type="button" class="btn-link hidden">End Without Saving</button>
        </div>
    </div>

    <div class="session-ended-overlay hidden" id="session-saving">
        <div class="session-ended-content">
            <p>Saving session…</p>
        </div>
    </div>`;
}

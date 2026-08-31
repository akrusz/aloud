/**
 * Noting circle orchestrator. Fully client-side: calls generateNotingLabel,
 * per-participant TTS, and the STT engine directly.
 *
 * Flow: opener → User → P1 → P2 → … → User → … Each LLM participant notes a
 * 1-2 word label in its own voice; the user notes by speaking on their turn.
 * Empty participant list = solo noting. Muting the mic pauses the circle.
 *
 * NOTE: the audio path (STT capture, TTS, chime) can't be exercised headlessly
 * and needs hands-on testing.
 */

import {
    SessionManager,
    generateNotingLabel,
    generateSessionSummary,
    pickTimerFallback,
    timerApproachLeadSec,
    NOTING_STATIC_OPENER,
    TIMER_APPROACH_FALLBACKS,
    TIMER_CLOSE_FALLBACKS,
    TIMER_COMPLETION_FALLBACKS,
} from '../../../src/facilitation/index.js';
import { OllamaProvider, type LLMProvider } from '../../../src/llm/index.js';
import type { SttEngine, TtsEngine } from '../../../src/platform/index.js';
import { isNonSpeechOnly } from '../../../src/platform/index.js';
import type { SessionState } from '../../../src/facilitation/session.js';
import {
    buildProvider,
    buildUtilityProvider,
    describeCloudError,
    type SessionEndDestination,
} from './session.js';
import { showErrorToast } from '../toast.js';
import { assetPath } from '../route-base.js';
import { showEndConfirm as wireEndConfirm } from './end-confirm.js';
import { loadAppSettings, saveAppSettings } from '../app-settings.js';
import { SessionClock } from '../session-clock.js';
import { createTtsForVoice } from '../adapters/tts-picker.js';
import { createSttForChoice, resolveSttChoice } from '../adapters/stt-picker.js';
import { isWebMode } from '../app-mode.js';
import { sessionStore } from '../state.js';
import { markSessionStarted } from '../tour/index-guide.js';
import { acquireWakeLock, releaseWakeLock } from '../wakelock.js';
import { initThemeToggle } from '../theme.js';
import {
    mountEmberContainer,
    unmountEmberContainer,
    wireEmberControls,
} from '../embers.js';
import { initKasinaMode } from '../kasina.js';
import {
    type SessionSetup,
    type NotingParticipantConfig,
    ALL_PROVIDERS,
    sessionNeedsLlm,
} from '../settings.js';
import { sessionModelLabel, isSlowModel, SLOW_MODEL_NOTE } from '../model-picker.js';
import { mountSessionInfoPanel, type SessionInfoRow } from '../session-info.js';
import { openAiContentReport, openBugReport } from '../bug-report.js';

export interface NotingSessionViewHandle {
    teardown(): void;
    /** Open the in-session info panel (model, mode, …). See the exploration
     *  session's SessionViewHandle.showInfo. */
    showInfo(): void;
    /**
     * Open the leave-confirmation overlay for an external nav request
     * (browser/hardware Back). On confirm the circle ends and onEnd fires with
     * `destination`.
     */
    requestLeave(destination?: SessionEndDestination): void;
    /** Enter/exit kasina gazing. Wired to the More sheet's Kasina entry; the
     *  nav orb toggles it directly (kasina.ts). */
    toggleKasina(): void;
}

const DEFAULT_CADENCE_MS = 4000;
const USER_TURN_CUE_DELAY_MS = 1000; // breathing room before the cue
const ECHO_REJECT_MS = 1500; // ignore "speech" this soon after the turn starts

export async function mountNotingSessionView(
    root: HTMLElement,
    setup: SessionSetup,
    onEnd: (destination?: SessionEndDestination) => void
): Promise<NotingSessionViewHandle> {
    const participants = setup.notingParticipants ?? [];
    const appSettings = await loadAppSettings();
    const session = new SessionManager({ contextStrategy: 'full' });
    session.startSession(undefined, 'noting');
    // Mark the user as no-longer-new so the setup-page tour stops auto-popping
    // on later boots (fire-and-forget).
    void markSessionStarted();

    // A circle of fixed phrases and sounds calls no model, and the opener is
    // static, so don't build a provider for one: on mobile the only provider is
    // 'aloud', and constructing it fetches a cloud token the session never needs
    // - which is what made an AI-free circle demand sign-in (meditation-pal-vr3w).
    const needsLlm = sessionNeedsLlm('noting', setup.notingParticipants);
    let provider: LLMProvider | null = null;
    // Noting labels and the session recap run on a cheap, fast, non-reasoning
    // model (see buildUtilityProvider), not the possibly slow/always-thinking
    // facilitation model. Falls back to `provider`.
    let utilityProvider: LLMProvider | null = null;
    if (needsLlm) {
        try {
            provider = await buildProvider(setup);
        } catch (err) {
            return mountError(root, (err as Error).message, onEnd);
        }
        utilityProvider = provider;
        try {
            utilityProvider = await buildUtilityProvider(setup, provider);
        } catch {
            utilityProvider = provider;
        }
    }

    // ---- nav chrome (breathing orb + End/History) ----
    const navLinks = document.getElementById('navLinks');
    const navCenter = document.getElementById('navCenter');
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
    // Flags the session chrome as exploration does: hides the mobile bottom-nav,
    // reveals the session-only More-sheet items (End/History), keeps the
    // wakelock/footer rules active. Cleared in endSession.
    document.body.dataset['sessionActive'] = 'true';
    void acquireWakeLock();
    if (navLinks) {
        navLinks.innerHTML = `
            <a href="#" id="end-btn" class="nav-end-link">End<span class="nav-word-session"> Session</span></a>
            <a href="#" data-nav="history">History</a>
            <button type="button" class="nav-info-btn" id="session-info-btn" aria-label="Session info" title="Session info">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
            <button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle theme"></button>`;
        const themeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
        if (themeBtn) initThemeToggle(themeBtn);
    }

    // Session info panel behind the nav "ⓘ" button (and the mobile More sheet).
    const infoPanel = mountSessionInfoPanel(root, (): SessionInfoRow[] => {
        const providerLabel =
            ALL_PROVIDERS.find((p) => p.value === setup.provider)?.label ?? setup.provider;
        const modelLabel = sessionModelLabel(setup.provider, setup.model);
        const streams =
            typeof (provider as { completeStream?: unknown } | null)?.completeStream === 'function';
        return [
            {
                label: 'Model',
                value: modelLabel,
                ...(isSlowModel(setup.model) ? { note: SLOW_MODEL_NOTE } : {}),
            },
            { label: 'Mode', value: 'Noting circle' },
            { label: 'Circle', value: `${participants.length} participant${participants.length === 1 ? '' : 's'}` },
            { label: 'Source', value: providerLabel },
            {
                label: 'Delivery',
                value: streams ? 'Speaks as it generates' : 'Speaks after receiving full reply',
            },
            // Actionable: the clock can be hidden from the input row, and this
            // is then the only way back to its settings mid-circle.
            {
                label: 'Clock',
                value: sessionClock.faceLabel(),
                onClick: () => void sessionClock.openPicker(),
            },
        ];
    }, 'Session', [
        { label: 'Report a bug', onClick: () => void openBugReport() },
        // AI circle participants generate content too (a word or two at a
        // time), so the Play GenAI-policy flag belongs here as well.
        {
            label: 'Report AI content',
            onClick: () =>
                void openAiContentReport({
                    sourceLabel:
                        ALL_PROVIDERS.find((p) => p.value === setup.provider)?.label ??
                        setup.provider,
                    ownProvider: setup.provider !== 'aloud',
                }),
        },
    ]);
    document
        .getElementById('session-info-btn')
        ?.addEventListener('click', () => infoPanel.toggle());

    root.innerHTML = `
        <div class="session-container">
            <div class="conversation" id="conversation"></div>
            <div class="input-area">
                <div class="input-row input-row-noting">
                    <div id="voice-status" class="voice-status">Starting…</div>
                    <button type="button" class="session-timer" id="timer" title="Session Clock">0:00</button>
                    <button id="tts-toggle" class="btn btn-tts active" title="Read notes aloud" aria-label="Toggle text-to-speech">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                            <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                            <path class="tts-waves" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                            <path class="tts-waves" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                            <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                        </svg>
                    </button>
                    <button id="voice-btn" class="btn btn-voice active" title="Toggle microphone" aria-label="Toggle microphone">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" y1="19" x2="12" y2="23"></line>
                            <line x1="8" y1="23" x2="16" y2="23"></line>
                            <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                        </svg>
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
                    <!-- Hidden state holder for kasina gazing (initKasinaMode).
                         Entry points: tapping the nav orb, or the More sheet's
                         Kasina entry on mobile; click-outside exits. -->
                    <input type="checkbox" id="kasina-toggle" class="hidden">
                </div>
            </div>
        </div>

        <div class="ember-container" id="ember-container"></div>

        <div class="session-ended-overlay hidden" id="session-confirm">
            <div class="session-ended-content">
                <p id="confirm-text"></p>
                <div class="session-ended-actions">
                    <button id="confirm-yes" type="button" class="btn btn-primary">End Session</button>
                    <button id="confirm-no" type="button" class="btn btn-secondary">Cancel</button>
                </div>
                <button id="confirm-skip-save" type="button" class="btn-link hidden">End Without Saving</button>
            </div>
        </div>`;

    const conversation = root.querySelector<HTMLElement>('#conversation')!;
    const statusEl = root.querySelector<HTMLElement>('#voice-status')!;
    const micBtn = root.querySelector<HTMLButtonElement>('#voice-btn')!;
    const ttsToggle = root.querySelector<HTMLButtonElement>('#tts-toggle')!;
    const timerEl = root.querySelector<HTMLElement>('#timer')!;
    const kasinaToggle = root.querySelector<HTMLInputElement>('#kasina-toggle')!;
    const orbEl = document.getElementById('orb');

    // Whether notes are read aloud (starts on; the button has .active). Gates
    // speakVia so the user can silence the circle's voices without muting their
    // own mic.
    let ttsEnabled = true;

    // TTS/STT errors are non-fatal to the circle, but hosted billing/auth
    // failures must still be visible: swallowing them meant an out-of-credits
    // voice just went silent with no explanation. Toast each distinct cloud
    // condition once - the circle loops every few seconds, so repeating the
    // same toast forever is noise.
    let lastCloudErrorToast: string | null = null;
    function surfaceCloudError(err: unknown): void {
        if (torn) return;
        const msg = err instanceof Error ? err.message : String(err);
        const described = describeCloudError(msg);
        if (described && described !== lastCloudErrorToast) {
            lastCloudErrorToast = described;
            showErrorToast(described);
        }
    }

    const sessionStartMs = Date.now();

    // Same clock as the exploration view: elapsed / time of day / countdown,
    // switched by tapping it, persisted app-wide.
    const sessionClock = new SessionClock(timerEl, sessionStartMs, appSettings, (choice) => {
        appSettings.sessionClockMode = choice.mode;
        appSettings.sessionTimerMin = choice.timerMin;
        appSettings.showSessionClock = choice.showClock;
        appSettings.endSessionOnTimer = choice.endOnComplete;
        // Re-read before writing, so a stale in-memory copy can't clobber
        // settings saved elsewhere since mount.
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

    // Floating embers + kasina gazing, shared with exploration. The
    // document-level kasina listeners (drag, outside-click) and the beforeunload
    // guard are tied to viewCleanup so they detach on teardown.
    const viewCleanup = new AbortController();
    viewCleanup.signal.addEventListener('abort', () => infoPanel.dispose());
    window.addEventListener(
        'beforeunload',
        (e) => {
            e.preventDefault();
            e.returnValue = '';
        },
        { signal: viewCleanup.signal }
    );
    mountEmberContainer();
    wireEmberControls(root);
    ttsToggle.addEventListener('click', () => {
        ttsEnabled = !ttsEnabled;
        ttsToggle.classList.toggle('active', ttsEnabled);
    });
    if (orbEl) {
        initKasinaMode({ orb: orbEl, root, toggle: kasinaToggle, signal: viewCleanup.signal });
    }

    function setStatus(text: string): void {
        statusEl.textContent = text;
    }
    function appendMessage(role: 'user' | 'facilitator', text: string, name: string): HTMLElement {
        const el = document.createElement('div');
        el.className = `message ${role}`;
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = text;
        const sender = document.createElement('div');
        sender.className = 'message-sender';
        sender.textContent = name;
        el.append(sender, content);
        conversation.appendChild(el);
        conversation.scrollTop = conversation.scrollHeight;
        return el;
    }

    // ---- audio: STT, per-participant TTS, chime cue ----
    // The Settings pick, same as views/session.ts - NOT an auto-detect. The
    // start gate (ensureCloudAccess) already pre-flights sign-in against this
    // resolved choice, so detecting separately here made the two disagree:
    // a browser with no Web Speech was asked to sign in for cloud STT and then
    // handed a mic-less session anyway (meditation-pal-j8k1).
    const stt: SttEngine | null = await createSttForChoice(
        resolveSttChoice(appSettings.sttEngine, isWebMode()),
        {
            micDeviceId: appSettings.micDeviceId,
            whisperModelSize: appSettings.sttWhisperModel,
            language: setup.language,
            silenceBaseMs: 1200,
            silenceMaxMs: 6000,
            silenceRampRate: 1,
            // Notes are SHORT ("warmth", "tension"), so keep the min-speech gate
            // low or the server-Whisper VAD discards a quick word and the turn
            // sticks re-listening.
            minSpeechDurationMs: 150,
        }
    );

    // One TTS engine per distinct voice id (participants + narrator).
    const ttsCache = new Map<string, TtsEngine>();
    async function ttsFor(voiceId: string | null): Promise<TtsEngine> {
        const key = voiceId ?? '__default__';
        let engine = ttsCache.get(key);
        if (!engine) {
            const built = await createTtsForVoice(voiceId, {
                onServerSynthesize: (chars) => session.recordTts(chars),
            });
            engine = built.engine;
            ttsCache.set(key, engine);
        }
        return engine;
    }

    let audioCtx: AudioContext | null = null;
    function playChime(): void {
        try {
            const AC =
                (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
                (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
                    .webkitAudioContext;
            if (!AC) return;
            audioCtx = audioCtx ?? new AC();
            const ctx = audioCtx;
            const now = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.setValueAtTime(554, now + 0.1); // A4 → C#5
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
            osc.start(now);
            osc.stop(now + 0.2);
        } catch {
            /* cue is optional */
        }
    }

    // ---- circle state ----
    const turnOrder: Array<'user' | number> = ['user', ...participants.map((_, i) => i)];
    let currentTurn = -1;
    const recentLabels: string[] = [];
    const ownLabels: string[][] = participants.map(() => []);
    const userCadences: number[] = [];
    let paused = false;
    let muted = false;
    let torn = false;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;

    function participantName(index: number): string {
        const p = participants[index];
        if (!p) return `Participant ${index + 1}`;
        if (p.type === 'sound') return capitalize(p.sound);
        return stripVoiceLabel(p.voice ?? setup.voice) || `Participant ${index + 1}`;
    }

    function clearWait(): void {
        if (waitTimer) {
            clearTimeout(waitTimer);
            waitTimer = null;
        }
    }

    function scheduleNextTurn(delayMs: number): void {
        if (torn || paused) return;
        clearWait();
        waitTimer = setTimeout(() => {
            waitTimer = null;
            void advanceTurn();
        }, delayMs);
    }

    function adaptiveDelay(): number {
        if (userCadences.length === 0) return DEFAULT_CADENCE_MS;
        const sum = userCadences.reduce((a, b) => a + b, 0);
        return sum / userCadences.length;
    }

    /**
     * The timer's spoken notices, canned rather than LLM-written: this mode's
     * only prose is the static opener, for the reason documented there, and a
     * generated paragraph would break the register of a circle of one-word
     * labels. Spoken by the facilitator voice at a turn boundary, so it never
     * lands on top of a participant or the user's turn.
     */
    async function speakTimerNotice(kind: 'approach' | 'completion'): Promise<void> {
        const ending = kind === 'completion' && sessionClock.endsSessionOnComplete();
        const pool =
            kind === 'approach'
                ? TIMER_APPROACH_FALLBACKS
                : ending
                  ? TIMER_CLOSE_FALLBACKS
                  : TIMER_COMPLETION_FALLBACKS;
        const text = pickTimerFallback(pool, sessionClock.timerMinutes());
        session.addAssistantMessage(text, 'Facilitator');
        appendMessage('facilitator', text, 'Facilitator');
        await speakVia(setup.voice, text);
        void autosaveSession();
    }

    async function advanceTurn(): Promise<void> {
        if (torn || paused) return;
        // Turn boundary: the natural seam for a timer notice. The circle keeps
        // going afterwards - completion is a word, not a stop, unless the user
        // asked for the sit to end, and then only after the word is spoken.
        const due = sessionClock.timerDue(
            timerApproachLeadSec(sessionClock.timerTotalSec(), null)
        );
        if (due) {
            const ending = due === 'completion' && sessionClock.endsSessionOnComplete();
            await speakTimerNotice(due);
            if (torn || paused) return;
            if (ending) {
                await endSession(undefined, !appSettings.saveSessionLogs);
                return;
            }
        }
        currentTurn = (currentTurn + 1) % turnOrder.length;
        const turn = turnOrder[currentTurn];
        if (turn === 'user') await startUserTurn();
        else await participantTurn(turn as number);
    }

    let userTurnStart = 0;

    /** One STT capture: shows partials, returns the final text (or '' on
     *  silence/error). */
    async function listenOnce(): Promise<string> {
        if (!stt) return '';
        let partialEl: HTMLElement | null = null;
        let finalText = '';
        try {
            for await (const event of stt.start()) {
                if (torn || paused) break;
                if (event.type === 'partial') {
                    if (!partialEl) partialEl = appendMessage('user', event.text, 'You');
                    else {
                        const c = partialEl.querySelector('.message-content');
                        if (c) c.textContent = event.text;
                    }
                    partialEl.classList.add('partial');
                } else if (event.type === 'final') {
                    finalText = event.text;
                    if (event.seconds) session.recordStt(event.seconds);
                    break;
                } else if (event.type === 'error') {
                    // The Whisper engine yields errors as events rather than
                    // throwing; same surfacing as the catch below.
                    surfaceCloudError(event.error);
                }
            }
        } catch (err) {
            // Treat as empty for the circle, but surface hosted billing/auth
            // failures (cloud STT) so the user knows why their turns stall.
            surfaceCloudError(err);
        }
        if (partialEl) partialEl.remove();
        return finalText;
    }

    async function startUserTurn(): Promise<void> {
        if (torn || paused) return;
        // Cue (after a breath) BEFORE listening, so the chime isn't transcribed
        // as the user's note.
        if (setup.notingUserTurnCue) {
            const cueDelay = userCadences.length === 0 ? 0 : USER_TURN_CUE_DELAY_MS;
            if (cueDelay > 0) await sleep(cueDelay);
            if (torn || paused) return;
            // A chosen sound file, or the built-in synth chime.
            if (setup.notingUserTurnCueSound) await playSoundFile(setup.notingUserTurnCueSound);
            else playChime();
            await sleep(250);
        }
        if (torn || paused) return;
        setStatus('Your turn. Say something you notice now, 1-2 words.');
        userTurnStart = Date.now();

        if (!stt) {
            // Unreachable: the circle doesn't start without an engine (below).
            // Kept so a future path into here can't hang the turn loop.
            scheduleNextTurn(DEFAULT_CADENCE_MS);
            return;
        }

        // Listen until a real note lands; silence/echo re-listens without
        // replaying the cue. The echo guard only rejects audio right at turn
        // start (TTS tail from the previous participant).
        while (!torn && !paused) {
            const note = (await listenOnce()).trim();
            if (torn || paused) return;
            const tooSoon = Date.now() - userTurnStart < ECHO_REJECT_MS;
            // A cough/breath transcribing to only non-speech markers ("[cough]",
            // "(sigh)") shouldn't become a noting label: re-listen, as for
            // silence/echo.
            if (note && !tooSoon && !isNonSpeechOnly(note)) {
                const cadence = Date.now() - userTurnStart;
                userCadences.push(cadence);
                if (userCadences.length > 5) userCadences.shift();
                recentLabels.push(note);
                session.addUserMessage(note, 'You');
                appendMessage('user', note, 'You');
                void autosaveSession();
                // Clear the "Your turn" prompt now, or it lingers through the
                // next participant's breathing delay and reads as "still my
                // turn" after the note is already shown.
                setStatus('');
                scheduleNextTurn(500);
                return;
            }
            await sleep(200); // brief breath before re-listening
        }
    }

    async function speakVia(voiceId: string | null, text: string): Promise<void> {
        // TTS off: the circle runs silently, labels still appear and turns
        // still advance.
        if (!ttsEnabled) return;
        try {
            const tts = await ttsFor(voiceId);
            await tts.speak(text, { rate: setup.ttsRate });
        } catch (err) {
            // TTS is optional (the circle continues text-only), but hosted
            // billing/auth failures get a toast instead of vanishing.
            surfaceCloudError(err);
        }
    }

    async function participantTurn(index: number): Promise<void> {
        if (torn || paused) return;
        const p = participants[index];
        if (!p) {
            scheduleNextTurn(1000);
            return;
        }
        // Wait before noting: fixed seconds, or adapted to the user's cadence
        // (the per-participant timing option).
        const delayMs = p.timing === 'fixed' ? (p.fixedDelaySec || 4) * 1000 : adaptiveDelay();
        await sleep(delayMs);
        if (torn || paused) return;

        const name = participantName(index);
        if (p.type === 'llm') {
            setStatus(`${name} is noting…`);
            // Unreachable without a provider: an 'llm' participant is exactly
            // what makes needsLlm true.
            if (!utilityProvider) return;
            const label = await generateNotingLabel(utilityProvider, {
                context: recentLabels.slice(),
                ownLabels: ownLabels[index]!.slice(),
                reactive: p.reactive,
                onUsage: (u) => session.recordLlmUsage(u),
            });
            if (torn || paused) return;
            recentLabels.push(label);
            ownLabels[index]!.push(label);
            session.addAssistantMessage(label, name);
            appendMessage('facilitator', label, name);
            await speakVia(p.voice, label);
        } else if (p.type === 'fixed') {
            const phrase = p.phrase.trim() || 'breathing';
            recentLabels.push(phrase);
            ownLabels[index]!.push(phrase);
            session.addAssistantMessage(phrase, name);
            appendMessage('facilitator', phrase, name);
            await speakVia(p.voice, phrase);
        } else {
            // Sound effect: bracketed marker, then the clip.
            session.addAssistantMessage(`〈${name}〉`, name);
            appendMessage('facilitator', `〈${name}〉`, name);
            if (p.sound === 'chime') {
                playChime();
                await sleep(300);
            } else {
                await playSoundFile(p.sound);
            }
        }
        if (torn || paused) return;
        // Persist this round's labels so a crash mid-circle keeps them. No-op
        // unless logging is on.
        void autosaveSession();
        scheduleNextTurn(300);
    }

    function playSoundFile(sound: string): Promise<void> {
        return new Promise((resolve) => {
            try {
                // The hosted build serves under /app/, so a bare /audio/... 404s.
                const audio = new Audio(assetPath(`/audio/${encodeURIComponent(sound)}.mp3`));
                audio.onended = () => resolve();
                audio.onerror = () => resolve();
                void audio.play().catch(() => resolve());
            } catch {
                resolve();
            }
        });
    }

    // ---- opener ----
    // Static, not LLM: some models returned meta-commentary here ("Here are a
    // few ways to say this…").
    async function speakOpener(): Promise<void> {
        if (torn) return;
        const text = NOTING_STATIC_OPENER;
        session.addAssistantMessage(text, 'Facilitator');
        appendMessage('facilitator', text, 'Facilitator');
        setStatus('Speaking…');
        await speakVia(setup.voice, text);
    }

    // ---- mute / pause ----
    function setMicButtonState(): void {
        micBtn.classList.toggle('active', !muted);
        orbEl?.classList.toggle('orb-muted', muted);
        micBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
    }
    micBtn.addEventListener('click', () => {
        muted = !muted;
        setMicButtonState();
        if (muted) {
            paused = true;
            clearWait();
            void stt?.stop();
            setStatus('Paused, unmute to resume');
        } else if (paused) {
            paused = false;
            setStatus('Resuming…');
            // Resume from the current turn.
            const turn = turnOrder[currentTurn];
            if (turn === 'user') void startUserTurn();
            else if (typeof turn === 'number') void participantTurn(turn);
        }
    });

    // ---- end / teardown ----
    // End button + History link live in the global nav (injected on mount).
    // Both route through showEndConfirm so a stray tap can't drop a circle,
    // mirroring the live-session guard in session.ts.
    const endBtn = document.getElementById('end-btn') as HTMLAnchorElement | null;
    endBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        showEndConfirm('End this session?', undefined);
    });
    const historyLink = navLinks?.querySelector<HTMLAnchorElement>('[data-nav="history"]');
    historyLink?.addEventListener('click', (e) => {
        e.preventDefault();
        // Stop the global data-nav handler so this confirm is the only path out
        // of a live circle.
        e.stopImmediatePropagation();
        showEndConfirm(
            'Leave session to view history? This will end your current session.',
            'history'
        );
    });

    /**
     * Show the leave/end confirmation overlay. On confirm, ends the circle and
     * routes to `destination` (or back to setup). Wires fresh handlers each call
     * so a re-open doesn't carry the previous click's destination.
     */
    function showEndConfirm(message: string, destination: SessionEndDestination | undefined): void {
        wireEndConfirm(root, message, {
            saveByDefault: appSettings.saveSessionLogs,
            end: (skipSave) => void endSession(destination, skipSave),
        });
    }

    /**
     * Persist the in-progress circle to local storage without an LLM summary,
     * so a crash or going offline still leaves a recoverable transcript. No-op
     * when "Save session logs" is off, or before any user turn exists. The
     * detailed summary is generated only on a clean end (endSession).
     */
    async function autosaveSession(): Promise<void> {
        if (!appSettings.saveSessionLogs) return;
        const state = session.state;
        if (!state || !state.exchanges.some((ex) => ex.role === 'user')) return;
        const snapshot: SessionState = {
            ...state,
            endTime: Math.floor(Date.now() / 1000),
        };
        try {
            await sessionStore.save(snapshot);
        } catch (err) {
            console.warn('Session autosave failed', err);
        }
    }

    async function endSession(destination?: SessionEndDestination, skipSave = false): Promise<void> {
        if (torn) return;
        torn = true;
        paused = true;
        clearWait();
        sessionClock.destroy();
        void stt?.stop();
        if (provider instanceof OllamaProvider) void provider.relaxKeepAlive();
        if (audioCtx && audioCtx.state !== 'closed') void audioCtx.close().catch(() => {});
        // Embers are session-only.
        unmountEmberContainer();
        // Exit kasina if active: the toggle's exit branch restores the theme and
        // returns the orb to the nav before we clear it, rather than orphaning
        // it in <body>.
        if (kasinaToggle.checked) {
            kasinaToggle.checked = false;
            kasinaToggle.dispatchEvent(new Event('change'));
        }
        // Remove the window/document-level listeners (kasina drag, beforeunload).
        viewCleanup.abort();
        const finalState = session.endSession();
        // Save only if there's a user turn (skip empty/abandoned circles).
        if (!skipSave && finalState && finalState.exchanges.some((ex) => ex.role === 'user')) {
            // History summary, as exploration sessions do (never throws;
            // returns '' on failure). The exchanges are short notes ("warmth",
            // "tension") distilled into a one-line recap.
            setStatus('Saving session…');
            // No provider means an AI-free circle: save without a recap rather
            // than reaching for a metered one the user never asked for
            // (meditation-pal-vr3w). No intention fallback here - noting has no
            // intention field, so setup.intention is always '' (see
            // SessionSetup.intention). History renders a missing summary fine.
            finalState.notes = utilityProvider
                ? await generateSessionSummary(utilityProvider, finalState.exchanges, {
                      onUsage: (u) => session.recordLlmUsage(u),
                  })
                : '';
            try {
                await sessionStore.save(finalState);
            } catch {
                /* non-fatal */
            }
        }
        delete document.body.dataset['sessionActive'];
        releaseWakeLock();
        if (navCenter) navCenter.innerHTML = '';
        if (navLinks && savedNavLinks !== null) {
            navLinks.innerHTML = savedNavLinks;
            const btn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
            if (btn) initThemeToggle(btn);
        }
        onEnd(destination);
    }

    // ---- kick off ----
    setMicButtonState();
    if (!stt) {
        // app.ts gates every session start on a working mic, so this is a
        // can't-happen. If it happens anyway, don't run a circle whose every
        // user turn would be skipped - say why and leave it unstarted.
        setStatus('No microphone available. Noting needs a mic for your turns.');
    } else {
        void (async () => {
            // Prime the STT capture graph before the opener so its onset
            // pre-buffer fills during the opening line; otherwise a barge-in on
            // the first turn has an empty buffer and clips the opening word (d35).
            await stt.prime?.();
            await speakOpener();
            if (!torn) void advanceTurn();
        })();
    }

    return {
        teardown(): void {
            void endSession();
        },
        requestLeave(destination?: SessionEndDestination): void {
            showEndConfirm(leaveMessage(destination), destination);
        },
        showInfo(): void {
            infoPanel.open();
        },
        toggleKasina(): void {
            kasinaToggle.checked = !kasinaToggle.checked;
            kasinaToggle.dispatchEvent(new Event('change'));
        },
    };
}

/** Confirm-overlay copy for an external nav request. Keep in sync with the
 *  matching helper in session.ts so the wording matches across modes. */
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

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Strip the 'browser:'/'server:' prefix and any "(Premium)"-style qualifier. */
function stripVoiceLabel(voice: string | null): string {
    if (!voice) return '';
    const noPrefix = voice.replace(/^(browser:|server:)/, '');
    return noPrefix.replace(/\s*\(.*\)$/, '').trim();
}

function mountError(
    root: HTMLElement,
    message: string,
    onEnd: () => void
): NotingSessionViewHandle {
    root.innerHTML = `
        <section class="session-stage">
            <div class="status"><div id="status">${escapeHtml(message)}</div></div>
            <div class="controls">
                <button type="button" class="btn btn-secondary" id="noting-back-btn">Back to setup</button>
            </div>
        </section>`;
    root.querySelector('#noting-back-btn')?.addEventListener('click', () => onEnd());
    return {
        teardown() { /* nothing to tear down */ },
        requestLeave() { /* no live circle to guard */ },
        showInfo() { /* no panel on the error view */ },
        toggleKasina() { /* no orb on the error view */ },
    };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
    );
}

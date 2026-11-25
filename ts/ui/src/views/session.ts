/**
 * Session view - the meditation conversation.
 *
 * From a configured SessionSetup: builds the PromptBuilder, session manager,
 * and LLM provider, then runs the conversation loop until the user ends it.
 */

import {
    PromptBuilder,
    appControlsChangeNote,
    SessionManager,
    PacingController,
    TurnDecision,
    parseTurnSignals,
    looksLikeTtsEcho,
    previewLooksLikeTtsEcho,
    getMode,
    StagedModeController,
    EXPLORATION_MODE,
    generateSessionSummary,
    buildResumeContext,
    classifyResumeIntent,
    classifyHoldRequest,
    routeUtterance,
    isMuteCommand,
    isEndCommand,
    opensWithReturn,
    endConfirmReply,
    answerPace,
    HOLD_REENTRY_GRACE_MS,
    classifyHoldConfirm,
    classifyTrouble,
    wantsTroubleCheck,
    localCheckFits,
    TROUBLE_GRACE_MS,
    STEPPING_OUT_NOTE,
    UtterancePrefetch,
    type ClassifyResumeIntentOptions,
    CommandPrefetch,
    detectVoiceCommand,
    saidJustBefore,
    classifyEndConfirm,
    parseTimerRequest,
    steppedRate,
    steppedPause,
    COMMAND_LINES,
    type DetectedCommand,
    type JudgeBefore,
    type VoiceCommandId,
    type SessionLanguage,
    defaultPacingConfig,
    runSmartCheckin,
    buildSmartCheckinEvent,
    checkinSuggestionFor,
    buildTimerApproachEvent,
    buildTimerCompletionEvent,
    spokenExchanges,
    hasSpokenUserTurn,
    pickTimerFallback,
    timerApproachLeadSec,
    SESSION_TIMER_MAX_CHARS,
    TIMER_APPROACH_FALLBACKS,
    TIMER_CLOSE_FALLBACKS,
    TIMER_COMPLETION_FALLBACKS,
    sessionLanguageOf,
    localizePool,
    EMPTY_REPLY_FALLBACKS,
    CLAUDE_STALLED_APOLOGIES,
    llmUsageOf,
} from '../../../src/facilitation/index.js';
import type { SessionState } from '../../../src/facilitation/session.js';
import {
    AnthropicProvider,
    CacheKeepAlive,
    OllamaProvider,
    OpenAIProvider,
    OpenRouterProvider,
    VeniceProvider,
    GroqProvider,
    type LLMProvider,
    type Message,
} from '../../../src/llm/index.js';
import type { SttEngine, TtsEngine, TtsOptions } from '../../../src/platform/index.js';
import { isNonSpeechOnly } from '../../../src/platform/index.js';
import { streamCompletionWithChunkedTts } from '../streaming-tts.js';
import {
    PLAYBACK_TAIL_MS,
    bargesInOnOwnStream as streamBargesIn,
    voiceEchoCancelled,
    wrapTtsWithBargeIn,
} from '../barge-in.js';
import { ClaudeProxyHttpProvider } from '../adapters/claude-proxy-http.js';
import {
    sessionModelLabel,
    isSlowModel,
    nearestSubscriptionModel,
    probeClaudeProxyModel,
    prettyModelName,
    cloudUtilityModel,
    SLOW_MODEL_NOTE,
} from '../model-picker.js';
import { mountSessionInfoPanel, type SessionInfoRow } from '../session-info.js';
import { openAiContentReport, openBugReport } from '../bug-report.js';
import { CloudLlmProvider, onCloudLlmRetry, type CloudProviderId } from '../adapters/cloud-llm.js';
import { CloudJudge, type RemoteJudge } from '../adapters/cloud-judge.js';
import { OwnKeyJudge } from '../adapters/own-key-judge.js';
import { downloadSttClips } from '../stt-clip-recorder.js';
import {
    VOICE_COMMANDS_CONSENT,
    VOICE_COMMANDS_SIGN_IN,
    canReachJudge,
    judgeContextFor,
    privacyPolicyLink,
    showVoiceCommandExamples,
    voiceCommandsAccess,
} from '../voice-commands.js';
import {
    claimVoiceHint,
    claimIntroSession,
    LISTENING_WITH_INVITE,
    VOICE_HINT_TEXT,
    type VoiceHintId,
} from '../voice-command-hints.js';
import { ensureCloudToken } from '../cloud-auth.js';
import { getKnownBalance, subscribeBalance } from '../cloud-balance.js';
import { getRetreatCovered } from '../cloud-coverage.js';
import { creditAmount } from '../credit-rate.js';

import {
    createSttForChoice,
    sttBackendForChoice,
    resolveSttChoice,
    sttEngineOptions,
    isHostedSttChoice,
    hostedSttDefault,
    sttModelForChoice,
    type SttBackend,
} from '../adapters/stt-picker.js';
import { buildRunRecord, conversationRunSettings, runBuild } from '../session-run-record.js';
import { isWebMode } from '../app-mode.js';
import { describeCloudError, describeSttError, isConnectionFailure } from '../stt-errors.js';
import { simulateLlmFault } from '../dev-sim.js';
import { isCheckinDebugOn, getJevClassifierMode } from '../dev-mode.js';
import { createTtsForVoice, createCloudAloudTts } from '../adapters/tts-picker.js';
import { WhisperPcmSttEngine } from '../adapters/whisper-pcm-stt.js';
import { iosHeadphones, watchIosHeadphones } from '../audio-route.js';
import { mountVolumeNotice } from '../output-volume.js';
import { startCloudSession, clearCloudSession } from '../cloud-session.js';
import {
    type SessionSetup,
    type Provider,
    ALL_PROVIDERS,
    GUIDANCE_LEVEL_LABELS,
    CHECKIN_PACE_LABELS,
    VERBOSITY_LABELS,
    FOCUS_LABELS,
    QUALITY_LABELS,
} from '../settings.js';
import {
    loadAppSettings,
    patchAppSettings,
    type AppSettings,
    type SttEngineChoice,
    LANGUAGES,
} from '../app-settings.js';
import { SessionClock } from '../session-clock.js';
import { sessionStore } from '../state.js';
import { markSessionActive, clearActiveSession } from '../active-session.js';
import { sessionAutosave } from '../session-autosave.js';
import { markSessionStarted } from '../tour/index-guide.js';
import { FIRST_SIT_CHECKIN_WAIT_SEC, FIRST_SIT_TIMER_MIN } from '../first-sit.js';
import { showEndConfirm as wireEndConfirm } from './end-confirm.js';
import { getApiKey, ownJudgeKey } from '../api-keys.js';
import {
    emberBlocksHTML,
    mountEmberContainer,
    setEmbersOn,
    unmountEmberContainer,
    wireEmberControls,
} from '../embers.js';
import { initKasinaMode } from '../kasina.js';
import { initThemeToggle, setTheme, toggleTheme, updateThemeIcon, type Theme } from '../theme.js';
import { t } from '../i18n.js';
import { escapeHtml } from '../escape-html.js';
import { showErrorToast } from '../toast.js';
import { alertDialog, confirmDialog } from '../dialog.js';
import { showBuyCreditsModal } from '../buy-credits-modal.js';
import { purchaseChannel, topUpHint } from '../purchase-channel.js';
import { playCannedApology } from '../canned-apology.js';
import { reportCloudIncident, isCloudTtsError } from '../cloud-incidents.js';
import { outOfCreditsNotice, BILLING_PAUSED_FINISH } from '../billing-messages.js';
import { startMicMeter, type MicMeter } from '../mic-meter.js';
import { isCapacitor, isIosWeb, isSingleOwnerMicPlatform } from '../is-desktop.js';
import { acquireWakeLock, releaseWakeLock } from '../wakelock.js';
import { playClosing, playOpening, resolveSignatureSound } from '../signature-sound.js';
import { navOrbPainted } from '../orb-pulse.js';
import { diag } from '../diag.js';
import {
    armSoakTap,
    tapCall,
    tapEvent,
    tapFlags,
    tapTurn,
    type TurnKind,
} from '../soak-tap.js';
import {
    buildScoredVoiceList,
    fetchServerVoices,
    fetchCloudVoices,
    hostedVoiceEntry,
    hostedVoicePromptNote,
    type CloudVoice,
    prefixedVoiceId,
    previewVoice as runVoicePreview,
    previewErrorMessage,
    renderVoiceList,
    renderVoiceModalHTML,
    stopPreview as stopVoicePreview,
    updateVoiceSelection,
    wirePickerModalKeys,
    syncSpeedControlForVoice,
    voiceRateLabel,
    ENGINE_LABELS,
    type ScoredVoice,
    stripVoicePrefix,
    voiceLabel,
} from '../voice-picker.js';
import { onBackdropClick } from '../modal-backdrop.js';
import { sessionOllama } from '../setup-local-reader.js';
import { createTurnPreview } from '../turn-preview.js';

const HAIKU_MODEL = 'claude-haiku-5-5';

async function requireApiKey(provider: Provider): Promise<string> {
    const key = await getApiKey(provider);
    if (!key) {
        throw new Error(
            t('No API key set for {provider}. Add it in Settings, or pick a different provider.', {
                provider,
            })
        );
    }
    return key;
}

export async function buildProvider(setup: SessionSetup): Promise<LLMProvider> {
    // Dev-build simulation hook (no-op everywhere else): draining a real
    // balance to see the out-of-credits apology is not a repeatable test.
    return simulateLlmFault(await buildRealProvider(setup));
}

async function buildRealProvider(setup: SessionSetup): Promise<LLMProvider> {
    const modelOpt = setup.model ? { model: setup.model } : {};
    switch (setup.provider) {
        case 'aloud': {
            // Hosted, metered proxy; sign in so the request carries a bearer
            // token. setup.model is "provider/model" and the model id itself may
            // contain a slash (openrouter), so split once.
            await ensureCloudToken();
            const slash = setup.model.indexOf('/');
            const sub = slash > 0 ? setup.model.slice(0, slash) : '';
            const model = slash > 0 ? setup.model.slice(slash + 1) : '';
            if (!sub || !model) {
                throw new Error(t('Pick a model for the aloud cloud in Settings.'));
            }
            return new CloudLlmProvider({ provider: sub as CloudProviderId, model });
        }
        case 'ollama':
            // One builder with the setup screen's local reader, so both ask
            // for the same context window (setup-local-reader.ts).
            return sessionOllama(setup.model || undefined);
        case 'anthropic':
            // BYOK direct: Anthropic accepts browser-origin requests that carry
            // anthropic-dangerous-direct-browser-access, and there is no relay
            // on the web build to go through instead (meditation-pal-aq4e).
            return new AnthropicProvider({
                apiKey: await requireApiKey('anthropic'),
                directBrowserAccess: true,
                ...modelOpt,
            });
        case 'claude_proxy':
            // The `claude` CLI is a subprocess: the app backend runs it and
            // exposes the result over /app/v1/llm/claude_proxy.
            return new ClaudeProxyHttpProvider(modelOpt);
        case 'openai':
        case 'openrouter':
        case 'venice':
        case 'groq': {
            // BYOK direct from the browser; these accept CORS.
            const opts = { apiKey: await requireApiKey(setup.provider), ...modelOpt };
            if (setup.provider === 'openai') return new OpenAIProvider(opts);
            if (setup.provider === 'openrouter') return new OpenRouterProvider(opts);
            if (setup.provider === 'venice') return new VeniceProvider(opts);
            return new GroqProvider(opts);
        }
    }
}

/**
 * Cheap, fast, NON-reasoning model (Haiku) for the auxiliary calls: the
 * classifiers, noting labels, and recaps where no recap model is flagged
 * (buildRecapProvider). An always-thinking
 * facilitation model spends the classifiers' tiny budgets on reasoning and
 * returns nothing. Where Haiku isn't reachable (Ollama, other BYOK providers)
 * this is the facilitation provider, whose model the user can pick freely.
 */
export async function buildUtilityProvider(
    setup: SessionSetup,
    facilitation: LLMProvider
): Promise<LLMProvider> {
    switch (setup.provider) {
        case 'aloud': {
            // The server holds the key; the client only names provider + model.
            await ensureCloudToken();
            return new CloudLlmProvider({ provider: 'anthropic', model: HAIKU_MODEL, purpose: 'utility' });
        }
        case 'anthropic': {
            const anthropicKey = await getApiKey('anthropic');
            // No key: the facilitation leg has already thrown, so this is only
            // reachable if that changes. Reuse it rather than construct a
            // provider that can't authenticate.
            if (!anthropicKey) return facilitation;
            return new AnthropicProvider({
                apiKey: anthropicKey,
                directBrowserAccess: true,
                model: HAIKU_MODEL,
            });
        }
        case 'claude_proxy':
            return new ClaudeProxyHttpProvider({ model: 'haiku' });
        default:
            // Ollama (free/local) and BYOK-direct providers: reuse facilitation.
            return facilitation;
    }
}

/**
 * The model for recaps: the in-session refreshes (nrj6), which resend the
 * whole transcript and are most of the utility leg's cost, and the
 * end-of-session summary shown in history. Hosted sessions run them on the
 * entry flagged `utility` in server/src/pricing/providers.ts, the server's
 * call. With none flagged and live, or the catalog out of reach, this falls
 * back to `utility`.
 */
export async function buildRecapProvider(
    setup: SessionSetup,
    utility: LLMProvider
): Promise<LLMProvider> {
    if (setup.provider !== 'aloud') return utility;
    const flagged = await cloudUtilityModel();
    if (!flagged) return utility;
    await ensureCloudToken();
    return new CloudLlmProvider({
        provider: flagged.provider as CloudProviderId,
        model: flagged.model,
        purpose: 'utility',
    });
}


export interface SessionViewHandle {
    /** Tear down the running session and release resources. */
    teardown(): void;
    /**
     * Open the end-session confirmation for a nav request from outside the
     * session UI (browser/hardware Back). On confirm, tears down and routes to
     * `destination` via onEnd.
     */
    requestLeave(destination?: SessionEndDestination): void;
    /** Open the in-session info panel (model, mode, …). Wired to the mobile
     *  "More" sheet's Session-info entry; the nav ⓘ button opens it directly. */
    showInfo(): void;
    /** Enter/exit kasina gazing. Wired to the More sheet's Kasina entry; the
     *  nav orb toggles it directly (kasina.ts). */
    toggleKasina(): void;
}

export type SessionEndDestination = 'setup' | 'history' | 'settings' | 'account';

/** Re-generate the background recap only after this many new exchanges land.
 *  A refresh is an LLM call over the whole transcript (see buildRecapProvider),
 *  so keep it to once or twice per long session. It can afford to lag:
 *  summary-based resume keeps the last RESUME_RECENT_KEEP exchanges verbatim,
 *  so the recap only has to cover the older portion. */
const SUMMARY_MIN_NEW_EXCHANGES = 12;

export async function mountSessionView(
    root: HTMLElement,
    setup: SessionSetup,
    onEnd: (destination?: SessionEndDestination) => void,
    continueFrom: SessionState | null = null
): Promise<SessionViewHandle> {
    root.innerHTML = renderSessionHTML();

    const mode = getMode(setup.meditationType) ?? EXPLORATION_MODE;
    // Loaded before the prompt builder because smart check-in timing rides on
    // the system prompt (the [WAIT:Nm] fragment). Also feeds the pacing config.
    const appSettings = await loadAppSettings();
    // In checkinPaceSlider modes (felt sense) the guidance slider is hidden and
    // directiveness doesn't compose; "Check-in pace" stands in for it, driving
    // only timing (the [WAIT] bias, the pacing seed, and whether check-ins may
    // be substantive).
    const directiveness = mode.checkinPaceSlider ? setup.feltSensePace : setup.directiveness;
    // Those modes also own their check-ins entirely: their setup panel has its
    // own toggle + pace slider, so the Settings-page Check-In radios (which the
    // panel can't show) don't apply. Content is always smart there - a line
    // generated under the mode's own prompt stays in-stance in a way the canned
    // pool can't, and it degrades to that pool on any failure anyway.
    const checkinTiming: AppSettings['checkinTiming'] = mode.checkinPaceSlider
        ? setup.feltSenseCheckins
            ? 'smart'
            : 'none'
        : appSettings.checkinTiming;
    const checkinContent: AppSettings['checkinContent'] = mode.checkinPaceSlider
        ? 'smart'
        : appSettings.checkinContent;
    // A continued session keeps the language it began in (its transcript and
    // its meditator are already in it); the setup pick applies to fresh sits.
    const sessionLanguage = continueFrom?.language ?? setup.language;
    const builder = new PromptBuilder({
        config: {
            focuses: setup.focuses,
            qualities: setup.qualities,
            directiveness,
            verbosity: setup.verbosity,
            customInstructions: setup.customInstructions,
            waitSignal: checkinTiming === 'smart',
            checkinWaitSec: setup.firstSit ? FIRST_SIT_CHECKIN_WAIT_SEC : null,
            holdSignal: appSettings.silenceModeEnabled,
            // Set for real once the judge gate is known (below).
            appControls: 'screen',
            // zh sessions: respond-in-Chinese fragment + zh canned pools
            // (openers, check-ins, hold re-entry). meditation-pal-c3a0.3.
            language: sessionLanguageOf(sessionLanguage),
        },
        mode,
    });
    // Staged modes: the whole arc sits in the system prompt, the active phase
    // travels as a note in the session log (queued just below), and the LLM
    // signals movement with [NEXT]/[BACK] (parsed each turn). A continued
    // session resumes where it left off (SessionState.modePhase).
    const stager = mode.phases
        ? new StagedModeController(mode, continueFrom?.modePhase)
        : null;
    const session = new SessionManager({ contextStrategy: 'full' });
    session.startSession(mode.id);
    const autosave = sessionAutosave(sessionStore);
    // The system prompt is built once, on the opener's first call (after the
    // voice note resolves), and frozen for the sit: any change to it re-bills
    // the whole cached prefix. Anything that changes mid-sit rides the session
    // log instead (a phase note, an event turn), never this.
    let frozenSystemPrompt: string | null = null;
    function systemPrompt(): string {
        if (frozenSystemPrompt === null) {
            frozenSystemPrompt = builder.buildSystemPrompt(stager?.promptSection());
            stampRunRecord(frozenSystemPrompt);
        }
        return frozenSystemPrompt;
    }
    // Stamped at start (not save) so autosave carries it and a resume keeps the
    // language the sit began in.
    if (session.state) session.state.language = sessionLanguage;
    if (stager) {
        session.setModePhase(stager.phase.id);
        // Lands right after the opener instruction.
        session.queueSystemNote(stager.phaseNote(), 'phase');
    }
    // Mark the user as no-longer-new so the setup-page tour stops auto-popping
    // on later boots (fire-and-forget).
    void markSessionStarted(setup.firstSit === true);
    // Tag every metered cloud call with one opaque grouping id so the server's
    // cost report attributes them to this session (cloud-session.ts). No
    // content/PII; cleared at endSession().
    startCloudSession();

    // Which model is facilitating: for the info panel, the saved record, and (on
    // resume) telling a *different* model who ran the earlier part. `let`s: a
    // mid-session availability fallback swaps the model.
    let activeModel = setup.model;
    let modelLabel = sessionModelLabel(setup.provider, activeModel);
    function recomputeModelLabel(): void {
        modelLabel = sessionModelLabel(setup.provider, activeModel);
    }
    // On continue, seed the model's context (by default a recap plus the last
    // few exchanges, resumeFromSummary). The UI renders the whole transcript
    // regardless.
    if (continueFrom && continueFrom.exchanges.length > 0) {
        session.loadExchanges(
            buildResumeContext(continueFrom, appSettings.resumeFromSummary, {
                ...(continueFrom.model !== undefined
                    ? { priorModelLabel: continueFrom.model }
                    : {}),
                currentModelLabel: modelLabel,
            })
        );
    }
    let provider: LLMProvider;
    try {
        provider = await buildProvider(setup);
    } catch (err) {
        root.innerHTML = `
            <section class="session-stage">
                <div class="status">
                    <div id="status">${escapeHtml((err as Error).message)}</div>
                </div>
            </section>
            <section class="controls">
                <button id="back" type="button" data-nav="setup">${t('Back to setup')}</button>
            </section>`;
        clearCloudSession();
        const noop = (): void => {};
        // This view is still the app's live session, so "Back to setup", the
        // nav and the browser's Back all arrive as requestLeave (app.ts
        // wireNav, wirePopstate). Nothing is running to confirm the end of:
        // leave at once, or every way off this screen is dead.
        return { teardown: noop, requestLeave: onEnd, showInfo: noop, toggleKasina: noop };
    }

    // The pause-before-submit window is provider-aware. A non-streaming
    // provider (the Claude subscription) can't talk over a mid-thought pause,
    // and a too-early submit that the next utterance supersedes costs a
    // subscriber nothing, so it gets a shorter window to cut latency.
    const providerStreams = canStream(provider);
    const silenceBaseMs = providerStreams
        ? appSettings.silenceBaseMs
        : appSettings.nonStreamingSilenceBaseMs;
    const silenceMaxMs = providerStreams
        ? appSettings.silenceMaxMs
        : appSettings.nonStreamingSilenceMaxMs;
    const pacingConfig = {
        ...defaultPacingConfig,
        responseDelayMs: appSettings.responseDelayMs,
        silenceCheckinSec: appSettings.silenceCheckinSec,
        silenceCheckinsEnabled: checkinTiming !== 'none',
        silenceModeEnabled: appSettings.silenceModeEnabled,
        silenceBaseMs,
        silenceMaxMs,
    };
    const pacing = new PacingController({ config: pacingConfig });
    pacing.startSession();
    // Smart timing: until the model's first [WAIT], the slider sets the wait
    // (12m/5m/3m/90s/30s across the stops) - guidance level, or in
    // checkinPaceSlider modes the check-in pace (already folded into
    // `directiveness` above). A first sit brings its own, shorter one.
    if (checkinTiming === 'smart') {
        pacing.setCheckinInterval(builder.checkinWaitSeconds());
    }

    // Auxiliary calls run on a cheap, fast model (see buildUtilityProvider).
    // Falls back to the facilitation provider on any setup hiccup so a
    // helper-model problem can never block the session itself.
    const utilityProvider = await buildUtilityProvider(setup, provider).catch(() => provider);
    // Recaps, in-session and at the end, run on the recap model
    // (buildRecapProvider); same never-block-the-session fallback.
    const recapProvider = await buildRecapProvider(setup, utilityProvider).catch(
        () => utilityProvider
    );
    const summaryLanguage = sessionLanguageOf(sessionLanguage);

    // Keeps the prompt cache warm while the sit is quiet (core keep-alive.ts),
    // on Anthropic direct or through aloud cloud. Only the facilitation
    // requests report to it (facilitationRequest, the check-in and the timer
    // notice), never the side calls that can share this provider.
    const keepAliveOf = provider.keepAlive?.bind(provider);
    const cacheKeepAlive = keepAliveOf
        ? new CacheKeepAlive({ ping: keepAliveOf, onPing: (r) => session.recordLlmUsage(llmUsageOf(r)) })
        : null;

    /**
     * Send one facilitation request (`run` sends `messages` with `system`) and
     * tell the keep-alive. `keeps` is asked once it completes: true when its
     * cache entry is the one the next request will extend.
     */
    async function facilitationRequest<T>(
        messages: Message[],
        system: string,
        run: () => Promise<T>,
        keeps: (result: T) => boolean
    ): Promise<T> {
        const ticket = cacheKeepAlive?.begin();
        try {
            const result = await run();
            ticket?.end(keeps(result) ? { messages, options: { system } } : undefined);
            return result;
        } finally {
            ticket?.end();
        }
    }

    // Jev (TypeSafe) for the silence classifiers and the spoken commands. Always
    // on for aloud cloud; an opt-in everywhere else (voice-commands.ts). Up here
    // because status text and the info panel below both depend on it. `let`s:
    // the info panel can turn it on mid-sit (offerVoiceCommands).
    const ownKey = await ownJudgeKey();
    let judgeAccess = voiceCommandsAccess({
        provider: setup.provider,
        ownKey: ownKey !== null,
        optedIn: appSettings.voiceCommandsViaCloud,
        signedIn: await canReachJudge(),
    });
    // The dev override (on/shadow/off) is about the hosted rollout; an opt-in
    // session asked for the judge by name.
    const jevMode = judgeAccess === 'hosted' ? getJevClassifierMode() : 'on';
    const judgeWanted = (): boolean =>
        judgeAccess === 'opted-in' ||
        judgeAccess === 'own-key' ||
        (judgeAccess === 'hosted' && jevMode !== 'off');
    // One instance, so the classifiers and the commands share its failure backoff.
    let cloudJudge: RemoteJudge | null = !judgeWanted()
        ? null
        : judgeAccess === 'own-key' && ownKey
          ? new OwnKeyJudge(ownKey)
          : new CloudJudge();
    cloudJudge?.warm();
    // The first few sessions with commands say so right where "Listening…" is.
    const inviteToCommands = cloudJudge !== null && claimIntroSession();
    // Asks the command judge while the recognizer is still waiting out the pause.
    // A request can point back at what was just said ("can you do that?").
    // Read at call time: judgeAccess can change mid-session.
    const saidBefore = (): JudgeBefore =>
        judgeContextFor(judgeAccess, saidJustBefore(session.state?.exchanges ?? []));
    let commandPrefetch = cloudJudge ? new CommandPrefetch(cloudJudge, undefined, saidBefore) : null;
    builder.config.appControls = cloudJudge ? 'voice' : 'screen';
    // They opted in and the sign-in lapsed: otherwise the only sign is a command
    // that does nothing. Until their first turn, then it's just Listening….
    let signInNudge = judgeAccess === 'signed-out';
    const listeningStatus = (): string =>
        t(
            signInNudge
                ? VOICE_COMMANDS_SIGN_IN
                : inviteToCommands
                  ? LISTENING_WITH_INVITE
                  : 'Listening…'
        );

    function buildSessionInfoRows(): SessionInfoRow[] {
        const providerLabel =
            ALL_PROVIDERS.find((p) => p.value === setup.provider)?.label ?? setup.provider;
        // Dimension rows only appear when the mode composes them into the
        // prompt (felt sense defines its own attention, tone, guidance, and
        // brevity, plus its own check-in timing default).
        const rows: SessionInfoRow[] = [
            {
                label: t('Model'),
                value: modelLabel,
                ...(isSlowModel(activeModel) ? { note: t(SLOW_MODEL_NOTE) } : {}),
            },
            { label: t('Mode'), value: t(mode.label) },
        ];
        if (mode.composes?.focuses !== false) {
            rows.push({
                label: t('Focus'),
                value:
                    setup.focuses.length > 0
                        ? setup.focuses.map((f) => t(FOCUS_LABELS[f])).join(', ')
                        : t(FOCUS_LABELS.open_awareness),
            });
        }
        if (mode.composes?.qualities !== false && setup.qualities.length > 0) {
            rows.push({
                label: t('Vibe'),
                value: setup.qualities.map((q) => t(QUALITY_LABELS[q])).join(', '),
            });
        }
        if (mode.composes?.directiveness !== false) {
            rows.push({ label: t('Guidance'), value: t(GUIDANCE_LEVEL_LABELS[setup.directiveness] ?? 'Balanced') });
        } else if (mode.checkinPaceSlider) {
            rows.push({
                label: t('Check-in pace'),
                value: setup.feltSenseCheckins
                    ? t(CHECKIN_PACE_LABELS[setup.feltSensePace] ?? 'Patient')
                    : t('Off'),
            });
        }
        if (mode.composes?.verbosity !== false) {
            rows.push({ label: t('Response length'), value: t(VERBOSITY_LABELS[setup.verbosity]) });
        }
        // What the sit speaks with and hears: the live voice (tap to change -
        // same modal as the input-row button), the recognizer, and the
        // session's language (see sessionLanguage).
        const voiceName = stripVoicePrefix(setup.voice);
        const voiceEntry = voiceName ? scoredVoices.find((v) => v.name === voiceName) : undefined;
        const engineId = voiceEntry?.displayEngine ?? voiceEntry?.engine;
        const engineLabel = engineId ? (ENGINE_LABELS[engineId] ?? engineId) : null;
        rows.push(
            {
                label: t('Voice'),
                value: voiceName ? voiceLabel(voiceName) : t('Default'),
                note: engineLabel
                    ? `${t(engineLabel)} · ${voiceRateLabel(voiceName, scoredVoices, setup.ttsRate)}`
                    : voiceRateLabel(voiceName, scoredVoices, setup.ttsRate),
                onClick: () => openSessionVoiceModal(),
            },
            {
                label: t('Speech recognition'),
                value: t(
                    sttEngineOptions(isWebMode(), undefined, undefined, sttChoice).find(
                        (o) => o.value === sttChoice
                    )?.label ?? sttChoice
                ),
            },
            {
                label: t('Language'),
                value: LANGUAGES.find(([c]) => c === sessionLanguage)?.[1] ?? sessionLanguage,
            },
            { label: t('Source'), value: t(providerLabel) },
            {
                label: t('Delivery'),
                value: canStream(provider) ? t('Speaks as it generates') : t('Waits for full reply, then speaks'),
            },
            // Actionable: the clock can be hidden from the input row, and this
            // is then the only way back to its settings mid-session.
            {
                label: t('Clock'),
                value: sessionClock.faceLabel(),
                onClick: () => void sessionClock.openPicker(),
            }
        );
        if (cloudJudge) {
            rows.push({
                label: t('Voice commands'),
                value: t('See what you can say'),
                onClick: () => void showVoiceCommandExamples(appSettings.saveSessionLogs),
            });
        } else if (judgeAccess === 'off' || judgeAccess === 'signed-out') {
            // Not "Off": the two that need no judge always work.
            rows.push({
                label: t('Voice commands'),
                value: t('"Mute" and "end the session" only'),
                onClick: () => void offerVoiceCommands(),
            });
        }
        return rows;
    }
    const infoPanel = mountSessionInfoPanel(root, buildSessionInfoRows, t('Session'), [
        { label: t('Report a bug'), onClick: () => void openBugReport() },
        // Flag an inappropriate facilitator response. Play's AI-Generated
        // Content policy requires this to be reachable in-session, whatever
        // the LLM source; own-provider (BYOK/local) reports self-identify in
        // the mail template.
        {
            label: t('Report AI content'),
            onClick: () =>
                void openAiContentReport({
                    sourceLabel:
                        ALL_PROVIDERS.find((p) => p.value === setup.provider)?.label ??
                        setup.provider,
                    ownProvider: setup.provider !== 'aloud',
                }),
        },
    ]);
    // The nav ⓘ button that opens it is created further down (navLinks), and
    // wired there once it exists in the DOM.

    /**
     * On a failed Claude-subscription turn, tell a *removed* model (Anthropic
     * pulling Fable, etc.) apart from a cold-start stall: re-probe, and only on
     * a confirmed "unavailable" swap the live provider to the nearest peer,
     * refresh the panel, and tell the user. Returns true if it swapped (caller
     * skips the generic stall apology). Best-effort; never throws.
     */
    async function tryFallbackSubscriptionModel(): Promise<boolean> {
        if (setup.provider !== 'claude_proxy') return false;
        const fallback = nearestSubscriptionModel(activeModel);
        if (!fallback) return false; // already on a dependable default
        // Only reclassify a stall as a removal when the probe confirms it, or a
        // plain cold-start hiccup would silently change the model.
        if ((await probeClaudeProxyModel(activeModel)) !== 'unavailable') return false;
        const prevLabel = sessionModelLabel('claude_proxy', activeModel);
        try {
            setup.model = fallback;
            provider = await buildProvider(setup);
        } catch {
            return false;
        }
        activeModel = fallback;
        recomputeModelLabel();
        infoPanel.refresh();
        // Toast carries the specifics; the spoken line stays in the
        // facilitator's voice (no "subscription"/model jargon mid-session).
        showErrorToast(
            t("{prev} isn't available on your subscription right now. Switched to {next}.", {
                prev: prevLabel,
                next: prettyModelName(fallback),
            })
        );
        void tts.speak('I need to switch models for a moment, then we can continue.', {
            rate: setup.ttsRate,
        });
        return true;
    }

    // Barge-in, from either detector. Never a hold exit: a timer notice or
    // command ack spoken into a hold can be barged over, and the hold outlives
    // it.
    const onBargeIn = () => {
        tapEvent('audio', 'barge-in');
    };

    // Tier-2 soak harness: no-op unless DEV and ?soak=1 (ui/src/soak-tap.ts).
    armSoakTap();

    const vadOpts = {
        silenceBaseMs: pacingConfig.silenceBaseMs,
        silenceMaxMs: pacingConfig.silenceMaxMs,
        silenceRampRate: pacingConfig.silenceRampRate,
        minSpeechDurationMs: pacingConfig.minSpeechDurationMs,
        micDeviceId: appSettings.micDeviceId,
        whisperModelSize: appSettings.sttWhisperModel,
        speculation: appSettings.sttSpeculation,
        // Per-session pick (setup; original language on a resume), not the app
        // default: the recognizer must hear the language this sit runs in
        // (meditation-pal-c3a0.2).
        language: sessionLanguage,
    };
    // The hosted adapter is the server-Whisper engine pointed at the cloud, so it
    // reports as 'server-whisper' downstream. `let`s: switchSttEngine can swap
    // a blocked browser recognizer for aloud cloud mid-session.
    let sttChoice = resolveSttChoice(appSettings.sttEngine, isWebMode());
    let stt: SttEngine | null = await createSttForChoice(sttChoice, vadOpts);
    let sttBackend: SttBackend = sttBackendForChoice(sttChoice);

    // server-Whisper detects barge-in on its own continuous capture stream, so
    // don't ALSO wrap TTS with the separate-stream detector there: a second mic
    // stream doesn't get the OS echo-cancellation and trips on the facilitator's
    // own voice (the self-barge-in bug). web-speech has no such stream, so it
    // keeps the wrapper, except on phones (see buildTts).
    // Not on an iPhone's speaker, whose echo canceller lets the facilitator's
    // voice through: it barged in on every reply and sent the reply's first
    // words as the meditator's turn (meditation-pal-hi6f). There the mic closes
    // while the facilitator speaks, as on the built-in recognizer. Headphones
    // are fine, and the iOS app can tell (watched below); iPhone Safari can't.
    // At a desktop, the same beside a voice the OS speaks, which no echo
    // canceller hears (bargesInOnOwnStream in barge-in.ts): known once the
    // voice is built.
    let iosHeadphonesOn = await iosHeadphones();
    let voiceCancelled = true;
    const bargesInOnOwnStream = (backend: SttBackend): boolean =>
        streamBargesIn({
            backend,
            phone: isSingleOwnerMicPlatform(),
            iosWeb: isIosWeb(),
            iosHeadphones: iosHeadphonesOn,
            voiceEchoCancelled: voiceCancelled,
        });
    let engineDrivenBargeIn = bargesInOnOwnStream(sttBackend);
    if (isIosWeb()) diag(`[vad] iPhone headphones: ${iosHeadphonesOn ? 'on' : 'off'}`);
    // Continuous capture (meditation-pal-57gl): on the engine-driven path the
    // mic stays live through the LLM+TTS window instead of pausing while `busy`,
    // so the user is never "deaf" mid-response. Safe because that VAD rejects
    // TTS echo (measured echo gate + energy floor vs ~0.005 echo); web-speech /
    // capacitor recognizers can't, so they keep pause-while-busy.
    let continuousCapture = engineDrivenBargeIn;
    // Turn supersession + barge-in plumbing. turnGen bumps each turn so a stale
    // turn bails; activeFullAbort stops a superseded turn generating;
    // activeTtsAbort hushes the in-flight reply, which keeps what was heard.
    let turnGen = 0;
    let activeFullAbort: AbortController | null = null;
    let activeTtsAbort: AbortController | null = null;
    // Set while a reply is in the log and still being spoken (watchReply).
    let cutReply: (() => void) | null = null;
    // The hosted voice catalog, once fetched (voiceNoteReady); empty until then.
    let hostedCatalog: CloudVoice[] = [];
    /** Whether the voice speaking now takes a whole reply per request
     *  (CloudVoice.wholeReply). Asked per reply: the voice can change mid-sit.
     *  Before the catalog arrives, or from a server older than the field, a
     *  sentence per request. */
    const replyWhole = (): boolean => hostedVoiceEntry(setup.voice, setup.provider, hostedCatalog)?.wholeReply === true;
    // The continuous-capture engine when that's the live backend; used for
    // barge-in wiring (echo calibration goes through echoListener).
    let whisperEngine = continuousWhisper(stt);
    function continuousWhisper(engine: SttEngine | null): WhisperPcmSttEngine | null {
        return continuousCapture && engine instanceof WhisperPcmSttEngine ? engine : null;
    }
    // The opening sound, and the mic opened (primed) by a recognizer that opens
    // one now, one after the other (playOpening says in which order). The
    // facilitator's first words wait for both (tts.speak below), and come as
    // soon after as they are ready.
    const signatureSound = resolveSignatureSound(appSettings.signatureSound);
    // When the volume banner judges "very low" (output-volume.ts).
    let micOpen: Promise<unknown> = Promise.resolve();
    const openingOver = playOpening(signatureSound, () => {
        const opening = stt?.prime?.();
        if (opening) micOpen = opening;
        return opening;
    });
    let openingSounding = true;
    void openingOver.then(() => {
        openingSounding = false;
    });
    /** Swap in a new live engine; returns the old one for the caller to stop. */
    function adoptStt(next: SttEngine): SttEngine | null {
        const prev = stt;
        stt = next;
        whisperEngine = continuousWhisper(next);
        wireWhisperBargeIn();
        return prev;
    }
    /** The engine for a voice, and whether echo cancellation can take that
     *  voice out of the mic (voiceEchoCancelled). */
    async function buildTts(voiceId: string | null): Promise<{ tts: TtsEngine; echoCancelled: boolean }> {
        // Server-side synthesis is billable compute; fold chars into usage.
        const ttsOpts = { onServerSynthesize: (chars: number) => session.recordTts(chars) };
        let engine;
        if (setup.provider === 'aloud' && !voiceId) {
            // Hosted pipeline with no voice picked: the server default. Any
            // explicit pick goes through the normal picker instead - `aloud:`
            // routes to this same hosted engine there, and a `browser:`/`server:`
            // voice must not be overridden with the hosted default (the Ava→Leda
            // bug, and its desktop twin with `server:`-prefixed macOS voices).
            engine = createCloudAloudTts('', ttsOpts);
        } else {
            ({ engine } = await createTtsForVoice(voiceId, ttsOpts));
        }
        // The barge-in wrapper opens a PARALLEL mic stream during every speak().
        // On a phone, echo cancellation can't cope with the loudspeaker, so the
        // facilitator's voice cancels its own TTS, and the extra stream starves
        // the platform's single recognizer (meditation-pal-x4h4, -oxmt). Phones
        // pause capture while busy anyway, so they skip it; server-whisper
        // drives its own, or none beside a voice the OS speaks. The wrapper
        // itself stands down beside such a voice (voiceEchoCancelled).
        const wrapBargeIn =
            sttBackend !== 'server-whisper' && sttBackend !== 'capacitor' && !isSingleOwnerMicPlatform();
        const tts = wrapBargeIn
            ? wrapTtsWithBargeIn(engine, {
                  // The wrapper cancels the sentence it heard over; the abort
                  // keeps the reply's next ones from playing over the meditator.
                  // Null outside a reply (a notice spoken into a hold).
                  onBargeIn: () => {
                      activeTtsAbort?.abort();
                      onBargeIn();
                  },
                  micDeviceId: appSettings.micDeviceId,
              })
            : engine;
        return { tts, echoCancelled: voiceEchoCancelled(engine) };
    }
    // A voice that can't speak the session's language (a leftover English pick
    // starting a zh sit) gets swapped, for this session only, to the best voice
    // that can: Leda glitching through a Chinese sit is worse than not honoring
    // the pick (meditation-pal-c3a0.6). Never persisted - the next English
    // session gets the original voice back.
    if (sessionLanguage !== 'en') {
        try {
            const [server, hosted] = await Promise.all([fetchServerVoices(), fetchCloudVoices()]);
            const list = buildScoredVoiceList(server, true, hosted, sessionLanguage);
            const currentName = stripVoicePrefix(setup.voice);
            const current = currentName ? list.find((v) => v.name === currentName) : undefined;
            const needsSwap = current
                ? current.langMismatch === true
                : setup.provider !== 'aloud';
            if (needsSwap) {
                // The list sorts zh-native voices first in a zh session, so
                // this lands on one when the catalog has it.
                const capable = list.find((v) => !v.langMismatch && !v.needsDownload);
                if (capable) setup.voice = prefixedVoiceId(capable.engine, capable.name);
            } else if (!current && setup.provider === 'aloud' && sessionLanguage === 'zh') {
                // No voice + hosted provider: the server default (Harper) does
                // speak zh, but with an audible accent - steer to a voice a
                // native speaker signed off on (CloudVoice.zhNative), when the
                // catalog names one. Session-only, like the swap above.
                const native = list.find((v) => v.zhNative && !v.langMismatch && !v.needsDownload);
                if (native) setup.voice = prefixedVoiceId(native.engine, native.name);
            }
        } catch {
            // Catalog unreachable: keep the picked voice.
        }
    }
    // Swapped by an in-session voice change; the outer `tts` wrapper reads it.
    let firstVoice: Awaited<ReturnType<typeof buildTts>>;
    try {
        firstVoice = await buildTts(setup.voice);
    } catch (err) {
        // The opening has opened the mic, and no endSession will ever close it.
        void playClosing(signatureSound, stt);
        throw err;
    }
    let activeTts = firstVoice.tts;
    voiceCancelled = firstVoice.echoCancelled;
    rederiveListening();

    /** Rebuild the live engine when the user picks a new voice mid-session. */
    async function rebuildTts(voiceId: string | null): Promise<void> {
        const next = await buildTts(voiceId);
        try {
            await activeTts.cancel();
        } catch {
            /* ignore */
        }
        activeTts = next.tts;
        // A voice the OS speaks closes the mic while it speaks, and one echo
        // cancellation hears gives the stream its barge-in back.
        voiceCancelled = next.echoCancelled;
        rederiveListening();
    }

    /** Barge-in and continuous capture follow what they depend on (the
     *  recognizer, iPhone headphones, the voice: bargesInOnOwnStream). Where
     *  this stops the mic listening through lines, a turn already open under
     *  one is the caller's to close. */
    function rederiveListening(): void {
        engineDrivenBargeIn = bargesInOnOwnStream(sttBackend);
        continuousCapture = engineDrivenBargeIn;
        const was = whisperEngine;
        whisperEngine = continuousWhisper(stt);
        // The engine still hears the speaker, so it must stop barging in.
        if (!whisperEngine) was?.setBargeInHandler(null);
        wireWhisperBargeIn();
        if (!voiceCancelled) diag(`[vad] the OS speaks this voice, mic open while it speaks: ${continuousCapture}`);
    }

    // Depth of in-flight speak() calls: while > 0 the facilitator's audio is
    // actually playing, which the capture engine uses to calibrate and gate its
    // echo. Bracketing real speak() calls keeps the signal to playback, not the
    // silent "thinking" phase.
    let ttsSpeakingDepth = 0;
    // Hold the engine's echo gate through the gaps BETWEEN a reply's sentence
    // chunks and briefly past playback: room reverb, AEC tails, and VAD debounce
    // all outlive the audio element, and per-speak() on/off flips leave ungated
    // windows where trailing-fragment echo sneaks through (meditation-pal-p8lx).
    const TTS_ACTIVE_HANGOVER_MS = 1000;
    let ttsActiveOffTimer: ReturnType<typeof setTimeout> | null = null;
    // When playback last ended; with the depth counter this defines the
    // "echo possible" window the transcript-level guard checks.
    let lastTtsEndedAt = 0;
    // Rolling tail of text handed to the synthesizer (everything voiced goes
    // through here). The transcript echo guard matches phantom turns against it.
    // A whole-reply utterance is capped to fit it (streaming-tts.ts
    // MAX_WHOLE_REPLY_CHARS): shrink one, shrink both.
    let spokenTail = '';
    const SPOKEN_TAIL_MAX_CHARS = 600;
    function ttsPlaybackStarted(text: string): void {
        tapFlags({ speaking: true });
        tapEvent('tts', 'start', { text });
        spokenTail = `${spokenTail} ${text}`.slice(-SPOKEN_TAIL_MAX_CHARS);
        if (ttsActiveOffTimer) {
            clearTimeout(ttsActiveOffTimer);
            ttsActiveOffTimer = null;
        }
        echoListener()?.setTtsActive(true);
        echoListener()?.noteVoicePlayback();
        // A line after the end question closes it: a yes to that line's own
        // question (a check-in, a timer notice) must not end the sit.
        endConfirmUntil = 0;
    }
    function ttsPlaybackEnded(): void {
        tapFlags({ speaking: false });
        tapEvent('tts', 'end');
        releaseEchoGate();
    }
    /** The engine told when the facilitator's audio plays. With continuous
     *  capture that raises its echo gates; without it (iPhone) nothing listens
     *  then, and it only measures the echo for the [vad] tts window line, the
     *  number that decides whether iPhones can barge in (hi6f). */
    function echoListener(): WhisperPcmSttEngine | null {
        return stt instanceof WhisperPcmSttEngine ? stt : null;
    }
    function releaseEchoGate(): void {
        lastTtsEndedAt = Date.now();
        // The engine is swappable (in-session STT switch), so pin the one this
        // playback belongs to.
        const engine = echoListener();
        if (!engine) return;
        engine.notePlaybackEnded();
        if (!continuousCapture) engine.watchPlaybackTail();
        ttsActiveOffTimer = setTimeout(() => {
            ttsActiveOffTimer = null;
            if (ttsSpeakingDepth === 0) engine.setTtsActive(false);
        }, TTS_ACTIVE_HANGOVER_MS);
    }
    /** Echo can only arrive while audio plays or shortly after (capture +
     *  transcription latency stretch "shortly" to a few seconds). */
    const ECHO_TEXT_WINDOW_MS = 4000;
    /** How long a paused recognizer waits after playback before reopening the
     *  mic, so a phone speaker's reverb isn't heard as the user. */
    const MIC_RESUME_COOLDOWN_MS = 700;
    const micCooldown = isSingleOwnerMicPlatform();
    /** Where the mic is closed while the facilitator speaks, how long after
     *  her last line it opens again. Phones wait out their speaker's reverb.
     *  Beside a voice the OS speaks, the tail, which the mic hears at full
     *  level: opened sooner, it would take her last word for a turn. On
     *  desktop otherwise no wait, which would cost the start of a barge-in
     *  (the wrapper's cancel reopens the mic mid-sentence). */
    const micReopensAfterMs = (): number =>
        micCooldown ? MIC_RESUME_COOLDOWN_MS : voiceCancelled ? 0 : PLAYBACK_TAIL_MS;
    function inEchoWindow(): boolean {
        return ttsSpeakingDepth > 0 || Date.now() - lastTtsEndedAt < ECHO_TEXT_WINDOW_MS;
    }
    const tts = {
        async speak(text: string, options?: TtsOptions): Promise<void> {
            // A torn-down session must never voice anything: a slow LLM turn
            // can resolve minutes after the user quit and would play into
            // whatever session is on screen now. This is the one chokepoint.
            if (!ttsEnabled || torn) return;
            if (openingSounding) {
                await openingOver;
                if (!ttsEnabled || torn) return;
            }
            // A recognizer that can't tell our voice from the meditator's must
            // be closed while we speak. A reply finds it closed already (the
            // listen loop awaits it); a check-in or timer notice starts on its
            // own and would otherwise be transcribed as the meditator's turn.
            if (!continuousCapture && sttCapturing) {
                diag('[echo-guard] recognizer closed for an unprompted line');
                void stt?.stop();
            }
            ++ttsSpeakingDepth;
            ttsPlaybackStarted(text);
            // The capture engine's echo warm-up counts only audible voice: from
            // the engine's onStart, or from here on one that reports no start.
            const engine = activeTts;
            const listener = echoListener();
            if (!engine.reportsStart) listener?.noteVoiceAudible();
            let live = true;
            try {
                return await engine.speak(text, {
                    ...options,
                    onStart: () => {
                        if (live) listener?.noteVoiceAudible();
                        options?.onStart?.();
                    },
                });
            } finally {
                live = false;
                if (--ttsSpeakingDepth === 0) ttsPlaybackEnded();
            }
        },
        prefetch(text: string, options?: TtsOptions): void {
            // Without this passthrough the streaming bridge sees no prefetch()
            // on the wrapper and inter-sentence synthesis stays serial.
            if (!ttsEnabled || torn) return;
            activeTts.prefetch?.(text, options);
        },
        cancel(): Promise<void> {
            return activeTts.cancel();
        },
        listVoices() {
            return activeTts.listVoices();
        },
        // Read per reply (streaming-tts.ts): the engine changes on a voice switch.
        get reportsMarks(): boolean {
            return activeTts.reportsMarks === true;
        },
    } satisfies TtsEngine;
    // To the mic, the opening sound is the facilitator's audio like any spoken
    // line: hold the capture engine's echo gate up while it plays, or the live
    // mic can take it for the meditator.
    if (openingSounding) {
        ++ttsSpeakingDepth;
        echoListener()?.setTtsActive(true);
        void openingOver.then(() => {
            if (--ttsSpeakingDepth === 0) releaseEchoGate();
        });
    }
    // On the server-Whisper path, barge-in comes from its continuous
    // (echo-cancelled) capture stream. Re-wired on every engine swap.
    function wireWhisperBargeIn(): void {
        if (!whisperEngine) return;
        whisperEngine.setBargeInHandler(() => {
            // Only meaningful while the facilitator is responding: hush it so
            // the user isn't talked over. The utterance keeps being captured and
            // gets its own turn, which supersedes this one. What wasn't heard
            // is cut from the transcript and the log (watchReply), so a false
            // trigger costs the rest of the reply. In a silence hold there's
            // nothing to interrupt (busy is false) and the resume classifier
            // owns leaving the hold, so don't clear it here.
            if (!busy || openingSounding) {
                diag(`[vad] barge-in ignored: busy=${busy} opening=${openingSounding}`);
                return;
            }
            void tts.cancel();
            activeTtsAbort?.abort();
            onBargeIn();
        });
    }
    wireWhisperBargeIn();

    // Inject an orb into the global nav's .nav-center slot and override the nav
    // links to End / History. Both are restored on teardown so swapping back to
    // setup doesn't leave stale chrome.
    const navCenter = document.getElementById('navCenter');
    const navLinks = document.getElementById('navLinks');
    const savedNavLinks = navLinks ? navLinks.innerHTML : null;
    if (navCenter) {
        navCenter.innerHTML = `
            <div class="nav-session-info">
                <div class="orb orb-breathing orb-nav" id="orb"></div>
                <button type="button" class="session-hamburger" id="sessionHamburger" aria-label="${t('Session menu')}" aria-haspopup="true" aria-controls="mobileMoreSheet" data-mobile-more-open>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg>
                </button>
            </div>`;
        navOrbPainted();
    }
    if (navLinks) {
        navLinks.innerHTML = `
            <a href="#" id="end-btn" class="nav-end-link">${t('End')}<span class="nav-word-session"> ${t('Session')}</span></a>
            <a href="#" data-nav="history">${t('History')}</a>
            <button type="button" class="nav-info-btn" id="session-info-btn" aria-label="${t('Session info')}" title="${t('Session info')}">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
            </button>
            <button type="button" class="theme-toggle"
                data-theme-toggle aria-label="${t('Toggle theme')}"></button>`;
        // Re-init the theme toggle since we just replaced its DOM node.
        const themeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
        if (themeBtn) initThemeToggle(themeBtn);
        navLinks
            .querySelector<HTMLElement>('#session-info-btn')
            ?.addEventListener('click', () => infoPanel.toggle());
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

    function setHolding(holding: boolean): void {
        if (orbEl) orbEl.classList.toggle('orb-holding', holding);
        listenBtn.classList.toggle('active', holding);
    }

    // Begin a silence hold. Every entry path routes through here so a pending
    // [HOLD] bid is always cleared with it.
    function enterHold(): void {
        tapEvent('hold', 'enter');
        tapFlags({ silenceMode: true, awaitingHoldConfirm: false });
        awaitingHoldConfirm = false;
        silenceMode = true;
        silenceBuffer = [];
        pacing.enterSilenceMode();
        setHolding(true);
        setStatus(holdingStatus());
    }

    /** The view's half of leaving a hold; the caller settles pacing. */
    function exitHold(): void {
        tapEvent('hold', 'exit');
        tapFlags({ silenceMode: false });
        silenceMode = false;
        leftHoldAt = Date.now();
        setHolding(false);
    }

    /** `micOpening` greys the mic button for as long as this line stands:
     *  any later status, whatever wrote it, gives the button its look back. */
    function setStatus(text: string, micOpening = false): void {
        statusEl.textContent = text;
        micBtn.classList.toggle('opening', micOpening);
    }

    function holdingStatus(): string {
        return t("Just listening, say when you're ready to continue");
    }

    // Slow-response indicator: if nothing has been spoken this long after a
    // turn (or opener) started generating, say so - during a provider
    // slowdown or outage the quiet typing dots read as a dead app. One shared
    // timer: arming replaces any previous one, and the first spoken sentence
    // or the turn's end clears it.
    const SLOW_RESPONSE_STATUS_MS = 15_000;
    let slowStatusTimer: ReturnType<typeof setTimeout> | null = null;
    function armSlowResponseStatus(): void {
        clearSlowResponseStatus();
        slowStatusTimer = setTimeout(
            () => setStatus(t('Still working - the response is taking longer than usual')),
            SLOW_RESPONSE_STATUS_MS
        );
    }
    function clearSlowResponseStatus(): void {
        if (slowStatusTimer) {
            clearTimeout(slowStatusTimer);
            slowStatusTimer = null;
        }
    }
    // A reply being re-sent through a dropped connection (net-retry.ts) says
    // so, while the dots are still all there is to see.
    const stopRetryNotice = onCloudLlmRetry(() => {
        if (slowStatusTimer) setStatus(t('Connection lost - trying again'));
    });

    // Persistent STT outage banner. The status line and a one-shot toast are
    // easy to miss, so a run of failed transcriptions raises a banner that stays
    // until a transcription lands: nobody should talk into a dead mic for a
    // whole session unaware. Streak-tracked so a network blip doesn't flash it.
    const sttTroubleEl = root.querySelector<HTMLElement>('#stt-trouble');
    let sttFailureStreak = 0;
    // The latest failure was the connection (a phone out of signal), not the
    // recognizer: the banner says so instead of blaming the browser.
    let sttFailureIsConnection = false;
    /** Show the banner once failures pass the threshold; called on each STT error. */
    function noteSttFailure(connection: boolean): void {
        sttFailureStreak++;
        sttFailureIsConnection = connection;
        if (sttFailureStreak >= 2 && sttTroubleEl) renderSttTrouble();
    }
    /**
     * Fill the trouble banner. When aloud cloud is an available STT option and
     * we're on none of its models, offer a one-click switch to its default
     * model (hostedSttDefault), so a user whose browser blocks its speech
     * recognizer (common on Edge/Windows) gets a working mic without leaving
     * the session or hunting through Settings.
     */
    function renderSttTrouble(): void {
        if (!sttTroubleEl) return;
        const cloudChoice = isHostedSttChoice(sttChoice) ? null : hostedSttDefault(isWebMode());
        sttTroubleEl.replaceChildren();
        const msg = document.createElement('span');
        msg.textContent = cloudChoice && !sttFailureIsConnection
            ? t('Trouble hearing you - your browser may be blocking its speech recognition.')
            : t(
                  "Trouble with speech to text. We're not catching your voice right now - check your connection, or change speech recognition in Settings."
              );
        sttTroubleEl.appendChild(msg);
        if (cloudChoice) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'stt-trouble-btn';
            btn.textContent = t('Use aloud cloud speech');
            btn.addEventListener('click', () => void switchSttEngine(cloudChoice));
            sttTroubleEl.appendChild(btn);
        }
        sttTroubleEl.classList.remove('hidden');
    }
    /** Clear the streak + banner; called whenever a transcription succeeds. */
    function clearSttTrouble(): void {
        sttFailureStreak = 0;
        sttTroubleEl?.classList.add('hidden');
    }

    // Guards a switch in progress so a double-click (or a fresh STT error
    // re-rendering the banner) can't build two engines at once.
    let switchingStt = false;
    /**
     * Swap the live STT engine mid-session (the trouble banner's button).
     * Re-derives every backend-shaped bit the listen loop, meter, and barge-in
     * read (all `let` above), rebuilds TTS so its barge-in wrapping matches the
     * new backend, and persists the choice. Stopping the old recognizer ends the
     * loop's current iteration; it re-enters on the new `stt`.
     */
    async function switchSttEngine(choice: SttEngineChoice): Promise<void> {
        if (switchingStt || torn || choice === sttChoice) return;
        switchingStt = true;
        try {
            setStatus(t('Switching to aloud cloud speech…'));
            const next = await createSttForChoice(choice, vadOpts);
            if (!next) {
                showErrorToast(
                    t("Couldn't start aloud cloud speech - check your connection and that you're signed in.")
                );
                setStatus(muted ? t('Muted') : listeningStatus());
                return;
            }
            sttChoice = choice;
            sttBackend = sttBackendForChoice(choice);
            engineDrivenBargeIn = bargesInOnOwnStream(sttBackend);
            continuousCapture = engineDrivenBargeIn;
            const prev = adoptStt(next);
            await rebuildTts(setup.voice);
            // Persist so the next session opens on the engine that worked here.
            await persistSettings({ sttEngine: choice }).catch(() => {
                /* best-effort; the live switch still stands for this session */
            });
            stopMeter();
            clearSttTrouble();
            // Ends the loop's in-flight `for await` on the old engine; it re-enters
            // on the new `stt`. resumeCapture below restarts it if it had already
            // fallen out.
            void prev?.stop();
            if (!muted) {
                setStatus(listeningStatus());
                resumeCapture();
            } else {
                setStatus(t('Muted'));
            }
        } finally {
            switchingStt = false;
        }
    }

    /**
     * Phones stop the recognizer and mute the mic tracks in the background,
     * and nothing brings them back: the mic stays silently dead
     * (meditation-pal-wudm). Rebuild the SAME engine on foreground. Phones only:
     * a desktop tab switch doesn't kill capture, and a rebuild there would cut
     * a live turn.
     */
    async function restartSttAfterForeground(): Promise<void> {
        if (torn || muted || switchingStt || !stt) return;
        switchingStt = true;
        try {
            const next = await createSttForChoice(sttChoice, vadOpts);
            if (!next) {
                // Leave the old engine in place: a failed rebuild shouldn't also
                // take away whatever capture may still work.
                renderSttTrouble();
                return;
            }
            const prev = adoptStt(next);
            stopMeter();
            // Ends the loop's in-flight iteration on the old engine; it re-enters
            // on the new `stt`, or is restarted below if it had already fallen out.
            void prev?.stop();
            if (torn || muted) return;
            resumeCapture();
            debugLog('stt restarted after foreground');
        } catch (err) {
            console.warn('STT restart after foreground failed', err);
            renderSttTrouble();
        } finally {
            switchingStt = false;
        }
    }

    const onVisibilityChange = (): void => {
        if (document.visibilityState !== 'visible') return;
        if (!isSingleOwnerMicPlatform()) return;
        void restartSttAfterForeground();
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    // Staged-mode phase hint: a quiet word in the input row ("Sensing",
    // "Finding words") so the user can feel where they are in the arc without
    // it being announced aloud. Hidden for single-phase modes.
    const phaseEl = root.querySelector<HTMLElement>('#session-phase');
    function setPhaseHint(): void {
        if (!phaseEl || !stager) return;
        phaseEl.textContent = t(stager.phase.label);
        phaseEl.title = t('{mode}: step {n} of {total}', {
            mode: t(mode.label),
            n: stager.phaseIndex + 1,
            total: stager.phases.length,
        });
        phaseEl.classList.remove('hidden');
    }
    setPhaseHint();

    function appendMessage(
        role: 'user' | 'assistant',
        text: string,
        partial = false
    ): HTMLElement {
        const el = document.createElement('div');
        el.className = `message ${role === 'assistant' ? 'facilitator' : 'user'}${partial ? ' partial' : ''}`;
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = text;
        el.appendChild(content);
        // Insert before the typing indicator so it stays at the bottom.
        conversation.insertBefore(el, typingIndicator);
        conversation.scrollTop = conversation.scrollHeight;
        return el;
    }

    /**
     * Progressive facilitator bubble revealed in step with the voice: each
     * sentence appears when its audio starts (streaming-tts onSpeakStart), not
     * when generation finishes - text running ahead of the voice breaks
     * immersion (beta feedback). finalize() swaps in the exact clean text
     * (original whitespace, plus anything never spoken because TTS was hushed
     * or failed), so the transcript always ends complete. The typing dots stay
     * up until the first reveal so the wait doesn't look dead.
     */
    function createAssistantReveal(): {
        anchor: () => void;
        reveal: (sentence: string) => void;
        finalize: (cleanText: string) => void;
        discard: () => void;
    } {
        let el: HTMLElement | null = null;
        let content: HTMLElement | null = null;
        let revealed = '';
        // Created hidden so anchor() can claim its transcript position (ahead of
        // any later turn's bubbles) without showing an empty balloon while the
        // first audio chunk is in flight.
        const ensure = (): HTMLElement => {
            if (!el) {
                el = appendMessage('assistant', '');
                el.style.display = 'none';
                content = el.querySelector<HTMLElement>('.message-content');
            }
            return content ?? el;
        };
        const show = (text: string): void => {
            const target = ensure();
            el!.style.display = '';
            target.textContent = text;
            hideTyping();
            conversation.scrollTop = conversation.scrollHeight;
        };
        return {
            anchor: () => {
                ensure();
            },
            reveal: (sentence: string) => {
                revealed = revealed ? `${revealed} ${sentence}` : sentence;
                show(revealed);
            },
            finalize: (cleanText: string) => {
                show(cleanText);
            },
            discard: () => {
                el?.remove();
                el = null;
                content = null;
            },
        };
    }

    /**
     * Follow a reply that is in the log and still being spoken. If a barge-in
     * or a newer turn keeps the rest of it from being heard, the log keeps
     * only what was (cutUnspokenReply). The returned settle gives the text the
     * log ended up with; call it when the audio is over. Until then whatever
     * takes the floor runs the same cut through `cutReply`, ahead of its own
     * words going into the log.
     */
    function watchReply(full: string, heard: () => { text: string; cut: boolean }): () => string {
        let kept = full;
        const cut = (): void => {
            if (kept !== full) return;
            const h = heard();
            if (!h.cut || !session.cutUnspokenReply(full, h.text)) return;
            kept = h.text;
            tapEvent('audio', 'reply-cut', { heardChars: kept.length, ofChars: full.length });
        };
        cutReply = cut;
        return () => {
            cut();
            if (cutReply === cut) cutReply = null;
            return kept;
        };
    }

    /** Render the out-of-credits apology as a transient facilitator bubble with
     *  an inline top-up button. NOT added to session history, so the saved
     *  transcript and the next LLM call's context resume from the last real turn
     *  once the user tops up or switches to a local/BYOK provider. */
    function appendBillingApology(text: string): void {
        const el = appendMessage('assistant', text);
        // A retreat attendee (meditation-pal-414) shouldn't be nudged to buy:
        // their cap reset restores access, not a top-up.
        if (getRetreatCovered()) return;
        if (purchaseChannel() === 'none') return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'buy-clouds-inline';
        btn.textContent = t('Buy ☁ to continue');
        btn.addEventListener('click', () => {
            void showBuyCreditsModal({
                title: t("You're out of clouds"),
                subtitle: t('Top up to keep going, or switch to a local/BYOK provider in Settings.'),
            });
        });
        el.appendChild(btn);
    }

    /** Show and voice the out-of-credits notice. A build that sells nothing
     *  gets the plain wording, and on Android the bubble (never the voice) adds
     *  where ☁ are sold. */
    function apologizeOutOfCredits(): void {
        const notice = outOfCreditsNotice();
        appendBillingApology([notice.text, topUpHint()].filter(Boolean).join(' '));
        void playCannedApology(notice.reason, cannedVoice(), notice.text);
    }

    /** The voice name to voice a canned apology in. Strips the `aloud:` prefix
     *  for the hosted endpoint; returns null (server default, then browser
     *  fallback) for a browser-side voice or non-hosted provider. */
    function cannedVoice(): string | null {
        const v = setup.voice;
        if (setup.provider === 'aloud' && v?.startsWith('aloud:')) return v.slice('aloud:'.length);
        return null;
    }

    /** First TTS failure of a turn (streaming-tts onTtsError). TTS stays
     *  non-fatal (the reply still lands in the transcript and the loop keeps
     *  listening), but hosted billing/auth failures must be SEEN: out of credits
     *  gets the same apology + buy prompt as the LLM leg, other recognized cloud
     *  conditions toast. Unrecognized errors stay quiet - a browser speech
     *  hiccup isn't worth interrupting a meditation for. */
    let voiceUnavailableShown = false;
    function handleTtsError(err: unknown): void {
        if (torn) return;
        // The browser refused to play the audio we did synthesize (Safari's
        // per-element autoplay gate, or a per-site "never auto-play" setting).
        // Worth saying: the alternative is a whole sit in silence with no clue.
        if ((err as { name?: string })?.name === 'NotAllowedError') {
            showErrorToast(t('Your browser blocked audio playback - allow auto-play for this site.'));
            const voice = cannedVoice();
            if (voice) reportCloudIncident('client_playback_blocked', { model: voice });
            return;
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (isOutOfCredits(msg)) {
            apologizeOutOfCredits();
            return;
        }
        // A hosted voice that failed for any other reason (5xx, timeout,
        // network): the sit continues text-first, the operator gets the row.
        if (isCloudTtsError(msg)) reportCloudIncident('client_tts_error', { detail: msg, model: cannedVoice() ?? '' });
        // The voice's provider refused aloud's account: every sentence will
        // fail the same way, so say once that it's the voice, not the sit.
        if (/provider_unavailable/.test(msg)) {
            if (!voiceUnavailableShown) {
                voiceUnavailableShown = true;
                showErrorToast(t("This voice isn't available right now. Pick another voice in Settings to hear the facilitator."));
            }
            return;
        }
        const described = describeCloudError(msg);
        if (described) showErrorToast(described);
    }

    // CSS hides the bubble with `.typing-bubble { display: none }` and reveals
    // it via `.typing-bubble.visible`, so toggle the class, not the `hidden`
    // attribute (which that display rule overrides).
    function showTyping(): void {
        typingIndicator.classList.add('visible');
        conversation.scrollTop = conversation.scrollHeight;
    }
    function hideTyping(): void {
        typingIndicator.classList.remove('visible');
        setFacilitatorHint(null);
    }

    // Transient hint next to the typing dots (e.g. Ollama "Loading model into
    // memory…" on first hit), inserted right after the typing indicator.
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

    const sessionStartMs = Date.now();

    // Keep the screen on for the session. The wake lock module also re-acquires
    // on visibility change while body[data-session-active] is set.
    document.body.dataset['sessionActive'] = 'true';
    void acquireWakeLock();

    // The clock in the input row: elapsed / time of day / countdown, switched by
    // tapping it. The mode and any timer length persist to app settings, so a
    // daily twenty-minute sit re-arms itself next session.
    let clockChangeByVoice = false;
    // A first sit runs on a timer nobody chose. It must not become the saved
    // default, and the clock reports its whole state on every change: until
    // the meditator picks a mode or length of their own, a change that keeps
    // the countdown (hiding the readout, the end-on-timer toggle) saves only
    // the part they touched.
    let unchosenTimer = setup.firstSit === true;
    const sessionClock = new SessionClock(
        timerEl,
        sessionStartMs,
        unchosenTimer
            ? {
                  ...appSettings,
                  sessionClockMode: 'timer',
                  sessionTimerMin: FIRST_SIT_TIMER_MIN,
                  endSessionOnTimer: false,
              }
            : appSettings,
        (choice) => {
            // The voice path persists through this same callback; only a timer
            // armed in the picker is news.
            if (choice.mode === 'timer' && !clockChangeByVoice) hintVoiceCommand('timer');
            if (!choice.keepRunning) unchosenTimer = false;
            const patch = {
                ...(unchosenTimer
                    ? {}
                    : { sessionClockMode: choice.mode, sessionTimerMin: choice.timerMin }),
                showSessionClock: choice.showClock,
                endSessionOnTimer: choice.endOnComplete,
            };
            Object.assign(appSettings, patch);
            void persistSettings(patch);
        }
    );

    // Rolling mean gap between completed turns, used to size the timer's
    // approach notice: with 90-second turns a one-minute lead can fall entirely
    // inside a silence and never be spoken before the end lands on top of it.
    const turnGaps: number[] = [];
    let lastTurnEndMs = sessionStartMs;
    const TURN_GAP_WINDOW = 4;
    function recordTurnGap(): void {
        const now = Date.now();
        turnGaps.push((now - lastTurnEndMs) / 1000);
        if (turnGaps.length > TURN_GAP_WINDOW) turnGaps.shift();
        lastTurnEndMs = now;
    }
    function avgTurnSec(): number | null {
        if (turnGaps.length === 0) return null;
        return turnGaps.reduce((a, b) => a + b, 0) / turnGaps.length;
    }

    if (stt === null) {
        micBtn.disabled = true;
        micBtn.classList.add('disabled');
        const hint = t(
            'No microphone available. Try Chrome or Edge for built-in transcription, or check your microphone permissions.'
        );
        micBtn.title = hint;
        setStatus(t('Mic unavailable'));
    } else {
        setStatus(listeningStatus());
    }

    // The turn's preview bubble, held through dispatch until showUserTurn puts
    // the turn's own bubble in its place (turn-preview.ts).
    const preview = createTurnPreview<HTMLElement>({
        add: (text) => appendMessage('user', text, true),
        set: (bubble, text) => {
            // The inner .message-content: setting textContent on the bubble
            // wipes that wrapper.
            const content = bubble.querySelector('.message-content');
            if (content) content.textContent = text;
            // Keep the growing partial in view: a multi-line in-progress
            // bubble otherwise runs off the bottom of the transcript until
            // the final replaces it.
            conversation.scrollTop = conversation.scrollHeight;
        },
        remove: (bubble) => bubble.remove(),
    });

    /** A meditator utterance on screen and in the soak tap (not in history). */
    function showUserTurn(text: string): void {
        preview.replaceWith(() => appendMessage('user', text));
        tapTurn('user', 'user', text);
    }

    function insertDivider(text: string): void {
        const divider = document.createElement('div');
        divider.className = 'message divider';
        divider.textContent = text;
        conversation.insertBefore(divider, typingIndicator);
    }

    if (continueFrom && continueFrom.exchanges.length > 0) {
        const oldDate = new Date(continueFrom.startTime * 1000).toLocaleString();
        insertDivider(t('continuing from {date}', { date: oldDate }));
        for (const ex of spokenExchanges(continueFrom.exchanges)) {
            if (ex.role === 'user' || ex.role === 'assistant') appendMessage(ex.role, ex.content);
        }
        insertDivider(t('resumed'));
    }

    if (setup.intention.trim()) {
        insertDivider(t('intention: {intention}', { intention: setup.intention }));
    }

    let busy = false;
    let muted = false;
    let listenLoopRunning = false;
    // Inside stt.start(): the recognizer is open and hearing the room.
    let sttCapturing = false;
    let torn = false;

    // Headphones in or out mid-session (iOS app): switch between talking over
    // the facilitator and the mic closing while it speaks.
    let unwatchHeadphones = (): void => {};
    let unmountVolumeNotice = (): void => {};
    void watchIosHeadphones((on) => {
        if (torn || on === iosHeadphonesOn) return;
        iosHeadphonesOn = on;
        rederiveListening();
        // Unplugged mid-reply: the open turn would hear the speaker. Close it
        // as for an unprompted line; the listen loop reopens it after playback.
        if (!continuousCapture && sttCapturing && (busy || ttsSpeakingDepth > 0)) void stt?.stop();
        diag(`[vad] iPhone headphones: ${on ? 'on' : 'off'}, barge-in ${engineDrivenBargeIn ? 'on' : 'off'}`);
    }).then((off) => {
        if (torn) off();
        else unwatchHeadphones = off;
    });

    // Capacitor App 'appStateChange' handle (mobile background-save); removed in
    // endSession. Held as the addListener promise so teardown can await + remove.
    let appStateListener: Promise<{ remove(): Promise<void> }> | null = null;
    // Smart check-ins: single-flight guard + how many have fired in the current
    // silence stretch (reset on any real user turn). Past the cap we stop paying
    // for LLM calls; auto-quit handles true walk-aways.
    let checkinInFlight = false;
    let smartCheckinStreak = 0;
    /** Consecutive [PASS] replies in this silence stretch. A user who asked for
     *  check-ins shouldn't get silence because the model keeps declining, so
     *  past the budget the next one speaks a canned line instead of asking. */
    let smartCheckinPasses = 0;
    /** What the next check-in event tells the model about this stretch
     *  (buildSmartCheckinEvent): how many check-ins were spoken, and how far
     *  into the silence the model last passed (null once anything is said). */
    let smartCheckinSpoken = 0;
    let smartCheckinPassedAtSec: number | null = null;
    /** Single-flight guard for the timer's approach/completion notices. */
    let timerNoticeInFlight = false;
    const SMART_CHECKIN_MAX_STREAK = 4;
    const SMART_CHECKIN_MAX_PASSES = 2;

    // ---- Check-in debug HUD --------------------------------------------
    // Dev tool: fixed monospace readout of [WAIT]/check-in traffic - active
    // modes, effective interval + countdown, rolling log of signals and
    // outcomes. Mounted via ?debug=checkin or the Developer setting (dev-mode.ts).
    const checkinDebug = isCheckinDebugOn();
    let debugPanel: HTMLElement | null = null;
    const debugLogLines: string[] = [];
    const debugT0 = Date.now();
    function debugLog(line: string): void {
        if (!checkinDebug) return;
        const t = Math.round((Date.now() - debugT0) / 1000);
        const mm = String(Math.floor(t / 60)).padStart(2, '0');
        const ss = String(t % 60).padStart(2, '0');
        debugLogLines.push(`${mm}:${ss} ${line}`);
        if (debugLogLines.length > 8) debugLogLines.shift();
        renderCheckinDebug();
    }
    function renderCheckinDebug(): void {
        if (!debugPanel) return;
        const over = pacing.hasCheckinOverride() ? ' (wait)' : '';
        // Hold state is otherwise invisible: the re-entry window is a timestamp
        // with no UI.
        const sinceHold = Date.now() - leftHoldAt;
        const hold = silenceMode
            ? 'held'
            : awaitingHoldConfirm
              ? 'awaiting confirm'
              : sinceHold < HOLD_REENTRY_GRACE_MS
                ? `re-entry ${Math.ceil((HOLD_REENTRY_GRACE_MS - sinceHold) / 1000)}s`
                : 'off';
        debugPanel.textContent = [
            `timing ${checkinTiming} · content ${checkinContent} · hold ${hold}`,
            `interval ${pacing.getCheckinInterval()}s${over} · next ${Math.round(
                pacing.getCheckinEtaSec()
            )}s · streak ${smartCheckinStreak}/${SMART_CHECKIN_MAX_STREAK} · pass ${smartCheckinPasses}/${SMART_CHECKIN_MAX_PASSES}`,
            ...debugLogLines,
        ].join('\n');
    }
    let debugTimer: ReturnType<typeof setInterval> | null = null;
    if (checkinDebug) {
        debugPanel = document.createElement('div');
        debugPanel.className = 'checkin-debug';
        root.appendChild(debugPanel);
        debugTimer = setInterval(renderCheckinDebug, 1000);
        renderCheckinDebug();
    }
    let silenceMode = false;
    // When the last hold ended, for the re-entry grace window below. 0 = never
    // held this session, which reads as "long ago" and needs no special case.
    let leftHoldAt = 0;
    // Require-confirm handshake for a model-initiated [HOLD] (rlgm). Small
    // models especially emit [HOLD] far too eagerly, often off a truncated
    // fragment, and going silent on that one token can strand the session. So a
    // [HOLD] is only a *bid*: the facilitator asks "shall I be quiet?" (per the
    // prompt) and we set this flag instead of going silent. The meditator's NEXT
    // utterance is judged by classifyHoldConfirm, not by a second [HOLD] from
    // the unreliable model, and only a clear yes enters the hold. The manual
    // listen button bypasses all of this: clicking it IS the confirmation.
    let awaitingHoldConfirm = false;
    // Wall-clock of the last USER activity (a completed turn), for the
    // auto-quit-after-silence timer. Facilitator check-ins must NOT reset it, or
    // they'd keep a forgotten session alive forever. Seeded at mount so a
    // session opened and abandoned still quits.
    let lastActivityAt = Date.now();
    // The current session recap, refreshed in the background on a throttle
    // (refreshSummaryThrottled). Persisted into autosaves so an interrupted
    // session still has a history label AND a cheap-resume seed. Seeded from a
    // resumed session's prior recap (not an intention standing in for one),
    // counting from the log the resume loaded; autosave falls back to the
    // intention.
    let currentSummary = continueFrom?.notesAreRecap ? continueFrom.notes : '';
    let summaryAtExchangeCount = currentSummary ? (session.state?.exchanges.length ?? 0) : 0;
    let summaryRefreshing = false;
    // Utterances spoken during a silence hold (see handleSilenceUtterance).
    // Cleared on entry to hold.
    let silenceBuffer: string[] = [];
    // True while the voice-picker modal is open: pause listening so the
    // mic doesn't transcribe a voice preview's own audio and "respond" to it.
    let voiceModalOpen = false;
    let scoredVoices: ScoredVoice[] = [];

    // Live in-session balance (opt-in; meditation-pal-14s), read off the shared
    // balance store every metered call feeds.
    let unsubscribeBalance: (() => void) | null = null;
    const balanceEl = root.querySelector<HTMLElement>('#session-balance');
    // Revealed only on a balance *drop*, i.e. once this session actually spends
    // credits: that keeps it hidden on local/BYOK/subscription sits without
    // predicting from the provider or voice. subscribeBalance doesn't fire on
    // subscribe, so nothing paints until a real spend arrives.
    if (balanceEl && appSettings.showSessionBalance && !getRetreatCovered()) {
        let prev = getKnownBalance();
        let revealed = false;
        unsubscribeBalance = subscribeBalance((b) => {
            if (b == null) {
                balanceEl.classList.add('hidden');
                revealed = false;
                prev = b;
                return;
            }
            if (!revealed && prev != null && b < prev) revealed = true;
            if (revealed) {
                // creditAmount already carries the ☁.
                balanceEl.textContent = creditAmount(b);
                balanceEl.classList.remove('hidden');
            }
            prev = b;
        });
    }

    // Shared by the three silence classifiers. A judge session puts Jev in front
    // of the utility-model call (on a hosted one the dev flag can demote it to
    // shadow or off); with no judge the LLM classifier is the only path.
    const classifierOptions: ClassifyResumeIntentOptions = {
        onUsage: (u) => session.recordLlmUsage(u),
    };
    function attachJudge(judge: RemoteJudge): void {
        classifierOptions.judge = judge;
        classifierOptions.judgeMode = jevMode === 'on' ? 'decide' : 'shadow';
        classifierOptions.onJudged = (report) => {
            // No utterance in the report, so this is safe in a console that bug
            // reports can carry; the tap pairs it with the adjacent classifier
            // event, which has the text.
            diag('[judge]', JSON.stringify(report));
            tapEvent('classifier', 'judge', { ...report });
        };
    }
    if (cloudJudge) attachJudge(cloudJudge);

    // The trouble check (core stepping-out.ts): on ordinary turns for the
    // models that need it, in a held silence for every session.
    const troubleOnTurns = wantsTroubleCheck(setup.provider, provider.model);
    interface TroubleAsk {
        text: string;
        verdict: Promise<boolean>;
        /** Null until the verdict is in. */
        settled: boolean | null;
        startedAt: number;
        cancel: () => void;
    }
    // What the check has been taking here, for the budget below: the quickest
    // of the last few, since one asked beside the resume classifier in a hold
    // queues behind it and reads long.
    const troubleTook: number[] = [];
    const troubleTypicalMs = (): number | null => (troubleTook.length ? Math.min(...troubleTook) : null);
    async function askTrouble(text: string, signal?: AbortSignal, timingOnly = false): Promise<boolean> {
        const t0 = Date.now();
        const troubled = await classifyTrouble(utilityProvider, text, {
            ...classifierOptions,
            ...(signal && { signal }),
        }).catch(() => false);
        if (signal?.aborted) return false;
        troubleTook.push(Date.now() - t0);
        if (troubleTook.length > 5) troubleTook.shift();
        tapCall('classify-trouble', Date.now() - t0);
        if (!timingOnly) tapEvent('classifier', 'trouble', { troubled, utterance: text });
        return troubled;
    }
    function trackTrouble(
        text: string,
        verdict: Promise<boolean>,
        startedAt: number,
        cancel: () => void
    ): TroubleAsk {
        const ask: TroubleAsk = { text, verdict, settled: null, startedAt, cancel };
        void verdict.then((v) => {
            ask.settled = v;
        });
        return ask;
    }
    // Asked while the recognizer waits out the pause, like the command judge,
    // so the verdict is usually in before the reply is requested.
    // Not for the two requests matched on the device: they never become a
    // turn, and on a meditator's own key each ask is theirs to pay for.
    const troublePrefetch = new UtterancePrefetch(askTrouble, undefined, (text) => !isMuteCommand(text) && !isEndCommand(text));
    /** The verdict for the utterance now being handled: one per utterance,
     *  whichever of the handlers asks first. */
    let troubleAsked: TroubleAsk | null = null;
    function troubleFor(text: string): TroubleAsk {
        if (troubleAsked?.text !== text) {
            const abort = new AbortController();
            troubleAsked = trackTrouble(text, askTrouble(text, abort.signal), Date.now(), () => abort.abort());
        }
        return troubleAsked;
    }
    /** A local session's check runs on the facilitator's own model, and Ollama
     *  takes the two calls one after the other: a check still out at submit is
     *  time in front of the reply (core stepping-out.ts, localCheckFits). Read
     *  at call time: turning voice commands on mid-session brings a judge. */
    const troubleContends = (): boolean =>
        provider instanceof OllamaProvider && utilityProvider === provider && !classifierOptions.judge;

    /** The info panel's "Off" row on a BYOK/local sit: say what turning it on
     *  sends where, then switch it on for this sit and the ones after. */
    async function offerVoiceCommands(): Promise<void> {
        if (!(await canReachJudge())) {
            await alertDialog(
                t(VOICE_COMMANDS_SIGN_IN)
            );
            return;
        }
        const ok = await confirmDialog(
            `<strong>${t('Voice commands')}</strong><p>${t('Say things like "set a timer for ten minutes" or "talk slower".')} ${t(VOICE_COMMANDS_CONSENT)}<br>${privacyPolicyLink()}</p>`,
            { okLabel: t('Turn on'), html: true }
        );
        if (!ok || torn || cloudJudge) return;
        void persistSettings({ voiceCommandsViaCloud: true });
        judgeAccess = 'opted-in';
        cloudJudge = new CloudJudge();
        cloudJudge.warm();
        commandPrefetch = new CommandPrefetch(cloudJudge, undefined, saidBefore);
        attachJudge(cloudJudge);
        builder.config.appControls = 'voice';
        // The system prompt is frozen once the opener has run; the model hears
        // about the change as a note instead.
        if (frozenSystemPrompt !== null) {
            session.queueSystemNote(appControlsChangeNote('voice'), 'setting');
        }
        tapEvent('note', 'voice-commands-enabled-mid-sit');
    }

    /** One-time "you can just say that" in the status line, after someone uses
     *  a control that has a command (voice-command-hints.ts). Only where the
     *  commands work. Whatever sets the status next replaces it, which is the
     *  right lifetime for a hint. */
    function hintVoiceCommand(id: VoiceHintId): void {
        if (torn) return;
        // The bare word "mute" needs no judge (isMuteCommand), so that hint is
        // true everywhere.
        if (cloudJudge || id === 'mute') {
            if (claimVoiceHint(id)) setStatus(t(VOICE_HINT_TEXT[id]));
        } else if (judgeAccess === 'off' && claimVoiceHint('enable')) {
            setStatus(t(VOICE_HINT_TEXT.enable));
        }
    }

    // ---- spoken commands (core voice-command.ts) ---------------------------
    // Judge sessions only (voice-commands.ts): it is the only thing that can tell
    // "slow down a little" from "everything is slowing down", and there is no LLM
    // twin to fall back on. Shadow mode leaves them on; it is about the classifiers.
    // Two need no judge and work everywhere: the bare "mute" and the plain
    // "end the session" with its yes/no (core mute-command.ts, end-command.ts).
    //
    // "End the session" is a bid, like [HOLD]: the app asks, and this flag routes
    // the NEXT utterance to classifyEndConfirm instead of a turn. It expires:
    // a "yes" to the facilitator five minutes later must not end the sit.
    const END_CONFIRM_WINDOW_MS = 45_000;
    let endConfirmUntil = 0;
    /** When the end question finished playing, for the [turn] line. */
    let endAskedAt = 0;
    // What a yes to the open question does. Plain "end the session" follows the
    // save-logs setting; "end without saving" / "end and save" override it for
    // this sit, the same two choices the End dialog offers by hand.
    let endConfirmSkipSave = false;

    /** A yes/no question has just been spoken (the end question, a hold bid):
     *  the Whisper engines take the next utterance as its answer (expectAnswer,
     *  voice-commands.md). A plain no ends the turn at once and a plain yes
     *  after a short pause, not the meditation turn's whole one; the browser's
     *  and the phones' recognizers end their turns themselves. */
    function listenForAnswer(): void {
        echoListener()?.expectAnswer(answerPace, END_CONFIRM_WINDOW_MS);
    }

    /** Supersede an in-flight reply so a command can speak. */
    function takeFloor(): void {
        if (!busy) return;
        ++turnGen;
        activeFullAbort?.abort();
        void tts.cancel();
        cutReply?.();
        // The superseded turn no longer owns the flag (see respondTo's finally).
        busy = false;
    }

    /** Say what a command did. Takes the floor if the facilitator is mid-reply
     *  (the same supersede respondTo does), records both sides so the model
     *  doesn't later read itself announcing a timer nobody asked for, and keeps
     *  a silence hold held - a command is not a call back. */
    async function speakCommandLine(userText: string, line: string): Promise<void> {
        takeFloor();
        showUserTurn(userText);
        session.addUserMessage(userText);
        await respondWithFacilitatorLine(line, 'command');
        restoreHoldAfterNotice('command');
    }

    function muteMicByVoice(userText: string, via: 'regex' | 'judge'): void {
        tapEvent('audio', 'mute-command', { text: userText, via });
        tapFlags({ muted: true });
        setMuted(true, 'voice');
    }

    /** Mic off first, so nothing said while the acknowledgment plays is heard.
     *  The spoken "Muted." is what makes a misfire noticeable with eyes shut:
     *  unmuting is button-only. */
    async function muteByVoice(userText: string): Promise<void> {
        muteMicByVoice(userText, 'regex');
        await speakCommandLine(userText, COMMAND_LINES.muted(sessionLanguageOf(sessionLanguage)));
    }

    /** Say the last facilitator line again. Off the record on both sides: the
     *  model already has the line once, and a transcript with it twice reads as
     *  a glitch. */
    async function repeatLastLine(userText: string): Promise<void> {
        // The ask is off the record too: its preview goes.
        preview.clear();
        const last = [...session.getContextMessages()].reverse().find((m) => m.role === 'assistant')?.content;
        if (!last) {
            await speakCommandLine(userText, COMMAND_LINES.nothingToRepeat(sessionLanguageOf(sessionLanguage)));
            return;
        }
        takeFloor();
        busy = true;
        tapFlags({ busy: true });
        tapEvent('note', 'command:repeat-spoken');
        setStatus(t('Speaking…'));
        try {
            await tts.speak(last, { rate: setup.ttsRate });
        } catch {
            /* non-fatal */
        } finally {
            busy = false;
            tapFlags({ busy: false });
            pacing.onResponseEnd();
            setStatus(idleStatus());
            restoreHoldAfterNotice('command');
        }
    }

    /** Move the pause-before-submit window a rung, live and for next time: it's
     *  the same preference the Settings "pause" preset holds ("it cuts me off"
     *  is rarely about one sit). Returns the line to say. */
    function adjustPause(direction: 'sooner' | 'longer'): string {
        const lang = sessionLanguageOf(sessionLanguage);
        if (!stt?.setPauseWindow) return COMMAND_LINES.pauseUnsupported(lang);
        const next = steppedPause(vadOpts.silenceBaseMs, direction);
        if (!next) return COMMAND_LINES[direction === 'sooner' ? 'soonest' : 'longest'](lang);
        // vadOpts too: a mid-session STT rebuild is constructed from it.
        vadOpts.silenceBaseMs = next.baseMs;
        vadOpts.silenceMaxMs = next.maxMs;
        stt.setPauseWindow(next.baseMs, next.maxMs);
        void persistSettings(
            providerStreams
                ? { silenceBaseMs: next.baseMs, silenceMaxMs: next.maxMs }
                : { nonStreamingSilenceBaseMs: next.baseMs, nonStreamingSilenceMaxMs: next.maxMs }
        );
        return COMMAND_LINES[direction === 'sooner' ? 'respondSooner' : 'waitLonger'](lang);
    }

    function setKasina(shown: boolean): void {
        if (kasinaToggle.checked === shown) return;
        kasinaToggle.checked = shown;
        kasinaToggle.dispatchEvent(new Event('change'));
    }

    function setThemeByVoice(theme: Theme | 'toggle'): Theme {
        const next = theme === 'toggle' ? toggleTheme() : setTheme(theme);
        const btn = document.querySelector<HTMLElement>('[data-theme-toggle]');
        if (btn) updateThemeIcon(btn);
        return next;
    }

    /** One command's effect. Returns what to say about it; `after` runs once
     *  that has been spoken (the speaker can't announce its own switching off
     *  after the fact, and the end question's window opens when it ends). */
    function applyCommand(
        command: VoiceCommandId,
        userText: string,
        lang: SessionLanguage
    ): { line: string; after?: () => void } {
        switch (command) {
            case 'slower':
            case 'faster': {
                const next = steppedRate(setup.ttsRate, command);
                if (next === null) return { line: COMMAND_LINES[command === 'slower' ? 'slowest' : 'fastest'](lang) };
                // Set first, so the acknowledgment is itself the demonstration.
                setup.ttsRate = next;
                updateVoicePickerLabel();
                return { line: COMMAND_LINES[command === 'slower' ? 'slower' : 'faster'](lang) };
            }
            case 'set_timer': {
                const req = parseTimerRequest(userText);
                if (!req) return { line: COMMAND_LINES.timerNoDuration(lang) };
                clockChangeByVoice = true;
                let line: string;
                if (req.relative && sessionClock.remainingSec() !== null) {
                    line = COMMAND_LINES.timerExtended(
                        lang,
                        sessionClock.extendTimer(
                            req.minutes,
                            timerApproachLeadSec(sessionClock.timerTotalSec() + req.minutes * 60, avgTurnSec())
                        )
                    );
                } else {
                    const armed = sessionClock.setTimer(req.minutes);
                    line = sessionClock.endsSessionOnComplete()
                        ? COMMAND_LINES.timerSetEnds(lang, armed)
                        : COMMAND_LINES.timerSet(lang, armed);
                }
                clockChangeByVoice = false;
                return { line };
            }
            case 'cancel_timer':
                return {
                    line: sessionClock.cancelTimer() ? COMMAND_LINES.timerCancelled(lang) : COMMAND_LINES.noTimer(lang),
                };
            case 'time_check': {
                const remaining = sessionClock.remainingSec();
                return {
                    line:
                        remaining !== null && remaining > 0
                            ? COMMAND_LINES.timeLeft(lang, Math.round(remaining / 60))
                            : COMMAND_LINES.timeElapsed(lang, Math.round(sessionClock.elapsedSec() / 60)),
                };
            }
            case 'respond_sooner':
                return { line: adjustPause('sooner') };
            case 'wait_longer':
                return { line: adjustPause('longer') };
            case 'mute':
                // Mic off before the line, so nothing said while it plays is heard.
                muteMicByVoice(userText, 'judge');
                return { line: COMMAND_LINES.muted(lang) };
            case 'mute_speaker':
                return { line: COMMAND_LINES.speakerOff(lang), after: () => setTtsEnabled(false) };
            case 'unmute_speaker':
                setTtsEnabled(true);
                return { line: COMMAND_LINES.speakerOn(lang) };
            case 'show_clock':
            case 'hide_clock': {
                clockChangeByVoice = true;
                sessionClock.setVisible(command === 'show_clock');
                clockChangeByVoice = false;
                const running = (sessionClock.remainingSec() ?? 0) > 0;
                return {
                    line:
                        command === 'show_clock'
                            ? COMMAND_LINES.clockShown(lang)
                            : running
                              ? COMMAND_LINES.clockHiddenTimerOn(lang)
                              : COMMAND_LINES.clockHidden(lang),
                };
            }
            case 'show_orb':
                setKasina(true);
                return { line: COMMAND_LINES.orbShown(lang) };
            case 'hide_orb':
                setKasina(false);
                return { line: COMMAND_LINES.orbHidden(lang) };
            case 'embers_on':
                setEmbersOn(true);
                return { line: COMMAND_LINES.embersOn(lang) };
            case 'embers_off':
                setEmbersOn(false);
                return { line: COMMAND_LINES.embersOff(lang) };
            case 'dark_mode':
            case 'light_mode':
            case 'toggle_theme': {
                const theme = setThemeByVoice(
                    command === 'dark_mode' ? 'dark' : command === 'light_mode' ? 'light' : 'toggle'
                );
                return { line: COMMAND_LINES[theme === 'dark' ? 'darkMode' : 'lightMode'](lang) };
            }
            case 'help':
                return { line: COMMAND_LINES.help(lang) };
            case 'end_session':
            case 'end_discard':
            case 'end_save': {
                const defaultSkip = !appSettings.saveSessionLogs;
                endConfirmSkipSave = command === 'end_discard' ? true : command === 'end_save' ? false : defaultSkip;
                // Saving only comes up in the question when it's not what would
                // have happened anyway.
                const line =
                    endConfirmSkipSave === defaultSkip
                        ? COMMAND_LINES.endConfirm(lang)
                        : endConfirmSkipSave
                          ? COMMAND_LINES.endDiscardConfirm(lang)
                          : COMMAND_LINES.endSaveConfirm(lang);
                // From the end of the question, not the start of speaking it.
                return {
                    line,
                    after: () => {
                        endAskedAt = Date.now();
                        endConfirmUntil = endAskedAt + END_CONFIRM_WINDOW_MS;
                        listenForAnswer();
                    },
                };
            }
            case 'repeat':
                // Its own path (repeatLastLine): it speaks off the record.
                return { line: '' };
        }
    }

    /** Carry out everything the utterance asked for (resolveCommands orders it)
     *  and say so once: "Okay, slower. Here's the orb." */
    async function runVoiceCommand(cmd: DetectedCommand, userText: string): Promise<void> {
        const lang = sessionLanguageOf(sessionLanguage);
        diag(
            '[command]',
            JSON.stringify({
                commands: cmd.commands,
                answers: cmd.answers,
                latencyMs: cmd.latencyMs,
                fromContext: cmd.fromContext ?? false,
            })
        );
        tapEvent('note', `command:${cmd.commands.join('+')}`, { answers: cmd.answers, utterance: userText });
        // A command in reply to "shall I be quiet?" isn't an answer to it.
        if (awaitingHoldConfirm) {
            awaitingHoldConfirm = false;
            tapFlags({ awaitingHoldConfirm: false });
        }
        lastActivityAt = Date.now();
        if (cmd.commands.length === 1 && cmd.commands[0] === 'repeat') {
            await repeatLastLine(userText);
            return;
        }
        const done = cmd.commands.map((c) => applyCommand(c, userText, lang));
        await speakCommandLine(userText, done.map((d) => d.line).filter(Boolean).join(' '));
        for (const d of done) d.after?.();
    }

    /** The reply to "Would you like to end the session now?". True when it was
     *  consumed here; false sends it on as an ordinary utterance. */
    async function handleEndConfirm(userText: string): Promise<boolean> {
        // A cough is no answer: the question stays open for the one that comes.
        if (isNonSpeechOnly(userText)) return false;
        endConfirmUntil = 0;
        const heardAfterMs = Date.now() - endAskedAt;
        // The judge reads the reply where there is one. A plain yes or no is
        // also recognized outright (core end-command.ts): all a sit without
        // the judge has, and what one whose judge failed falls back to.
        let verdict = cloudJudge ? await classifyEndConfirm(cloudJudge, userText) : 'other';
        const judged = verdict !== 'other';
        if (!judged) verdict = endConfirmReply(userText) ?? 'other';
        diag(
            `[turn] end-confirm: ${verdict} by ${judged ? 'judge' : 'words'}, ` +
                `${userText.length} chars, heard ${(heardAfterMs / 1000).toFixed(1)}s after the question`
        );
        tapEvent('note', `end-confirm:${verdict}`, { utterance: userText });
        if (torn) return true;
        if (verdict === 'yes') {
            showUserTurn(userText);
            // Same terms as the timer's close and the idle auto-quit: they asked
            // for this twice, so no dialog.
            await endSession(undefined, endConfirmSkipSave);
            return true;
        }
        if (verdict === 'no') {
            await speakCommandLine(userText, COMMAND_LINES.endDeclined(sessionLanguageOf(sessionLanguage)));
            return true;
        }
        return false;
    }

    // An utterance spoken while the facilitator holds silence. The meditator can
    // think out loud without the facilitator jumping in on every word: each
    // utterance is shown and buffered, and a lightweight classification (no
    // history) judges whether it means "I'm ready to continue." Only a yes exits
    // the hold and submits the whole buffer as the resume turn
    // (meditation-pal-k1yc). Check-ins are suppressed during a hold (pacing
    // returns Hold) and the listen loop awaits this, so there's no race with
    // respondTo / the check-in timer.
    async function handleSilenceUtterance(userText: string): Promise<void> {
        if (isNonSpeechOnly(userText)) return;
        showUserTurn(userText);
        silenceBuffer.push(userText);
        setStatus(t('Going quiet, one moment…'));
        const classifyStart = Date.now();
        // "I'm back" opening the utterance resumes with no classifier, which
        // loses it in a run-on sentence (core return-command.ts).
        const byWords = opensWithReturn(userText);
        // The resume classifiers hear a frightened line as thinking out loud
        // ("describing experience"), so the trouble check is asked beside them:
        // a meditator in trouble inside a hold gets the facilitator back.
        const [verdict, troubled] = await Promise.all([
            byWords
                ? ('resume' as const)
                : classifyResumeIntent(utilityProvider, userText, {
                      ...classifierOptions,
                      // Everything buffered in this hold before the utterance being judged.
                      judgeContext: { earlier: silenceBuffer.slice(0, -1) },
                  }),
            troubleFor(userText).verdict,
        ]);
        if (!byWords) tapCall('classify-resume', Date.now() - classifyStart);
        tapEvent('classifier', 'resume', { verdict, utterance: userText, ...(byWords && { by: 'words' }) });
        // The user may have toggled out of the hold (or the view torn down)
        // during the classifier round-trip; bail so we don't resurrect it.
        if (torn || !silenceMode) return;
        if (verdict === 'stay' && !troubled) {
            setStatus(holdingStatus());
            return;
        }
        // 'resume' (they asked to continue) or 'error' (the classifier call
        // itself failed, e.g. a provider 429). On 'error' we fail OPEN and leave
        // the hold: a silence with no voice escape is the worst outcome (a
        // quota-stalled session could otherwise never be resumed by speech,
        // ff1y), and the resumed turn surfaces any real provider failure through
        // the normal error banner instead of trapping the user in limbo.
        const joined = silenceBuffer.join(' ');
        silenceBuffer = [];
        // The buffered utterances' bubbles are already on screen. Each one was
        // checked as it was said, so the turn doesn't ask again.
        await respondTo(joined, { skipUserBubble: true, troubled });
    }

    // The meditator's reply to the facilitator's "shall I be quiet?" bid (see
    // awaitingHoldConfirm, rlgm): a clear yes enters the hold; a no (or a
    // classifier error, or the user carrying on after an eager mis-bid) runs as
    // a normal turn. Awaited by the listen loop, so no race with the check-in
    // timer.
    async function handleHoldConfirm(userText: string): Promise<void> {
        if (isNonSpeechOnly(userText)) return;
        awaitingHoldConfirm = false;
        tapFlags({ awaitingHoldConfirm: false });
        const confirmStart = Date.now();
        const confirmed = await classifyHoldConfirm(utilityProvider, userText, classifierOptions);
        tapCall('classify-confirm', Date.now() - confirmStart);
        tapEvent('classifier', 'hold-confirm', { confirmed, utterance: userText });
        if (torn) return;
        if (confirmed) {
            // Show their "yes" and begin the silence. The reply isn't recorded
            // as a meditation turn: enterHold resets the buffer, and the next
            // thing they say is what gets buffered for the resume.
            showUserTurn(userText);
            enterHold();
        } else {
            // Not a yes: an ordinary turn. Also the graceful exit for an eager
            // mis-bid - they kept talking, so we keep going.
            await respondTo(userText);
        }
    }

    // An utterance in the window just after a hold ended. The app already knows
    // a silence just broke - the model doesn't - so it decides here rather than
    // asking for a reply and then talking over it (tv9u). A yes speaks one
    // canned line and drops straight back under, skipping both the facilitation
    // turn and the "shall I be quiet?" handshake: the meditator confirmed that
    // once already, and they're usually only back here because the resume
    // classifier misread them. Anything else runs as an ordinary turn.
    async function handleReHoldRequest(userText: string): Promise<void> {
        if (isNonSpeechOnly(userText)) return;
        const reholdStart = Date.now();
        const asking = await classifyHoldRequest(utilityProvider, userText, classifierOptions);
        tapCall('classify-rehold', Date.now() - reholdStart);
        tapEvent('classifier', 'rehold', { asking, utterance: userText });
        if (torn) return;
        if (!asking) {
            await respondTo(userText);
            return;
        }
        // Recorded, unlike the hold-confirm yes: the canned line goes into
        // history, so without the request the model later reads itself saying
        // "going quiet" with nothing that asked for it.
        showUserTurn(userText);
        session.addUserMessage(userText);
        await respondWithFacilitatorLine(builder.getHoldReentryLine(), 'reentry');
        if (torn) return;
        enterHold();
    }

    async function respondTo(
        userText: string,
        /** `troubled`: the trouble check's verdict when the caller already has
         *  it (a hold); left out, the turn asks for itself where it should. */
        opts: { skipUserBubble?: boolean; troubled?: boolean } = {}
    ): Promise<void> {
        // Drop transcriptions that are only non-speech markers ("[cough]",
        // "[BLANK_AUDIO]", "(wind blowing)", "*sighs*") or carry no words: a
        // cough or background noise shouldn't take the user's turn or wake us
        // from a silence hold. (The listen loop already cleared the partial.)
        if (isNonSpeechOnly(userText)) return;
        // Supersede any in-flight turn: bump the generation, stop the previous
        // turn generating (it bails without recording), and cut its audio. With
        // continuous capture this is how an interrupting utterance takes over.
        const myGen = ++turnGen;
        // For logcat: tells a real barge-in from an un-caught echo cutting a
        // reply short.
        if (busy) diag(`[turn] interrupting in-flight reply (${userText.length} chars)`);
        activeFullAbort?.abort();
        void tts.cancel();
        // Before this turn's words go into the log behind it.
        cutReply?.();
        const myFullAbort = new AbortController();
        const myTtsAbort = new AbortController();
        activeFullAbort = myFullAbort;
        activeTtsAbort = myTtsAbort;
        // True once a newer turn (or teardown) has taken over; we bail silently
        // at each such point so the live turn owns the transcript + dots.
        const superseded = (): boolean => torn || myGen !== turnGen;
        // If the user just spoke to break a silence hold, a [HOLD] in the reply
        // shouldn't bid to go straight back under on the same turn - it reads
        // as "I can't get out of silence mode."
        const wasSilent = silenceMode;
        // aloud cloud is the convenience path: its glitches are smoothed over
        // in the chair and logged for the operator (cloud-incidents.ts).
        const cloudSmooth = setup.provider === 'aloud';
        busy = true;
        tapFlags({ busy: true });
        // Hoisted so the catch can discard a partially revealed bubble when the
        // stream dies mid-reply (the reply never reaches history).
        let reveal: ReturnType<typeof createAssistantReveal> | null = null;
        try {
            pacing.onSpeechEnd();
            pacing.onTranscription();
            smartCheckinStreak = 0;
            smartCheckinPasses = 0;
            smartCheckinSpoken = 0;
            smartCheckinPassedAtSec = null;
            if (silenceMode) exitHold();
            // On a resume from silence the buffered utterances are already on
            // screen (and tapped); only the joined text goes into history.
            if (!opts.skipUserBubble) showUserTurn(userText);
            session.addUserMessage(userText);
            // The trouble check never stands in front of the reply. A verdict
            // already in (prefetched during the pause, or from the hold) is
            // acted on here; one still out runs beside the reply and holds
            // only its first words, briefly (troubleStillOut, below).
            let troubleAsk: TroubleAsk | null = null;
            if (opts.troubled === undefined && troubleOnTurns) {
                const had = troubleAsked?.text === userText ? troubleAsked : null;
                // A prefetched verdict that came in during the pause is only
                // marked settled a tick after it is handed over here. Without
                // this it read as still out: the reply was requested without
                // the note, then called off and asked for again with it.
                if (had && had.settled === null) await Promise.race([had.verdict, Promise.resolve()]);
                if (superseded()) return;
                if (had && had.settled !== null) {
                    troubleAsk = had;
                } else if (
                    !troubleContends() ||
                    localCheckFits(troubleTypicalMs(), had ? Date.now() - had.startedAt : 0)
                ) {
                    troubleAsk = had ?? troubleFor(userText);
                } else {
                    // Too slow on this machine to stand in front of a reply.
                    had?.cancel();
                    tapEvent('note', 'stepping-out', { when: 'skipped-slow', typicalMs: troubleTypicalMs() });
                }
            }
            let troubled = opts.troubled === true || troubleAsk?.settled === true;
            if (troubled) {
                session.appendSystemNote(STEPPING_OUT_NOTE, 'trouble');
                tapEvent('note', 'stepping-out', { when: 'before-reply' });
            }
            const troubleStillOut = troubleAsk?.settled === null ? troubleAsk.verdict : null;
            // Dots the instant we submit, before any network round-trip, so the
            // user sees their turn was received.
            showTyping();
            setStatus(t('Thinking…'));

            // Ollama: surface a not-yet-loaded model next to the dots so the
            // user knows why the first response is slow. One cheap HTTP call.
            if (provider instanceof OllamaProvider) {
                setFacilitatorHint(await provider.coldLoadMessage());
            }
            if (superseded()) return;

            const system = systemPrompt();
            // Streaming + sentence-chunked TTS, falling back to non-streaming
            // when the provider has no completeStream: the first sentence starts
            // speaking before the rest finishes generating. Two signals, so a
            // barge-in can hush the audio (ttsSignal) and keep the reply's
            // signals and what was heard, while a newer turn aborts outright
            // (signal).
            // onSpeakStart fires with control tokens already stripped; status
            // stays "Thinking…" until a sentence actually speaks.
            armSlowResponseStatus();
            let bubble = createAssistantReveal();
            reveal = bubble;
            const turnStart = Date.now();
            const attemptCompletion = (
                target: typeof bubble,
                gated?: { signal: AbortSignal; speakGate: () => Promise<boolean> }
            ) => {
                const messages = session.getContextMessages();
                const signal = gated?.signal ?? myFullAbort.signal;
                return facilitationRequest(
                    messages,
                    system,
                    () =>
                        streamCompletionWithChunkedTts(provider, tts, messages, {
                            system,
                            ttsOptions: { rate: setup.ttsRate },
                            wholeReply: replyWhole(),
                            onTtsError: handleTtsError,
                            signal,
                            ttsSignal: myTtsAbort.signal,
                            ...(gated && { speakGate: gated.speakGate }),
                            onSpeakStart: (sentence) => {
                                if (!superseded()) {
                                    clearSlowResponseStatus();
                                    setStatus(t('Speaking…'));
                                    target.reveal(sentence);
                                }
                            },
                        }),
                    // A paused account's canned turn never reached a model.
                    (r) => !signal.aborted && r.finishReason !== BILLING_PAUSED_FINISH
                );
            };
            let completion: Awaited<ReturnType<typeof attemptCompletion>> | null = null;
            if (troubleStillOut) {
                // The reply is asked for now and the verdict is awaited beside
                // it. Nothing is spoken until the verdict is in or the grace
                // runs out, whichever is first; a yes in time stops this reply
                // and asks again with the note. A yes that arrives after the
                // grace is too late to act on: the reply is already being heard.
                const firstAbort = new AbortController();
                const stopFirst = (): void => firstAbort.abort();
                myFullAbort.signal.addEventListener('abort', stopFirst, { once: true });
                let decided: Promise<boolean> | null = null;
                const decide = (yes: boolean): boolean => {
                    if (yes) {
                        troubled = true;
                        stopFirst();
                    }
                    return yes;
                };
                const verdictInTime = (): Promise<boolean> =>
                    (decided ??= Promise.race([
                        troubleStillOut,
                        sleep(TROUBLE_GRACE_MS).then(() => false),
                    ]).then(decide));
                void troubleStillOut.then((yes) => {
                    if (!yes) return;
                    if (decided === null) decided = Promise.resolve(decide(true));
                    else if (!troubled) tapEvent('note', 'stepping-out', { when: 'too-late' });
                });
                try {
                    completion = await attemptCompletion(bubble, {
                        signal: firstAbort.signal,
                        speakGate: async () => !(await verdictInTime()),
                    });
                } catch (err) {
                    // Stopping the reply mid-stream surfaces as an abort.
                    if (!troubled || superseded()) throw err;
                }
                if (superseded()) {
                    bubble.discard();
                    return;
                }
                // A reply that ended before any of it was ready to speak never
                // asked the gate.
                if (!troubled) await verdictInTime();
                if (superseded()) {
                    bubble.discard();
                    return;
                }
                if (troubled) {
                    session.appendSystemNote(STEPPING_OUT_NOTE, 'trouble');
                    tapEvent('note', 'stepping-out', { when: 'replaced-reply' });
                    bubble.discard();
                    bubble = createAssistantReveal();
                    reveal = bubble;
                    completion = null;
                }
            }
            let { text: rawText, ttsDone, usage, finishReason, heard } =
                completion ?? (await attemptCompletion(bubble));
            if (superseded()) {
                bubble.discard();
                return;
            }
            // A completion with NO text at all is a glitch, not a reply: some
            // endpoints intermittently burn the whole budget on a hidden
            // thinking preamble (Kimi K2, finish "length", meditation-pal-yi02).
            // One quiet retry before anything is said or shown; the dots stay
            // up, so from the chair it is just a slower turn. Cloud only: a
            // local/BYOK user owns that setup and should see its failures as
            // they happen. Not after a safety-classifier refusal: the same
            // prompt mostly draws the same decline, and where the model has a
            // fallback the server already tried it (anthropic.ts
            // takesRefusalFallback), so a retry only adds dead air. A reply
            // that was only the model's reasoning is blank too: it was never
            // spoken (streaming-tts.ts) and is never stored.
            const firstReasoning = parseTurnSignals(rawText).reasoning;
            if (
                cloudSmooth &&
                (!rawText.trim() || firstReasoning) &&
                finishReason !== BILLING_PAUSED_FINISH &&
                finishReason !== 'refusal'
            ) {
                console.warn(
                    `[turn] empty completion finish=${finishReason ?? 'null'} raw=${rawText.length} chars${firstReasoning ? ' of reasoning' : ''} - retrying once`
                );
                tapEvent('error', 'empty-completion-retry', {
                    finish: finishReason ?? 'null',
                    ...(firstReasoning && { reasoning: true }),
                });
                reportCloudIncident('client_llm_empty_retry', {
                    detail: `finish=${finishReason ?? 'null'}${firstReasoning ? ' reasoning' : ''}`,
                    model: setup.model,
                });
                bubble.discard();
                bubble = createAssistantReveal();
                reveal = bubble;
                ({ text: rawText, ttsDone, usage, finishReason, heard } = await attemptCompletion(bubble));
                if (superseded()) {
                    bubble.discard();
                    return;
                }
            }
            clearSlowResponseStatus();
            const turnLatencyMs = Date.now() - turnStart;
            tapCall('turn', turnLatencyMs);
            const { hold, stage, waitSec, cleanText, reasoning } = parseTurnSignals(rawText);
            // A soft-launch-pause canned turn (proxy spoke a graceful apology,
            // charged nothing): show it transiently but keep it OUT of session
            // history/logs so we resume from the last real turn. No buy prompt
            // and no silence mode - a top-up can't lift the pause.
            const ephemeral = finishReason === BILLING_PAUSED_FINISH;
            // Staged modes: apply the LLM's movement signal (clamped at the ends
            // of the arc) and persist the new phase for resume.
            if (stager && !ephemeral && stage !== 'none') {
                if (stager.apply(stage)) {
                    session.setModePhase(stager.phase.id);
                    session.queueSystemNote(stager.phaseNote(), 'phase');
                    tapEvent('stage', stage, { phase: stager.phase.id });
                    tapFlags({ phase: stager.phase.id });
                    setPhaseHint();
                } else {
                    tapEvent('stage', 'clamped', { signal: stage, phase: stager.phase.id });
                }
            }
            // Smart timing: [WAIT:Nm] sets when the next check-in may fire
            // (sticky across turns, clamped by the controller).
            if (!ephemeral && waitSec !== null) {
                if (checkinTiming === 'smart') {
                    pacing.setCheckinInterval(waitSec);
                    tapEvent('signal', 'wait', {
                        requestedSec: waitSec,
                        effectiveSec: pacing.getCheckinInterval(),
                    });
                    debugLog(`turn [WAIT] ${waitSec}s → interval ${pacing.getCheckinInterval()}s`);
                } else {
                    tapEvent('signal', 'wait-ignored', { requestedSec: waitSec });
                    debugLog(`turn [WAIT] ${waitSec}s ignored (timing ${checkinTiming})`);
                }
            }
            // An empty cleanText is never recorded or spoken as a turn, whether
            // the completion was blank or carried only control tokens
            // ("[WAIT:8m]", a bare "[HOLD]": rawText non-empty, cleanText empty
            // once parseTurnSignals strips it). The signals above are already
            // applied, so the model's intent still lands. A bare [HOLD] must
            // NOT arm awaitingHoldConfirm (set further down, past this bail):
            // no question was asked, so the meditator's next words are a
            // normal turn, not an answer. (meditation-pal-9era)
            if (!ephemeral && !cleanText.trim()) {
                if (rawText.trim() && !reasoning) {
                    // The model chose to say nothing beyond its signals. That
                    // is a legitimate turn shape (a bare "[WAIT:8m]" after
                    // someone says they want to sit quietly), so go back to
                    // listening with no reply and no complaint.
                    tapEvent('signal', 'signal-only-reply', { raw: rawText });
                    bubble.discard();
                    hideTyping();
                    pacing.onResponseEnd();
                    setStatus(idleStatus());
                    return;
                }
                // finishReason is the one clue to WHY a completion came back
                // blank ("length" = budget eaten, "error" = upstream failed,
                // null = the stream ended without a done chunk); keep it in
                // the device log (meditation-pal-yi02).
                console.warn(
                    `[turn] empty completion finish=${finishReason ?? 'null'} raw=${rawText.length} chars${reasoning ? ' of reasoning' : ''}`
                );
                if (!cloudSmooth) {
                    throw new Error(
                        t('The model returned an empty response. Try again, or check your provider in Settings.')
                    );
                }
                // aloud cloud, blank twice running: the meditator gets a short
                // canned acknowledgement in the facilitator's voice rather than
                // an error toast - their words shouldn't land in dead air, and
                // the next turn is a fresh request anyway. The operator sees
                // it in the admin incident log instead.
                tapEvent('error', 'empty-completion-fallback', {
                    finish: finishReason ?? 'null',
                    ...(reasoning && { reasoning: true }),
                });
                reportCloudIncident('client_llm_empty_fallback', {
                    detail: `finish=${finishReason ?? 'null'}${reasoning ? ' reasoning' : ''}`,
                    model: setup.model,
                });
                const pool = localizePool(EMPTY_REPLY_FALLBACKS, sessionLanguageOf(sessionLanguage));
                const line = pool[Math.floor(Math.random() * pool.length)]!;
                session.addAssistantMessage(line, undefined, usage);
                bubble.anchor();
                setStatus(t('Speaking…'));
                bubble.reveal(line);
                try {
                    await tts.speak(line, { rate: setup.ttsRate });
                } catch (err) {
                    handleTtsError(err as Error);
                }
                bubble.finalize(line);
                tapTurn('assistant', 'reply', line, { raw: '', latencyMs: Date.now() - turnStart });
                if (superseded()) return;
                pacing.onResponseEnd();
                setStatus(idleStatus());
                return;
            }
            if (!ephemeral) session.addAssistantMessage(cleanText, undefined, usage);
            // Claim the bubble's transcript spot now (still hidden if nothing
            // has been spoken), so a turn that supersedes us mid-playback can't
            // end up ordered above this reply.
            bubble.anchor();
            const settleReply = ephemeral ? () => cleanText : watchReply(cleanText, heard);

            // Let in-flight TTS chunks finish so the next turn doesn't pile on.
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            // The bubble ends up showing what history holds: the whole reply
            // (TTS failure and muted voice included), or what was heard of one
            // that was cut off.
            const said = settleReply();
            if (said.trim()) {
                bubble.finalize(said);
                tapTurn('assistant', 'reply', said, { raw: rawText, latencyMs: turnLatencyMs });
            } else {
                bubble.discard();
                if (!superseded()) hideTyping();
            }
            if (superseded()) return;
            // A [HOLD] is only a bid (see awaitingHoldConfirm, rlgm): the
            // meditator's next utterance is classified for a yes. Ignored
            // entirely when silenceModeEnabled is false. (Re-entry right after
            // a hold never reaches here: handleReHoldRequest takes that turn
            // before the model is asked for a reply.)
            // Nor one whose reply was cut off: the question it asks comes last.
            let bid =
                !ephemeral && !wasSilent && hold && pacingConfig.silenceModeEnabled && said === cleanText;
            // A bid made in answer to someone frightened or in danger is not
            // one. Models reach for [HOLD] as "I am stopping the meditation"
            // (Haiku 5.5 on "I don't think I want to be alive anymore", 1 try
            // in 3), and the next thing said would be read for a yes: "yes"
            // to "are you safe right now?" would begin a silence. Checked on
            // every model, since a bid is rare and this is the costly miss.
            if (bid && (troubled || (await troubleFor(userText).verdict))) {
                bid = false;
                tapEvent('note', 'stepping-out', { when: 'hold-bid-dropped' });
            }
            if (superseded()) return;
            awaitingHoldConfirm = bid;
            if (bid) listenForAnswer();
            tapFlags({ awaitingHoldConfirm });
            if (hold) tapEvent('signal', awaitingHoldConfirm ? 'hold-bid' : 'hold-bid-ignored');
            setStatus(idleStatus());
            pacing.onResponseEnd();
        } catch (err) {
            // The reply never made it into history: drop any partially revealed
            // bubble so the transcript matches what's recorded.
            reveal?.discard();
            if (superseded()) return;
            clearSlowResponseStatus();
            hideTyping();
            const msg = (err as Error).message;
            tapEvent('error', 'turn-failed', { message: msg });
            // 402s are already logged server-side; everything else that fails a
            // cloud turn in the app (timeouts, network, upstream) goes to the
            // operator's incident log.
            if (cloudSmooth && !isOutOfCredits(msg)) {
                reportCloudIncident('client_llm_error', { detail: msg, model: setup.model });
            }
            // Running out of credits is a graceful stop, not an error: the
            // ephemeral apology (appendBillingApology), voiced via the free
            // canned endpoint. (meditation-pal-44o, meditation-pal-4l5)
            if (isOutOfCredits(msg)) {
                apologizeOutOfCredits();
            } else if (/claude_proxy_stalled/.test(msg)) {
                // The local Claude CLI failed across all retries (see
                // ClaudeProxyHttpProvider). First rule out a *removed* model:
                // swap to the nearest peer rather than apologize for a model
                // that will never answer.
                const swapped = await tryFallbackSubscriptionModel();
                if (!swapped) {
                    // Spoken apology stays non-technical (facilitator's voice,
                    // local TTS so it works offline); the toast names the cause
                    // when the CLI gave an actionable one - retrying can't fix
                    // a spent usage limit or an expired login.
                    const limit = /usage limit|rate limit/i.test(msg);
                    const auth = /oauth|authentication|api key|log ?in/i.test(msg);
                    const apologies = localizePool(CLAUDE_STALLED_APOLOGIES, sessionLanguageOf(sessionLanguage));
                    const apology = apologies[limit ? 0 : 1]!;
                    showErrorToast(
                        limit
                            ? t('Claude subscription usage limit reached. It resets after a few hours, or pick another model in Settings.')
                            : auth
                              ? t('Claude sign-in expired. Run `claude` in a terminal to log in again.')
                              : apology
                    );
                    void tts.speak(apology, { rate: setup.ttsRate });
                }
            } else {
                // Other failures: a toast is more visible than the small status
                // line, and the loop resumes listening so nothing is wedged. A
                // dropped connection (already re-sent for a while, net-retry.ts)
                // says so plainly: the words are in history, so the next turn
                // answers them too.
                showErrorToast(
                    describeCloudError(msg) ??
                        (isConnectionFailure(msg)
                            ? t("The connection dropped before the reply came back. What you said is kept - carry on when you're ready.")
                            : t('Something went wrong: {msg}', { msg }))
                );
            }
            setStatus(idleStatus());
            // Reset the check-in clock like the success path does, or a long
            // failed turn leaves a stale timestamp and the next poll fires a
            // check-in right on top of the error apology.
            pacing.onResponseEnd();
        } finally {
            // Only the latest turn owns the shared flags: a superseded turn
            // unwinding later must not clear the busy/abort state the live one
            // set, or it would re-open the gate mid-response.
            if (myGen === turnGen) {
                busy = false;
                tapFlags({ busy: false });
                activeFullAbort = null;
                activeTtsAbort = null;
            }
            // A completed user turn is the activity signal for auto-quit, and
            // the sample the timer's approach notice sizes itself against.
            lastActivityAt = Date.now();
            signInNudge = false;
            recordTurnGap();
            // Every round, failed ones included (see autosaveSession).
            void autosaveSession();
        }
    }

    /**
     * Always-on listening loop: one STT utterance per iteration, dispatched
     * when speech ends.
     *
     * With continuous capture (see `continuousCapture`, meditation-pal-57gl)
     * the loop never pauses while the facilitator thinks or speaks: a barge-in
     * hushes the facilitator, and an utterance landing during a response
     * supersedes it in respondTo, so the response isn't awaited here. Other
     * backends (web-speech, capacitor) would transcribe the facilitator's own
     * TTS, so they pause while `busy`.
     */
    async function listenLoop(): Promise<void> {
        if (!stt || listenLoopRunning) return;
        listenLoopRunning = true;
        // Toast a mic error only when it first appears (the loop re-checks every
        // 2s) so a persistent fault doesn't spam; reset on a successful capture
        // so a later recurrence surfaces again.
        let lastMicErrorToast: string | null = null;
        try {
            while (!torn && !muted) {
                // Always pause for the voice-picker modal and for the opening
                // sound, which a mic with a cold echo canceller hears at full
                // strength (and its voices are vowels: it starts a turn). Pause
                // for `busy` only on backends that can't capture during
                // playback.
                while (
                    (voiceModalOpen ||
                        openingSounding ||
                        (!continuousCapture && (busy || ttsSpeakingDepth > 0))) &&
                    !torn &&
                    !muted
                ) {
                    await sleep(100);
                }
                // Then let the last of the facilitator's audio die away before
                // reopening the mic - the acoustic half of the echo guard, and
                // the only half that works when the recognizer mangles what it
                // leaked (meditation-pal-oxmt). See micReopensAfterMs.
                while (micReopensAfterMs() > 0 && !continuousCapture && !torn && !muted) {
                    const since = Date.now() - lastTtsEndedAt;
                    if (ttsSpeakingDepth === 0 && since >= micReopensAfterMs()) break;
                    await sleep(Math.max(50, micReopensAfterMs() - since));
                }
                if (torn || muted) break;
                // The last turn was dispatched without a bubble of its own.
                preview.clear();

                const cycleStart = Date.now();
                let finalText = '';
                // Engine-reported "speech began while TTS was playing", the
                // authoritative echo signal. undefined on engines that don't
                // report it; the guard then falls back to the arrival window.
                let finalStartedDuringTts: boolean | undefined;
                let micError: string | null = null;
                // micError came from a lost connection (stt-errors.ts), not the
                // recognizer or the mic.
                let micErrorIsConnection = false;
                // Echo test: did the utterance start during playback (or, absent
                // that signal, land near it), AND does it read as a verbatim run
                // of the recently synthesized text?
                const isEcho = (text: string, startedDuringTts: boolean | undefined): boolean =>
                    (startedDuringTts ?? inEchoWindow()) && looksLikeTtsEcho(text, spokenTail);
                // The preview takes less convincing than the turn does.
                const previewIsEcho = (text: string, startedDuringTts: boolean | undefined): boolean =>
                    (startedDuringTts ?? inEchoWindow()) &&
                    previewLooksLikeTtsEcho(text, spokenTail);
                try {
                    sttCapturing = true;
                    // Its onset buffer kept listening through the reply, which
                    // is the facilitator, not the start of this turn.
                    if (!continuousCapture && stt instanceof WhisperPcmSttEngine) {
                        stt.keepOnsetTail(Date.now() - lastTtsEndedAt - PLAYBACK_TAIL_MS);
                        // Playback is over, but the echo gate's hangover outlasts
                        // the cooldown: left on, the turn opens at the bar for
                        // speech over the facilitator (0.1 after the greeting),
                        // and a short word said then never starts a turn.
                        stt.setTtsActive(false);
                    }
                    for await (const event of stt.start()) {
                        if (event.type === 'partial') {
                            // Don't preview our own echo as the user's words: a
                            // partial bubble showing the facilitator's sentence
                            // breaks immersion even when the final is dropped.
                            // Non-speech markers ("[NOISES]") show nothing.
                            const echo = previewIsEcho(event.text, event.startedDuringTts);
                            preview.partial(event.text, echo);
                            if (echo || isNonSpeechOnly(event.text)) continue;
                            commandPrefetch?.note(event.text);
                            if (troubleOnTurns || silenceMode) troublePrefetch.note(event.text);
                        } else if (event.type === 'final') {
                            finalText = event.text;
                            finalStartedDuringTts = event.startedDuringTts;
                            // Billable server-side STT compute (Whisper) reports
                            // audio seconds; on-device engines omit it.
                            if (event.seconds) session.recordStt(event.seconds);
                        } else if (event.type === 'error') {
                            micError = describeSttError(event.error);
                            // Hosted STT failures reach the operator's incident
                            // log; device recognizers are the user's own.
                            const sttMsg = event.error instanceof Error ? event.error.message : String(event.error);
                            micErrorIsConnection = sttMsg === 'network-lost' || isConnectionFailure(sttMsg);
                            if (/Whisper endpoint (?!402)/.test(sttMsg)) {
                                reportCloudIncident('client_stt_error', { detail: sttMsg });
                            }
                        }
                    }
                } catch (err) {
                    micError = describeSttError(err);
                    micErrorIsConnection = isConnectionFailure(err instanceof Error ? err.message : String(err));
                } finally {
                    sttCapturing = false;
                }
                // Transcript-level echo guard (meditation-pal-p8lx): our own TTS
                // leaking back through the mic must not take a turn, wake a
                // silence hold, answer a hold-confirm question, or read as a
                // request to go back under. One choke point covering every
                // dispatch path below.
                if (finalText.trim() && isEcho(finalText.trim(), finalStartedDuringTts)) {
                    diag(`[echo-guard] dropped TTS echo (${finalText.trim().length} chars)`);
                    tapEvent('audio', 'echo-dropped', { text: finalText.trim() });
                    finalText = '';
                }
                // A turn to dispatch keeps its preview up until showUserTurn
                // replaces it: dispatch can wait on the command judge first.
                preview.final(!torn && !muted && !voiceModalOpen && !isNonSpeechOnly(finalText));
                if (torn || muted) break;
                // The voice modal opened mid-capture: discard what was heard
                // (likely a preview) and wait it out.
                if (voiceModalOpen) continue;

                if (finalText.trim()) {
                    lastMicErrorToast = null;
                    clearSttTrouble();
                    const text = finalText.trim();
                    tapEvent('stt', 'final', { text });
                    // "mute" outranks every route below, silence mode included:
                    // it's the one thing you say when you want the app to stop
                    // hearing you, so it must not become a turn or wake a hold.
                    // The bare word is matched here with no judge, so it works
                    // on every provider and offline; natural phrasings ("turn
                    // off the mic") come through the command judge just below.
                    if (isMuteCommand(text)) {
                        await muteByVoice(text);
                        break;
                    }
                    // Commands come next and also outrank the silence routes: a
                    // timer set from inside a hold must not end it, and "end the
                    // session" must not be buffered as think-out-loud.
                    // Taken even when unused below, so a verdict never
                    // outlives the utterance it was asked about.
                    const early = commandPrefetch?.take(text) ?? null;
                    const earlyTrouble = troublePrefetch.takeAsk(text);
                    troubleAsked = earlyTrouble
                        ? trackTrouble(text, earlyTrouble.result, earlyTrouble.startedAt, earlyTrouble.cancel)
                        : null;
                    if (Date.now() < endConfirmUntil) {
                        // The open end question takes the reply, judge or not.
                        if (await handleEndConfirm(text)) continue;
                    } else {
                        let cmd: DetectedCommand | null = null;
                        if (cloudJudge) {
                            if (early) tapEvent('note', 'command:prefetched');
                            cmd = await (early ?? detectVoiceCommand(cloudJudge, text, saidBefore()));
                            if (torn || muted) break;
                        }
                        // The plain request to end is matched outright (core
                        // end-command.ts), so a sit with no judge can still be
                        // left by voice, and one whose judge is down or missed
                        // it is not stuck either. Still only a bid: it asks.
                        if (!cmd && isEndCommand(text)) {
                            tapEvent('note', 'command:end-matched-locally', { judge: Boolean(cloudJudge) });
                            cmd = { command: 'end_session', commands: ['end_session'], answers: {}, latencyMs: 0 };
                        }
                        if (cmd) {
                            await runVoiceCommand(cmd, text);
                            if (torn || muted) break;
                            continue;
                        }
                    }
                    // Precedence between the silence handlers lives in
                    // routeUtterance, where it can be tested without a mic.
                    const route = routeUtterance({
                        silenceMode,
                        awaitingHoldConfirm,
                        silenceModeEnabled: pacingConfig.silenceModeEnabled,
                        msSinceHoldEnded: Date.now() - leftHoldAt,
                    });
                    tapEvent('note', `route:${route}`);
                    switch (route) {
                        case 'silence':
                            await handleSilenceUtterance(text);
                            break;
                        case 'hold-confirm':
                            await handleHoldConfirm(text);
                            break;
                        case 'rehold':
                            await handleReHoldRequest(text);
                            break;
                        case 'normal':
                            if (continuousCapture) {
                                // Don't block the mic on the response; keep
                                // capturing so an interrupting utterance is
                                // caught. respondTo supersedes any in-flight
                                // turn itself.
                                void respondTo(text);
                            } else {
                                await respondTo(text);
                            }
                            break;
                    }
                } else if (micError) {
                    tapEvent('stt', 'error', { message: micError });
                    setStatus(micError);
                    if (micError !== lastMicErrorToast) {
                        showErrorToast(micError);
                        lastMicErrorToast = micError;
                    }
                    noteSttFailure(micErrorIsConnection);
                    // Brief backoff so a broken mic doesn't tight-loop us.
                    await sleep(2000);
                } else if (Date.now() - cycleStart < 1000) {
                    // Empty capture that also ended in under a second: the
                    // engine is bouncing (e.g. Android's recognizer erroring
                    // straight into 'stopped'). Pace the restart so a bounce
                    // can't become a bridge-speed storm.
                    await sleep(600);
                }
                // Empty utterance with no error: just loop and listen again.
            }
        } finally {
            listenLoopRunning = false;
            preview.clear();
        }
    }

    function setMicButtonState(): void {
        if (!stt) return;
        // CSS drives the mute-line off `.btn-voice.active` (active = mic on,
        // line hidden), so muting means removing .active. The orb desaturates
        // via .orb-muted.
        micBtn.classList.toggle('active', !muted);
        orbEl?.classList.toggle('orb-muted', muted);
        micBtn.setAttribute(
            'aria-label',
            muted ? t('Unmute microphone') : t('Mute microphone')
        );
    }

    // Mic input-level ring (the .btn-voice.active --mic-level box-shadow).
    // server-Whisper feeds it from the engine's own per-frame RMS, NEVER a
    // second mic stream: macOS re-arbitrating its voice-processing input between
    // two captures can zero the engine's stream mid-utterance. Web Speech hides
    // its audio, so on desktop it gets a small dedicated meter stream; on phones
    // that stream starves the single system recognizer, so there is no ring.
    let micMeter: MicMeter | null = null;
    let meterEngine: WhisperPcmSttEngine | null = null;
    function startMeter(): void {
        const engine = stt instanceof WhisperPcmSttEngine ? stt : null;
        if (engine) {
            if (meterEngine) return;
            meterEngine = engine;
            // Same level mapping as mic-meter.ts (GAIN 4); smoothing retuned
            // for the ~85ms frame cadence vs its 60fps rAF.
            let smoothed = 0;
            engine.setLevelListener((rms) => {
                // Without continuous capture the stream still hears the reply,
                // but no turn is open: don't show the facilitator's voice as
                // the meditator's level.
                const level = continuousCapture || sttCapturing ? Math.min(1, rms * 4) : 0;
                smoothed = smoothed * 0.6 + level * 0.4;
                micBtn.style.setProperty('--mic-level', smoothed.toFixed(3));
            });
            return;
        }
        if (micMeter || sttBackend !== 'web-speech') return;
        // Single-owner mic platforms (Android, iOS/iPadOS): see above.
        if (isSingleOwnerMicPlatform()) return;
        void startMicMeter(micBtn, appSettings.micDeviceId)
            .then((m) => {
                if (torn || muted) m.stop(); // raced with teardown/mute
                else micMeter = m;
            })
            .catch(() => {});
    }
    function stopMeter(): void {
        if (meterEngine) {
            meterEngine.setLevelListener(null);
            micBtn.style.removeProperty('--mic-level');
            meterEngine = null;
        }
        micMeter?.stop();
        micMeter = null;
    }

    // The resting status line between turns. Every reply path resets the
    // line when it ends, and a mute set mid-reply must survive that.
    function idleStatus(): string {
        if (muted) return t('Muted');
        return stt ? listeningStatus() : t('Mic unavailable');
    }

    /** Settles once the facilitator has nothing playing and no reply under
     *  way, for a stop that keeps the mic until then (keepMicUntil): on macOS,
     *  letting the mic go rebuilds the audio output a second or two later, and
     *  a line playing then skips. A reply is several lines back to back, and
     *  only `busy` spans the gaps between them. */
    async function facilitatorQuiet(): Promise<void> {
        // Looked at a task later, so a line started right after the stop (the
        // spoken "Muted.") counts.
        await sleep(0);
        while (!torn && (ttsSpeakingDepth > 0 || (busy && ttsEnabled))) await sleep(100);
    }

    /** How long a closed voice modal waits for the listen loop to take the
     *  kept mic back before letting it go. */
    const MODAL_MIC_HANDBACK_MS = 3000;

    /** Past this the unmuted status line stops saying the mic is opening,
     *  so a mic that never sends sound can't leave it stuck there. */
    const MIC_OPENING_STATUS_MAX_MS = 5000;
    let micOpenings = 0;

    /** Mic on/off. Unmuting is button-only - a muted mic hears no way back. */
    function setMuted(next: boolean, source: 'button' | 'voice'): void {
        if (!stt || next === muted) return;
        diag(`[turn] mic ${next ? 'muted' : 'unmuted'} (${source})`);
        if (next) {
            muted = true;
            // Listening stops now; the mic itself is let go once the
            // facilitator is quiet, at once when it already is.
            void stt.stop({ keepMicUntil: facilitatorQuiet() });
            stopMeter();
            setMicButtonState();
            setStatus(t('Muted'));
        } else {
            muted = false;
            setMicButtonState();
            // The listen loop resumes without re-announcing, so clear the
            // 'Muted' status here or it sticks.
            const ready = (): string => (silenceMode ? holdingStatus() : listeningStatus());
            // A mic opened afresh hears only digital silence for a second or
            // more (whenHearing), and a word said then is lost. A kept stream
            // taken back is live at once.
            const opensMic = stt instanceof WhisperPcmSttEngine && !stt.micKept ? stt : null;
            if (opensMic) {
                const opening = ++micOpenings;
                setStatus(t('Opening the mic…'), true);
                void Promise.race([opensMic.whenHearing(), sleep(MIC_OPENING_STATUS_MAX_MS)]).then(() => {
                    // Anything that replaced it meanwhile (muted again, a
                    // reply, a mic error) stands, and so does a later unmute's
                    // opening, which this one's bound must not cut short.
                    if (!torn && opening === micOpenings && micBtn.classList.contains('opening')) {
                        setStatus(ready());
                    }
                });
            } else {
                setStatus(ready());
            }
            resumeCapture();
        }
    }

    function resumeCapture(): void {
        startMeter();
        void listenLoop();
    }

    micBtn.addEventListener('click', () => {
        setMuted(!muted, 'button');
        // After, so it replaces the plain "Muted" setMuted just wrote.
        if (muted) hintVoiceCommand('mute');
    });

    // The .active class shows the wave icons; without it, the mute-line.
    let ttsEnabled = true;
    function setTtsEnabled(on: boolean): void {
        ttsEnabled = on;
        ttsToggle.classList.toggle('active', ttsEnabled);
        if (!ttsEnabled) void tts.cancel();
    }
    ttsToggle.addEventListener('click', () => {
        setTtsEnabled(!ttsEnabled);
    });
    unmountVolumeNotice = mountVolumeNotice(root.querySelector<HTMLElement>('#volume-trouble'), {
        wanted: () => ttsEnabled,
        micOpen,
    });

    // Manual silence-mode toggle. Exiting is immediate here; while held, the
    // resume-intent classifier decides when speech ends the hold.
    listenBtn.addEventListener('click', () => {
        if (silenceMode) {
            exitHold();
            pacing.exitSilenceMode();
            setStatus(stt ? listeningStatus() : t('Ready'));
        } else {
            // Clicking IS the confirmation: no [HOLD] bid handshake (rlgm).
            enterHold();
        }
    });

    // Window/document-level listeners (kasina drag, beforeunload) outlive the
    // view's elements, so they must be removed on teardown or they leak across
    // sessions. One AbortController covers them all; endSession() aborts it, and
    // it's handed to initKasinaMode() so its document listeners detach too.
    const viewCleanup = new AbortController();
    viewCleanup.signal.addEventListener('abort', () => infoPanel.dispose());

    // Guard against accidentally closing/reloading the tab mid-session (the
    // browser's native "Leave site?" prompt). In-app nav away is already guarded
    // by showEndConfirm on the End/History links below.
    window.addEventListener(
        'beforeunload',
        (e) => {
            e.preventDefault();
            e.returnValue = '';
        },
        { signal: viewCleanup.signal }
    );

    // Mobile: Android can kill a backgrounded activity (meditation-pal-v73p), so
    // save the moment we go inactive. Coming back is where the mic gets rebuilt:
    // the Capacitor Android WebView fires no 'visibilitychange' across a
    // background round trip, only appStateChange. Removed in endSession
    // (App.addListener isn't AbortController-aware).
    if (isCapacitor()) {
        appStateListener = (async () => {
            const { App } = await import('@capacitor/app');
            return App.addListener('appStateChange', ({ isActive }) => {
                if (torn) return;
                if (!isActive) {
                    void autosaveSession();
                    return;
                }
                if (isSingleOwnerMicPlatform()) void restartSttAfterForeground();
            });
        })();
    }

    // Kasina gazing mode, shared with the noting session view.
    if (orbEl) {
        initKasinaMode({
            orb: orbEl,
            root,
            toggle: kasinaToggle,
            signal: viewCleanup.signal,
        });
    }

    void initVoicePicker();

    async function initVoicePicker(): Promise<void> {
        const [server, hosted] = await Promise.all([fetchServerVoices(), fetchCloudVoices()]);
        scoredVoices = buildScoredVoiceList(server, true, hosted, sessionLanguage);
        updateVoicePickerLabel();
    }

    function updateVoicePickerLabel(): void {
        const name = stripVoicePrefix(setup.voice);
        if (name) voicePickerBtn.textContent = `${voiceLabel(name)} · ${voiceRateLabel(name, scoredVoices, setup.ttsRate)}`;
        else voicePickerBtn.textContent = t('Voice');
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
        renderVoiceList(listEl, scoredVoices, currentName, { showEngine: true, hideIncompatible: true });
        speedSlider.value = String(setup.ttsRate);
        syncSpeedControlForVoice(speedSlider, speedLabel, currentName, scoredVoices, setup.ttsRate);
        modal.classList.remove('hidden');
        diag('[turn] voice picker opened');
        // Park the listen loop (see voiceModalOpen) and stop in-flight capture.
        // The mic is kept through any line still playing (setMuted) and until
        // the modal is closed: let go under a preview, the preview skips, and
        // closing would open the mic afresh, deaf for its first second.
        voiceModalOpen = true;
        let modalOver = (): void => {};
        const modalClosed = new Promise<void>((resolve) => (modalOver = resolve));
        void stt?.stop({ keepMicUntil: Promise.all([facilitatorQuiet(), modalClosed]) });

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
            syncSpeedControlForVoice(speedSlider, speedLabel, name, scoredVoices, setup.ttsRate);
            updateVoicePickerLabel();
            // Rebuild the live engine, or a browser/server voice change would
            // update only the label and silently keep the old engine.
            void rebuildTts(setup.voice);
        };
        let speedChanged = false;
        const onSpeedInput = () => {
            speedChanged = true;
            const rate = Number(speedSlider.value);
            setup.ttsRate = rate;
            speedLabel.textContent = t('{rate} wpm', { rate });
            updateVoicePickerLabel();
        };
        const closeModal = () => {
            modal.classList.add('hidden');
            diag('[turn] voice picker closed');
            stopVoicePreview();
            // Behind the modal the status line can't be seen; say it on the way out.
            if (speedChanged) hintVoiceCommand('speed');
            // The loop is parked in its busy/modal wait and picks back up on its
            // own; restart it if it had exited.
            voiceModalOpen = false;
            if (stt && !muted && !torn && !listenLoopRunning) void listenLoop();
            // Not before the loop has taken the kept mic back, or it is let
            // go a moment ahead of being opened again.
            const resuming = stt instanceof WhisperPcmSttEngine && !muted && !torn ? stt : null;
            if (resuming) void Promise.race([resuming.whenLive(), sleep(MODAL_MIC_HANDBACK_MS)]).then(modalOver);
            else modalOver();
            listEl.removeEventListener('click', onListClick);
            speedSlider.removeEventListener('input', onSpeedInput);
            closeBtn.removeEventListener('click', closeModal);
            offBackdrop();
            releaseKeys();
        };
        listEl.addEventListener('click', onListClick);
        speedSlider.addEventListener('input', onSpeedInput);
        closeBtn.addEventListener('click', closeModal);
        const offBackdrop = onBackdropClick(modal, closeModal);
        const releaseKeys = wirePickerModalKeys(modal, closeModal);
    }

    // A hosted voice can ask the LLM for a text rule (CloudVoice.promptNote,
    // e.g. Harper's "don't open with Right"). Resolved ONCE, for the voice the
    // session starts with, and awaited before the opener: the note lives in the
    // system prompt, so changing it mid-sit (a voice pick, or a late catalog
    // fetch landing after the opener) re-bills the whole cached prefix.
    const voiceNoteReady = fetchCloudVoices().then((hosted) => {
        hostedCatalog = hosted;
        builder.config.voiceNote = hostedVoicePromptNote(setup.voice, setup.provider, hosted);
    });

    /** SessionState.run, stamped as the prompt freezes (systemPrompt), so the
     *  autosave snapshots and the final save carry it. A fault here must never
     *  cost the session its reply. */
    function stampRunRecord(system: string): void {
        if (!session.state) return;
        try {
            const settings = conversationRunSettings({
                setup,
                appSettings,
                prompt: builder.config,
                mode: mode.id,
                language: sessionLanguage,
                continuedFrom: continueFrom?.sessionId ?? null,
                checkinTiming,
                checkinContent,
                checkinWaitSec: checkinTiming === 'smart' ? builder.checkinWaitSeconds() : null,
                voiceCommands: judgeAccess,
                silenceBaseMs,
                silenceMaxMs,
                timerMin: sessionClock.remainingSec() === null ? null : sessionClock.timerMinutes(),
                endSessionOnTimer: sessionClock.endsSessionOnComplete(),
                sttEngine: sttChoice,
                sttModel: sttModelForChoice(sttChoice, appSettings.sttWhisperModel),
                wholeReply: replyWhole(),
            });
            session.state.run = buildRunRecord(runBuild(), settings, system);
        } catch (err) {
            console.warn('Session run record not stamped', err);
        }
    }

    // Greet first. busy holds check-ins, and the mic on pause-while-busy
    // backends, until the opener finishes. Resuming gets a welcome-back.
    // The greeting is a turn like a reply: a barge-in hushes it, an utterance
    // supersedes it (respondTo), and only the live turn releases the shared
    // flags. Without that, a barge-in cut one sentence and the next one
    // played, and the superseded greeting's finally cleared busy under the
    // reply that took over, so that reply ignored barge-ins.
    {
        busy = true;
        tapFlags({ busy: true });
        const myGen = ++turnGen;
        const myFullAbort = new AbortController();
        const myTtsAbort = new AbortController();
        activeFullAbort = myFullAbort;
        activeTtsAbort = myTtsAbort;
        void (async () => {
            try {
                // No stt.prime() here: playOpening opens the mic, in the order
                // the platform needs, and every line waits for it (tts.speak).
                // That also fills the onset pre-buffer before the greeting, so a
                // barge-in on it doesn't clip the first word (d35).
                await voiceNoteReady;
                await speakOpener(!!continueFrom && continueFrom.exchanges.length > 0, {
                    superseded: () => torn || myGen !== turnGen,
                    signal: myFullAbort.signal,
                    ttsSignal: myTtsAbort.signal,
                });
            } finally {
                if (myGen === turnGen) {
                    busy = false;
                    tapFlags({ busy: false });
                    activeFullAbort = null;
                    activeTtsAbort = null;
                }
            }
        })();
    }

    /**
     * The facilitator's first line: a brief LLM welcome (or welcome-back on a
     * resume) from a one-shot instruction, falling back to a static line on any
     * error. The instruction goes into the log as an 'opener' control entry,
     * so turn 2's request extends this one and reads it from cache.
     */
    async function speakOpener(
        resuming: boolean,
        turn: { superseded: () => boolean; signal: AbortSignal; ttsSignal: AbortSignal }
    ): Promise<void> {
        if (turn.superseded()) return;
        const instruction = resuming
            ? 'The meditator is returning to continue from a previous session. ' +
              "Offer a brief, warm welcome back and gently acknowledge they're " +
              'picking up where they left off.'
            : builder.buildOpenerPrompt(setup.intention.trim(), {
                  firstSit: setup.firstSit === true,
              });
        session.addControlMessage('user', instruction, 'opener');
        const reveal = createAssistantReveal();
        try {
            setStatus(resuming ? t('Resuming…') : t('Thinking…'));
            showTyping();
            armSlowResponseStatus();
            // First LLM call, so this is where Ollama pays the cold-load cost;
            // surface that wait at session start.
            if (!resuming && provider instanceof OllamaProvider) {
                setFacilitatorHint(await provider.coldLoadMessage());
            }
            const messages = session.getContextMessages();
            const system = systemPrompt();
            const { text: rawText, ttsDone, usage, finishReason, heard } = await facilitationRequest(
                messages,
                system,
                () =>
                    streamCompletionWithChunkedTts(provider, tts, messages, {
                        system,
                        ttsOptions: { rate: setup.ttsRate },
                        wholeReply: replyWhole(),
                        onTtsError: handleTtsError,
                        signal: turn.signal,
                        ttsSignal: turn.ttsSignal,
                        onSpeakStart: (sentence) => {
                            if (turn.superseded()) return;
                            clearSlowResponseStatus();
                            setStatus(t('Speaking…'));
                            reveal.reveal(sentence);
                        },
                    }),
                (r) => !turn.signal.aborted && r.finishReason !== BILLING_PAUSED_FINISH
            );
            if (turn.superseded()) {
                reveal.discard();
                return;
            }
            // One throwaway check while the greeting plays and the model is
            // otherwise idle, so the first turn already knows what the check
            // costs on this machine.
            if (troubleOnTurns && troubleContends()) void askTrouble('My breath is slow and even.', undefined, true);
            clearSlowResponseStatus();
            // Strip control tokens an eager model put on the greeting: an opener
            // can neither hold nor move the arc.
            const { cleanText } = parseTurnSignals(rawText);
            // An empty greeting is a failed opener: throw so the catch uses the
            // static fallback rather than a blank first turn. Tested on
            // cleanText, so a signal-only greeting falls back too (9era).
            if (!cleanText.trim()) {
                throw new Error(
                    `empty opener completion (finish=${finishReason ?? 'null'} raw=${rawText.length} chars)`
                );
            }
            if (!resuming) tapTurn('assistant', 'opener', cleanText, { raw: rawText });
            session.addAssistantMessage(cleanText, undefined, usage);
            reveal.anchor();
            const settleReply = watchReply(cleanText, heard);
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            const said = settleReply();
            if (said.trim()) {
                reveal.finalize(said);
            } else {
                reveal.discard();
                if (!turn.superseded()) hideTyping();
            }
        } catch (err) {
            // Aborted by the turn that took over: no fallback greeting.
            if (turn.superseded()) {
                reveal.discard();
                return;
            }
            console.warn('LLM opener failed, using static fallback', err);
            clearSlowResponseStatus();
            reveal.discard();
            hideTyping();
            const fallback = resuming ? 'Welcome back. Let’s continue.' : builder.getSessionOpener();
            session.addAssistantMessage(fallback);
            appendMessage('assistant', fallback);
            if (!resuming) {
                tapEvent('note', 'opener-fallback');
                tapTurn('assistant', 'opener', fallback);
            }
            try {
                await tts.speak(fallback, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
        }
        pacing.onResponseEnd();
        setStatus(idleStatus());
    }

    if (stt) {
        setMicButtonState();
        resumeCapture();
    }

    // Background check-in loop, polling the PacingController for when it's been
    // quiet long enough. Off in silence mode or when check-ins are disabled.
    const CHECK_IN_POLL_MS = 10_000;
    const checkInTimer: ReturnType<typeof setInterval> | null = pacingConfig.silenceCheckinsEnabled
        ? setInterval(() => {
              if (torn || busy || muted) return;
              // The pacing controller only sees COMPLETED turns, so it can't
              // tell the user is mid-ramble. Without this guard a long
              // utterance gets a check-in spoken over it.
              if (stt?.userSpeechActive) return;
              const decision = pacing.shouldRespond();
              if (decision !== TurnDecision.CheckIn) return;
              if (checkinContent === 'smart') {
                  void respondWithSmartCheckIn();
              } else {
                  debugLog('canned check-in');
                  tapEvent('checkin', 'canned');
                  void respondWithFacilitatorLine(builder.getCheckInPrompt());
              }
          }, CHECK_IN_POLL_MS)
        : null;

    // Session-timer poll. Separate from the check-in loop and deliberately not
    // gated on silenceCheckinsEnabled or silence mode: a timer the user set is
    // the one thing that must land. It still waits for a turn boundary (busy),
    // so it never speaks over the user or a response in flight - a few seconds
    // late beats barging in.
    const TIMER_POLL_MS = 2000;
    const timerPoll = setInterval(() => {
        if (torn || busy || timerNoticeInFlight) return;
        if (stt?.userSpeechActive) return;
        const due = sessionClock.timerDue(
            timerApproachLeadSec(sessionClock.timerTotalSec(), avgTurnSec())
        );
        if (due) void respondWithTimerNotice(due);
    }, TIMER_POLL_MS);

    /**
     * Speak the timer's approach notice or closing word. Same shape as a smart
     * check-in (event turn → model → canned fallback), with two differences:
     * completion may not [PASS], and neither notice is subject to the check-in
     * streak cap, since the user explicitly asked to be told.
     */
    async function respondWithTimerNotice(kind: 'approach' | 'completion'): Promise<void> {
        if (timerNoticeInFlight || busy) return;
        timerNoticeInFlight = true;
        const myGen = turnGen;
        // The countdown this notice is about. A spoken "cancel the timer" or
        // "five more minutes" while the line is being composed makes it stale.
        const myArm = sessionClock.armGeneration();
        const myAbort = new AbortController();
        activeFullAbort = myAbort;
        const total = sessionClock.timerMinutes();
        const staged = stager !== null;
        // Opted in: this closing word is the last thing they hear, and the sit
        // ends once it has been spoken. Never the other way round - the notice
        // always lands before the session goes away.
        const endsSession = kind === 'completion' && sessionClock.endsSessionOnComplete();
        const fallbackPool =
            kind === 'approach'
                ? TIMER_APPROACH_FALLBACKS
                : endsSession
                  ? TIMER_CLOSE_FALLBACKS
                  : TIMER_COMPLETION_FALLBACKS;
        const canned = pickTimerFallback(
            localizePool(fallbackPool, sessionLanguageOf(sessionLanguage)),
            total
        );
        const speakNotice = async (line: string): Promise<void> => {
            // The closing word: nothing is worth keeping warm past it.
            if (endsSession) cacheKeepAlive?.stop();
            await respondWithFacilitatorLine(
                line,
                kind === 'approach' ? 'timer-approach' : 'timer-completion'
            );
            if (endsSession) void closeAfterTimer();
            else restoreHoldAfterNotice();
        };
        const keepAliveTicket = cacheKeepAlive?.begin();
        try {
            const eventText =
                kind === 'approach'
                    ? buildTimerApproachEvent(sessionClock.remainingSec() ?? 0, total, { staged })
                    : buildTimerCompletionEvent(total, { staged, endsSession });
            debugLog(`timer ${kind} event sent (${total}m)`);
            const timerStart = Date.now();
            const messages: Message[] = [...session.getContextMessages(), { role: 'user', content: eventText }];
            const system = systemPrompt();
            const { reply, usage } = await runSmartCheckin(provider, messages, {
                system,
                signal: myAbort.signal,
                maxChars: SESSION_TIMER_MAX_CHARS,
            });
            tapCall(`timer-${kind}`, Date.now() - timerStart);
            if (torn) return;
            if (myArm !== sessionClock.armGeneration()) {
                tapEvent('timer', `${kind}-stale`);
                return;
            }
            if (myGen !== turnGen || busy || stt?.userSpeechActive) {
                // The meditator took the floor first. timerDue already marked
                // this fired; hand it back so the next turn boundary says it.
                tapEvent('timer', `${kind}-deferred`);
                sessionClock.requeue(kind, myArm);
                return;
            }
            session.recordLlmUsage(usage);
            if (reply.kind === 'pass' && kind === 'approach') {
                debugLog('timer approach → pass');
                tapEvent('timer', 'approach-pass');
                pacing.onResponseEnd();
                return;
            }
            if (reply.kind === 'pass') tapEvent('timer', 'pass-on-completion');
            const line = reply.kind === 'speak' ? reply.text : canned;
            debugLog(`timer ${kind} → ${reply.kind === 'speak' ? 'speak' : 'canned'}`);
            tapEvent('timer', `${kind}-${reply.kind === 'speak' ? 'speak' : 'canned'}`);
            // The event turn enters history with the line, so later turns know
            // why the facilitator spoke about time unprompted.
            session.addControlMessage('user', eventText, 'event');
            keepAliveTicket?.end({ messages, options: { system } });
            tapTurn('user', 'event', eventText);
            await speakNotice(line);
        } catch {
            keepAliveTicket?.end();
            if (torn || myArm !== sessionClock.armGeneration()) return;
            if (myGen !== turnGen || busy || stt?.userSpeechActive) {
                sessionClock.requeue(kind, myArm);
                return;
            }
            debugLog(`timer ${kind} → error (canned)`);
            tapEvent('timer', `${kind}-error-canned`);
            tapTurn('user', 'event', `[Timer: ${kind}]`);
            await speakNotice(canned);
        } finally {
            keepAliveTicket?.end();
            timerNoticeInFlight = false;
        }
    }

    /** End the sit after the timer's closing word has finished speaking. Saves
     *  on the same terms as the idle auto-quit; no confirm dialog, since the
     *  user asked for this when they set the timer. */
    async function closeAfterTimer(): Promise<void> {
        if (torn) return;
        debugLog('timer completion → ending session');
        await endSession(undefined, !appSettings.saveSessionLogs);
    }

    /**
     * A timer notice and a command's acknowledgment are the only things allowed
     * to speak into a silence hold, but they must not END the hold:
     * respondWithFacilitatorLine calls pacing.onResponseEnd, which drops the
     * controller back to Listening. Put the hold back unless the meditator
     * themselves came out of it while we were speaking.
     */
    function restoreHoldAfterNotice(after: 'timer' | 'command' = 'timer'): void {
        if (torn || !silenceMode) return;
        tapEvent('hold', `restored-after-${after}`);
        pacing.enterSilenceMode();
        setStatus(holdingStatus());
    }

    // Auto-quit-after-silence: once a session goes untouched past the configured
    // window, save (if logging is on) and end it. An open session keeps
    // listening and checking in, which slowly spends cloud credit.
    const AUTO_QUIT_POLL_MS = 30_000;
    const idleQuitTimer = setInterval(() => {
        if (torn || busy) return;
        if (!appSettings.autoQuitAfterSilence) return;
        // A silent sit on a timer longer than the window is not a walk-away:
        // the window opens when the countdown ends, not before.
        const remaining = sessionClock.remainingSec();
        if (remaining !== null && remaining > 0) return;
        const timerEndedAt = remaining === null ? 0 : Date.now() + remaining * 1000;
        const idleSince = Math.max(lastActivityAt, timerEndedAt);
        if (Date.now() - idleSince < appSettings.autoQuitSilenceMin * 60_000) return;
        void endSession(undefined, !appSettings.saveSessionLogs);
    }, AUTO_QUIT_POLL_MS);

    /**
     * Speak a line the caller already has (a check-in, timer notice, command
     * acknowledgment, or hold re-entry line): transcript + session history +
     * TTS. No LLM call here.
     */
    async function respondWithFacilitatorLine(
        text: string,
        kind: TurnKind = 'checkin-canned'
    ): Promise<void> {
        if (busy) return;
        busy = true;
        // "Shall I be quiet?" stands only until someone speaks again. With
        // this line said, a yes answers this line, not that one.
        awaitingHoldConfirm = false;
        tapFlags({ busy: true, awaitingHoldConfirm: false });
        try {
            session.addAssistantMessage(text);
            tapTurn('assistant', kind, text);
            // Reveal with the voice, like LLM replies.
            const reveal = createAssistantReveal();
            reveal.anchor();
            setStatus(t('Speaking…'));
            try {
                await tts.speak(text, {
                    rate: setup.ttsRate,
                    onStart: () => reveal.reveal(text),
                });
            } catch {
                /* non-fatal */
            }
            reveal.finalize(text);
            pacing.onResponseEnd();
            setStatus(idleStatus());
        } finally {
            busy = false;
            tapFlags({ busy: false });
            // Capture check-ins too, so a crash between turns doesn't lose them.
            void autosaveSession();
        }
    }

    /**
     * Smart check-in: ask the model for a line that fits the session, or for
     * permission to keep quiet (contract in facilitation/smart-checkin.ts). Any
     * failure degrades to a canned line, so this is never worse than the simple
     * check-in.
     */
    async function respondWithSmartCheckIn(): Promise<void> {
        if (checkinInFlight || busy) return;
        if (smartCheckinStreak >= SMART_CHECKIN_MAX_STREAK) {
            // Out of chances: silent no-op that resets the interval so the
            // poll doesn't refire every tick. Auto-quit takes it from here.
            debugLog('check-in skipped (streak cap)');
            tapEvent('checkin', 'skipped-streak-cap');
            pacing.onCheckinDeferred();
            return;
        }
        // Spent the pass budget: speak a canned line rather than give the model
        // another chance to stay quiet. Still counts as a check-in (streak), so
        // the cap above remains the walk-away backstop.
        if (smartCheckinPasses >= SMART_CHECKIN_MAX_PASSES) {
            smartCheckinStreak++;
            smartCheckinPasses = 0;
            smartCheckinSpoken++;
            smartCheckinPassedAtSec = null;
            debugLog('canned check-in (pass budget)');
            tapEvent('checkin', 'canned-pass-budget');
            await respondWithFacilitatorLine(builder.getCheckInPrompt());
            return;
        }
        checkinInFlight = true;
        // Don't own the turn (no turnGen bump): a real utterance arriving
        // mid-call must win. Registering our abort as the active one lets
        // respondTo cancel the in-flight completion; the gen check catches the
        // takeover either way.
        const myGen = turnGen;
        const myAbort = new AbortController();
        activeFullAbort = myAbort;
        const keepAliveTicket = cacheKeepAlive?.begin();
        try {
            smartCheckinStreak++;
            const smartTiming = checkinTiming === 'smart';
            const silenceSec = pacing.getSilenceDuration();
            const eventText = buildSmartCheckinEvent(
                silenceSec,
                smartCheckinSpoken + 1,
                {
                    passedSecAgo:
                        smartCheckinPassedAtSec === null
                            ? null
                            : silenceSec - smartCheckinPassedAtSec,
                    withWaitHint: smartTiming,
                    // How much the line may steer follows the slider. In pace
                    // modes the line is generated under the mode's own system
                    // prompt, so it stays in-stance.
                    suggestion: checkinSuggestionFor(directiveness),
                }
            );
            debugLog(`event #${smartCheckinStreak} sent (silence ${Math.round(silenceSec)}s)`);
            const checkinStart = Date.now();
            const messages: Message[] = [...session.getContextMessages(), { role: 'user', content: eventText }];
            const system = systemPrompt();
            const { reply, usage } = await runSmartCheckin(provider, messages, {
                system,
                signal: myAbort.signal,
            });
            tapCall('checkin', Date.now() - checkinStart);
            if (torn || myGen !== turnGen || busy || stt?.userSpeechActive) return;
            // The call happened whether or not anything gets spoken; tally it.
            session.recordLlmUsage(usage);
            // A check-in reply can also carry [WAIT:Nm] ("not now, ask again in
            // 15 minutes"), honored under smart timing.
            if (smartTiming && reply.kind !== 'fallback' && reply.waitSec !== null) {
                pacing.setCheckinInterval(reply.waitSec);
                tapEvent('signal', 'wait', {
                    requestedSec: reply.waitSec,
                    effectiveSec: pacing.getCheckinInterval(),
                });
            }
            const waitNote =
                reply.kind !== 'fallback' && reply.waitSec !== null
                    ? ` [WAIT] ${reply.waitSec}s`
                    : '';
            if (reply.kind === 'pass') {
                smartCheckinPasses++;
                smartCheckinPassedAtSec = silenceSec;
                debugLog(`→ pass${waitNote}`);
                tapEvent('checkin', 'pass', { streak: smartCheckinStreak });
                pacing.onCheckinDeferred();
                return;
            }
            smartCheckinPasses = 0;
            smartCheckinSpoken++;
            smartCheckinPassedAtSec = null;
            if (reply.kind === 'speak') {
                debugLog(`→ speak "${reply.text.slice(0, 40)}"${waitNote}`);
                tapEvent('checkin', 'speak', { streak: smartCheckinStreak });
                // Event turn enters history only when the model speaks, so
                // the next turn's model sees why the facilitator piped up.
                session.addControlMessage('user', eventText, 'event');
                keepAliveTicket?.end({ messages, options: { system } });
                tapTurn('user', 'event', eventText);
                await respondWithFacilitatorLine(reply.text, 'checkin');
            } else {
                keepAliveTicket?.end();
                debugLog('→ fallback (canned)');
                tapEvent('checkin', 'fallback', { streak: smartCheckinStreak });
                await respondWithFacilitatorLine(builder.getCheckInPrompt());
            }
        } catch {
            keepAliveTicket?.end();
            // Provider hiccup, or aborted by a real turn: canned fallback unless
            // a real turn took over.
            if (!torn && myGen === turnGen && !busy && !stt?.userSpeechActive) {
                smartCheckinSpoken++;
                smartCheckinPassedAtSec = null;
                debugLog('→ error (canned)');
                tapEvent('checkin', 'error-fallback', { streak: smartCheckinStreak });
                await respondWithFacilitatorLine(builder.getCheckInPrompt());
            }
        } finally {
            keepAliveTicket?.end();
            checkinInFlight = false;
        }
    }

    // End button + History link live in the global nav (injected on mount).
    // Clicks during an active session go through showEndConfirm() so a stray tap
    // can't drop a meditation.
    if (endBtn) {
        endBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showEndConfirm(t('End this session?'), undefined);
        });
    }
    const historyLink = navLinks?.querySelector<HTMLAnchorElement>('[data-nav="history"]');
    if (historyLink) {
        historyLink.addEventListener('click', (e) => {
            e.preventDefault();
            // Stop the global data-nav handler so this confirm is the only way
            // out of a live session.
            e.stopImmediatePropagation();
            showEndConfirm(
                t('Leave session to view history? This will end your current session.'),
                'history'
            );
        });
    }

    /**
     * Show the End-Session confirmation overlay (end-confirm.ts). On
     * confirm/skip-save the session ends and onEnd fires with `destination` so
     * the router knows where to land the user.
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
        const autosaveSettled = autosave.close();
        cacheKeepAlive?.stop();
        unwatchHeadphones();
        unmountVolumeNotice();
        downloadSttClips();
        tapFlags({ ended: true });
        tapEvent('note', `session-ended${skipSave ? ' (unsaved)' : ''}`);
        // Stop any in-flight turn from generating/speaking into a torn-down view.
        activeFullAbort?.abort();
        unsubscribeBalance?.();
        if (checkInTimer) clearInterval(checkInTimer);
        clearInterval(idleQuitTimer);
        if (debugTimer) clearInterval(debugTimer);
        clearInterval(timerPoll);
        sessionClock.destroy();
        const finalState = session.endSession();
        document.removeEventListener('visibilitychange', onVisibilityChange);
        stopMeter();
        micBtn.classList.remove('opening');
        void tts.cancel();
        // Listening stops now; the mic itself is let go once the closing sound
        // is over, so it never closes under it.
        void playClosing(signatureSound, stt);
        // Relax Ollama's keep_alive to the short default: the model idles out
        // soon (not the full 30m) but stays warm for an immediate restart.
        if (provider instanceof OllamaProvider) void provider.relaxKeepAlive();
        // Clearing the session-active flag also stops the visibility-change
        // handler re-acquiring the wake lock.
        releaseWakeLock();
        delete document.body.dataset['sessionActive'];
        void appStateListener?.then((h) => h.remove());
        // Cleanly ended: drop the resume pointer so relaunch doesn't offer it.
        void clearActiveSession();
        stopRetryNotice();
        // Embers are session-only.
        unmountEmberContainer();
        // Exit kasina if active: the toggle's exit branch restores the
        // pre-kasina theme and moves the orb back into the nav (about to be
        // cleared) rather than orphaning it in <body>.
        setKasina(false);
        viewCleanup.abort();
        // Restore the global nav slots we replaced on mount.
        if (navCenter) navCenter.innerHTML = '';
        if (navLinks && savedNavLinks !== null) {
            navLinks.innerHTML = savedNavLinks;
            // Re-init the theme toggle; the restore just replaced its node.
            const restoredThemeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
            if (restoredThemeBtn) initThemeToggle(restoredThemeBtn);
        }

        if (!skipSave && finalState && hasSpokenUserTurn(finalState.exchanges)) {
            // LLM summary for the history row; falls back to the intention.
            setStatus(t('Saving session…'));
            let summary = '';
            try {
                // Off-transcript completion, so fold its token usage into the
                // session tally before persisting finalState (same object
                // reference as session.state, so recording still mutates it
                // after endSession()).
                summary = await generateSessionSummary(recapProvider, finalState.exchanges, {
                    language: summaryLanguage,
                    onUsage: (u) => session.recordLlmUsage(u),
                });
            } catch {
                /* fall through to fallback */
            }
            // Diagnostic: distinguishes a guard-skip (low userTurns) from an
            // empty/failed recap (userTurns ok but chars=0) behind the same
            // "Exploration" fallback. Remove once the summary path is confirmed.
            diag(
                `[summary] provider=${recapProvider.constructor?.name ?? '?'} ` +
                    `userTurns=${spokenExchanges(finalState.exchanges).filter((e) => e.role === 'user').length} ` +
                    `chars=${summary.length}`
            );
            finalState.notes = summary || setup.intention.trim();
            finalState.notesAreRecap = summary !== '';
            // Record who facilitated: history shows it, and a later resume can
            // tell a different model who came before (buildResumeContext).
            finalState.model = modelLabel;
            finalState.provider = setup.provider;
            try {
                await autosaveSettled;
                await sessionStore.save(finalState);
            } catch (err) {
                console.warn('Failed to save session', err);
            }
        } else if (skipSave) {
            // Before onEnd: History, if that is where this lands, lists the
            // rows as it mounts.
            try {
                await autosave.discard();
            } catch (err) {
                console.warn('Failed to discard session', err);
            }
        }

        // After the summary completion, which is an off-transcript LLM turn that
        // still belongs to this session's cost group.
        clearCloudSession();
        onEnd(destination);
    }


    /**
     * Persist the in-progress session to local storage without an LLM summary,
     * so a crash or going offline still leaves a recoverable transcript. No-op
     * when "Save session logs" is off, before any user turn exists, or once the
     * session has ended (session-autosave.ts). The
     * detailed summary is generated only on a clean end (endSession); until then
     * the background recap or the intention stands in for it (`notes` below).
     */
    async function autosaveSession(): Promise<void> {
        if (!appSettings.saveSessionLogs) return;
        const state = session.state;
        if (!state || !hasSpokenUserTurn(state.exchanges)) return;
        // Provisional endTime so an interrupted session still shows a sensible
        // duration in history; the live state stays active (endTime null) so the
        // running loop is unaffected. A clean end overwrites this row.
        //
        // notes carries the latest background recap (or the intention) so an
        // interrupted session is never blank in history and can be resumed
        // cheaply from the recap - see refreshSummaryThrottled.
        const snapshot: SessionState = {
            ...state,
            endTime: Math.floor(Date.now() / 1000),
            notes: currentSummary || setup.intention.trim(),
            notesAreRecap: currentSummary !== '',
            model: modelLabel,
            provider: setup.provider,
        };
        // Mark this session as the one to resume if the app is killed while
        // backgrounded (meditation-pal-v73p). Only after a successful save,
        // so the pointer never outlives a recoverable transcript, and not once
        // the session has ended, whose end clears it.
        if ((await autosave.save(snapshot)) && !torn) void markSessionActive(state.sessionId);
        void refreshSummaryThrottled();
    }

    /**
     * Refresh `currentSummary` in the background, throttled. Generating a recap
     * is an LLM call, so it only runs once SUMMARY_MIN_NEW_EXCHANGES have landed
     * since the last one, on the recap model (buildRecapProvider). Never runs
     * mid-turn (busy) or into a torn-down view; its token cost folds into the
     * session tally.
     */
    async function refreshSummaryThrottled(): Promise<void> {
        if (!appSettings.saveSessionLogs) return;
        if (summaryRefreshing || busy || torn) return;
        const state = session.state;
        if (!state || !hasSpokenUserTurn(state.exchanges)) return;
        const exCount = state.exchanges.length;
        if (exCount - summaryAtExchangeCount < SUMMARY_MIN_NEW_EXCHANGES) return;
        summaryRefreshing = true;
        try {
            const recap = await generateSessionSummary(recapProvider, state.exchanges, {
                language: summaryLanguage,
                onUsage: (u) => session.recordLlmUsage(u),
            });
            if (!torn && recap) {
                currentSummary = recap;
                summaryAtExchangeCount = exCount;
            }
        } catch {
            /* non-fatal; a missing recap falls back to the intention */
        } finally {
            summaryRefreshing = false;
        }
    }

    return {
        teardown(): void { void endSession(); },
        requestLeave(destination?: SessionEndDestination): void {
            showEndConfirm(leaveMessage(destination), destination);
        },
        showInfo(): void { infoPanel.open(); },
        toggleKasina(): void {
            setKasina(!kasinaToggle.checked);
        },
    };
}

/** Save a few settings mid-session, as what was just chosen. Not the view's
 *  copy, which was loaded at mount and would clobber anything saved since. */
function persistSettings(patch: Partial<AppSettings>): Promise<void> {
    return patchAppSettings(patch);
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function isOutOfCredits(message: string): boolean {
    return /insufficient_credits|out of credits|endpoint 402/i.test(message);
}

function canStream(provider: LLMProvider): boolean {
    return typeof (provider as { completeStream?: unknown }).completeStream === 'function';
}

/** Message shown in the end-session confirm for an external nav request
 *  (browser Back). Matches the wording the in-session links use. */
function leaveMessage(destination?: SessionEndDestination): string {
    if (destination === 'history') {
        return t('Leave session to view history? This will end your current session.');
    }
    if (destination === 'settings') {
        return t('Leave session to view settings? This will end your current session.');
    }
    if (destination === 'account') {
        return t('Leave session to view your account? This will end your current session.');
    }
    return t('Leave your session?');
}

// Re-exported for noting-session.ts.
export { describeCloudError, describeSttError } from '../stt-errors.js';

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
            <!-- Persistent STT-outage banner. Hidden until a run of failed
                 transcriptions (renderSttTrouble); cleared on the next success.
                 Unlike the status line, it stays put so a user can't talk into
                 a dead mic for a whole session without noticing. -->
            <div class="stt-trouble hidden" id="stt-trouble" role="status"></div>
            <!-- The phone's volume is off or nearly off (output-volume.ts). -->
            <div class="stt-trouble hidden" id="volume-trouble" role="status"></div>
            <div class="input-row">
                <div id="voice-status" class="voice-status">${t('Connecting…')}</div>
                <span class="session-phase hidden" id="session-phase"></span>
                <!-- Live cloud balance: hidden unless the user opts in
                     (Settings, "Show credit balance during sessions"). -->
                <span class="session-balance hidden" id="session-balance" title="${t('Cloud credits remaining')}"></span>
                <button type="button" class="session-timer" id="timer" title="${t('Session Clock')}">0:00</button>
                <button id="tts-toggle" class="btn btn-tts active" title="${t('Read responses aloud')}" aria-label="${t('Toggle text-to-speech')}">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                        <path class="tts-waves" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        <path class="tts-waves" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                        <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                    </svg>
                </button>
                <button id="voice-btn" class="btn btn-voice" title="${t('Toggle microphone')}" aria-label="${t('Toggle microphone')}">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                        <line x1="12" y1="19" x2="12" y2="23"></line>
                        <line x1="8" y1="23" x2="16" y2="23"></line>
                        <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                    </svg>
                </button>
                <button id="listen-btn" class="btn btn-listen"
                    title="${t('The facilitator stays quiet until you ask to resume.')}">
                    ${t('Just Listen')}
                </button>
            </div>
            <div class="input-controls">
                <div class="ember-level" role="group" title="${t('Floating ember particles')}" aria-label="${t('Floating ember particles')}">
                    <button class="ember-btn" id="ember-minus" type="button">−</button>
                    <div class="ember-blocks" id="ember-blocks">${emberBlocksHTML()}</div>
                    <button class="ember-btn" id="ember-plus" type="button">+</button>
                </div>
                <!-- Hidden state holder for kasina gazing (initKasinaMode).
                     Entry points: tapping the nav orb, or the More sheet's
                     Kasina entry on mobile; click-outside exits. -->
                <input type="checkbox" id="kasina-toggle" class="hidden">
                <div class="voice-control">
                    <button type="button" id="voice-picker-btn" class="voice-picker-btn">${t('Voice')}</button>
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
                <button id="confirm-yes" type="button" class="btn btn-primary">${t('End Session')}</button>
                <button id="confirm-no" type="button" class="btn btn-secondary">${t('Cancel')}</button>
            </div>
            <button id="confirm-skip-save" type="button" class="btn-link hidden">${t('End Without Saving')}</button>
        </div>
    </div>

    <div class="session-ended-overlay hidden" id="session-saving">
        <div class="session-ended-content">
            <p>${t('Saving session…')}</p>
        </div>
    </div>`;
}

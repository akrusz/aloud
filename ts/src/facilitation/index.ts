export {
    ConversationState,
    TurnDecision,
    PacingController,
    defaultPacingConfig,
    CHECKIN_INTERVAL_MIN_SEC,
    CHECKIN_INTERVAL_MAX_SEC,
    type PacingConfig,
    type PacingControllerOptions,
} from './pacing.js';

// `Role` stays off this barrel: ./llm exports it too, and the root
// `export * from` would collide. Import message shapes from `./llm`.
export {
    SessionManager,
    emptyUsage,
    type Exchange,
    type SessionState,
    type SessionUsage,
    type LlmUsage,
    type ContextStrategy,
    type SessionManagerOptions,
} from './session.js';

export { generateSessionSummary } from './summary.js';
export {
    buildResumeContext,
    RESUME_COMPRESS_CHARS,
    RESUME_RECENT_KEEP,
    type ResumeMessage,
    type ResumeContextOptions,
} from './resume.js';
export { classifyResumeIntent, classifyHoldConfirm } from './resume-intent.js';
export {
    runSmartCheckin,
    parseSmartCheckinReply,
    buildSmartCheckinEvent,
    isSmartCheckinEvent,
    PASS_PREFIX,
    SMART_CHECKIN_EVENT_PREFIX,
    SMART_CHECKIN_MAX_CHARS,
    SMART_CHECKIN_MAX_TOKENS,
    type SmartCheckinReply,
    type SmartCheckinEventOptions,
    type SmartCheckinResult,
} from './smart-checkin.js';
export { looksLikeTtsEcho, MIN_ECHO_WORDS } from './echo-guard.js';

export {
    generateNotingLabel,
    NOTING_SYSTEM_PROMPT,
    NOTING_OPENER_PROMPT,
    NOTING_CHECK_IN_PROMPTS,
    NOTING_LABEL_SYSTEM_PROMPT,
    NOTING_STATIC_OPENER,
    type Participant,
    type SoundParticipant,
    type LlmParticipant,
    type ReactiveLevel,
    type GenerateLabelOptions,
} from './noting.js';

export {
    getMode,
    listModes,
    parseTurnSignals,
    matchWaitToken,
    scrubControlTokens,
    StagedModeController,
    EXPLORATION_MODE,
    NOTING_MODE,
    NEXT_PREFIX,
    BACK_PREFIX,
    WAIT_PREFIX,
    type ModeSpec,
    type ModePhase,
    type ModeComposes,
    type StageSignal,
    type TurnSignals,
} from './modes.js';

export {
    FELT_SENSE_MODE,
    FELT_SENSE_SYSTEM_PROMPT,
    FELT_SENSE_PHASES,
    FELT_SENSE_OPENERS,
    FELT_SENSE_CHECK_INS,
} from './felt-sense.js';

export {
    PromptBuilder,
    defaultPromptConfig,
    parseHoldSignal,
    stripHoldPrefix,
    startsWithHold,
    HOLD_PREFIX,
    realRandom,
    BASE_SYSTEM_PROMPT,
    DIMENSIONS_PREAMBLE,
    VOICE_STYLE_FRAGMENT,
    HOLD_SIGNAL_FRAGMENT,
    REALTIME_VOICE_FRAGMENT,
    WAIT_SIGNAL_FRAGMENT,
    waitBiasFragment,
    defaultWaitSeconds,
    FOCUS_PROMPTS,
    QUALITY_PROMPTS,
    DIRECTIVENESS_ADDITIONS,
    VERBOSITY_ADDITIONS,
    CHECK_IN_PROMPTS,
    RESUME_INTENT_SYSTEM_PROMPT,
    type PromptConfig,
    type PromptBuilderOptions,
    type Focus,
    type Quality,
    type Verbosity,
    type HoldSignal,
    type Random,
} from './prompts.js';

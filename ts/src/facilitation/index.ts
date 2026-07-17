export {
    ConversationState,
    TurnDecision,
    PacingController,
    defaultPacingConfig,
    type PacingConfig,
    type PacingControllerOptions,
} from './pacing.js';

// `Role` is also exported from ./llm — kept off the facilitation barrel
// so `export * from` at the root doesn't collide. Import via `./llm` for
// LLM message shapes; the session module narrows it internally.
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
    StagedModeController,
    EXPLORATION_MODE,
    NOTING_MODE,
    NEXT_PREFIX,
    BACK_PREFIX,
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
    VOICE_STYLE_FRAGMENT,
    HOLD_SIGNAL_FRAGMENT,
    REALTIME_VOICE_FRAGMENT,
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

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
export { classifyResumeIntent } from './resume-intent.js';

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
    PromptBuilder,
    defaultPromptConfig,
    parseHoldSignal,
    realRandom,
    BASE_SYSTEM_PROMPT,
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

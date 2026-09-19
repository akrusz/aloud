/**
 * Resume-intent classification for silence ("Just Listen") mode.
 *
 * While holding silence the meditator can think out loud without the
 * facilitator jumping in. This lightweight call (utterance only, no history)
 * judges whether they meant "I'm ready to continue", catching natural phrasing
 * like "alright, let's keep going" that keyword matching would miss.
 */

import type { LLMProvider, Message } from '../llm/index.js';
import {
    RESUME_INTENT_SYSTEM_PROMPT,
    HOLD_CONFIRM_SYSTEM_PROMPT,
    HOLD_REQUEST_SYSTEM_PROMPT,
} from './prompts.js';
import type { LlmUsage } from './session.js';
import { stripThinkTags } from './strip-think-tags.js';
import {
    judgeVerdict,
    type ClassifierId,
    type JudgeContext,
    type JudgeMode,
    type JudgeReport,
    type UtteranceJudge,
} from './utterance-judge.js';

/** CompletionResult usage split, in LlmUsage shape. */
function resultUsage(r: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
}): LlmUsage {
    return {
        tokensIn: r.inputTokens ?? null,
        tokensOut: r.outputTokens ?? null,
        cacheRead: r.cacheReadTokens ?? null,
        cacheCreation: r.cacheCreationTokens ?? null,
    };
}

export interface ClassifyResumeIntentOptions {
    /**
     * Reports this call's off-transcript usage for session usage tracking.
     * Fired only on success.
     */
    onUsage?: (usage: LlmUsage) => void;
    /**
     * Typed-judgment fast path (utterance-judge.ts). Omitted everywhere but
     * hosted sessions, which leaves the LLM classifier as the only path.
     */
    judge?: UtteranceJudge;
    /** Passed to the judge only; the LLM classifier stays history-free. */
    judgeContext?: JudgeContext;
    /** Default 'decide'. Ignored without `judge`. */
    judgeMode?: JudgeMode;
    /** Every classification that had a judge, both sides timed. For the A/B. */
    onJudged?: (report: JudgeReport) => void;
}

/**
 * Verdict for one utterance spoken during a held silence:
 * - `resume` - a "continue" intent; leave the hold.
 * - `stay`   - think-out-loud; stay held.
 * - `error`  - the classifier call failed (provider 429/5xx/network).
 *
 * `error` is DISTINCT from `stay` on purpose: collapsing them trapped the
 * meditator in silence with no voice escape whenever the provider was down, so
 * a 429-quota'd session could never be resumed by speech (ff1y). The caller
 * decides how to fail.
 */
export type ResumeVerdict = 'resume' | 'stay' | 'error';

/**
 * Shared yes/no classifier: one utterance, no history, tiny token budget.
 * Never throws; a provider failure returns 'error' for the caller to handle.
 *
 * One retry, because both callers treat 'error' as a decision, not a no-op: a
 * single overloaded/429 blip would otherwise drop the meditator out of a hold
 * they never asked to leave (tv9u). Two attempts, no backoff - the meditator is
 * waiting on this before the next utterance is judged.
 */
async function llmYesNo(
    provider: LLMProvider,
    text: string,
    system: string,
    options: ClassifyResumeIntentOptions
): Promise<'yes' | 'no' | 'error'> {
    const messages: Message[] = [{ role: 'user', content: text }];
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const result = await provider.complete(messages, { system, maxTokens: 10 });
            options.onUsage?.(resultUsage(result));
            return stripThinkTags(result.text).trim().toUpperCase().startsWith('YES') ? 'yes' : 'no';
        } catch {
            /* retry once, then surface 'error' */
        }
    }
    return 'error';
}

async function timed<T>(run: () => Promise<T>): Promise<{ value: T; latencyMs: number }> {
    const t0 = Date.now();
    const value = await run();
    return { value, latencyMs: Date.now() - t0 };
}

/**
 * The judge, when there is one, in front of (or beside) the LLM. A judge failure
 * is never a verdict: it falls through to the LLM, whose own 'error' keeps its
 * meaning for the callers.
 */
async function classifyYesNo(
    provider: LLMProvider,
    text: string,
    id: ClassifierId,
    system: string,
    options: ClassifyResumeIntentOptions
): Promise<'yes' | 'no' | 'error'> {
    const { judge } = options;
    if (!judge) return llmYesNo(provider, text, system, options);

    const mode = options.judgeMode ?? 'decide';
    const runJudge = async (): Promise<NonNullable<JudgeReport['judge']>> => {
        const t0 = Date.now();
        try {
            const answers = await judge.judge(id, text, options.judgeContext);
            return { answers, verdict: judgeVerdict(id, answers), latencyMs: Date.now() - t0 };
        } catch (err) {
            return { error: String(err), latencyMs: Date.now() - t0 };
        }
    };
    const runLlm = async (): Promise<NonNullable<JudgeReport['llm']>> => {
        const { value, latencyMs } = await timed(() => llmYesNo(provider, text, system, options));
        return { verdict: value, latencyMs };
    };

    if (mode === 'shadow') {
        const [judged, llm] = await Promise.all([runJudge(), runLlm()]);
        options.onJudged?.({ classifier: id, mode, verdict: llm.verdict, judge: judged, llm });
        return llm.verdict;
    }

    const judged = await runJudge();
    if ('verdict' in judged) {
        options.onJudged?.({ classifier: id, mode, verdict: judged.verdict, judge: judged });
        return judged.verdict;
    }
    const llm = await runLlm();
    options.onJudged?.({ classifier: id, mode, verdict: llm.verdict, judge: judged, llm });
    return llm.verdict;
}

/**
 * Does `text` (one utterance spoken during held silence) signal a wish to
 * resume? Provider failure surfaces as `error`, not a silent `stay`, so the
 * caller can avoid trapping the user in a hold they can't leave.
 */
export async function classifyResumeIntent(
    provider: LLMProvider,
    text: string,
    options: ClassifyResumeIntentOptions = {}
): Promise<ResumeVerdict> {
    const verdict = await classifyYesNo(provider, text, 'resume', RESUME_INTENT_SYSTEM_PROMPT, options);
    return verdict === 'yes' ? 'resume' : verdict === 'no' ? 'stay' : 'error';
}

/**
 * Just after a hold ended: are they asking to go back under? Runs in place of
 * the facilitation turn inside the re-entry window (tv9u), so a yes never
 * generates a reply the app would speak over. False on a classifier error, like
 * classifyHoldConfirm: the fallback is an ordinary turn, which is what would
 * have happened anyway.
 */
export async function classifyHoldRequest(
    provider: LLMProvider,
    text: string,
    options: ClassifyResumeIntentOptions = {}
): Promise<boolean> {
    return (await classifyYesNo(provider, text, 'hold-request', HOLD_REQUEST_SYSTEM_PROMPT, options)) === 'yes';
}

/**
 * Classify the reply to "would you like me to be quiet?". The client uses this,
 * not a second [HOLD] from the model, to decide whether to enter silence (rlgm).
 * True only on a clear yes: 'no' and 'error' both stay OUT of the hold, since a
 * missed hold just keeps facilitating while a wrong hold is the bug being fixed.
 */
export async function classifyHoldConfirm(
    provider: LLMProvider,
    text: string,
    options: ClassifyResumeIntentOptions = {}
): Promise<boolean> {
    return (await classifyYesNo(provider, text, 'hold-confirm', HOLD_CONFIRM_SYSTEM_PROMPT, options)) === 'yes';
}

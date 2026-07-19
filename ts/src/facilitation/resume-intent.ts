/**
 * Resume-intent classification for silence ("Just Listen") mode.
 *
 * While holding silence the meditator can think out loud without the
 * facilitator jumping in. This lightweight call (utterance only, no history)
 * judges whether they meant "I'm ready to continue", catching natural phrasing
 * like "alright, let's keep going" that keyword matching would miss.
 */

import type { LLMProvider, Message } from '../llm/index.js';
import { RESUME_INTENT_SYSTEM_PROMPT, HOLD_CONFIRM_SYSTEM_PROMPT } from './prompts.js';
import type { LlmUsage } from './session.js';
import { stripThinkTags } from './strip-think-tags.js';

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
 */
async function classifyYesNo(
    provider: LLMProvider,
    text: string,
    system: string,
    options: ClassifyResumeIntentOptions
): Promise<'yes' | 'no' | 'error'> {
    const messages: Message[] = [{ role: 'user', content: text }];
    try {
        const result = await provider.complete(messages, { system, maxTokens: 10 });
        options.onUsage?.(resultUsage(result));
        return stripThinkTags(result.text).trim().toUpperCase().startsWith('YES') ? 'yes' : 'no';
    } catch {
        return 'error';
    }
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
    const verdict = await classifyYesNo(provider, text, RESUME_INTENT_SYSTEM_PROMPT, options);
    return verdict === 'yes' ? 'resume' : verdict === 'no' ? 'stay' : 'error';
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
    return (await classifyYesNo(provider, text, HOLD_CONFIRM_SYSTEM_PROMPT, options)) === 'yes';
}

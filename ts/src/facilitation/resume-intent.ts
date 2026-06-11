/**
 * Resume-intent classification for silence ("Just Listen") mode.
 *
 * While the facilitator is holding silence the meditator can think out loud
 * without the facilitator jumping in on every utterance; this lightweight LLM
 * call (just the utterance, no conversation history) judges whether what they
 * said means "I'm ready to continue" — catching natural phrases like
 * "alright, let's keep going" that a keyword match would miss.
 */

import type { LLMProvider, Message } from '../llm/index.js';
import { RESUME_INTENT_SYSTEM_PROMPT, HOLD_CONFIRM_SYSTEM_PROMPT } from './prompts.js';
import type { LlmUsage } from './session.js';
import { stripThinkTags } from './strip-think-tags.js';

/** Extract the usage split from a CompletionResult into LlmUsage shape. */
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
     * Reports the off-transcript LLM usage for this call so the caller can
     * fold it into session usage tracking. Fired only on a successful call.
     */
    onUsage?: (usage: LlmUsage) => void;
}

/**
 * The classifier's verdict for one utterance spoken during a held silence:
 * - `resume` — the LLM judged it a "continue" intent; leave the hold.
 * - `stay`   — the LLM judged it think-out-loud; stay held.
 * - `error`  — the classifier call itself failed (provider 429/5xx/network).
 *
 * The `error` case is kept DISTINCT from `stay` on purpose: collapsing them
 * (the old `return false` on catch) trapped the meditator in silence with no
 * voice escape whenever the provider was down — a 429-quota'd session could
 * never be resumed by speech at all (ff1y). The caller decides how to fail.
 */
export type ResumeVerdict = 'resume' | 'stay' | 'error';

/**
 * Shared yes/no intent classifier: one utterance, the given system prompt, no
 * history, a tiny token budget. Returns 'yes'/'no' on a successful call, or
 * 'error' if the provider call itself failed (429/5xx/network). Never throws —
 * callers decide how to treat 'error'.
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
 * Classify whether `text` (a single utterance spoken during held silence)
 * signals the meditator wants to end the silence and resume. A provider
 * failure surfaces as `error` (not a silent `stay`) so the caller can avoid
 * trapping the user in a hold they can't leave.
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
 * Classify the meditator's reply to "would you like me to be quiet?" — the
 * client uses this, not a second [HOLD] from the model, to decide whether to
 * enter silence (rlgm). Returns true ONLY on a clear yes: a 'no' and a provider
 * 'error' both stay OUT of the hold, which is the safe, non-trapping default
 * (a missed hold just keeps facilitating; a wrong hold is the bug we're fixing).
 */
export async function classifyHoldConfirm(
    provider: LLMProvider,
    text: string,
    options: ClassifyResumeIntentOptions = {}
): Promise<boolean> {
    return (await classifyYesNo(provider, text, HOLD_CONFIRM_SYSTEM_PROMPT, options)) === 'yes';
}

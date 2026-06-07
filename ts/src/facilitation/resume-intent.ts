/**
 * Resume-intent classification for silence ("Just Listen") mode.
 *
 * TS port of meditation_session.py::classify_resume_intent. While the
 * facilitator is holding silence the meditator can think out loud without the
 * facilitator jumping in on every utterance; this lightweight LLM call (just
 * the utterance, no conversation history) judges whether what they said means
 * "I'm ready to continue" — catching natural phrases like "alright, let's
 * keep going" that a keyword match would miss.
 */

import type { LLMProvider, Message } from '../llm/index.js';
import { RESUME_INTENT_SYSTEM_PROMPT } from './prompts.js';
import type { LlmUsage } from './session.js';

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
 * True when `text` (a single utterance spoken during held silence) signals the
 * meditator wants to end the silence and resume. Uses the session LLM with no
 * history and a tiny token budget. Never throws — on any error it returns
 * false (stay in the hold), matching the Python behavior: a failed classifier
 * shouldn't yank the user out of silence.
 */
export async function classifyResumeIntent(
    provider: LLMProvider,
    text: string,
    options: ClassifyResumeIntentOptions = {}
): Promise<boolean> {
    const messages: Message[] = [{ role: 'user', content: text }];
    try {
        const result = await provider.complete(messages, {
            system: RESUME_INTENT_SYSTEM_PROMPT,
            maxTokens: 10,
        });
        options.onUsage?.(resultUsage(result));
        return stripThinkTags(result.text).trim().toUpperCase().startsWith('YES');
    } catch {
        return false;
    }
}

/**
 * Some open-weights models (Qwen 3, DeepSeek-R1, etc.) emit a
 * <think>...</think> block before the answer. Strip it so the YES/NO check
 * reads the actual verdict.
 */
function stripThinkTags(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

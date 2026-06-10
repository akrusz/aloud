/**
 * Post-session summary generation.
 *
 * Sends the conversation back to the LLM and asks for a short recap. The recap
 * is dual-purpose: a label in the history list AND the seed for a cheap resume
 * (continuing a saved session from summary + recent turns instead of replaying
 * the whole transcript cold). So it's a couple of sentences, not a few words.
 *
 * Warm-cache reuse: pass `systemPrompt` = the session's facilitation system
 * prompt. The summary instruction is appended as the final user message, so the
 * cached system+transcript prefix is reused (read at ~0.1x) and only the
 * instruction + output are fresh — making an in-session summary refresh nearly
 * free while the cache is warm. Omit it to use the standalone summary prompt.
 */

import type { LLMProvider, Message } from '../llm/index.js';
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

const SUMMARY_SYSTEM_PROMPT =
    'You are a helpful assistant. The conversation above is a ' +
    'meditation session between a facilitator and a meditator. Your job ' +
    "is to produce a brief recap of the session for the meditator's " +
    'history log. Respond with only the recap, nothing else.';

/**
 * The recap instruction. Asks for 2-3 sentences: enough to label the session in
 * history AND to re-orient a facilitator when resuming (what was explored, where
 * it landed, any thread left open) without replaying the whole transcript.
 */
const SUMMARY_USER_PROMPT =
    'Recap this meditation session in 2-3 sentences (about 40-60 words): ' +
    'what was explored, where it landed, and any thread left open to pick up ' +
    'later. Write it as a neutral note to self. Just the recap, nothing else.';

export interface GenerateSummaryOptions {
    /** Override the max-tokens hint. Defaults to room for ~2-3 sentences. */
    maxTokens?: number;
    /**
     * Use this as the system prompt instead of the standalone summary prompt.
     * Pass the session's facilitation system prompt to reuse the warm prompt
     * cache (the transcript reads at ~0.1x instead of a cold full-input pass).
     */
    systemPrompt?: string;
    /**
     * Reports the off-transcript LLM usage for this call so the caller can
     * fold it into session usage tracking. Fired only when the LLM call
     * succeeds (a failed/empty summary made no billable completion).
     */
    onUsage?: (usage: LlmUsage) => void;
}

/**
 * Generate a short summary for a finished session. Returns an empty
 * string if the LLM returns nothing usable; never throws upstream — the
 * caller can fall back to intention or "" without try/catch.
 */
export async function generateSessionSummary(
    provider: LLMProvider,
    messages: ReadonlyArray<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    options: GenerateSummaryOptions = {}
): Promise<string> {
    const llmMessages: Message[] = [...messages.map((m) => ({ role: m.role, content: m.content }))];
    llmMessages.push({ role: 'user', content: SUMMARY_USER_PROMPT });

    try {
        const result = await provider.complete(llmMessages, {
            system: options.systemPrompt ?? SUMMARY_SYSTEM_PROMPT,
            maxTokens: options.maxTokens ?? 200,
        });
        options.onUsage?.(resultUsage(result));
        return stripThinkTags(result.text).trim();
    } catch {
        return '';
    }
}

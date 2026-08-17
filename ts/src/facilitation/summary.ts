/**
 * Post-session summary generation.
 *
 * The recap is dual-purpose: the history-list label AND the seed for a cheap
 * resume (see resume.ts). Hence a couple of sentences, not a few words.
 *
 * Warm-cache reuse: pass `systemPrompt` = the session's facilitation system
 * prompt. The instruction is appended as the final user message, so the cached
 * system+transcript prefix reads at ~0.1x and only the instruction and output
 * are fresh. Omit it to use the standalone summary prompt.
 */

import type { LLMProvider, Message } from '../llm/index.js';
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

const SUMMARY_SYSTEM_PROMPT =
    'You are a helpful assistant. The conversation above is a ' +
    'meditation session between a facilitator and a meditator. Your job ' +
    "is to produce a brief recap of the session for the meditator's " +
    'history log. Respond with only the recap, nothing else.';

/**
 * The recap instruction. 2-3 sentences: enough to label the session and to
 * re-orient a facilitator on resume, without replaying the transcript.
 *
 * In the warm-cache path the system prompt IS the facilitator persona (kept
 * byte-identical for the cache hit), so this trailing message is the only place
 * to override it, and must break the fourth wall explicitly. Otherwise the model
 * stays in character and deflects the recap as a meta-request from the meditator
 * ("that doesn't quite fit what we're doing here... what's here right now?").
 * Do not soften this back into an in-session ask.
 */
const SUMMARY_USER_PROMPT =
    'The meditation session above has ended. Step out of the facilitator role ' +
    'for a moment. You are not speaking to the meditator now, and this is not ' +
    "part of the session. Write a brief recap for the meditator's history log: " +
    'what was explored, where it landed, and any thread left open to pick up ' +
    'later. 2-3 sentences (about 40-60 words), a neutral note to self. Output ' +
    'only the recap, nothing else: no questions, no facilitation.';

/**
 * Don't spend an LLM call recapping a session that barely started; asking anyway
 * is what surfaced the in-character deflection above. Below this the caller
 * falls back to the intention (or ""). Counts user turns, not total messages,
 * so the facilitator's opener alone never clears the bar.
 */
const MIN_USER_TURNS_FOR_SUMMARY = 2;

/**
 * A leading meta-label the model sometimes writes despite "output only the
 * recap" (measured on gpt-5-nano: "Brief recap: The meditator explored..."). It
 * lands verbatim in the history label, so strip it.
 *
 * Deliberately a CLOSED vocabulary rather than "any short prefix before a
 * colon": a recap legitimately opens "Today: heaviness in the chest", and a
 * general rule would eat it. Nothing here can appear at the start of a real
 * recap, since the model is writing the note, not announcing it.
 */
const RECAP_LABEL_RE = /^\**\s*(?:brief |short |session )?(?:recap|summary|note to self)\s*\**\s*:\s*\**\s*/i;

export interface GenerateSummaryOptions {
    /** Override the max-tokens hint. Defaults to room for ~2-3 sentences. */
    maxTokens?: number;
    /**
     * System prompt to use instead of the standalone summary prompt. Pass the
     * session's facilitation prompt to hit the warm cache (~0.1x on the
     * transcript instead of a cold full-input pass).
     */
    systemPrompt?: string;
    /**
     * Reports this call's off-transcript usage for session usage tracking.
     * Fired only on success; a failed summary made no billable completion.
     */
    onUsage?: (usage: LlmUsage) => void;
}

/**
 * Generate a short summary for a finished session. Returns "" when the LLM
 * gives nothing usable; never throws, so callers need no try/catch.
 */
export async function generateSessionSummary(
    provider: LLMProvider,
    messages: ReadonlyArray<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    options: GenerateSummaryOptions = {}
): Promise<string> {
    const userTurns = messages.reduce((n, m) => (m.role === 'user' ? n + 1 : n), 0);
    if (userTurns < MIN_USER_TURNS_FOR_SUMMARY) return '';

    const llmMessages: Message[] = [...messages.map((m) => ({ role: m.role, content: m.content }))];
    llmMessages.push({ role: 'user', content: SUMMARY_USER_PROMPT });

    try {
        const result = await provider.complete(llmMessages, {
            system: options.systemPrompt ?? SUMMARY_SYSTEM_PROMPT,
            maxTokens: options.maxTokens ?? 200,
        });
        options.onUsage?.(resultUsage(result));
        return stripThinkTags(result.text).trim().replace(RECAP_LABEL_RE, '');
    } catch (err) {
        // A failed recap falls back to the intention/label, indistinguishable
        // from a short-session skip. Surface why.
        console.warn('[summary] generation failed:', err);
        return '';
    }
}

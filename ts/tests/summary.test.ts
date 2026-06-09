/**
 * generateSessionSummary — the recap used for history labels and cheap resume.
 */

import { describe, it, expect, vi } from 'vitest';
import { generateSessionSummary } from '../src/facilitation/summary.js';
import type { CompletionOptions, CompletionResult, LLMProvider, Message } from '../src/llm/index.js';

function fakeProvider(text: string): { provider: LLMProvider; calls: Array<{ messages: Message[]; options: CompletionOptions }> } {
    const calls: Array<{ messages: Message[]; options: CompletionOptions }> = [];
    const provider: LLMProvider = {
        model: 'fake',
        async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
            calls.push({ messages, options });
            return {
                text,
                finishReason: 'end_turn',
                tokensUsed: 10,
                inputTokens: 8,
                outputTokens: 2,
                cacheReadTokens: null,
                cacheCreationTokens: null,
            };
        },
    };
    return { provider, calls };
}

describe('generateSessionSummary', () => {
    it('reuses the facilitation system prompt when given (warm-cache path)', async () => {
        const { provider, calls } = fakeProvider('We explored the breath; left the chest open to revisit.');
        const out = await generateSessionSummary(
            provider,
            [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'welcome' }],
            { systemPrompt: 'FACILITATION-SYSTEM' }
        );
        expect(out).toBe('We explored the breath; left the chest open to revisit.');
        expect(calls).toHaveLength(1);
        // The session's own system prompt is used (so the transcript prefix is cached)...
        expect(calls[0]!.options.system).toBe('FACILITATION-SYSTEM');
        // ...and the recap instruction is appended as the final message.
        const msgs = calls[0]!.messages;
        expect(msgs[msgs.length - 1]!.role).toBe('user');
        expect(msgs[msgs.length - 1]!.content.toLowerCase()).toContain('recap');
    });

    it('falls back to the standalone summary system prompt when none is given', async () => {
        const { provider, calls } = fakeProvider('a recap');
        await generateSessionSummary(provider, [{ role: 'user', content: 'hi' }]);
        expect(calls[0]!.options.system).toContain('meditation session');
        expect(calls[0]!.options.system).not.toBe('FACILITATION-SYSTEM');
    });

    it('returns empty string when the provider throws (never bubbles)', async () => {
        const provider: LLMProvider = {
            model: 'fake',
            complete: vi.fn(async () => {
                throw new Error('boom');
            }),
        };
        expect(await generateSessionSummary(provider, [{ role: 'user', content: 'hi' }])).toBe('');
    });
});

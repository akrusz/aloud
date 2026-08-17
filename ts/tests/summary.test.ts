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
    // A transcript with enough user turns to clear the short-session floor.
    const realSession: Message[] = [
        { role: 'assistant', content: 'welcome' },
        { role: 'user', content: 'i keep noticing tension in my chest' },
        { role: 'assistant', content: 'stay with it' },
        { role: 'user', content: 'it softened a little' },
    ];

    it('reuses the facilitation system prompt when given (warm-cache path)', async () => {
        const { provider, calls } = fakeProvider('We explored the breath; left the chest open to revisit.');
        const out = await generateSessionSummary(provider, realSession, { systemPrompt: 'FACILITATION-SYSTEM' });
        expect(out).toBe('We explored the breath; left the chest open to revisit.');
        expect(calls).toHaveLength(1);
        // The session's own system prompt is used (so the transcript prefix is cached)...
        expect(calls[0]!.options.system).toBe('FACILITATION-SYSTEM');
        // ...and the recap instruction is appended as the final message. It must
        // break the fourth wall so the persona doesn't deflect it as a meta-ask.
        const msgs = calls[0]!.messages;
        expect(msgs[msgs.length - 1]!.role).toBe('user');
        const instruction = msgs[msgs.length - 1]!.content.toLowerCase();
        expect(instruction).toContain('recap');
        expect(instruction).toContain('ended');
    });

    it('falls back to the standalone summary system prompt when none is given', async () => {
        const { provider, calls } = fakeProvider('a recap');
        await generateSessionSummary(provider, realSession);
        expect(calls[0]!.options.system).toContain('meditation session');
        expect(calls[0]!.options.system).not.toBe('FACILITATION-SYSTEM');
    });

    it('skips the LLM call for a barely-started session (below the user-turn floor)', async () => {
        const { provider, calls } = fakeProvider('should not be called');
        // One stray opener + a single short reply: nothing to recap.
        const out = await generateSessionSummary(provider, [
            { role: 'assistant', content: 'what brings you here?' },
            { role: 'user', content: 'a dog was barking' },
        ]);
        expect(out).toBe('');
        expect(calls).toHaveLength(0);
    });

    it('returns empty string when the provider throws (never bubbles)', async () => {
        const provider: LLMProvider = {
            model: 'fake',
            complete: vi.fn(async () => {
                throw new Error('boom');
            }),
        };
        expect(await generateSessionSummary(provider, realSession)).toBe('');
    });

    // Models sometimes announce the recap despite "output only the recap".
    // Measured on gpt-5-nano; the label would otherwise show in the history list.
    describe('leading meta-label', () => {
        const BODY = 'Explored an unnamed heaviness in the chest; left unresolved.';

        it.each([
            'Brief recap: ',
            'Recap: ',
            'Summary: ',
            'Session summary: ',
            'Note to self: ',
            '**Recap:** ',
            'RECAP: ',
        ])('strips %j', async (label) => {
            const { provider } = fakeProvider(label + BODY);
            expect(await generateSessionSummary(provider, realSession)).toBe(BODY);
        });

        // The guard that keeps the rule safe: it matches a closed vocabulary,
        // not "any word before a colon", so real recap prose survives intact.
        it.each([
            'Today: heaviness in the chest, left unnamed.',
            'One thread stayed open: the heaviness never resolved.',
            'She said it plainly: it is not sadness.',
            'Recapturing the thread: the chest stayed heavy.',
        ])('leaves %j alone', async (text) => {
            const { provider } = fakeProvider(text);
            expect(await generateSessionSummary(provider, realSession)).toBe(text);
        });
    });
});

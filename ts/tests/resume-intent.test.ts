import { describe, it, expect } from 'vitest';

import { classifyResumeIntent } from '../src/facilitation/resume-intent.js';
import { RESUME_INTENT_SYSTEM_PROMPT } from '../src/facilitation/prompts.js';
import type { LLMProvider, CompletionResult, Message, CompletionOptions } from '../src/llm/index.js';

class StubProvider implements LLMProvider {
    readonly model = 'stub';
    seenSystem: string | undefined = undefined;
    seenMessages: Message[] = [];
    seenMaxTokens: number | undefined = undefined;
    constructor(private readonly response: string | Error) {}
    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        this.seenMessages = messages;
        this.seenSystem = options.system;
        this.seenMaxTokens = options.maxTokens;
        if (this.response instanceof Error) throw this.response;
        return { text: this.response, finishReason: 'stop', tokensUsed: null };
    }
}

describe('classifyResumeIntent', () => {
    it('returns true on a YES verdict', async () => {
        expect(await classifyResumeIntent(new StubProvider('YES'), "okay I'm ready")).toBe(true);
    });

    it('returns false on a NO verdict', async () => {
        expect(await classifyResumeIntent(new StubProvider('NO'), 'hmm, I feel some tightness')).toBe(
            false
        );
    });

    it('is case-insensitive and tolerates surrounding text', async () => {
        expect(await classifyResumeIntent(new StubProvider('Yes, they do.'), 'let us continue')).toBe(
            true
        );
    });

    it('strips a <think> block before reading the verdict', async () => {
        const provider = new StubProvider('<think>they sound done</think>YES');
        expect(await classifyResumeIntent(provider, 'alright, onward')).toBe(true);
    });

    it('uses the resume-intent system prompt, no history, and a tiny token budget', async () => {
        const provider = new StubProvider('NO');
        await classifyResumeIntent(provider, 'just breathing');
        expect(provider.seenSystem).toBe(RESUME_INTENT_SYSTEM_PROMPT);
        expect(provider.seenMessages).toEqual([{ role: 'user', content: 'just breathing' }]);
        expect(provider.seenMaxTokens).toBe(10);
    });

    it('reports usage via onUsage on success', async () => {
        const provider = new StubProvider('YES');
        let reported = false;
        await classifyResumeIntent(provider, 'done now', { onUsage: () => (reported = true) });
        expect(reported).toBe(true);
    });

    it('stays in the hold (returns false) when the LLM call throws', async () => {
        const provider = new StubProvider(new Error('network down'));
        let reported = false;
        expect(
            await classifyResumeIntent(provider, 'ready', { onUsage: () => (reported = true) })
        ).toBe(false);
        expect(reported).toBe(false);
    });
});

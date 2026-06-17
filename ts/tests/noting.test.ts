import { describe, it, expect, vi } from 'vitest';

import {
    generateNotingLabel,
    NOTING_LABEL_SYSTEM_PROMPT,
} from '../src/facilitation/noting.js';
import type { LLMProvider, CompletionResult, Message, CompletionOptions } from '../src/llm/index.js';

class StubProvider implements LLMProvider {
    readonly model = 'stub';
    seenSystem: string | undefined = undefined;
    seenMessages: Message[] = [];
    constructor(private readonly response: string | Error) {}
    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        this.seenMessages = messages;
        this.seenSystem = options.system;
        if (this.response instanceof Error) throw this.response;
        return { text: this.response, finishReason: 'stop', tokensUsed: null };
    }
}

describe('generateNotingLabel', () => {
    it('uses the noting label system prompt as the base', async () => {
        const provider = new StubProvider('warmth');
        await generateNotingLabel(provider);
        expect(provider.seenSystem).toContain(NOTING_LABEL_SYSTEM_PROMPT);
    });

    it('passes a single user-turn prompt as the message', async () => {
        const provider = new StubProvider('warmth');
        await generateNotingLabel(provider);
        expect(provider.seenMessages).toEqual([
            { role: 'user', content: 'Your turn. Say something you notice now, 1-2 words.' },
        ]);
    });

    it('appends the circle context when provided', async () => {
        const provider = new StubProvider('softness');
        await generateNotingLabel(provider, {
            context: ['warmth', 'thinking'],
        });
        expect(provider.seenSystem).toContain('The circle has noted so far: warmth, thinking');
    });

    it('appends the avoid-self-repeat hint when ownLabels provided', async () => {
        const provider = new StubProvider('floating');
        await generateNotingLabel(provider, {
            ownLabels: ['warmth', 'tightness'],
        });
        expect(provider.seenSystem).toContain('warmth, tightness');
        expect(provider.seenSystem).toContain('Try not to repeat');
    });

    it.each([
        ['none', 'background'],
        ['low', 'Most of the time, stay with your own'],
        ['high', 'sociable, attentive meditator'],
    ] as const)('appends the right reactivity flavor: %s', async (reactive, snippet) => {
        const provider = new StubProvider('breath');
        await generateNotingLabel(provider, { reactive });
        expect(provider.seenSystem).toContain(snippet);
    });

    it('strips trailing punctuation and surrounding quotes, lowercases', async () => {
        const provider = new StubProvider('"Warmth."');
        const label = await generateNotingLabel(provider);
        expect(label).toBe('warmth');
    });

    it('strips <think>...</think> reasoning blocks', async () => {
        const provider = new StubProvider('<think>let me check</think>tingling');
        const label = await generateNotingLabel(provider);
        expect(label).toBe('tingling');
    });

    it('returns "breathing" fallback when the LLM throws', async () => {
        const provider = new StubProvider(new Error('rate limited'));
        const label = await generateNotingLabel(provider);
        expect(label).toBe('breathing');
    });

    it('returns "breathing" fallback when the LLM returns empty text', async () => {
        const provider = new StubProvider('');
        const label = await generateNotingLabel(provider);
        expect(label).toBe('breathing');
    });
});

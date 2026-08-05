import { describe, it, expect } from 'vitest';

import {
    classifyResumeIntent,
    classifyHoldConfirm,
    classifyHoldRequest,
} from '../src/facilitation/resume-intent.js';
import {
    RESUME_INTENT_SYSTEM_PROMPT,
    HOLD_CONFIRM_SYSTEM_PROMPT,
    HOLD_REQUEST_SYSTEM_PROMPT,
} from '../src/facilitation/prompts.js';
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

/** Fails the first N calls, then answers - a transient provider blip. */
class FlakyProvider implements LLMProvider {
    readonly model = 'stub';
    calls = 0;
    constructor(
        private readonly failures: number,
        private readonly response: string
    ) {}
    async complete(_messages: Message[], _options: CompletionOptions = {}): Promise<CompletionResult> {
        this.calls++;
        if (this.calls <= this.failures) throw new Error('overloaded');
        return { text: this.response, finishReason: 'stop', tokensUsed: null };
    }
}

describe('classifyResumeIntent', () => {
    it("returns 'resume' on a YES verdict", async () => {
        expect(await classifyResumeIntent(new StubProvider('YES'), "okay I'm ready")).toBe('resume');
    });

    it("returns 'stay' on a NO verdict", async () => {
        expect(await classifyResumeIntent(new StubProvider('NO'), 'hmm, I feel some tightness')).toBe(
            'stay'
        );
    });

    it('is case-insensitive and tolerates surrounding text', async () => {
        expect(await classifyResumeIntent(new StubProvider('Yes, they do.'), 'let us continue')).toBe(
            'resume'
        );
    });

    it('strips a <think> block before reading the verdict', async () => {
        const provider = new StubProvider('<think>they sound done</think>YES');
        expect(await classifyResumeIntent(provider, 'alright, onward')).toBe('resume');
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

    it("returns 'error' (distinct from 'stay') when the LLM call throws", async () => {
        const provider = new StubProvider(new Error('network down'));
        let reported = false;
        expect(
            await classifyResumeIntent(provider, 'ready', { onUsage: () => (reported = true) })
        ).toBe('error');
        expect(reported).toBe(false);
    });

    // A one-off 429/overloaded shouldn't drop the meditator out of the hold
    // (the caller fails open on 'error'), so the classifier retries once.
    it('retries once, so a single transient failure still yields a verdict', async () => {
        const provider = new FlakyProvider(1, 'NO');
        expect(await classifyResumeIntent(provider, 'a warmth in my chest')).toBe('stay');
        expect(provider.calls).toBe(2);
    });

    it('gives up after the retry', async () => {
        const provider = new FlakyProvider(2, 'NO');
        expect(await classifyResumeIntent(provider, 'ready')).toBe('error');
        expect(provider.calls).toBe(2);
    });
});

describe('classifyHoldRequest', () => {
    it('returns true on a clear request to go back to silence', async () => {
        expect(await classifyHoldRequest(new StubProvider('YES'), 'no, stay quiet')).toBe(true);
    });

    // A false quiet talks over someone who wanted to talk; a miss is just an
    // ordinary turn, which is what would have happened anyway.
    it('fails closed (false, ordinary turn) on a no or an error', async () => {
        expect(await classifyHoldRequest(new StubProvider('NO'), 'my chest feels tight')).toBe(
            false
        );
        expect(await classifyHoldRequest(new StubProvider(new Error('429')), 'quiet')).toBe(false);
    });

    it('uses the hold-request system prompt with a tiny token budget', async () => {
        const provider = new StubProvider('YES');
        await classifyHoldRequest(provider, 'shh');
        expect(provider.seenSystem).toBe(HOLD_REQUEST_SYSTEM_PROMPT);
        expect(provider.seenMaxTokens).toBe(10);
    });
});

describe('classifyHoldConfirm', () => {
    it('returns true only on a clear yes', async () => {
        expect(await classifyHoldConfirm(new StubProvider('YES'), 'yes please')).toBe(true);
    });

    it('returns false on a no', async () => {
        expect(await classifyHoldConfirm(new StubProvider('NO'), "no, keep going")).toBe(false);
    });

    it('fails closed (false, stays out of the hold) when the LLM call throws', async () => {
        expect(await classifyHoldConfirm(new StubProvider(new Error('429')), 'sure')).toBe(false);
    });

    it('uses the hold-confirm system prompt with a tiny token budget', async () => {
        const provider = new StubProvider('YES');
        await classifyHoldConfirm(provider, 'mm-hmm');
        expect(provider.seenSystem).toBe(HOLD_CONFIRM_SYSTEM_PROMPT);
        expect(provider.seenMaxTokens).toBe(10);
    });
});

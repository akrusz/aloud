import { describe, it, expect } from 'vitest';
import { OpenRouterProvider } from '@aloud/core/llm';
import { usageOf } from '../src/providers/forward.js';

/**
 * Verifies the cached_tokens fix (meditation-pal-6ue): the OpenAI-compatible
 * provider must split prompt_tokens_details.cached_tokens out as cacheRead so
 * Gemini/DeepSeek implicit caching is billed at the discounted rate instead of
 * full input. Exercised through the core provider the server forwards with.
 */
function fakeFetch(body: unknown): typeof fetch {
    return (async () =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch;
}

describe('OpenAI-compatible usage: cached_tokens split', () => {
    it('splits cached prompt tokens into cacheRead and leaves fresh input', async () => {
        const provider = new OpenRouterProvider({
            apiKey: 'test',
            model: 'google/gemini-2.5-flash-lite',
            fetchImpl: fakeFetch({
                choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
                usage: {
                    prompt_tokens: 10_000,
                    completion_tokens: 300,
                    total_tokens: 10_300,
                    prompt_tokens_details: { cached_tokens: 9_500 },
                },
            }),
        });

        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        const usage = usageOf(result);
        expect(usage.cacheRead).toBe(9_500);
        expect(usage.tokensIn).toBe(500); // 10_000 - 9_500 fresh
        expect(usage.tokensOut).toBe(300);
    });

    it('reports null cacheRead when the provider sends no cache details', async () => {
        const provider = new OpenRouterProvider({
            apiKey: 'test',
            model: 'google/gemini-2.5-flash-lite',
            fetchImpl: fakeFetch({
                choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1_000, completion_tokens: 50, total_tokens: 1_050 },
            }),
        });

        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        const usage = usageOf(result);
        expect(usage.cacheRead).toBeNull();
        expect(usage.tokensIn).toBe(1_000);
    });
});

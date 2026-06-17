import { describe, it, expect } from 'vitest';
import { GoogleProvider } from '../src/llm/index.js';

/** A fetch stub that captures the URL/headers and returns one OpenAI-shaped
 *  chat completion. */
function captureFetch() {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response(
            JSON.stringify({
                choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        );
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
}

describe('GoogleProvider', () => {
    it('targets Google\'s OpenAI-compatible endpoint with the API key', async () => {
        const { calls, fetchImpl } = captureFetch();
        const provider = new GoogleProvider({ apiKey: 'k-test', model: 'gemini-2.5-flash-lite', fetchImpl });

        const result = await provider.complete([{ role: 'user', content: 'hello' }]);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
        );
        const auth = (calls[0]!.init?.headers as Record<string, string>)['authorization'];
        expect(auth).toBe('Bearer k-test');
        expect(result.text).toBe('hi');
    });

    it('defaults to the value-tier model', () => {
        const { fetchImpl } = captureFetch();
        expect(new GoogleProvider({ apiKey: 'k', fetchImpl }).model).toBe('gemini-2.5-flash-lite');
    });
});

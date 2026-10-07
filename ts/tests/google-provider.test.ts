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
        const provider = new GoogleProvider({ apiKey: 'k-test', model: 'gemini-3.5-flash-lite', fetchImpl });

        const result = await provider.complete([{ role: 'user', content: 'hello' }]);

        expect(calls).toHaveLength(1);
        expect(calls[0]!.url).toBe(
            'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
        );
        const auth = (calls[0]!.init?.headers as Record<string, string>)['authorization'];
        expect(auth).toBe('Bearer k-test');
        expect(result.text).toBe('hi');
    });

    it("sends each Gemini generation its own thinking floor: 'none' on 2.x, 'minimal' on 3.x", async () => {
        // 3.x 400s on 'none', so the wrong floor fails every turn.
        for (const [model, floor] of [
            ['gemini-2.5-flash-lite', 'none'],
            ['gemini-3.5-flash-lite', 'minimal'],
            ['gemini-3.8-flash', 'minimal'],
        ] as const) {
            const { calls, fetchImpl } = captureFetch();
            await new GoogleProvider({ apiKey: 'k', model, fetchImpl }).complete([{ role: 'user', content: 'hello' }]);
            const body = JSON.parse(String(calls[0]!.init?.body)) as { reasoning_effort?: string };
            expect(body.reasoning_effort).toBe(floor);
        }
    });

    it('defaults to the value-tier model', () => {
        const { fetchImpl } = captureFetch();
        expect(new GoogleProvider({ apiKey: 'k', fetchImpl }).model).toBe('gemini-3.5-flash-lite');
    });
});

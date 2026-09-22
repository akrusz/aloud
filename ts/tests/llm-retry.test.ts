import { describe, it, expect, vi } from 'vitest';

import {
    fetchWithRetry,
    parseRetryAfter,
    MAX_RETRY_DELAY_MS,
    MAX_TOTAL_RETRY_DELAY_MS,
} from '../src/llm/retry.js';
import { OllamaProvider } from '../src/llm/ollama.js';
import { OpenAIProvider } from '../src/llm/openai.js';

const noSleep = async (): Promise<void> => {};

function statuses(...codes: number[]): ReturnType<typeof vi.fn> {
    const fn = vi.fn();
    for (const code of codes) {
        fn.mockImplementationOnce(async () => new Response(code === 200 ? 'ok' : 'err', { status: code }));
    }
    return fn;
}

describe('fetchWithRetry', () => {
    it.each([408, 429, 500, 502, 503, 504, 529])('retries a %i and returns the recovery', async (code) => {
        const fetchImpl = statuses(code, 200);
        const res = await fetchWithRetry(fetchImpl as unknown as typeof fetch, 'u', {}, { sleep: noSleep });
        expect(res.status).toBe(200);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it.each([400, 401, 403, 404, 422])('returns a %i without retrying', async (code) => {
        const fetchImpl = statuses(code, 200);
        const res = await fetchWithRetry(fetchImpl as unknown as typeof fetch, 'u', {}, { sleep: noSleep });
        expect(res.status).toBe(code);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('stops after maxRetries and hands back the last error response', async () => {
        const fetchImpl = vi.fn(async () => new Response('busy', { status: 503 }));
        const res = await fetchWithRetry(fetchImpl as unknown as typeof fetch, 'u', {}, { sleep: noSleep });
        expect(res.status).toBe(503);
        expect(fetchImpl).toHaveBeenCalledTimes(4);
    });

    it('honours a custom retryable set', async () => {
        const fetchImpl = statuses(500, 200);
        const res = await fetchWithRetry(fetchImpl as unknown as typeof fetch, 'u', {}, {
            sleep: noSleep,
            retryableStatus: new Set([503]),
        });
        expect(res.status).toBe(500);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('retries a network throw, but not an abort', async () => {
        const net = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(new Response('ok'));
        const res = await fetchWithRetry(net as unknown as typeof fetch, 'u', {}, { sleep: noSleep });
        expect(res.status).toBe(200);
        expect(net).toHaveBeenCalledTimes(2);

        const abort = vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError'));
        await expect(
            fetchWithRetry(abort as unknown as typeof fetch, 'u', {}, { sleep: noSleep })
        ).rejects.toThrow(/aborted/);
        expect(abort).toHaveBeenCalledTimes(1);
    });

    it('waits the Retry-After delay when it fits the cap', async () => {
        const sleep = vi.fn(noSleep);
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }))
            .mockResolvedValueOnce(new Response('ok'));
        const res = await fetchWithRetry(fetchImpl as unknown as typeof fetch, 'u', {}, { sleep });
        expect(res.status).toBe(200);
        expect(sleep).toHaveBeenCalledWith(2000);
    });

    it('gives up at once when Retry-After asks for longer than the cap', async () => {
        const sleep = vi.fn(noSleep);
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response('later', { status: 429, headers: { 'retry-after': '60' } }))
            .mockResolvedValueOnce(new Response('ok'));
        const res = await fetchWithRetry(fetchImpl as unknown as typeof fetch, 'u', {}, { sleep });
        expect(res.status).toBe(429);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('keeps the summed waits within the total budget', async () => {
        const sleep = vi.fn(noSleep);
        const ra = String((MAX_RETRY_DELAY_MS - 1000) / 1000);
        const fetchImpl = vi.fn(
            async () => new Response('busy', { status: 503, headers: { 'retry-after': ra } })
        );
        await fetchWithRetry(fetchImpl as unknown as typeof fetch, 'u', {}, { sleep });
        const total = sleep.mock.calls.reduce((sum, [ms]) => sum + (ms as number), 0);
        expect(total).toBeLessThanOrEqual(MAX_TOTAL_RETRY_DELAY_MS);
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('an abort during backoff rejects at once, without another attempt', async () => {
        const ac = new AbortController();
        const fetchImpl = vi.fn(async () => new Response('busy', { status: 503 }));
        // A sleep that never ends on its own: only the abort can release it.
        const sleep = vi.fn(() => {
            queueMicrotask(() => ac.abort());
            return new Promise<void>(() => {});
        });
        await expect(
            fetchWithRetry(fetchImpl as unknown as typeof fetch, 'u', { signal: ac.signal }, { sleep })
        ).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('maxRetries 0 disables retry', async () => {
        const fetchImpl = statuses(503, 200);
        const res = await fetchWithRetry(fetchImpl as unknown as typeof fetch, 'u', {}, {
            sleep: noSleep,
            maxRetries: 0,
        });
        expect(res.status).toBe(503);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

describe('parseRetryAfter', () => {
    it('reads delta-seconds and HTTP dates, ignores junk', () => {
        expect(parseRetryAfter('3')).toBe(3000);
        expect(parseRetryAfter('0.5')).toBe(500);
        const now = Date.parse('2026-09-22T12:00:00Z');
        expect(parseRetryAfter('Tue, 22 Sep 2026 12:00:04 GMT', now)).toBe(4000);
        expect(parseRetryAfter('Tue, 22 Sep 2026 11:00:00 GMT', now)).toBe(0);
        expect(parseRetryAfter('soon')).toBeNull();
        expect(parseRetryAfter(null)).toBeNull();
    });
});

/** A 200 whose body yields one SSE chunk and then fails, like a dropped connection. */
function brokenSseResponse(firstEvent: string): Response {
    const enc = new TextEncoder();
    let sent = false;
    const body = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (!sent) {
                sent = true;
                controller.enqueue(enc.encode(firstEvent));
            } else {
                controller.error(new TypeError('network connection lost'));
            }
        },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('provider retry wiring', () => {
    it('OpenAI-compatible retries a 429 before the stream starts', async () => {
        const fetchImpl = vi
            .fn()
            .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
            .mockResolvedValueOnce(
                new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n', {
                    status: 200,
                })
            );
        const provider = new OpenAIProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
            sleepImpl: noSleep,
        });
        let text = '';
        for await (const c of provider.completeStream([{ role: 'user', content: 'x' }])) text += c.text;
        expect(text).toBe('hi');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('never replays a stream that fails after its first bytes', async () => {
        const fetchImpl = vi.fn(async () =>
            brokenSseResponse('data: {"choices":[{"delta":{"content":"Breathe"}}]}\n\n')
        );
        const provider = new OpenAIProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
            sleepImpl: noSleep,
        });
        const seen: string[] = [];
        await expect(
            (async () => {
                for await (const c of provider.completeStream([{ role: 'user', content: 'x' }])) {
                    seen.push(c.text);
                }
            })()
        ).rejects.toThrow(/connection lost/);
        expect(seen).toEqual(['Breathe']);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('Ollama retries an unreachable daemon', async () => {
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('fetch failed'))
            .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ message: { content: 'hello' }, done_reason: 'stop' }))
            );
        const provider = new OllamaProvider({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            sleepImpl: noSleep,
        });
        const result = await provider.complete([{ role: 'user', content: 'x' }]);
        expect(result.text).toBe('hello');
        expect(fetchImpl).toHaveBeenCalledTimes(3);
    });

    it.each([404, 500])('Ollama surfaces a %i without retrying', async (code) => {
        const fetchImpl = vi.fn(async () => new Response('model "nope" not found', { status: code }));
        const provider = new OllamaProvider({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            sleepImpl: noSleep,
        });
        await expect(provider.complete([{ role: 'user', content: 'x' }])).rejects.toThrow(
            new RegExp(`Ollama error ${code}`)
        );
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});

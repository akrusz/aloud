import { describe, it, expect, vi } from 'vitest';

import { AnthropicProvider } from '../src/llm/anthropic.js';
import { OllamaProvider, contextLengthForRam } from '../src/llm/ollama.js';
import {
    OpenAIProvider,
    OpenRouterProvider,
    VeniceProvider,
    GroqProvider,
} from '../src/llm/openai.js';
import type { StreamChunk } from '../src/llm/base.js';

function mockSseResponse(events: string[]): Response {
    // Each SSE event is joined as one or more lines, separated by blank line.
    const body = events.map((e) => e.endsWith('\n\n') ? e : e + '\n\n').join('');
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
    });
}

function mockNdjsonResponse(lines: object[]): Response {
    const body = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
    return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
    });
}

async function collectStream(iter: AsyncIterable<StreamChunk>): Promise<{
    text: string;
    finishReason: string | null;
    tokensUsed: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
}> {
    let text = '';
    let finishReason: string | null = null;
    let tokensUsed: number | null = null;
    let inputTokens: number | null = null;
    let outputTokens: number | null = null;
    let cacheReadTokens: number | null = null;
    let cacheCreationTokens: number | null = null;
    for await (const chunk of iter) {
        text += chunk.text;
        if (chunk.done) {
            finishReason = chunk.finishReason ?? null;
            tokensUsed = chunk.tokensUsed ?? null;
            inputTokens = chunk.inputTokens ?? null;
            outputTokens = chunk.outputTokens ?? null;
            cacheReadTokens = chunk.cacheReadTokens ?? null;
            cacheCreationTokens = chunk.cacheCreationTokens ?? null;
        }
    }
    return {
        text,
        finishReason,
        tokensUsed,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheCreationTokens,
    };
}

function mockJsonResponse(data: unknown, init: { ok?: boolean; status?: number } = {}): Response {
    const body = JSON.stringify(data);
    return new Response(body, {
        status: init.status ?? (init.ok === false ? 500 : 200),
        headers: { 'content-type': 'application/json' },
    });
}

describe('AnthropicProvider', () => {
    it('throws if no API key provided and no proxy URL', () => {
        expect(() => new AnthropicProvider({ apiKey: '' })).toThrow(/API key/);
    });

    it('accepts an empty apiKey when baseUrl points at a proxy', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({ content: [{ type: 'text', text: 'ok' }] })
        );
        const provider = new AnthropicProvider({
            baseUrl: '/api/llm/anthropic/messages',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const [, init] = fetchImpl.mock.calls[0]!;
        const headers = (init as RequestInit).headers as Record<string, string>;
        // No x-api-key header — proxy injects it server-side
        expect(headers['x-api-key']).toBeUndefined();
        expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('sends the direct-browser-access header only when asked, hitting the real API', async () => {
        const headersFor = async (directBrowserAccess: boolean) => {
            const fetchImpl = vi.fn(async () =>
                mockJsonResponse({ content: [{ type: 'text', text: 'ok' }] })
            );
            const provider = new AnthropicProvider({
                apiKey: 'k',
                directBrowserAccess,
                fetchImpl: fetchImpl as unknown as typeof fetch,
            });
            await provider.complete([{ role: 'user', content: 'hi' }]);
            const [url, init] = fetchImpl.mock.calls[0]!;
            return { url, headers: (init as RequestInit).headers as Record<string, string> };
        };
        // Without it, a browser preflight fails and every turn dies on the
        // network - this header is the whole reason the webview can go direct.
        const on = await headersFor(true);
        expect(on.url).toBe('https://api.anthropic.com/v1/messages');
        expect(on.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
        expect(on.headers['x-api-key']).toBe('k');

        const off = await headersFor(false);
        expect(off.headers['anthropic-dangerous-direct-browser-access']).toBeUndefined();
    });

    it('tunes thinking by model family: effort low on always-on, disable on opt-out, nothing on opt-in', async () => {
        const bodyFor = async (model: string) => {
            const fetchImpl = vi.fn(async () =>
                mockJsonResponse({ content: [{ type: 'text', text: 'ok' }] })
            );
            const provider = new AnthropicProvider({
                apiKey: 'k',
                model,
                fetchImpl: fetchImpl as unknown as typeof fetch,
            });
            await provider.complete([{ role: 'user', content: 'hi' }]);
            return JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
        };

        // Sonnet 5 runs adaptive thinking when the param is omitted — the
        // voice loop needs the explicit disable to speak without a preamble.
        expect((await bodyFor('claude-sonnet-5'))['thinking']).toEqual({ type: 'disabled' });
        // Opus 5 is the same opt-out shape, and must NOT carry an effort
        // override: the disable 400s above effort `high`.
        const opus5 = await bodyFor('claude-opus-5');
        expect(opus5['thinking']).toEqual({ type: 'disabled' });
        expect(opus5['output_config']).toBeUndefined();
        // Opt-in models are already off without it; Fable would 400 on it.
        expect((await bodyFor('claude-opus-4-8'))['thinking']).toBeUndefined();
        expect((await bodyFor('claude-3-opus-20240229'))['output_config']).toBeUndefined();
        // Always-on models get the low-effort pin and no thinking param. The
        // BYOK list serves new ids straight off /v1/models, so the rule is by
        // family: a point release must work with no code edit.
        for (const model of ['claude-fable-5', 'claude-fable-5-1', 'claude-fable-6', 'claude-mythos-5-1']) {
            const body = await bodyFor(model);
            expect(body['thinking']).toBeUndefined();
            expect(body['output_config']).toEqual({ effort: 'low' });
        }
        // Same for the opt-out family's point releases.
        expect((await bodyFor('claude-opus-5-1'))['thinking']).toEqual({ type: 'disabled' });
    });

    it('retries once without the tuning when a model 400s on it, then stays untuned', async () => {
        const rejection = () =>
            new Response(
                JSON.stringify({
                    type: 'error',
                    error: { type: 'invalid_request_error', message: 'thinking.type: disabled is not supported' },
                }),
                { status: 400, headers: { 'content-type': 'application/json' } }
            );
        const fetchImpl = vi
            .fn()
            .mockImplementationOnce(async () => rejection())
            .mockImplementation(async () => mockJsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
        const provider = new AnthropicProvider({
            apiKey: 'k',
            model: 'claude-opus-7', // a future opt-out guess that turns out wrong
            maxRetries: 0,
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(result.text).toBe('ok');
        const bodies = fetchImpl.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string));
        expect(bodies[0]['thinking']).toEqual({ type: 'disabled' });
        expect(bodies[1]['thinking']).toBeUndefined();
        // The next turn skips the tuning outright - no round trip wasted.
        await provider.complete([{ role: 'user', content: 'again' }]);
        expect(fetchImpl).toHaveBeenCalledTimes(3);
        expect(JSON.parse((fetchImpl.mock.calls[2]![1] as RequestInit).body as string)['thinking']).toBeUndefined();
    });

    it('does not retry a 400 that blames the prompt rather than the tuning', async () => {
        const fetchImpl = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({ type: 'error', error: { message: 'messages: first message must use the user role' } }),
                    { status: 400 }
                )
        );
        const provider = new AnthropicProvider({
            apiKey: 'k',
            model: 'claude-opus-5',
            maxRetries: 0,
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/400/);
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('sends the system prompt without its own cache_control and strips system from messages', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                content: [{ type: 'text', text: 'Welcome.' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 100, output_tokens: 5 },
            })
        );
        const provider = new AnthropicProvider({
            apiKey: 'test-key',
            model: 'claude-test',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        const result = await provider.complete(
            [
                { role: 'system', content: 'should be stripped' },
                { role: 'user', content: 'hi' },
            ],
            { system: 'be warm' }
        );

        expect(result.text).toBe('Welcome.');
        expect(result.finishReason).toBe('end_turn');
        expect(result.tokensUsed).toBe(105);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toContain('/v1/messages');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['x-api-key']).toBe('test-key');
        expect(headers['anthropic-version']).toBe('2023-06-01');

        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.model).toBe('claude-test');
        // System carries NO cache_control of its own — a 5m block here would
        // precede the 1h anchor and Anthropic 400s. It's cached via the message
        // breakpoint below instead.
        expect(body.system).toEqual([{ type: 'text', text: 'be warm' }]);
        // System messages are filtered out; the last message carries the cache
        // breakpoint (its content becomes a block array) so the whole prefix
        // is cached for the next turn.
        expect(body.messages).toEqual([
            { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] },
        ]);
    });

    it('puts the cache breakpoint on the last message only, leaving earlier turns plain', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 2 },
            })
        );
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        await provider.complete(
            [
                { role: 'user', content: 'first' },
                { role: 'assistant', content: 'reply' },
                { role: 'user', content: 'second' },
            ],
            { system: 'be warm' }
        );

        const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
        // Earlier turns stay plain strings — only the final message is a cached
        // block so the breakpoint sits at the end of the accumulated prefix.
        expect(body.messages).toEqual([
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: [{ type: 'text', text: 'second', cache_control: { type: 'ephemeral' } }] },
        ]);
    });

    it('adds a 1h-TTL anchor breakpoint every 16 messages in a long conversation', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                content: [{ type: 'text', text: 'ok' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 10, output_tokens: 2 },
            })
        );
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        // 18 messages (indices 0..17). Anchor boundary = floor((17-1)/16)*16 = 16.
        const convo = Array.from({ length: 18 }, (_v, i) => ({
            role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
            content: `m${i}`,
        }));
        await provider.complete(convo, { system: 'be warm' });

        const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
        // Index 16 → 1h anchor; index 17 (last) → 5m rolling tail; rest plain.
        expect(body.messages[16].content).toEqual([
            { type: 'text', text: 'm16', cache_control: { type: 'ephemeral', ttl: '1h' } },
        ]);
        expect(body.messages[17].content).toEqual([
            { type: 'text', text: 'm17', cache_control: { type: 'ephemeral' } },
        ]);
        expect(body.messages[0]).toEqual({ role: 'user', content: 'm0' });
        expect(body.messages[15]).toEqual({ role: 'assistant', content: 'm15' });
        // Exactly two cached blocks (anchor + tail), not one per turn.
        const cached = body.messages.filter((m: { content: unknown }) => Array.isArray(m.content));
        expect(cached).toHaveLength(2);
        // Regression: the system block must NOT carry cache_control. A 5m system
        // block is processed before the messages, so it would precede this 1h
        // anchor and Anthropic 400s ("a 1h block must not come after a 5m block")
        // — which broke every turn once a session grew past the anchor threshold.
        expect(body.system).toEqual([{ type: 'text', text: 'be warm' }]);
    });

    it('parses the per-TTL cache_creation breakdown (ephemeral_1h_input_tokens)', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                content: [{ type: 'text', text: 'hi' }],
                stop_reason: 'end_turn',
                usage: {
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_read_input_tokens: 80,
                    cache_creation_input_tokens: 12,
                    cache_creation: { ephemeral_5m_input_tokens: 8, ephemeral_1h_input_tokens: 4 },
                },
            })
        );
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        // Flat total stays the sum; the 1h subset is broken out for billing.
        expect(result.cacheCreationTokens).toBe(12);
        expect(result.cacheCreation1hTokens).toBe(4);
    });

    it('prepends a user stub when the conversation opens with an assistant message', async () => {
        // The summary-based resume flow leads with an assistant recap;
        // Anthropic requires the first message to be from the user.
        const fetchImpl = vi.fn(async () => mockJsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([
            { role: 'assistant', content: '[Continuing from a previous session. Recap: breath work.]' },
            { role: 'user', content: 'hi again' },
        ]);
        const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
        expect(body.messages).toHaveLength(3);
        expect(body.messages[0]).toEqual({ role: 'user', content: '[Resuming a previous session.]' });
        expect(body.messages[1]).toEqual({
            role: 'assistant',
            content: '[Continuing from a previous session. Recap: breath work.]',
        });
    });

    it('merges consecutive same-role messages so roles strictly alternate', async () => {
        const fetchImpl = vi.fn(async () => mockJsonResponse({ content: [{ type: 'text', text: 'ok' }] }));
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([
            { role: 'user', content: 'first thought' },
            { role: 'user', content: 'second thought' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'third' },
        ]);
        const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
        expect(body.messages.map((m: { role: string }) => m.role)).toEqual([
            'user',
            'assistant',
            'user',
        ]);
        expect(body.messages[0].content).toBe('first thought\n\nsecond thought');
    });

    it('omits the system field when no system prompt provided', async () => {
        const fetchImpl = vi.fn(async () => mockJsonResponse({ content: [{ type: 'text', text: '' }] }));
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
        expect(body.system).toBeUndefined();
    });

    it('surfaces API errors with the status code (after exhausting retries)', async () => {
        const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
            maxRetries: 0, // surface immediately for the test
        });
        await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/429/);
    });

    it('retries a transient 529 (overloaded) and then succeeds', async () => {
        let calls = 0;
        const fetchImpl = vi.fn(async () => {
            calls++;
            if (calls === 1) return new Response('overloaded', { status: 529 });
            return mockJsonResponse({ content: [{ type: 'text', text: 'recovered' }] });
        });
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
            sleepImpl: async () => {}, // no real backoff in the test
        });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(result.text).toBe('recovered');
        expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('completeStream yields incremental text deltas + final usage', async () => {
        const fetchImpl = vi.fn(async () =>
            mockSseResponse([
                'event: message_start\ndata: {"type":"message_start"}',
                'event: content_block_start\ndata: {"type":"content_block_start"}',
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}',
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there."}}',
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":3}}',
                'event: message_stop\ndata: {"type":"message_stop"}',
            ])
        );
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await collectStream(
            provider.completeStream([{ role: 'user', content: 'hi' }])
        );
        expect(result.text).toBe('Hello there.');
        expect(result.finishReason).toBe('end_turn');
        expect(result.tokensUsed).toBe(13);

        // Request body should have stream: true
        const body = JSON.parse(
            ((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string
        );
        expect(body.stream).toBe(true);
    });
});

describe('OllamaProvider', () => {
    it('sends system as a leading message and uses num_predict for max tokens', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                message: { content: 'What do you notice?' },
                done_reason: 'stop',
                prompt_eval_count: 20,
                eval_count: 8,
            })
        );
        const provider = new OllamaProvider({
            model: 'qwen3.5:4b',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        const result = await provider.complete(
            [{ role: 'user', content: "I'm here" }],
            { system: 'be a facilitator', maxTokens: 150 }
        );

        expect(result.text).toBe('What do you notice?');
        expect(result.finishReason).toBe('stop');
        expect(result.tokensUsed).toBe(28);

        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toBe('http://localhost:11434/api/chat');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.model).toBe('qwen3.5:4b');
        expect(body.stream).toBe(false);
        expect(body.think).toBe(false);
        // num_ctx always rides along: Ollama's own default window is small
        // and overflows silently (meditation-pal-76qx).
        expect(body.options).toEqual({ num_predict: 150, num_ctx: 16384 });
        expect(body.messages).toEqual([
            { role: 'system', content: 'be a facilitator' },
            { role: 'user', content: "I'm here" },
        ]);
    });

    it('contextLengthForRam only steps down, and only on low RAM', () => {
        expect(contextLengthForRam(null)).toBe(16384);
        expect(contextLengthForRam(8)).toBe(8192);
        expect(contextLengthForRam(7)).toBe(8192);
        expect(contextLengthForRam(16)).toBe(16384);
        expect(contextLengthForRam(64)).toBe(16384);
    });

    it('strips trailing slashes from the base URL', () => {
        const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434/' });
        // The trailing-slash strip is private — verify indirectly via a request.
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({ message: { content: '' }, eval_count: 0, prompt_eval_count: 0 })
        );
        const p = new OllamaProvider({
            baseUrl: 'http://localhost:11434/',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        void provider;
        return p.complete([{ role: 'user', content: 'x' }]).then(() => {
            expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:11434/api/chat');
        });
    });

    it('checkModelAvailable matches exact and prefixed model names', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                models: [{ name: 'qwen3.5:4b' }, { name: 'gemma:2b' }],
            })
        );
        const provider = new OllamaProvider({
            model: 'qwen3.5',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(await provider.checkModelAvailable()).toBe(true);

        const notFound = new OllamaProvider({
            model: 'mistral',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(await notFound.checkModelAvailable()).toBe(false);
    });

    it('checkModelAvailable returns false on network error', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('econnrefused');
        });
        const provider = new OllamaProvider({
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(await provider.checkModelAvailable()).toBe(false);
    });

    it('coldLoadMessage returns null when the model is already loaded', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({ models: [{ name: 'qwen3.5:4b' }] })
        );
        const provider = new OllamaProvider({
            model: 'qwen3.5',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(await provider.coldLoadMessage()).toBeNull();
        expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:11434/api/ps');
    });

    it('coldLoadMessage returns a status string when the model is not loaded', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({ models: [{ name: 'gemma:2b' }] })
        );
        const provider = new OllamaProvider({
            model: 'qwen3.5:4b',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const msg = await provider.coldLoadMessage();
        expect(msg).toContain('Loading qwen3.5:4b');
    });

    it('coldLoadMessage returns null when Ollama is unreachable', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('econnrefused');
        });
        const provider = new OllamaProvider({
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(await provider.coldLoadMessage()).toBeNull();
    });

    it('completeStream yields NDJSON deltas with final usage', async () => {
        const fetchImpl = vi.fn(async () =>
            mockNdjsonResponse([
                { message: { content: 'Hi' }, done: false },
                { message: { content: ' there' }, done: false },
                {
                    message: { content: '' },
                    done: true,
                    done_reason: 'stop',
                    prompt_eval_count: 10,
                    eval_count: 4,
                },
            ])
        );
        const provider = new OllamaProvider({
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await collectStream(
            provider.completeStream([{ role: 'user', content: 'hi' }])
        );
        expect(result.text).toBe('Hi there');
        expect(result.finishReason).toBe('stop');
        expect(result.tokensUsed).toBe(14);

        const body = JSON.parse(
            ((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string
        );
        expect(body.stream).toBe(true);
    });
});

describe('OpenAIProvider', () => {
    function mockChatResponse(text: string, extras: Record<string, unknown> = {}): Response {
        return mockJsonResponse({
            choices: [{ message: { content: text }, finish_reason: 'stop' }],
            usage: { total_tokens: 42 },
            ...extras,
        });
    }

    it('throws if no API key and no proxy URL', () => {
        expect(() => new OpenAIProvider({ apiKey: '' })).toThrow(/API key/);
    });

    it('accepts an empty apiKey when baseUrl points at a proxy', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse('ok'));
        const provider = new OpenAIProvider({
            baseUrl: '/api/llm/openai',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const [, init] = fetchImpl.mock.calls[0]!;
        const headers = (init as RequestInit).headers as Record<string, string>;
        // No bearer token — proxy injects it server-side
        expect(headers['authorization']).toBeUndefined();
    });

    it('sends system as a leading message, bearer auth, and max_completion_tokens for OpenAI direct', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse('Welcome.'));
        const provider = new OpenAIProvider({
            apiKey: 'sk-test',
            model: 'gpt-5.4-mini',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        const result = await provider.complete(
            [{ role: 'user', content: 'hi' }],
            { system: 'be warm', maxTokens: 150 }
        );

        expect(result.text).toBe('Welcome.');
        expect(result.finishReason).toBe('stop');
        expect(result.tokensUsed).toBe(42);

        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toBe('https://api.openai.com/v1/chat/completions');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['authorization']).toBe('Bearer sk-test');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.model).toBe('gpt-5.4-mini');
        // gpt-5 family rejects max_tokens — the new name is required.
        expect(body.max_completion_tokens).toBe(150);
        expect(body.max_tokens).toBeUndefined();
        // Reasoning models default to their family's lowest effort (no
        // thinking budget) — 'none' for versioned gpt-5.x.
        expect(body.reasoning_effort).toBe('none');
        expect(body.messages).toEqual([
            { role: 'system', content: 'be warm' },
            { role: 'user', content: 'hi' },
        ]);
    });

    it('omits reasoning_effort for non-reasoning models on OpenAI direct, but still uses max_completion_tokens', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse('ok'));
        const provider = new OpenAIProvider({
            apiKey: 'sk-test',
            model: 'gpt-4o-mini',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 100 });
        const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
        expect(body.max_completion_tokens).toBe(100);
        expect(body.max_tokens).toBeUndefined();
        // gpt-4o rejects reasoning_effort — only reasoning models get it.
        expect(body.reasoning_effort).toBeUndefined();
    });

    it('keeps max_tokens for OpenAI-compatible providers with non-reasoning models', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse('ok'));
        const provider = new OpenAIProvider({
            apiKey: 'k',
            baseUrl: 'https://api.groq.com/openai/v1',
            model: 'llama-3.3-70b-versatile',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 120 });
        const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
        expect(body.max_tokens).toBe(120);
        expect(body.max_completion_tokens).toBeUndefined();
        expect(body.reasoning_effort).toBeUndefined();
    });

    it('uses max_completion_tokens for gpt-5/o-series models even via a proxy baseUrl', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse('ok'));
        const provider = new OpenAIProvider({
            baseUrl: '/cloud/v1/llm/openai',
            model: 'gpt-5.4-mini',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 80 });
        const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
        expect(body.max_completion_tokens).toBe(80);
        expect(body.max_tokens).toBeUndefined();
        expect(body.reasoning_effort).toBe('none');
    });

    it('picks each OpenAI reasoning family\'s lowest accepted reasoning_effort', async () => {
        // Probed July 2026: each family 400s on the other families' floor
        // values, so getting these wrong breaks the model outright (the
        // gpt-5.6-sol "Unsupported value: 'minimal'" stream-forward failure).
        const cases: Array<[string, string]> = [
            ['gpt-5.6-sol', 'none'],
            ['gpt-5.5', 'none'],
            ['gpt-5', 'minimal'],
            ['gpt-5-mini', 'minimal'],
            ['o3', 'low'],
            ['o4-mini', 'low'],
        ];
        for (const [model, effort] of cases) {
            const fetchImpl = vi.fn(async () => mockChatResponse('ok'));
            const provider = new OpenAIProvider({
                apiKey: 'sk-test',
                model,
                fetchImpl: fetchImpl as unknown as typeof fetch,
            });
            await provider.complete([{ role: 'user', content: 'hi' }]);
            const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
            expect(body.reasoning_effort, model).toBe(effort);
        }
    });

    it('strips trailing slashes from baseUrl', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse(''));
        const provider = new OpenAIProvider({
            apiKey: 'k',
            baseUrl: 'https://api.openai.com/v1////',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(fetchImpl.mock.calls[0]?.[0]).toBe(
            'https://api.openai.com/v1/chat/completions'
        );
    });

    it('merges extraBody into the request body', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse(''));
        const provider = new OpenAIProvider({
            apiKey: 'k',
            extraBody: { reasoning_effort: 'low' },
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const body = JSON.parse(
            ((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string
        );
        expect(body.reasoning_effort).toBe('low');
    });

    it('surfaces API errors with the status code', async () => {
        const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
        const provider = new OpenAIProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await expect(
            provider.complete([{ role: 'user', content: 'hi' }])
        ).rejects.toThrow(/429/);
    });

    it('completeStream yields SSE deltas + [DONE] terminator', async () => {
        const fetchImpl = vi.fn(async () =>
            mockSseResponse([
                'data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}',
                'data: {"choices":[{"delta":{"content":" there."},"finish_reason":null}]}',
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":7}}',
                'data: [DONE]',
            ])
        );
        const provider = new OpenAIProvider({
            apiKey: 'sk-test',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await collectStream(
            provider.completeStream([{ role: 'user', content: 'hi' }])
        );
        expect(result.text).toBe('Hi there.');
        expect(result.finishReason).toBe('stop');
        expect(result.tokensUsed).toBe(7);

        const body = JSON.parse(
            ((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string
        );
        expect(body.stream).toBe(true);
        expect(body.stream_options).toEqual({ include_usage: true });
    });
});

describe('Preconfigured OpenAI-compatible providers', () => {
    function mockChatResponse(): Response {
        return new Response(
            JSON.stringify({
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { total_tokens: 1 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } }
        );
    }

    it('OpenRouter uses openrouter.ai with deepseek default model', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new OpenRouterProvider({
            apiKey: 'sk-or-test',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(provider.model).toBe('deepseek/deepseek-v3.2');
        await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(fetchImpl.mock.calls[0]?.[0]).toBe(
            'https://openrouter.ai/api/v1/chat/completions'
        );
    });

    it('OpenRouter disables reasoning by default', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new OpenRouterProvider({
            apiKey: 'sk-or-test',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.reasoning).toEqual({ enabled: false });
    });

    it('OpenRouter pins effort low for mandatory-reasoning models (kimi-k3) instead of disabling', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new OpenRouterProvider({
            apiKey: 'sk-or-test',
            model: 'moonshotai/kimi-k3',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.reasoning).toEqual({ effort: 'low' });
    });

    it('OpenRouter omits the reasoning param entirely for models that do not support it (kimi-k2)', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new OpenRouterProvider({
            apiKey: 'sk-or-test',
            model: 'moonshotai/kimi-k2',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
        // Sending `reasoning` to the kimi-k2 endpoint intermittently flipped it
        // into a thinking template whose planning got spoken or blanked the turn.
        expect(body.reasoning).toBeUndefined();
    });

    it('OpenRouter adds reasoning headroom to max_tokens for mandatory-reasoning models', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new OpenRouterProvider({
            apiKey: 'sk-or-test',
            model: 'moonshotai/kimi-k3',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        // Default 300 content budget + 1024 headroom; the thinking preamble
        // bills against max_tokens, so without headroom a long think returns
        // an empty turn (finish_reason "length").
        await provider.complete([{ role: 'user', content: 'hi' }]);
        let body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(300 + 1024);
        // Per-request budgets (resume-intent's 10, noting's 20) get it too.
        await provider.complete([{ role: 'user', content: 'hi' }], { maxTokens: 10 });
        body = JSON.parse((fetchImpl.mock.calls[1]![1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(10 + 1024);
    });

    it('OpenRouter adds no headroom for models that run without reasoning', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new OpenRouterProvider({
            apiKey: 'sk-or-test',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const body = JSON.parse((fetchImpl.mock.calls[0]![1] as RequestInit).body as string);
        expect(body.max_tokens).toBe(300);
    });

    it('Venice uses api.venice.ai and injects extraBody for system prompt suppression', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new VeniceProvider({
            apiKey: 'sk-venice-test',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(provider.model).toBe('llama-3.3-70b');
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toBe('https://api.venice.ai/api/v1/chat/completions');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.venice_parameters).toEqual({
            include_venice_system_prompt: false,
        });
    });

    it('Groq uses api.groq.com with llama default model', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new GroqProvider({
            apiKey: 'gsk-test',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(provider.model).toBe('llama-3.3-70b-versatile');
        await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(fetchImpl.mock.calls[0]?.[0]).toBe(
            'https://api.groq.com/openai/v1/chat/completions'
        );
    });

    it('caller can override the default model', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new GroqProvider({
            apiKey: 'k',
            model: 'mixtral-8x7b-32768',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(provider.model).toBe('mixtral-8x7b-32768');
    });

    it('caller-provided extraBody merges over the default extraBody', async () => {
        const fetchImpl = vi.fn(async () => mockChatResponse());
        const provider = new VeniceProvider({
            apiKey: 'k',
            extraBody: { foo: 'bar' },
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const body = JSON.parse(
            ((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string
        );
        // Both venice defaults and caller-added fields appear
        expect(body.venice_parameters).toEqual({
            include_venice_system_prompt: false,
        });
        expect(body.foo).toBe('bar');
    });
});

describe('usage split — input/output/cache kept separate', () => {
    it('Anthropic complete() parses input/output + cache fields', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                content: [{ type: 'text', text: 'hi' }],
                stop_reason: 'end_turn',
                usage: {
                    input_tokens: 100,
                    output_tokens: 20,
                    cache_read_input_tokens: 80,
                    cache_creation_input_tokens: 12,
                },
            })
        );
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(result.inputTokens).toBe(100);
        expect(result.outputTokens).toBe(20);
        expect(result.cacheReadTokens).toBe(80);
        expect(result.cacheCreationTokens).toBe(12);
        // tokensUsed stays the input+output sum (cache excluded)
        expect(result.tokensUsed).toBe(120);
    });

    it('Anthropic completeStream merges message_start + message_delta usage', async () => {
        const fetchImpl = vi.fn(async () =>
            mockSseResponse([
                'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50,"cache_read_input_tokens":40}}}',
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}',
                'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}',
                'event: message_stop\ndata: {"type":"message_stop"}',
            ])
        );
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await collectStream(
            provider.completeStream([{ role: 'user', content: 'hi' }])
        );
        expect(result.text).toBe('hi');
        expect(result.inputTokens).toBe(50);
        expect(result.outputTokens).toBe(7);
        expect(result.cacheReadTokens).toBe(40);
        expect(result.tokensUsed).toBe(57);
    });

    it('OpenAI complete() maps prompt/completion tokens to input/output', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 30, completion_tokens: 9, total_tokens: 39 },
            })
        );
        const provider = new OpenAIProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(result.inputTokens).toBe(30);
        expect(result.outputTokens).toBe(9);
        expect(result.tokensUsed).toBe(39);
        // no prompt_tokens_details reported -> no cache breakdown
        expect(result.cacheReadTokens ?? null).toBeNull();
        expect(result.cacheCreationTokens ?? null).toBeNull();
    });

    it('OpenAI complete() splits cached + written prompt tokens out of fresh input', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
                usage: {
                    prompt_tokens: 100,
                    completion_tokens: 10,
                    total_tokens: 110,
                    // GPT-5.6+ shape: reads (cached_tokens) and 1.25x-billed
                    // writes (cache_write_tokens) are both prompt subsets.
                    prompt_tokens_details: { cached_tokens: 60, cache_write_tokens: 25 },
                },
            })
        );
        const provider = new OpenAIProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        // fresh = 100 - 60 cached - 25 written
        expect(result.inputTokens).toBe(15);
        expect(result.cacheReadTokens).toBe(60);
        expect(result.cacheCreationTokens).toBe(25);
        expect(result.outputTokens).toBe(10);
    });

    it('Ollama maps prompt_eval_count/eval_count to input/output (no cache)', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                message: { content: 'ok' },
                done_reason: 'stop',
                prompt_eval_count: 25,
                eval_count: 6,
            })
        );
        const provider = new OllamaProvider({
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(result.inputTokens).toBe(25);
        expect(result.outputTokens).toBe(6);
        expect(result.tokensUsed).toBe(31);
        expect(result.cacheReadTokens ?? null).toBeNull();
    });

    it('null usage yields null splits, not zeros', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({ content: [{ type: 'text', text: 'hi' }], stop_reason: 'end_turn' })
        );
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(result.tokensUsed).toBeNull();
        expect(result.inputTokens).toBeNull();
        expect(result.outputTokens).toBeNull();
    });
});

describe('streaming cancellation', () => {
    /** A Response whose body stays open (generation "in flight") and whose
     *  cancel we can observe — abandoning the stream should cancel it so the
     *  HTTP connection (and billable generation) is actually torn down. */
    function observableBody(chunks: string[], contentType: string): {
        response: Response;
        wasCancelled: () => boolean;
    } {
        let cancelled = false;
        const enc = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                for (const c of chunks) controller.enqueue(enc.encode(c));
                // Intentionally never closed — the stream is still "live".
            },
            cancel() {
                cancelled = true;
            },
        });
        return {
            response: new Response(stream, {
                status: 200,
                headers: { 'content-type': contentType },
            }),
            wasCancelled: () => cancelled,
        };
    }

    it('abandoning OpenAI completeStream mid-iteration cancels the response body', async () => {
        const { response, wasCancelled } = observableBody(
            ['data: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n'],
            'text/event-stream'
        );
        const fetchImpl = vi.fn(async () => response);
        const provider = new OpenAIProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        for await (const chunk of provider.completeStream([{ role: 'user', content: 'hi' }])) {
            expect(chunk.text).toBe('Hi');
            break; // barge-in: stop consuming mid-stream
        }
        expect(wasCancelled()).toBe(true);
    });

    it('abandoning Ollama completeStream mid-iteration cancels the response body', async () => {
        const { response, wasCancelled } = observableBody(
            ['{"message":{"content":"Hi"},"done":false}\n'],
            'application/x-ndjson'
        );
        const fetchImpl = vi.fn(async () => response);
        const provider = new OllamaProvider({
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        for await (const chunk of provider.completeStream([{ role: 'user', content: 'hi' }])) {
            expect(chunk.text).toBe('Hi');
            break;
        }
        expect(wasCancelled()).toBe(true);
    });

    it('Anthropic completeStream cancels the body after message_stop ends the stream', async () => {
        const { response, wasCancelled } = observableBody(
            [
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}\n\n',
                'event: message_stop\ndata: {"type":"message_stop"}\n\n',
            ],
            'text/event-stream'
        );
        const fetchImpl = vi.fn(async () => response);
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        const result = await collectStream(
            provider.completeStream([{ role: 'user', content: 'hi' }])
        );
        expect(result.text).toBe('Hi');
        expect(wasCancelled()).toBe(true);
    });

    it('passes CompletionOptions.signal through to fetch on every provider', async () => {
        const controller = new AbortController();
        const { signal } = controller;

        const anthropicFetch = vi.fn(async () =>
            mockJsonResponse({ content: [{ type: 'text', text: 'ok' }] })
        );
        await new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: anthropicFetch as unknown as typeof fetch,
        }).complete([{ role: 'user', content: 'hi' }], { signal });
        expect((anthropicFetch.mock.calls[0]?.[1] as RequestInit).signal).toBe(signal);

        const openaiFetch = vi.fn(async () =>
            mockJsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] })
        );
        await new OpenAIProvider({
            apiKey: 'k',
            fetchImpl: openaiFetch as unknown as typeof fetch,
        }).complete([{ role: 'user', content: 'hi' }], { signal });
        expect((openaiFetch.mock.calls[0]?.[1] as RequestInit).signal).toBe(signal);

        const ollamaFetch = vi.fn(async () =>
            mockJsonResponse({ message: { content: 'ok' }, done_reason: 'stop' })
        );
        await new OllamaProvider({
            fetchImpl: ollamaFetch as unknown as typeof fetch,
        }).complete([{ role: 'user', content: 'hi' }], { signal });
        expect((ollamaFetch.mock.calls[0]?.[1] as RequestInit).signal).toBe(signal);
    });

    it('passes the signal on streaming requests too', async () => {
        const controller = new AbortController();
        const fetchImpl = vi.fn(async () =>
            mockSseResponse(['data: [DONE]'])
        );
        const provider = new OpenAIProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await collectStream(
            provider.completeStream([{ role: 'user', content: 'hi' }], {
                signal: controller.signal,
            })
        );
        expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).signal).toBe(controller.signal);
    });
});

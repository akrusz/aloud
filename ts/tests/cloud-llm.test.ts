import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { CloudLlmProvider } from '../ui/src/adapters/cloud-llm.js';
import { setCloudAuthBackend, setCloudAuthFetch } from '../ui/src/cloud-auth.js';
import type { KvStorage } from '../src/platform/storage.js';
import type { StreamChunk } from '../src/llm/index.js';

class MemoryKv implements KvStorage {
    private m = new Map<string, string>();
    async get(k: string) {
        return this.m.get(k) ?? null;
    }
    async set(k: string, v: string) {
        this.m.set(k, v);
    }
    async delete(k: string) {
        this.m.delete(k);
    }
    async keys() {
        return [...this.m.keys()];
    }
    async clear() {
        this.m.clear();
    }
}

/** A Response carrying an SSE stream built from the given frames (each already
 *  ending in the blank-line separator the parser splits on). */
function sseResponse(frames: string[]): Response {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            const enc = new TextEncoder();
            for (const f of frames) controller.enqueue(enc.encode(f));
            controller.close();
        },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

let kv: MemoryKv;

beforeEach(() => {
    kv = new MemoryKv();
    setCloudAuthBackend(kv);
    // Default dev sign-in mints "tok-fresh"; tests that pre-seed a token won't hit this.
    setCloudAuthFetch(async () =>
        new Response(JSON.stringify({ token: 'tok-fresh', isNewAccount: false, account: {} }), {
            status: 200,
        })
    );
});

describe('CloudLlmProvider.complete', () => {
    it('posts with the cached bearer token and maps the response', async () => {
        await kv.set('server:token', 'tok-1');
        let seenAuth = '';
        let seenBody: Record<string, unknown> = {};
        const provider = new CloudLlmProvider({
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            fetchImpl: async (_url, init) => {
                seenAuth = (init?.headers as Record<string, string>)['authorization'] ?? '';
                seenBody = JSON.parse(init?.body as string);
                return new Response(
                    JSON.stringify({
                        text: 'Welcome.',
                        finishReason: 'stop',
                        creditsCharged: 2,
                        creditsRemaining: 18,
                    }),
                    { status: 200 }
                );
            },
        });

        const result = await provider.complete([{ role: 'user', content: 'hi' }], { system: 'be kind' });
        expect(seenAuth).toBe('Bearer tok-1');
        expect(seenBody['provider']).toBe('anthropic');
        expect(seenBody['model']).toBe('claude-sonnet-5-5');
        expect(seenBody['system']).toBe('be kind');
        expect(seenBody['stream']).toBe(false);
        expect(result.text).toBe('Welcome.');
        expect(result.finishReason).toBe('stop');
    });

    it('on 401 clears the stale token, re-signs-in, and retries once', async () => {
        await kv.set('server:token', 'stale');
        const authSeen: string[] = [];
        const provider = new CloudLlmProvider({
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            fetchImpl: async (_url, init) => {
                authSeen.push((init?.headers as Record<string, string>)['authorization'] ?? '');
                if (authSeen.length === 1) {
                    return new Response(JSON.stringify({ error: { code: 'unauthenticated' } }), {
                        status: 401,
                    });
                }
                return new Response(
                    JSON.stringify({ text: 'ok', finishReason: 'stop', creditsCharged: 1, creditsRemaining: 9 }),
                    { status: 200 }
                );
            },
        });

        const result = await provider.complete([{ role: 'user', content: 'hi' }]);
        expect(authSeen).toEqual(['Bearer stale', 'Bearer tok-fresh']);
        expect(result.text).toBe('ok');
    });

    it('surfaces the server error message on a non-retryable failure', async () => {
        await kv.set('server:token', 'tok-1');
        const provider = new CloudLlmProvider({
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            fetchImpl: async () =>
                new Response(JSON.stringify({ error: { code: 'insufficient_credits', message: 'out of credits' } }), {
                    status: 402,
                }),
        });
        await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('out of credits');
    });
});

describe('CloudLlmProvider.completeStream', () => {
    async function collect(it: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
        const out: StreamChunk[] = [];
        for await (const c of it) out.push(c);
        return out;
    }

    it('parses SSE deltas and ends with a terminal done chunk', async () => {
        await kv.set('server:token', 'tok-1');
        const provider = new CloudLlmProvider({
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            fetchImpl: async () =>
                sseResponse([
                    `data: ${JSON.stringify({ text: 'Hello ', done: false })}\n\n`,
                    `data: ${JSON.stringify({ text: 'there.', done: false })}\n\n`,
                    `data: ${JSON.stringify({
                        text: '',
                        done: true,
                        result: { text: 'Hello there.', finishReason: 'stop', creditsCharged: 1, creditsRemaining: 9 },
                    })}\n\n`,
                ]),
        });

        const chunks = await collect(provider.completeStream([{ role: 'user', content: 'hi' }]));
        const deltas = chunks.filter((c) => !c.done).map((c) => c.text);
        expect(deltas).toEqual(['Hello ', 'there.']);
        const terminal = chunks.at(-1)!;
        expect(terminal.done).toBe(true);
        expect(terminal.finishReason).toBe('stop');
    });

    it('handles SSE frames split across read() boundaries', async () => {
        await kv.set('server:token', 'tok-1');
        const provider = new CloudLlmProvider({
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            // One frame delivered in two pieces, the split landing mid-JSON.
            fetchImpl: async () =>
                sseResponse([
                    `data: ${JSON.stringify({ text: 'par', done: false })}`,
                    `\n\ndata: ${JSON.stringify({ text: 'tial', done: false })}\n\n`,
                    `data: ${JSON.stringify({ text: '', done: true })}\n\n`,
                ]),
        });

        const chunks = await collect(provider.completeStream([{ role: 'user', content: 'hi' }]));
        const text = chunks.filter((c) => !c.done).map((c) => c.text).join('');
        expect(text).toBe('partial');
        expect(chunks.at(-1)!.done).toBe(true);
    });

    it('throws on an SSE error event', async () => {
        await kv.set('server:token', 'tok-1');
        const provider = new CloudLlmProvider({
            provider: 'anthropic',
            model: 'claude-sonnet-5-5',
            fetchImpl: async () =>
                sseResponse([
                    `event: error\ndata: ${JSON.stringify({ error: { code: 'provider_error', message: 'upstream provider error' } })}\n\n`,
                ]),
        });

        await expect(async () => {
            for await (const _ of provider.completeStream([{ role: 'user', content: 'hi' }])) void _;
        }).rejects.toThrow('upstream provider error');
    });
});

/** A dropped connection (net-retry.ts): re-sent until the response arrives,
 *  never after, so a half-spoken reply is never replayed. */
describe('CloudLlmProvider on a dropped connection', () => {
    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    const done = `data: ${JSON.stringify({ text: '', done: true })}\n\n`;

    it('re-sends a stream whose request failed before any response', async () => {
        await kv.set('server:token', 'tok-1');
        const fetchImpl = vi
            .fn()
            .mockRejectedValueOnce(new TypeError('Load failed'))
            .mockResolvedValueOnce(sseResponse([`data: ${JSON.stringify({ text: 'Welcome back.', done: false })}\n\n`, done]));
        const provider = new CloudLlmProvider({ provider: 'anthropic', model: 'm', fetchImpl });

        const chunks: StreamChunk[] = [];
        const run = (async () => {
            for await (const c of provider.completeStream([{ role: 'user', content: 'hi' }])) chunks.push(c);
        })();
        await vi.advanceTimersByTimeAsync(600);
        await run;
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(chunks.filter((c) => !c.done).map((c) => c.text)).toEqual(['Welcome back.']);
    });

    it('does not re-send once the stream has started', async () => {
        await kv.set('server:token', 'tok-1');
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ text: 'Hel', done: false })}\n\n`));
                controller.error(new TypeError('network error'));
            },
        });
        const fetchImpl = vi.fn(async () => new Response(body, { status: 200 }));
        const provider = new CloudLlmProvider({ provider: 'anthropic', model: 'm', fetchImpl });

        await expect(async () => {
            for await (const _ of provider.completeStream([{ role: 'user', content: 'hi' }])) void _;
        }).rejects.toThrow('network error');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("a newer turn's abort ends the re-sending", async () => {
        await kv.set('server:token', 'tok-1');
        const fetchImpl = vi.fn(async () => {
            throw new TypeError('Failed to fetch');
        });
        const provider = new CloudLlmProvider({ provider: 'anthropic', model: 'm', fetchImpl });
        const ac = new AbortController();

        const run = (async () => {
            for await (const _ of provider.completeStream([{ role: 'user', content: 'hi' }], { signal: ac.signal })) void _;
        })();
        const settled = expect(run).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(100);
        ac.abort();
        await settled;
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it("passes the caller's signal to the fetch, so a superseded turn stops streaming", async () => {
        await kv.set('server:token', 'tok-1');
        let seen: AbortSignal | null = null;
        const provider = new CloudLlmProvider({
            provider: 'anthropic',
            model: 'm',
            fetchImpl: async (_url, init) => {
                seen = init?.signal ?? null;
                return sseResponse([done]);
            },
        });
        const ac = new AbortController();
        const it = provider.completeStream([{ role: 'user', content: 'hi' }], { signal: ac.signal })[Symbol.asyncIterator]();
        await it.next();
        expect(seen!.aborted).toBe(false);
        ac.abort();
        expect(seen!.aborted).toBe(true);
        await it.return?.(undefined);
    });
});

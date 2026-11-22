import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

import { CloudLlmProvider } from '../ui/src/adapters/cloud-llm.js';
import { CLOUD_TTS_RETRY_BUDGET_MS, CloudTtsEngine } from '../ui/src/adapters/cloud-tts.js';
import { CLOUD_FINAL_RETRY_BUDGET_MS, WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';
import { setCloudAuthBackend } from '../ui/src/cloud-auth.js';
import { streamCompletionWithChunkedTts } from '../ui/src/streaming-tts.js';
import { isConnectionFailure } from '../ui/src/stt-errors.js';
import { SessionManager } from '../src/facilitation/session.js';
import type { KvStorage } from '../src/platform/storage.js';
import type { LLMProvider, StreamChunk } from '../src/llm/index.js';

/**
 * The cloud calls' stall guards (net-timeout.ts and the per-chunk timer in
 * cloud-llm completeStream) against a real socket that stalls: a local server
 * that accepts and hangs, the client's real fetch, the shipping limits. Fake
 * timers drive only the clock the guards run on; the sockets are real, so
 * "the socket is released" is the server seeing the connection close.
 */

// Captured before any test fakes the clock: the waits on real socket events
// below need a real one.
const realSetTimeout = globalThis.setTimeout;

const LLM_STALL_MS = 60_000;
const TTS_STALL_MS = 45_000;
const STT_STALL_MS = 45_000;

type Shape =
    /** Accepts the TCP connection and reads the request, never writes. */
    | 'silent'
    /** Sends response headers, then nothing. */
    | 'headers'
    /** Sends headers and the given body, then nothing. */
    | 'partial'
    /** Sends headers; the body is whatever the test pushes, when it does. */
    | 'live';

interface Stall {
    origin: string;
    /** Requests that reached the server so far. */
    readonly requests: number;
    /** Of those, the ones whose connection is still open. */
    readonly open: number;
    /** Write to every open response (live / partial). */
    push(data: string | Uint8Array): void;
    /** End every open response. */
    end(data?: string): void;
    stop(): Promise<void>;
}

async function stallServer(shape: Shape, opts: { contentType?: string; partial?: string } = {}): Promise<Stall> {
    // Only sockets that carried a request count: undici opens a fresh idle
    // connection right after one it destroyed, which is no leak.
    const all = new Set<net.Socket>();
    const carrying = new Set<net.Socket>();
    const responses = new Set<http.ServerResponse>();
    let requests = 0;
    const carried = (socket: net.Socket): void => {
        if (carrying.has(socket)) return;
        requests++;
        carrying.add(socket);
        if (socket.destroyed) carrying.delete(socket);
        else socket.once('close', () => carrying.delete(socket));
    };
    let server: net.Server;
    if (shape === 'silent') {
        server = net.createServer((socket) => socket.on('data', () => carried(socket)));
    } else {
        server = http.createServer((req, res) => {
            carried(req.socket);
            req.resume();
            res.writeHead(200, { 'content-type': opts.contentType ?? 'application/octet-stream' });
            res.flushHeaders();
            if (shape === 'partial' && opts.partial) res.write(opts.partial);
            responses.add(res);
            res.once('close', () => responses.delete(res));
        });
    }
    server.on('connection', (socket: net.Socket) => {
        all.add(socket);
        socket.once('close', () => all.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        get requests() {
            return requests;
        },
        get open() {
            return carrying.size;
        },
        push(data) {
            for (const res of responses) res.write(data);
        },
        end(data) {
            for (const res of responses) res.end(data);
        },
        async stop() {
            for (const s of all) s.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
}

/** Wait on real I/O (not the faked clock) until `ok()`, or fail after `ms`. */
async function until(ok: () => boolean, what: string, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
        await new Promise((r) => realSetTimeout(r, 5));
    }
}

/** A fetch that resolves the app's relative cloud paths against `origin`. */
function fetchTo(origin: string): typeof fetch {
    return ((url: string | URL | Request, init?: RequestInit) =>
        fetch(new URL(String(url), origin), init)) as typeof fetch;
}

/** Settlement of `p`, observable without awaiting it. */
function watch<T>(p: Promise<T>): { settled: () => boolean; error: () => unknown; value: () => T | undefined } {
    let settled = false;
    let error: unknown;
    let value: T | undefined;
    p.then(
        (v) => {
            settled = true;
            value = v;
        },
        (e: unknown) => {
            settled = true;
            error = e ?? new Error('rejected');
        }
    );
    return { settled: () => settled, error: () => error, value: () => value };
}

class MemoryKv implements KvStorage {
    private m = new Map<string, string>([['server:token', 'tok']]);
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

const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`;

let server: Stall | null = null;
beforeEach(() => {
    setCloudAuthBackend(new MemoryKv());
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await server?.stop();
    server = null;
});

function llm(origin: string): CloudLlmProvider {
    return new CloudLlmProvider({ provider: 'anthropic', model: 'claude-haiku', fetchImpl: fetchTo(origin) });
}

/** Drain a completion stream into `texts`, noting each chunk as it lands. */
function consume(stream: AsyncIterable<StreamChunk>, texts: string[]): Promise<void> {
    return (async () => {
        for await (const chunk of stream) if (chunk.text) texts.push(chunk.text);
    })();
}

describe('cloud LLM against a stalled server', { timeout: 30_000 }, () => {
    it('complete(): a server that never answers fails at 60 s and the socket is let go', async () => {
        server = await stallServer('silent');
        const call = watch(llm(server.origin).complete([{ role: 'user', content: 'hi' }]));
        await until(() => server!.requests === 1, 'connection');
        await vi.advanceTimersByTimeAsync(LLM_STALL_MS - 1);
        expect(call.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await until(call.settled, 'complete() to fail');
        expect((call.error() as Error).message).toBe('aloud cloud did not respond in time.');
        expect(isConnectionFailure((call.error() as Error).message)).toBe(true);
        await until(() => server!.open === 0, 'socket closed');
        expect(server.requests).toBe(1);
    });

    it('complete(): headers and then nothing fails at 60 s, not never', async () => {
        server = await stallServer('headers', { contentType: 'application/json' });
        const call = watch(llm(server.origin).complete([{ role: 'user', content: 'hi' }]));
        await until(() => server!.requests === 1, 'connection');
        await vi.advanceTimersByTimeAsync(LLM_STALL_MS);
        await until(call.settled, 'complete() to fail');
        expect(isConnectionFailure((call.error() as Error).message)).toBe(true);
        await until(() => server!.open === 0, 'socket closed');
    });

    it('complete(): the caller aborting mid-stall ends it at once and lets the socket go', async () => {
        server = await stallServer('silent');
        const ac = new AbortController();
        const call = watch(llm(server.origin).complete([{ role: 'user', content: 'hi' }], { signal: ac.signal }));
        await until(() => server!.requests === 1, 'connection');
        ac.abort();
        await until(call.settled, 'complete() to end');
        expect(call.error()).toBeDefined();
        await until(() => server!.open === 0, 'socket closed');
    });

    it('stream: a server that never answers fails at 60 s, once, and the socket is let go', async () => {
        server = await stallServer('silent');
        const texts: string[] = [];
        const run = watch(consume(llm(server.origin).completeStream([{ role: 'user', content: 'hi' }]), texts));
        await until(() => server!.requests === 1, 'connection');
        await vi.advanceTimersByTimeAsync(LLM_STALL_MS - 1);
        expect(run.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await until(run.settled, 'stream to fail');
        expect(isConnectionFailure((run.error() as Error).message)).toBe(true);
        await until(() => server!.open === 0, 'socket closed');
        expect(server.requests).toBe(1);
    });

    it('stream: headers and then nothing fails 60 s after the headers', async () => {
        server = await stallServer('headers', { contentType: 'text/event-stream' });
        const texts: string[] = [];
        const run = watch(consume(llm(server.origin).completeStream([{ role: 'user', content: 'hi' }]), texts));
        await until(() => server!.requests === 1, 'connection');
        await vi.advanceTimersByTimeAsync(LLM_STALL_MS - 1);
        expect(run.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await until(run.settled, 'stream to fail');
        expect(isConnectionFailure((run.error() as Error).message)).toBe(true);
        await until(() => server!.open === 0, 'socket closed');
        expect(server.requests).toBe(1);
    });

    it('stream: words and then quiet fails 60 s after the last chunk, without asking again', async () => {
        server = await stallServer('partial', {
            contentType: 'text/event-stream',
            partial: sse({ text: 'Let the breath ', done: false }),
        });
        const texts: string[] = [];
        const run = watch(consume(llm(server.origin).completeStream([{ role: 'user', content: 'hi' }]), texts));
        await until(() => texts.length === 1, 'first words');
        await vi.advanceTimersByTimeAsync(LLM_STALL_MS - 1);
        expect(run.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await until(run.settled, 'stream to fail');
        expect(texts).toEqual(['Let the breath ']);
        expect(isConnectionFailure((run.error() as Error).message)).toBe(true);
        await until(() => server!.open === 0, 'socket closed');
        expect(server.requests).toBe(1);
    });

    it('stream: a slow but live stream is never cut, however long it runs', async () => {
        server = await stallServer('live', { contentType: 'text/event-stream' });
        const texts: string[] = [];
        const run = watch(consume(llm(server.origin).completeStream([{ role: 'user', content: 'hi' }]), texts));
        await until(() => server!.requests === 1, 'connection');
        // Four gaps of 50 s each: 200 s in all, each gap under the limit.
        for (let i = 1; i <= 4; i++) {
            await vi.advanceTimersByTimeAsync(50_000);
            expect(run.settled()).toBe(false);
            server.push(sse({ text: `${i} `, done: false }));
            await until(() => texts.length === i, `chunk ${i}`);
        }
        server.end(sse({ text: '', done: true, result: { finishReason: 'stop', creditsCharged: 1, creditsRemaining: 9 } }));
        await until(run.settled, 'stream to finish');
        expect(run.error()).toBeUndefined();
        expect(texts.join('')).toBe('1 2 3 4 ');
    });

    it('stream: a barge-in (the consumer stops reading) mid-stall lets the socket go at once', async () => {
        server = await stallServer('partial', {
            contentType: 'text/event-stream',
            partial: sse({ text: 'Let the breath ', done: false }),
        });
        const stream = llm(server.origin).completeStream([{ role: 'user', content: 'hi' }]);
        const it = stream[Symbol.asyncIterator]();
        const first = await it.next();
        expect(first.value).toMatchObject({ text: 'Let the breath ' });
        await it.return?.();
        await until(() => server!.open === 0, 'socket closed');
    });

    it('stream: the turn superseded mid-stall (its signal aborts) ends at once and lets the socket go', async () => {
        server = await stallServer('silent');
        const ac = new AbortController();
        const texts: string[] = [];
        const run = watch(
            consume(llm(server.origin).completeStream([{ role: 'user', content: 'hi' }], { signal: ac.signal }), texts)
        );
        await until(() => server!.requests === 1, 'connection');
        ac.abort();
        await until(run.settled, 'stream to end');
        expect(run.error()).toBeDefined();
        await until(() => server!.open === 0, 'socket closed');
    });

    it('keep-alive: headers and then nothing fails at 60 s, so the keep-alive stops instead of hanging', async () => {
        server = await stallServer('headers', { contentType: 'application/json' });
        const ping = watch(llm(server.origin).keepAlive!([{ role: 'user', content: 'hi' }]));
        await until(() => server!.requests === 1, 'connection');
        await vi.advanceTimersByTimeAsync(LLM_STALL_MS);
        await until(ping.settled, 'ping to fail');
        expect(ping.error()).toBeDefined();
        await until(() => server!.open === 0, 'socket closed');
    });
});

/** The shared playback element, enough for speak() to play a clip at once. */
function stubAudio(): void {
    (globalThis as unknown as { Audio: unknown }).Audio = class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onpause: (() => void) | null = null;
        onplaying: (() => void) | null = null;
        preload = '';
        paused = true;
        ended = false;
        src = '';
        removeAttribute(): void {
            this.src = '';
        }
        play(): Promise<void> {
            queueMicrotask(() => {
                this.onplaying?.();
                this.onended?.();
            });
            return Promise.resolve();
        }
        pause(): void {}
    };
    URL.createObjectURL = () => 'blob:x';
    URL.revokeObjectURL = () => {};
}

let ttsText = 0;
/** A sentence no earlier test asked for: synthesis is cached and shared
 *  module-wide. */
const sentence = (): string => `Let the breath settle, number ${++ttsText}.`;

function tts(origin: string): CloudTtsEngine {
    return new CloudTtsEngine({
        voice: 'Harper',
        endpointUrl: `${origin}/cloud/v1/tts`,
        usePost: true,
        authProvider: async () => 'tok',
        networkRetryMs: CLOUD_TTS_RETRY_BUDGET_MS,
    });
}

describe('cloud TTS against a stalled server', { timeout: 30_000 }, () => {
    beforeEach(stubAudio);

    it('a server that never answers fails the sentence at 45 s, once, and the socket is let go', async () => {
        server = await stallServer('silent');
        const speak = watch(tts(server.origin).speak(sentence()));
        await until(() => server!.requests === 1, 'request');
        await vi.advanceTimersByTimeAsync(TTS_STALL_MS - 1);
        expect(speak.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await until(speak.settled, 'speak() to fail');
        expect((speak.error() as Error).message).toBe('aloud cloud TTS timed out.');
        expect(isConnectionFailure((speak.error() as Error).message)).toBe(true);
        await until(() => server!.open === 0, 'socket closed');
        expect(server.requests).toBe(1);
    });

    it('headers and then nothing fails at 45 s and lets the socket go', async () => {
        server = await stallServer('headers', { contentType: 'audio/mpeg' });
        const speak = watch(tts(server.origin).speak(sentence()));
        await until(() => server!.requests === 1, 'request');
        await vi.advanceTimersByTimeAsync(TTS_STALL_MS - 1);
        expect(speak.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await until(speak.settled, 'speak() to fail');
        expect((speak.error() as Error).message).toBe('aloud cloud TTS timed out.');
        await until(() => server!.open === 0, 'socket closed');
    });

    it('half a clip and then nothing fails at 45 s and lets the socket go', async () => {
        server = await stallServer('partial', { contentType: 'audio/mpeg', partial: 'ID3 half a clip' });
        const speak = watch(tts(server.origin).speak(sentence()));
        await until(() => server!.requests === 1, 'request');
        await vi.advanceTimersByTimeAsync(TTS_STALL_MS);
        await until(speak.settled, 'speak() to fail');
        expect((speak.error() as Error).message).toBe('aloud cloud TTS timed out.');
        await until(() => server!.open === 0, 'socket closed');
    });

    it('a clip that trickles in but lands inside the limit plays', async () => {
        server = await stallServer('live', { contentType: 'audio/mpeg' });
        const speak = watch(tts(server.origin).speak(sentence()));
        await until(() => server!.requests === 1, 'request');
        for (let i = 0; i < 4; i++) {
            await vi.advanceTimersByTimeAsync(10_000);
            server.push('frames ');
        }
        server.end('last');
        await until(speak.settled, 'speak() to finish');
        expect(speak.error()).toBeUndefined();
    });

    it('a barge-in (cancel) mid-stall settles the sentence at once; the request still ends at 45 s', async () => {
        server = await stallServer('silent');
        const engine = tts(server.origin);
        const speak = watch(engine.speak(sentence()));
        await until(() => server!.requests === 1, 'request');
        await vi.advanceTimersByTimeAsync(5000);
        await engine.cancel();
        await until(speak.settled, 'speak() to settle');
        expect(speak.error()).toBeUndefined();
        // Not tied to the cancel (a prefetch shares it): it runs to its own
        // deadline, and that failure is nobody's to report.
        expect(server.open).toBe(1);
        await vi.advanceTimersByTimeAsync(TTS_STALL_MS - 5000);
        await until(() => server!.open === 0, 'socket closed');
    });
});

/** The engine's private transcription pass, on one second of tone (as
 *  whisper-pcm-retry.test.ts drives it). */
type TranscribeResult = { ok: true; text: string } | { ok: false; error: unknown };
function transcribe(engine: WhisperPcmSttEngine, label: 'spec' | 'final'): Promise<TranscribeResult> {
    const frame = new Float32Array(16_000).map((_, i) => Math.sin(i / 10) * 0.2);
    const fn = (
        engine as unknown as {
            transcribe: (f: Float32Array[], l: 'spec' | 'final', r: number) => Promise<TranscribeResult>;
        }
    ).transcribe.bind(engine);
    return fn([frame], label, 16_000);
}

function stt(origin: string): WhisperPcmSttEngine {
    return new WhisperPcmSttEngine({
        endpointUrl: `${origin}/cloud/v1/stt`,
        authProvider: async () => 'tok',
        finalRetryBudgetMs: CLOUD_FINAL_RETRY_BUDGET_MS,
    });
}

describe('cloud STT against a stalled server', { timeout: 30_000 }, () => {
    it.each(['final', 'spec'] as const)(
        'a server that never answers fails the %s pass at 45 s, once, and the socket is let go',
        async (label) => {
            server = await stallServer('silent');
            const pass = watch(transcribe(stt(server.origin), label));
            await until(() => server!.requests === 1, 'request');
            await vi.advanceTimersByTimeAsync(STT_STALL_MS - 1);
            expect(pass.settled()).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            await until(pass.settled, 'the pass to fail');
            const result = pass.value()!;
            expect(result.ok).toBe(false);
            const message = ((result as { error: Error }).error).message;
            expect(message).toBe('aloud cloud transcription timed out.');
            expect(isConnectionFailure(message)).toBe(true);
            await until(() => server!.open === 0, 'socket closed');
            expect(server.requests).toBe(1);
        }
    );

    it('headers and then nothing fails the final pass at 45 s, not never', async () => {
        server = await stallServer('headers', { contentType: 'application/json' });
        const pass = watch(transcribe(stt(server.origin), 'final'));
        await until(() => server!.requests === 1, 'request');
        await vi.advanceTimersByTimeAsync(STT_STALL_MS - 1);
        expect(pass.settled()).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        await until(pass.settled, 'the pass to fail');
        expect(pass.value()!.ok).toBe(false);
        expect(isConnectionFailure(((pass.value() as { error: Error }).error).message)).toBe(true);
        await until(() => server!.open === 0, 'socket closed');
    });
});

/** An aloud cloud that stalls while `down` (accepts, reads, never answers)
 *  and answers with `answer` once it is back: what a session meets when the
 *  cloud goes away for a while and comes back. */
interface Outage extends Stall {
    down: boolean;
    /** Request bodies, in order, answered or not. */
    bodies: string[];
}
async function outageServer(answer: (body: string) => { type: string; body: string }): Promise<Outage> {
    const all = new Set<net.Socket>();
    const carrying = new Set<net.Socket>();
    const bodies: string[] = [];
    const state = { down: true };
    const srv = http.createServer((req, res) => {
        carrying.add(req.socket);
        req.socket.once('close', () => carrying.delete(req.socket));
        let body = '';
        req.on('data', (d: Buffer) => (body += d.toString('latin1')));
        req.on('end', () => {
            bodies.push(body);
            if (state.down) return;
            const a = answer(body);
            res.writeHead(200, { 'content-type': a.type });
            res.end(a.body);
        });
    });
    srv.on('connection', (socket: net.Socket) => {
        all.add(socket);
        socket.once('close', () => all.delete(socket));
    });
    await new Promise<void>((resolve) => srv.listen(0, '127.0.0.1', resolve));
    const { port } = srv.address() as AddressInfo;
    return {
        origin: `http://127.0.0.1:${port}`,
        bodies,
        get down() {
            return state.down;
        },
        set down(v: boolean) {
            state.down = v;
        },
        get requests() {
            return bodies.length;
        },
        get open() {
            return carrying.size;
        },
        push() {},
        end() {},
        async stop() {
            for (const s of all) s.destroy();
            await new Promise<void>((resolve) => srv.close(() => resolve()));
        },
    };
}

describe('when aloud cloud comes back after a stall', { timeout: 30_000 }, () => {
    beforeEach(stubAudio);

    it('LLM: the next completion and the next stream go through on the same provider', async () => {
        const cloud = await outageServer((body) =>
            (JSON.parse(body) as { stream: boolean }).stream
                ? {
                      type: 'text/event-stream',
                      body:
                          sse({ text: 'Welcome back.', done: false }) +
                          sse({ text: '', done: true, result: { finishReason: 'stop', creditsCharged: 1, creditsRemaining: 9 } }),
                  }
                : {
                      type: 'application/json',
                      body: JSON.stringify({ text: 'NO', finishReason: 'stop', creditsCharged: 0, creditsRemaining: 9 }),
                  }
        );
        server = cloud;
        const provider = llm(cloud.origin);
        const texts: string[] = [];
        const lost = watch(consume(provider.completeStream([{ role: 'user', content: 'hi' }]), texts));
        const lostCheck = watch(provider.complete([{ role: 'user', content: 'hi' }]));
        await until(() => cloud.requests === 2, 'both requests');
        await vi.advanceTimersByTimeAsync(LLM_STALL_MS);
        await until(() => lost.settled() && lostCheck.settled(), 'both to fail');
        expect(lost.error()).toBeDefined();
        expect(lostCheck.error()).toBeDefined();
        await until(() => cloud.open === 0, 'the stalled sockets let go');

        cloud.down = false;
        const back: string[] = [];
        await consume(provider.completeStream([{ role: 'user', content: 'hi' }]), back);
        expect(back).toEqual(['Welcome back.']);
        expect((await provider.complete([{ role: 'user', content: 'hi' }])).text).toBe('NO');
    });

    it('LLM: what was said in a turn that failed goes with the next one, extending the request it was in', async () => {
        const cloud = await outageServer(() => ({
            type: 'text/event-stream',
            body:
                sse({ text: 'Mm.', done: false }) +
                sse({ text: '', done: true, result: { finishReason: 'stop', creditsCharged: 1, creditsRemaining: 9 } }),
        }));
        server = cloud;
        const provider = llm(cloud.origin);
        const session = new SessionManager({ contextStrategy: 'full' });
        session.startSession('exploration');
        session.addControlMessage('user', '[Begin the session]', 'opener');
        session.addAssistantMessage('Welcome.');
        // A turn as respondTo runs it: the words go into the log before the
        // reply is asked for, and a failed reply takes nothing back out.
        session.addUserMessage('There is a warmth in my chest.');
        const lost = watch(consume(provider.completeStream(session.getContextMessages()), []));
        await until(() => cloud.requests === 1, 'request');
        await vi.advanceTimersByTimeAsync(LLM_STALL_MS);
        await until(lost.settled, 'the reply to fail');
        expect(lost.error()).toBeDefined();

        cloud.down = false;
        session.addUserMessage('It is spreading to my arms.');
        await consume(provider.completeStream(session.getContextMessages()), []);
        type Sent = { messages: Array<{ role: string; content: string }> };
        const [first, second] = cloud.bodies.map((b) => (JSON.parse(b) as Sent).messages) as [Sent['messages'], Sent['messages']];
        expect(second.slice(0, first.length)).toEqual(first);
        expect(second.slice(first.length)).toEqual([{ role: 'user', content: 'It is spreading to my arms.' }]);
        expect(first.at(-1)).toEqual({ role: 'user', content: 'There is a warmth in my chest.' });
    });

    it('TTS: the sentence that failed is asked for again, not remembered as failed', async () => {
        const cloud = await outageServer(() => ({ type: 'audio/mpeg', body: 'ID3 clip' }));
        server = cloud;
        const engine = tts(cloud.origin);
        const text = sentence();
        const lost = watch(engine.speak(text));
        await until(() => cloud.requests === 1, 'request');
        await vi.advanceTimersByTimeAsync(TTS_STALL_MS);
        await until(lost.settled, 'speak() to fail');
        expect(lost.error()).toBeDefined();

        cloud.down = false;
        await engine.speak(text);
        expect(cloud.requests).toBe(2);
    });

    it('TTS: a whole-reply voice goes back to one request per reply after replies that fell to chunks', async () => {
        const cloud = await outageServer(() => ({ type: 'audio/mpeg', body: 'ID3 clip' }));
        server = cloud;
        const engine = tts(cloud.origin);
        const n = ++ttsText;
        const reply = [`Let the breath come and go, ${n}. `, 'Notice where it is easiest to feel. ', 'Stay with that for a while.'];
        const llmStub = {
            model: 'stub',
            async complete() {
                return { text: reply.join(''), finishReason: 'stop', tokensUsed: null };
            },
            async *completeStream(): AsyncIterable<StreamChunk> {
                for (const t of reply) yield { text: t, done: false };
                yield { text: '', done: true, finishReason: 'stop' };
            },
        } as LLMProvider;

        const during = await streamCompletionWithChunkedTts(llmStub, engine, [], { wholeReply: true });
        const duringDone = watch(during.ttsDone);
        await until(() => cloud.requests === 1, 'the whole reply asked for');
        await vi.advanceTimersByTimeAsync(TTS_STALL_MS);
        await until(() => cloud.requests === 4, 'its chunks asked for one at a time');
        await vi.advanceTimersByTimeAsync(TTS_STALL_MS);
        await until(duringDone.settled, 'the reply to end');
        expect(during.heard().text).toBe('');

        cloud.down = false;
        const after = await streamCompletionWithChunkedTts(llmStub, engine, [], { wholeReply: true });
        await after.ttsDone;
        expect(cloud.requests).toBe(5);
        const last = JSON.parse(cloud.bodies[4]!) as { text: string; marks?: number[] };
        expect(last.text).toBe(reply.map((s) => s.trim()).join(' '));
        expect(last.marks).toHaveLength(2);
        expect(after.heard().text).toBe(last.text);
    });

    it('STT: the next pass goes through on the same engine', async () => {
        const cloud = await outageServer(() => ({ type: 'application/json', body: JSON.stringify({ text: 'my hands are warm' }) }));
        server = cloud;
        const engine = stt(cloud.origin);
        const lost = watch(transcribe(engine, 'final'));
        await until(() => cloud.requests === 1, 'request');
        await vi.advanceTimersByTimeAsync(STT_STALL_MS);
        await until(lost.settled, 'the pass to fail');
        expect(lost.value()!.ok).toBe(false);

        cloud.down = false;
        expect(await transcribe(engine, 'final')).toMatchObject({ ok: true, text: 'my hands are warm' });
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CloudTtsEngine } from '../ui/src/adapters/cloud-tts.js';

// HTMLAudioElement isn't in the Node test env; stub a minimal Audio that
// "plays" instantly so speak() resolves. The adapter only needs play() +
// the lifecycle event handlers.
beforeEach(() => {
    (globalThis as unknown as { Audio: unknown }).Audio = class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onpause: (() => void) | null = null;
        preload = '';
        src = '';
        constructor(public url?: string) {}
        play() {
            queueMicrotask(() => this.onended?.());
            return Promise.resolve();
        }
        pause() {}
    };
    (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = () => 'blob:x';
    (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = () => {};
});

describe('CloudTtsEngine (hosted POST mode)', () => {
    it('POSTs JSON with a bearer token and the voice/rate, then plays the audio', async () => {
        let seen: { url: string; init: RequestInit } | null = null;
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            seen = { url: String(url), init: init! };
            return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), {
                status: 200,
            });
        }) as unknown as typeof fetch;

        const onSynthesize = vi.fn();
        const engine = new CloudTtsEngine({
            voice: 'en-US-Chirp3-HD-Achernar',
            endpointUrl: '/v1/tts',
            usePost: true,
            authProvider: async () => 'tok-123',
            fetchImpl,
            onSynthesize,
        });

        await engine.speak('Breathe in.', { rate: 0.9 });

        expect(seen).not.toBeNull();
        const { url, init } = seen!;
        expect(url).toBe('/v1/tts');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-123');
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ text: 'Breathe in.', voice: 'en-US-Chirp3-HD-Achernar', rate: 0.9 });
        expect(onSynthesize).toHaveBeenCalledWith('Breathe in.'.length);
    });

    it('converts a WPM rate to a Google multiplier (160 WPM baseline)', async () => {
        let body: Record<string, unknown> = {};
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
            body = JSON.parse(init!.body as string);
            return new Response(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }), { status: 200 });
        }) as unknown as typeof fetch;

        const engine = new CloudTtsEngine({
            voice: 'en-US-Chirp3-HD-Achernar',
            endpointUrl: '/v1/tts',
            usePost: true,
            authProvider: async () => 't',
            fetchImpl,
        });
        await engine.speak('hi', { rate: 200 }); // 200 wpm
        expect(body['rate']).toBeCloseTo(200 / 160, 6); // → 1.25× multiplier
    });

    it('still supports the legacy GET query mode (Flask)', async () => {
        let seenUrl = '';
        const fetchImpl = (async (url: string | URL | Request) => {
            seenUrl = String(url);
            return new Response(new Blob([new Uint8Array([1])], { type: 'audio/wav' }), { status: 200 });
        }) as unknown as typeof fetch;

        const engine = new CloudTtsEngine({ voice: 'Samantha', endpointUrl: '/api/voices/preview', fetchImpl });
        await engine.speak('hello');
        expect(seenUrl).toContain('/api/voices/preview?');
        expect(seenUrl).toContain('voice=Samantha');
    });
});

describe('CloudTtsEngine hosted 401 self-heal', () => {
    it('clears a stale token and retries once with a fresh one', async () => {
        const tokens = ['stale-token', 'fresh-token'];
        const seen: Array<string | undefined> = [];
        let calls = 0;
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
            calls++;
            const auth = (init?.headers as Record<string, string> | undefined)?.['authorization'];
            seen.push(auth);
            if (calls === 1) {
                return new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 401 });
            }
            return new Response(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }), {
                status: 200,
            });
        }) as unknown as typeof fetch;

        const onAuthError = vi.fn(async () => {
            tokens.shift(); // drop the stale token so the next authProvider() returns the fresh one
        });
        const engine = new CloudTtsEngine({
            voice: 'Leda',
            endpointUrl: '/cloud/v1/tts',
            usePost: true,
            authProvider: async () => tokens[0] ?? null,
            onAuthError,
            fetchImpl,
        });

        await engine.speak('Settle in.');

        expect(calls).toBe(2);
        expect(onAuthError).toHaveBeenCalledTimes(1);
        expect(seen[0]).toBe('Bearer stale-token');
        expect(seen[1]).toBe('Bearer fresh-token');
    });

    it('surfaces a 401 that persists after the retry', async () => {
        const fetchImpl = (async () =>
            new Response('', { status: 401 })) as unknown as typeof fetch;
        const engine = new CloudTtsEngine({
            voice: 'Leda',
            endpointUrl: '/cloud/v1/tts',
            usePost: true,
            authProvider: async () => 'tok',
            onAuthError: async () => {},
            fetchImpl,
        });
        await expect(engine.speak('Hi.')).rejects.toThrow('401');
    });
});

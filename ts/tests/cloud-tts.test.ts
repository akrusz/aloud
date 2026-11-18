import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudTtsEngine } from '../ui/src/adapters/cloud-tts.js';
import { playbackAudio } from '../ui/src/audio-unlock.js';

// Off: play() stays pending until the test starts playback by hand, and a
// pause() or a new src rejects it with AbortError, as a browser does.
let autoPlay = true;

// HTMLAudioElement isn't in the Node test env; stub a minimal Audio that
// "plays" instantly so speak() resolves. The adapter plays through the shared
// element from audio-unlock.ts, which needs play()/pause()/removeAttribute plus
// the lifecycle event handlers.
beforeEach(() => {
    autoPlay = true;
    (globalThis as unknown as { Audio: unknown }).Audio = class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onpause: (() => void) | null = null;
        onplaying: (() => void) | null = null;
        preload = '';
        paused = true;
        ended = false;
        private source = '';
        private pending: ((err: Error) => void) | null = null;
        constructor(public url?: string) {}
        get src() {
            return this.source;
        }
        set src(value: string) {
            this.abortPending();
            this.source = value;
        }
        removeAttribute(_name: string) {
            this.source = '';
        }
        play() {
            this.paused = false;
            if (!autoPlay) {
                return new Promise<void>((_, reject) => (this.pending = reject));
            }
            queueMicrotask(() => {
                this.paused = true;
                this.onplaying?.();
                this.onended?.();
            });
            return Promise.resolve();
        }
        pause() {
            this.paused = true;
            this.abortPending();
        }
        private abortPending() {
            const reject = this.pending;
            this.pending = null;
            reject?.(Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }));
        }
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

    it('prefetch() shares one synthesis (and one charge) with the following speak()', async () => {
        let calls = 0;
        const fetchImpl = (async () => {
            calls++;
            // Defer a tick so the speak() lands while the prefetch is in flight.
            await new Promise((r) => setTimeout(r, 0));
            return new Response(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }), {
                status: 200,
            });
        }) as unknown as typeof fetch;

        const onSynthesize = vi.fn();
        const engine = new CloudTtsEngine({
            voice: 'en-US-Chirp3-HD-Achernar',
            endpointUrl: '/v1/tts',
            usePost: true,
            authProvider: async () => 't',
            fetchImpl,
            onSynthesize,
        });

        engine.prefetch('A sentence arriving early.', { rate: 0.9 });
        await engine.speak('A sentence arriving early.', { rate: 0.9 });

        expect(calls).toBe(1);
        expect(onSynthesize).toHaveBeenCalledTimes(1);
    });

    it('reports onStart when playback begins, before speak() resolves', async () => {
        const fetchImpl = (async () =>
            new Response(new Blob([new Uint8Array([1])], { type: 'audio/mpeg' }), {
                status: 200,
            })) as unknown as typeof fetch;

        const engine = new CloudTtsEngine({
            voice: 'en-US-Chirp3-HD-Achernar',
            endpointUrl: '/v1/tts',
            usePost: true,
            authProvider: async () => 't',
            fetchImpl,
        });

        const events: string[] = [];
        await engine
            .speak('Playback start reporting.', { onStart: () => events.push('start') })
            .then(() => events.push('done'));
        expect(events).toEqual(['start', 'done']);
    });

    it('GETs with query params when usePost is off (the app backend and the public preview)', async () => {
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

describe('CloudTtsEngine on a dropped connection', () => {
    const audio = (): Response =>
        new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), { status: 200 });

    it('a hosted session voice re-sends the sentence (net-retry.ts)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const fetchImpl = vi.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValueOnce(audio());
            const engine = new CloudTtsEngine({
                voice: 'Leda',
                endpointUrl: '/v1/tts',
                usePost: true,
                authProvider: async () => 'tok',
                networkRetryMs: 10_000,
                fetchImpl: fetchImpl as unknown as typeof fetch,
            });
            const spoken = engine.speak('Let the breath come back on its own.');
            await vi.advanceTimersByTimeAsync(600);
            await spoken;
            expect(fetchImpl).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('without a retry budget (loopback, previews) it fails on the first drop', async () => {
        const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
        const engine = new CloudTtsEngine({
            voice: 'Leda',
            endpointUrl: '/v1/tts/unique-for-this-test',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await expect(engine.speak('Just this breath.')).rejects.toThrow('Failed to fetch');
        expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
});


describe('CloudTtsEngine on the shared element', () => {
    const fetchImpl = (async () =>
        new Response(new Blob([new Uint8Array([1])], { type: 'audio/wav' }), {
            status: 200,
        })) as unknown as typeof fetch;

    afterEach(() => {
        autoPlay = true;
    });

    it('an engine taking the element finalizes the one on it, and keeps its own handlers', async () => {
        autoPlay = false;
        const session = new CloudTtsEngine({ voice: 'Leda', endpointUrl: '/handoff/session', fetchImpl });
        const preview = new CloudTtsEngine({ voice: 'Puck', endpointUrl: '/handoff/preview', fetchImpl });
        const audio = playbackAudio();

        let sessionDone = false;
        const sessionLine = session.speak('Notice the breath.').then(() => (sessionDone = true));
        await vi.waitFor(() => expect(audio.onended).not.toBeNull());

        // Its play() is still pending: taking the element rejects it, and that
        // late rejection must not strip the preview's handlers.
        let previewDone = false;
        const previewLine = preview.speak('A preview.').then(() => (previewDone = true));
        await sessionLine;
        expect(sessionDone).toBe(true);
        await new Promise((r) => setTimeout(r, 0));
        expect(previewDone).toBe(false);

        audio.onplaying?.(new Event('playing'));
        audio.onended?.(new Event('ended'));
        await previewLine;
        expect(previewDone).toBe(true);
    });
});

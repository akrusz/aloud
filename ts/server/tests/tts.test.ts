import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { MAX_TTS_CHARS, type AuthResponse } from '../src/contract.js';

// MP3 bytes Google would return, base64-encoded as audioContent.
const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // "ID3"
let googleCalls: Array<{ url: string; body: any }> = [];
let openaiCalls: Array<{ url: string; body: any; auth: string | null }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
    googleCalls = [];
    openaiCalls = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('texttospeech.googleapis.com')) {
            googleCalls.push({ url: u, body: JSON.parse(init?.body as string) });
            return new Response(
                JSON.stringify({ audioContent: Buffer.from(FAKE_MP3).toString('base64') }),
                { status: 200 }
            );
        }
        if (u.includes('api.openai.com/v1/audio/speech')) {
            const headers = (init?.headers ?? {}) as Record<string, string>;
            openaiCalls.push({
                url: u,
                body: JSON.parse(init?.body as string),
                auth: headers['authorization'] ?? null,
            });
            // OpenAI returns the audio as the raw response body (not base64 JSON).
            return new Response(FAKE_MP3, { status: 200 });
        }
        return realFetch(url, init);
    }) as typeof fetch;
});

function app() {
    const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', GOOGLE_TTS_API_KEY: 'tts-key', ALOUD_FREE_SIGNUP_CREDITS: '20' });
    return createApp(buildDeps(config));
}

async function devToken(a: ReturnType<typeof createApp>): Promise<string> {
    const res = await a.request('/cloud/v1/auth/dev', { method: 'POST' });
    return ((await res.json()) as AuthResponse).token;
}

describe('POST /cloud/v1/tts', () => {
    it('synthesizes MP3 via Google and reports cost in headers', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'Breathe in.', voice: 'en-US-Chirp3-HD-Achernar', rate: 0.9 }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('audio/mpeg');
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect(Array.from(bytes)).toEqual(Array.from(FAKE_MP3));

        // Cost rides in headers; ~0.0000066 credits for 11 chars — fractional.
        const charged = Number(res.headers.get('X-Credits-Charged'));
        expect(charged).toBeGreaterThan(0);
        expect(Number(res.headers.get('X-Credits-Remaining'))).toBeCloseTo(20 - charged, 6);

        // Forwarded the right voice + derived languageCode.
        expect(googleCalls).toHaveLength(1);
        const sent = googleCalls[0]!.body as {
            voice: { name: string; languageCode: string };
            audioConfig: { speakingRate: number };
        };
        expect(sent.voice.name).toBe('en-US-Chirp3-HD-Achernar');
        expect(sent.voice.languageCode).toBe('en-US');
        expect(sent.audioConfig.speakingRate).toBe(0.9);
    });

    it('clamps an out-of-range speakingRate into Google\'s accepted band', async () => {
        const a = app();
        const token = await devToken(a);
        // A stray WPM-ish value that slipped through as a "multiplier".
        const res = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hi', rate: 50 }),
        });
        expect(res.status).toBe(200);
        const sent = googleCalls[0]!.body as { audioConfig: { speakingRate: number } };
        expect(sent.audioConfig.speakingRate).toBe(4); // clamped to the [0.25, 4.0] max
    });

    it('requires auth', async () => {
        const res = await app().request('/cloud/v1/tts', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hi' }),
        });
        expect(res.status).toBe(401);
    });

    it('400s on empty text', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: '   ' }),
        });
        expect(res.status).toBe(400);
    });

    it('400s over the char cap without spending or calling the provider', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'a'.repeat(MAX_TTS_CHARS + 1) }),
        });
        expect(res.status).toBe(400);
        expect(googleCalls).toHaveLength(0);
    });

    it('reports provider_error without a TTS key', async () => {
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', ALOUD_FREE_SIGNUP_CREDITS: '20' });
        const a = createApp(buildDeps(config));
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hi' }),
        });
        expect(res.status).toBe(502);
    });
});

describe('POST /cloud/v1/tts/canned', () => {
    /** An app whose accounts start with ZERO credits — the case the canned
     *  endpoint exists for (the metered /tts 402s here). */
    function brokeApp() {
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', GOOGLE_TTS_API_KEY: 'tts-key', ALOUD_FREE_SIGNUP_CREDITS: '0' });
        return createApp(buildDeps(config));
    }

    it('voices the apology for a zero-balance account (no charge, no balance gate)', async () => {
        const a = brokeApp();
        const token = await devToken(a);

        // The metered path is closed at zero balance...
        const metered = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hi' }),
        });
        expect(metered.status).toBe(402);

        // ...but the canned apology still speaks.
        const res = await a.request('/cloud/v1/tts/canned', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'insufficient_credits', voice: 'en-US-Chirp3-HD-Achernar' }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('audio/mpeg');
        expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(FAKE_MP3));
        // No metering headers — it's free.
        expect(res.headers.get('X-Credits-Charged')).toBeNull();
    });

    it('synthesizes once per (reason, voice) and serves the cache thereafter', async () => {
        const a = brokeApp();
        const token = await devToken(a);
        const call = () =>
            a.request('/cloud/v1/tts/canned', {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ reason: 'paused', voice: 'en-US-Chirp3-HD-Achernar' }),
            });
        await call();
        await call();
        // Cache is process-lifetime, so the prior test's insufficient_credits
        // synth may also be present; the key invariant is this voice+reason
        // synthesized at most once across the two calls above.
        const pausedCalls = googleCalls.filter(
            (c) => (c.body as { input: { text: string } }).input.text.includes('limit of free credit')
        );
        expect(pausedCalls).toHaveLength(1);
    });

    it('400s on an unknown reason', async () => {
        const a = brokeApp();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/tts/canned', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'whatever' }),
        });
        expect(res.status).toBe(400);
    });

    it('requires auth', async () => {
        const res = await brokeApp().request('/cloud/v1/tts/canned', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ reason: 'paused' }),
        });
        expect(res.status).toBe(401);
    });
});

describe('GET /cloud/v1/tts/preview', () => {
    it('previews a curated voice with no auth and no charge', async () => {
        const a = app();
        // No Authorization header at all — the endpoint is public.
        const res = await a.request('/cloud/v1/tts/preview?voice=Leda');
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('audio/mpeg');
        expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(FAKE_MP3));
        // Free: no metering headers.
        expect(res.headers.get('X-Credits-Charged')).toBeNull();
        // Spoke the server-owned phrase through Leda's Google id.
        expect(googleCalls).toHaveLength(1);
        const sent = googleCalls[0]!.body as {
            voice: { name: string };
            input: { text: string };
        };
        expect(sent.voice.name).toBe('en-US-Chirp3-HD-Leda');
        expect(sent.input.text).toContain('Welcome to aloud');
    });

    it('synthesizes once per voice, then serves the cache', async () => {
        const a = app();
        // Vega is used only here, so the per-test googleCalls reset means a cold
        // cache: first call synthesizes, second is served from PREVIEW_AUDIO.
        await a.request('/cloud/v1/tts/preview?voice=Vega');
        await a.request('/cloud/v1/tts/preview?voice=Vega');
        const vegaCalls = googleCalls.filter(
            (c) => (c.body as { voice: { name: string } }).voice.name === 'en-US-Neural2-F'
        );
        expect(vegaCalls).toHaveLength(1);
    });

    it('400s on a non-curated voice (no free arbitrary synthesis)', async () => {
        const res = await app().request('/cloud/v1/tts/preview?voice=en-US-Chirp3-HD-Achernar');
        expect(res.status).toBe(400);
        expect(googleCalls).toHaveLength(0);
    });

    it('reports provider_error without a TTS key', async () => {
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', ALOUD_FREE_SIGNUP_CREDITS: '20' });
        const a = createApp(buildDeps(config));
        const res = await a.request('/cloud/v1/tts/preview?voice=Leda');
        expect(res.status).toBe(502);
    });

    it('previews an OpenAI voice via OpenAI when its key is set', async () => {
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', OPENAI_TTS_API_KEY: 'oai-key' });
        const a = createApp(buildDeps(config));
        const res = await a.request('/cloud/v1/tts/preview?voice=Lyra'); // Lyra → shimmer
        expect(res.status).toBe(200);
        expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(FAKE_MP3));
        expect(googleCalls).toHaveLength(0);
        expect(openaiCalls).toHaveLength(1);
        expect(openaiCalls[0]!.body.voice).toBe('shimmer');
        expect(openaiCalls[0]!.body.input).toContain('Welcome to aloud');
    });
});

describe('POST /cloud/v1/tts — OpenAI voices', () => {
    function openaiApp() {
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', OPENAI_TTS_API_KEY: 'oai-key', ALOUD_FREE_SIGNUP_CREDITS: '20' });
        return createApp(buildDeps(config));
    }

    it('routes a curated OpenAI voice to OpenAI (not Google) and bills it', async () => {
        const a = openaiApp();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'Breathe in.', voice: 'Lyra', rate: 0.9 }),
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('audio/mpeg');
        expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual(Array.from(FAKE_MP3));
        expect(Number(res.headers.get('X-Credits-Charged'))).toBeGreaterThan(0);

        // It went to OpenAI, with the resolved voice + model + a steering instruction.
        expect(googleCalls).toHaveLength(0);
        expect(openaiCalls).toHaveLength(1);
        const sent = openaiCalls[0]!.body;
        expect(sent.model).toBe('gpt-4o-mini-tts');
        expect(sent.voice).toBe('shimmer'); // Lyra → shimmer
        expect(sent.response_format).toBe('mp3');
        expect(typeof sent.instructions).toBe('string');
        expect(openaiCalls[0]!.auth).toBe('Bearer oai-key');
    });

    it('502s for an OpenAI voice when only the Google key is configured', async () => {
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', GOOGLE_TTS_API_KEY: 'tts-key', ALOUD_FREE_SIGNUP_CREDITS: '20' });
        const a = createApp(buildDeps(config));
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'hi', voice: 'Lyra' }),
        });
        expect(res.status).toBe(502);
        // Neither provider was actually called — it fails fast on the missing key.
        expect(openaiCalls).toHaveLength(0);
        expect(googleCalls).toHaveLength(0);
    });
});

describe('POST /cloud/v1/tts — up-front cost gate', () => {
    it('refuses synthesis whose estimated cost exceeds the balance (no provider call)', async () => {
        // A dust balance passes a naive balance > 0 gate but can't fund a long
        // synthesis — the route must refuse before calling the provider.
        const config = loadConfig({
            ALOUD_ENABLE_DEV_AUTH: '1',
            GOOGLE_TTS_API_KEY: 'tts-key',
            ALOUD_FREE_SIGNUP_CREDITS: '0',
        });
        const deps = buildDeps(config);
        const a = createApp(deps);
        const token = await devToken(a);
        const accountId = (await deps.store.allAccounts())[0]!.id;
        await deps.ledger.grant(accountId, 0.000001, 'test dust');

        const res = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            // Under MAX_TTS_CHARS (that's a separate 400) but far past a dust balance.
            body: JSON.stringify({ text: 'so long, and thanks for all the breaths. '.repeat(20) }),
        });
        expect(res.status).toBe(402);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('insufficient_credits');
        expect(googleCalls).toHaveLength(0); // refused BEFORE spending on the provider
    });

    it('still synthesizes when the estimate fits the balance', async () => {
        const a = app();
        const token = await devToken(a); // 20 credits — plenty for a short phrase
        const res = await a.request('/cloud/v1/tts', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ text: 'Breathe out.' }),
        });
        expect(res.status).toBe(200);
        expect(googleCalls).toHaveLength(1);
    });
});

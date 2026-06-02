import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { AuthResponse } from '../src/contract.js';

// MP3 bytes Google would return, base64-encoded as audioContent.
const FAKE_MP3 = new Uint8Array([0x49, 0x44, 0x33, 0x04]); // "ID3"
let googleCalls: Array<{ url: string; body: unknown }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
    googleCalls = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('texttospeech.googleapis.com')) {
            googleCalls.push({ url: u, body: JSON.parse(init?.body as string) });
            return new Response(
                JSON.stringify({ audioContent: Buffer.from(FAKE_MP3).toString('base64') }),
                { status: 200 }
            );
        }
        return realFetch(url, init);
    }) as typeof fetch;
});

function app() {
    const config = loadConfig({ GOOGLE_TTS_API_KEY: 'tts-key', ALOUD_FREE_SIGNUP_CREDITS: '20' });
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

    it('reports provider_error without a TTS key', async () => {
        const config = loadConfig({ ALOUD_FREE_SIGNUP_CREDITS: '20' });
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
        const config = loadConfig({ GOOGLE_TTS_API_KEY: 'tts-key', ALOUD_FREE_SIGNUP_CREDITS: '0' });
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

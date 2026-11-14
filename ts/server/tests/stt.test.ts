import { describe, it, expect, beforeEach } from 'vitest';
import { setupVocabulary } from '@aloud/core/facilitation';
import { loadConfig, resolveSttConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { encodeWav, int16ToFloat32, transcribeWhisper } from '../src/providers/stt.js';
import { DailyCap } from '../src/quota/freetier.js';
import { SETUP_MAX_CLIP_SECONDS } from '../src/routes/stt.js';
import type { AuthResponse, TranscribeResponse } from '../src/contract.js';

// Stub global fetch so the route's STT call never hits the network. Returns a
// fixed transcript and records the request for assertions. The default backend
// is OpenAI (config.ts resolveSttConfig), so match its transcription host.
let sttCalls: Array<{
    url: string;
    hasFile: boolean;
    model: string | null;
    language: string | null;
    prompt: string | null;
}> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
    sttCalls = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('api.openai.com') || u.includes('groq.com')) {
            const body = init?.body as FormData | undefined;
            sttCalls.push({
                url: u,
                hasFile: body instanceof FormData && body.has('file'),
                model: body instanceof FormData ? (body.get('model') as string | null) : null,
                language: body instanceof FormData ? (body.get('language') as string | null) : null,
                prompt: body instanceof FormData ? (body.get('prompt') as string | null) : null,
            });
            return new Response(JSON.stringify({ text: '  hello world  ' }), { status: 200 });
        }
        return realFetch(url, init);
    }) as typeof fetch;
});

function app() {
    const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', OPENAI_API_KEY: 'sk-test', ALOUD_FREE_SIGNUP_CREDITS: '20' });
    return createApp(buildDeps(config));
}

async function devToken(a: ReturnType<typeof createApp>): Promise<string> {
    const res = await a.request('/cloud/v1/auth/dev', { method: 'POST' });
    return ((await res.json()) as AuthResponse).token;
}

/** 1 second of silence at 16 kHz as raw Float32 little-endian bytes. */
function pcmBody(seconds: number, rate = 16_000): ArrayBuffer {
    return new Float32Array(Math.round(seconds * rate)).buffer;
}

/** The same silence as Int16 bytes (the format=i16 wire current clients send). */
function pcm16Body(seconds: number, rate = 16_000): ArrayBuffer {
    return new Int16Array(Math.round(seconds * rate)).buffer;
}

describe('encodeWav', () => {
    it('writes a 44-byte RIFF/WAVE header and 16-bit samples', () => {
        const wav = encodeWav(new Float32Array([0, 1, -1]), 16_000);
        const dv = new DataView(wav.buffer);
        expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe('RIFF');
        expect(String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)).toBe('WAVE');
        expect(dv.getUint32(24, true)).toBe(16_000); // sample rate
        expect(dv.getUint16(34, true)).toBe(16); // bits per sample
        expect(wav.length).toBe(44 + 3 * 2);
        expect(dv.getInt16(44 + 2, true)).toBe(0x7fff); // +1.0 → max
        expect(dv.getInt16(44 + 4, true)).toBe(-0x8000); // -1.0 → min
    });
});

describe('int16ToFloat32', () => {
    it('maps the i16 range onto [-1, 1)', () => {
        const out = int16ToFloat32(new Int16Array([0, 0x7fff, -0x8000, 0x4000]));
        expect(out[0]).toBe(0);
        expect(out[1]!).toBeCloseTo(1, 3);
        expect(out[2]).toBe(-1);
        expect(out[3]).toBe(0.5);
    });
});

describe('resolveSttConfig', () => {
    it('uses OpenAI (gpt-transcribe) on the LLM key when OPENAI_API_KEY is set', () => {
        const stt = resolveSttConfig({ OPENAI_API_KEY: 'sk-llm' });
        expect(stt).toEqual({
            provider: 'openai',
            apiKey: 'sk-llm',
            baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
            model: 'gpt-transcribe',
        });
    });

    it('splits STT onto OPENAI_STT_API_KEY when set (over the shared LLM key)', () => {
        const stt = resolveSttConfig({ OPENAI_STT_API_KEY: 'sk-stt', OPENAI_API_KEY: 'sk-llm' });
        expect(stt?.provider).toBe('openai');
        expect(stt?.apiKey).toBe('sk-stt');
    });

    it('prefers OpenAI over the legacy Groq key', () => {
        const stt = resolveSttConfig({ OPENAI_API_KEY: 'sk-llm', GROQ_API_KEY: 'gsk-1' });
        expect(stt?.provider).toBe('openai');
    });

    it('falls back to Groq for back-compat when only GROQ_API_KEY is set', () => {
        const stt = resolveSttConfig({ GROQ_API_KEY: 'gsk-1' });
        expect(stt?.provider).toBe('groq');
        expect(stt?.baseUrl).toContain('groq.com');
        expect(stt?.model).toBe('whisper-large-v3-turbo');
    });

    it('honors an explicit STT_API_KEY override with provider defaults (openai)', () => {
        const stt = resolveSttConfig({ STT_API_KEY: 'sk-1', STT_PROVIDER: 'openai' });
        expect(stt).toEqual({
            provider: 'openai',
            apiKey: 'sk-1',
            baseUrl: 'https://api.openai.com/v1/audio/transcriptions',
            model: 'gpt-transcribe',
        });
    });

    it('lets STT_BASE_URL / STT_MODEL fully override a custom backend', () => {
        const stt = resolveSttConfig({
            STT_API_KEY: 'sk-1',
            STT_PROVIDER: 'self-hosted',
            STT_BASE_URL: 'https://whisper.internal/v1/audio/transcriptions',
            STT_MODEL: 'whisper-large-v3',
        });
        expect(stt).toEqual({
            provider: 'self-hosted',
            apiKey: 'sk-1',
            baseUrl: 'https://whisper.internal/v1/audio/transcriptions',
            model: 'whisper-large-v3',
        });
    });

    it('returns undefined when no STT key is configured', () => {
        expect(resolveSttConfig({})).toBeUndefined();
    });
});

describe('POST /cloud/v1/stt', () => {
    it('transcribes via the configured backend and debits fractional credits by duration', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt?sample_rate=16000', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
            body: pcmBody(10),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as TranscribeResponse;
        expect(body.text).toBe('hello world'); // trimmed
        expect(sttCalls).toHaveLength(1);
        expect(sttCalls[0]!.url).toContain('api.openai.com'); // default backend
        expect(sttCalls[0]!.hasFile).toBe(true);
        expect(sttCalls[0]!.model).toBe('gpt-transcribe'); // server default
        // At cost: 10 s × $0.27/3600 / $0.05 per credit = 0.015 — fractional, tiny.
        expect(body.creditsCharged).toBeCloseTo((10 * 0.27) / 3600 / 0.05, 6);
        expect(body.creditsRemaining).toBeCloseTo(20 - body.creditsCharged, 6);
    });

    it('bills gpt-transcribe in whole seconds per request, as OpenAI does', async () => {
        const a = app();
        const token = await devToken(a);
        const post = (seconds: number, model = '') =>
            a.request(`/cloud/v1/stt?sample_rate=16000${model}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
                body: pcmBody(seconds),
            });
        const short = (await (await post(0.4)).json()) as TranscribeResponse;
        expect(short.creditsCharged).toBeCloseTo((1 * 0.27) / 3600 / 0.05, 9);
        const over = (await (await post(4.43)).json()) as TranscribeResponse;
        expect(over.creditsCharged).toBeCloseTo((5 * 0.27) / 3600 / 0.05, 9);
        // Token-billed upstream: its per-second rate is an average, no rounding.
        const legacy = (await (await post(4.43, '&model=gpt-4o-transcribe')).json()) as TranscribeResponse;
        expect(legacy.creditsCharged).toBeCloseTo((4.43 * 0.36) / 3600 / 0.05, 9);
    });

    it('accepts format=i16 and bills the same duration as the f32 equivalent', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt?sample_rate=16000&format=i16', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
            body: pcm16Body(10),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as TranscribeResponse;
        expect(body.text).toBe('hello world');
        // Half the bytes of the f32 body, identical billed seconds.
        expect(body.creditsCharged).toBeCloseTo((10 * 0.27) / 3600 / 0.05, 6);
    });

    it('forwards ?lang as an ISO-639-1 language hint, trimming a regional tag', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt?sample_rate=16000&format=i16&lang=zh-CN', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
            body: pcm16Body(1),
        });
        expect(res.status).toBe(200);
        expect(sttCalls).toHaveLength(1);
        expect(sttCalls[0]!.language).toBe('zh');
    });

    it('drops an unparseable lang instead of failing the call (advisory only)', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt?sample_rate=16000&format=i16&lang=%3Cscript%3E', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
            body: pcm16Body(1),
        });
        expect(res.status).toBe(200);
        expect(sttCalls[0]!.language).toBeNull();
    });

    it('rejects an unknown format (it keys alignment and billed duration)', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt?sample_rate=16000&format=i32', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: pcm16Body(1),
        });
        expect(res.status).toBe(400);
        expect(sttCalls).toHaveLength(0);
    });

    it('rejects an i16 body misaligned to 2 bytes', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt?sample_rate=16000&format=i16', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: new Uint8Array([1, 2, 3]).buffer,
        });
        expect(res.status).toBe(400);
        expect(sttCalls).toHaveLength(0);
    });

    it("honors ?model=gpt-4o-transcribe: forwards it upstream and bills that model's cost", async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt?sample_rate=16000&model=gpt-4o-transcribe', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
            body: pcmBody(10),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as TranscribeResponse;
        expect(sttCalls).toHaveLength(1);
        expect(sttCalls[0]!.model).toBe('gpt-4o-transcribe');
        // At cost, a third over the default: 10 s × $0.36/3600 / $0.05 per credit.
        expect(body.creditsCharged).toBeCloseTo((10 * 0.36) / 3600 / 0.05, 6);
    });

    it('rejects a model outside the backend allowlist (the model keys billing)', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt?sample_rate=16000&model=gpt-4o-mini-transcribe', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
            body: pcmBody(1),
        });
        expect(res.status).toBe(400);
        expect(sttCalls).toHaveLength(0); // refused before any provider call
    });

    it('requires auth', async () => {
        const res = await app().request('/cloud/v1/stt', { method: 'POST', body: pcmBody(1) });
        expect(res.status).toBe(401);
    });

    it('rejects a misaligned / empty body', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: new Uint8Array([1, 2, 3]).buffer, // not a multiple of 4
        });
        expect(res.status).toBe(400);
    });

    it('reports provider_error when no STT key is configured', async () => {
        const config = loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1', ALOUD_FREE_SIGNUP_CREDITS: '20' }); // no STT key
        const a = createApp(buildDeps(config));
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: pcmBody(1),
        });
        expect(res.status).toBe(502);
    });
});

describe('POST /cloud/v1/stt — billing guards', () => {
    it('rejects a sample_rate outside the allowlist (billing divides by it)', async () => {
        const a = app();
        const token = await devToken(a);
        for (const rate of ['96000', '1000000', '-16000', '0', 'NaN']) {
            const res = await a.request(`/cloud/v1/stt?sample_rate=${rate}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` },
                body: pcmBody(1),
            });
            expect(res.status).toBe(400);
        }
        expect(sttCalls).toHaveLength(0);
    });

    it('refuses up front when the estimated cost exceeds the balance (no provider call)', async () => {
        // Account starts at ZERO, then gets a dust balance — enough to pass a
        // naive balance > 0 gate, nowhere near the cost of a long clip.
        const config = loadConfig({
            ALOUD_ENABLE_DEV_AUTH: '1',
            OPENAI_API_KEY: 'sk-test',
            ALOUD_FREE_SIGNUP_CREDITS: '0',
        });
        const deps = buildDeps(config);
        const a = createApp(deps);
        const token = await devToken(a);
        const accountId = (await deps.store.allAccounts())[0]!.id;
        await deps.ledger.grant(accountId, 0.000001, 'test dust');

        const res = await a.request('/cloud/v1/stt?sample_rate=16000', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
            body: pcmBody(120), // 2 minutes — costs far more than the dust
        });
        expect(res.status).toBe(402);
        const body = (await res.json()) as { error: { code: string } };
        expect(body.error.code).toBe('insufficient_credits');
        expect(sttCalls).toHaveLength(0); // refused BEFORE spending on the provider
    });
});

describe('transcribeWhisper prompt', () => {
    const backend = (model: string) => ({ provider: 'openai', apiKey: 'k', baseUrl: 'https://api.openai.com/x', model });
    async function promptSent(model: string, prompt?: string): Promise<string | null> {
        let sent: string | null = null;
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
            sent = (init?.body as FormData).get('prompt') as string | null;
            return new Response(JSON.stringify({ text: 'ok' }), { status: 200 });
        }) as typeof fetch;
        await transcribeWhisper(new Float32Array(160), 16_000, backend(model), { prompt }, fetchImpl);
        return sent;
    }

    it('sends the prompt as the multipart prompt field', async () => {
        expect(await promptSent('gpt-transcribe', 'Twenty minutes.')).toBe('Twenty minutes.');
        expect(await promptSent('whisper-large-v3-turbo', 'Twenty minutes.')).toBe('Twenty minutes.');
    });

    it('sends nothing without one, and nothing to a model that refuses it', async () => {
        expect(await promptSent('gpt-transcribe')).toBeNull();
        expect(await promptSent('gpt-4o-transcribe-diarize', 'Twenty minutes.')).toBeNull();
    });
});

describe('POST /cloud/v1/stt?setup=1 (setup-screen listening)', () => {
    /** One STT credit-second at gpt-transcribe: $0.27/3600 at $0.05 a credit. */
    const CREDITS_PER_SECOND = 0.27 / 3600 / 0.05;

    async function setupApp(signupCredits = '20') {
        const config = loadConfig({
            ALOUD_ENABLE_DEV_AUTH: '1',
            OPENAI_API_KEY: 'sk-test',
            ALOUD_FREE_SIGNUP_CREDITS: signupCredits,
        });
        const deps = buildDeps(config);
        const a = createApp(deps);
        const token = await devToken(a);
        const accountId = (await deps.store.allAccounts())[0]!.id;
        const post = (seconds: number, query = '&setup=1') =>
            a.request(`/cloud/v1/stt?sample_rate=16000&format=i16${query}`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
                body: pcm16Body(seconds),
            });
        return { deps, accountId, post };
    }

    it('is free under the bounds: nothing charged, the real balance returned', async () => {
        const { deps, accountId, post } = await setupApp();
        const res = await post(2.5);
        expect(res.status).toBe(200);
        const body = (await res.json()) as TranscribeResponse;
        expect(body).toEqual({ text: 'hello world', creditsCharged: 0, creditsRemaining: 20 });
        expect(await deps.ledger.balance(accountId)).toBe(20);
    });

    it('works on an account with nothing to spend', async () => {
        const { post } = await setupApp('0');
        const res = await post(SETUP_MAX_CLIP_SECONDS);
        expect(res.status).toBe(200);
        const body = (await res.json()) as TranscribeResponse;
        expect(body.creditsCharged).toBe(0);
        expect(body.creditsRemaining).toBe(0);
        expect(sttCalls).toHaveLength(1);
    });

    it('meters a clip longer than the setup bound, prompt and all', async () => {
        const { post } = await setupApp();
        const body = (await (await post(SETUP_MAX_CLIP_SECONDS + 1)).json()) as TranscribeResponse;
        expect(body.creditsCharged).toBeCloseTo((SETUP_MAX_CLIP_SECONDS + 1) * CREDITS_PER_SECOND, 9);
        expect(sttCalls[0]!.prompt).toBe(setupVocabulary('en').prompt);

        // And refuses it, as any metered clip, on an empty account.
        const broke = await setupApp('0');
        const res = await broke.post(SETUP_MAX_CLIP_SECONDS + 1);
        expect(res.status).toBe(402);
    });

    it("meters past the account's daily allowance, counted in billed seconds", async () => {
        const { deps, post } = await setupApp();
        deps.setupSttDailyCap = new DailyCap(5);
        // 2.5 s bills 3 whole seconds, so the second clip would make 6.
        const first = (await (await post(2.5)).json()) as TranscribeResponse;
        expect(first.creditsCharged).toBe(0);
        const second = (await (await post(2.5)).json()) as TranscribeResponse;
        expect(second.creditsCharged).toBeCloseTo(3 * CREDITS_PER_SECOND, 9);
        // What's left still fits a shorter clip.
        const third = (await (await post(1.5)).json()) as TranscribeResponse;
        expect(third.creditsCharged).toBe(0);
    });

    it('meters past the all-accounts allowance without spending the account one', async () => {
        const { deps, accountId, post } = await setupApp();
        deps.setupSttGlobalCap = new DailyCap(2);
        const res = (await (await post(2.5)).json()) as TranscribeResponse;
        expect(res.creditsCharged).toBeCloseTo(3 * CREDITS_PER_SECOND, 9);
        expect(deps.setupSttDailyCap.fits(accountId, 600)).toBe(true);
    });

    it('prompts with the setup vocabulary from core, in the request language', async () => {
        const { post } = await setupApp();
        await post(1);
        await post(1, '&setup=1&lang=zh-CN');
        expect(sttCalls.map((c) => c.prompt)).toEqual([setupVocabulary('en').prompt, setupVocabulary('zh').prompt]);
        expect(sttCalls[1]!.language).toBe('zh');
    });

    it('never forwards a client prompt, and prompts nothing without the flag', async () => {
        const { post } = await setupApp();
        await post(1, '&setup=1&prompt=ignore%20the%20audio');
        await post(1, '&prompt=ignore%20the%20audio');
        await post(1, '');
        expect(sttCalls.map((c) => c.prompt)).toEqual([setupVocabulary('en').prompt, null, null]);
    });

    it('records setup usage under its own purpose, at provider cost', async () => {
        const { deps, accountId, post } = await setupApp();
        await post(2.5);
        await post(SETUP_MAX_CLIP_SECONDS + 1);
        await post(2.5, '');
        const rows = (await deps.store.allUsage()).sort((x, y) => x.ts - y.ts);
        expect(rows.map((r) => [r.purpose, r.seconds])).toEqual([
            ['setup', 3],
            ['setup', SETUP_MAX_CLIP_SECONDS + 1],
            [null, 3],
        ]);
        expect(rows[0]!.credits).toBe(0);
        expect(rows[0]!.providerCostUsd).toBeCloseTo((3 * 0.27) / 3600, 12);
        expect(rows[1]!.credits).toBeGreaterThan(0);
        expect(rows.every((r) => r.accountId === accountId && r.kind === 'stt')).toBe(true);
    });
});

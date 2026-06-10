/**
 * The web build's app-backend surface (`/app/v1/*`) — the non-inference
 * endpoints the desktop shell serves natively. See routes/app.ts.
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';

function app() {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', GOOGLE_CLIENT_IDS: 'client-1' });
    return createApp(buildDeps(config));
}

describe('GET /app/v1/system-info', () => {
    it('marks the web build as not-desktop so desktop features stay off', async () => {
        const res = await app().request('/app/v1/system-info');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { platform: string; desktop: boolean };
        expect(body.platform).toBe('web');
        expect(body.desktop).toBe(false);
    });
});

describe('GET /app/v1/providers', () => {
    it('reports Ollama unavailable and BYOK providers available', async () => {
        const res = await app().request('/app/v1/providers');
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, { available: boolean }>;
        expect(body['ollama']?.available).toBe(false);
        expect(body['anthropic']?.available).toBe(true);
        expect(body['openrouter']?.available).toBe(true);
    });
});

describe('GET /app/v1/voices', () => {
    it('returns an empty local-voice list on the web (hosted voices are separate)', async () => {
        const res = await app().request('/app/v1/voices');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });
});

describe('GET /app/v1/models/:provider', () => {
    it('returns the static alias list for claude_proxy (no network)', async () => {
        const res = await app().request('/app/v1/models/claude_proxy');
        expect(res.status).toBe(200);
        const body = (await res.json()) as Array<{ value: string }>;
        expect(body.map((m) => m.value)).toContain('opus');
    });

    it('returns [] for a key-requiring provider when no key is forwarded', async () => {
        const res = await app().request('/app/v1/models/openai');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });
});

describe('GET /app/v1/models/:provider — per-IP rate limit', () => {
    it('429s after the per-minute budget; other IPs unaffected', async () => {
        const a = app();
        const get = (ip: string) =>
            a.request('/app/v1/models/claude_proxy', { headers: { 'x-forwarded-for': ip } });
        // The guard allows 30/min per IP.
        for (let i = 0; i < 30; i++) {
            expect((await get('203.0.113.7')).status).toBe(200);
        }
        expect((await get('203.0.113.7')).status).toBe(429);
        expect((await get('198.51.100.8')).status).toBe(200);
    });
});

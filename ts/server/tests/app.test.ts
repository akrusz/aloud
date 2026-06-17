import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';

function app() {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', GOOGLE_CLIENT_IDS: 'client-1' });
    return createApp(buildDeps(config));
}

function corsApp(origins: string) {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ALOUD_CORS_ORIGINS: origins });
    return createApp(buildDeps(config));
}

describe('app', () => {
    it('GET /health reports configured providers without leaking keys', async () => {
        const res = await app().request('/health');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; providers: string[] };
        expect(body.ok).toBe(true);
        expect(body.providers).toContain('anthropic');
        expect(JSON.stringify(body)).not.toContain('sk-test');
    });

    it('GET /cloud/v1/me requires auth', async () => {
        const res = await app().request('/cloud/v1/me');
        expect(res.status).toBe(401);
    });

    it('GET /cloud/v1/me/models is public and publishes the markup', async () => {
        const res = await app().request('/cloud/v1/me/models');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { packMarkup: number; usdPerCredit: number; models: unknown[] };
        expect(body.packMarkup).toBeGreaterThan(1);
        expect(body.usdPerCredit).toBeGreaterThan(0);
        expect(body.models.length).toBeGreaterThan(0);
    });

    it('POST /cloud/v1/llm/complete requires auth (no billing without identity)', async () => {
        const res = await app().request('/cloud/v1/llm/complete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6', messages: [] }),
        });
        expect(res.status).toBe(401);
    });
});

describe('CORS allowlist', () => {
    async function preflightAcao(a: ReturnType<typeof createApp>, origin: string): Promise<string | null> {
        const res = await a.request('/cloud/v1/me', {
            method: 'OPTIONS',
            headers: { origin, 'access-control-request-method': 'GET' },
        });
        return res.headers.get('access-control-allow-origin');
    }

    it('echoes a configured origin on the preflight', async () => {
        expect(await preflightAcao(corsApp('https://aloud.rest'), 'https://aloud.rest')).toBe('https://aloud.rest');
    });

    it('matches despite a trailing slash in the configured value', async () => {
        // The classic misconfig: `https://aloud.rest/` configured, browser sends
        // no trailing slash. Must still match (not drop the header).
        expect(await preflightAcao(corsApp('https://aloud.rest/'), 'https://aloud.rest')).toBe('https://aloud.rest');
    });

    it('omits the header for an origin not on the list', async () => {
        expect(await preflightAcao(corsApp('https://aloud.rest'), 'https://evil.example')).toBeNull();
    });

    it('falls back to open (*) when no origins are configured', async () => {
        expect(await preflightAcao(corsApp(''), 'https://anything.example')).toBe('*');
    });
});

describe('strict (production) config gate', () => {
    const PROD_OK = {
        ALOUD_ENV: 'production',
        ALOUD_SESSION_SECRET: 'x'.repeat(32),
        GOOGLE_CLIENT_IDS: 'client-1',
        ALOUD_CORS_ORIGINS: 'https://app.test',
        ANTHROPIC_API_KEY: 'sk-test',
        ALOUD_DB_PATH: ':memory:',
    };

    it('accepts a fully-configured production env', () => {
        expect(() => loadConfig(PROD_OK)).not.toThrow();
    });

    it('refuses to start without ALOUD_CORS_ORIGINS (would fall open to *)', () => {
        const { ALOUD_CORS_ORIGINS: _drop, ...env } = PROD_OK;
        expect(() => loadConfig(env)).toThrow(/ALOUD_CORS_ORIGINS/);
    });

    it('normalizes ALOUD_ENV (case/whitespace) when deciding strictness', () => {
        expect(() => loadConfig({ ...PROD_OK, ALOUD_ENV: ' Production ', ALOUD_CORS_ORIGINS: '' })).toThrow(
            /ALOUD_CORS_ORIGINS/
        );
    });

    it('counts any configured provider key, including OpenAI/Gemini', () => {
        const { ANTHROPIC_API_KEY: _drop, ...env } = PROD_OK;
        expect(() => loadConfig(env)).toThrow(/provider key/);
        expect(() => loadConfig({ ...env, OPENAI_API_KEY: 'sk-oai' })).not.toThrow();
        expect(() => loadConfig({ ...env, GEMINI_API_KEY: 'gk' })).not.toThrow();
    });
});

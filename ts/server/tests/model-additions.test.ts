/**
 * Allowlist coverage for the July 2026 model additions: GPT-5.6 Sol (openai
 * direct) and Kimi K3 (moonshotai via openrouter). Guards the exact pinned ids
 * the picker and the debit math both key on.
 */
import { describe, it, expect } from 'vitest';
import { pricingFor, isModelAllowed } from '../src/pricing/providers.js';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { Forwarder } from '../src/providers/forward.js';
import type { AuthResponse } from '../src/contract.js';

const M = 1_000_000;

/** Route-level turn against a stub forwarder; returns the response. The llm
 *  route once hand-kept its own provider set and silently bounced 'openai' as
 *  bad_request — this drives the real validation path so that can't recur. */
async function completeTurn(provider: string, model: string): Promise<Response> {
    const config = loadConfig({
        ALOUD_ENABLE_DEV_AUTH: '1',
        GEMINI_API_KEY: 'gk-test',
        ALOUD_FREE_SIGNUP_CREDITS: '20',
    });
    const deps = buildDeps(config);
    deps.forwarder = {
        async complete() {
            return {
                text: 'Breathe in.',
                finishReason: 'stop',
                tokensUsed: 1100,
                inputTokens: 1000,
                outputTokens: 100,
                cacheReadTokens: null,
                cacheCreationTokens: null,
            };
        },
    } as unknown as Forwarder;
    const app = createApp(deps);
    const auth = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    const token = ((await auth.json()) as AuthResponse).token;
    return app.request('/cloud/v1/llm/complete', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ provider, model, messages: [{ role: 'user', content: 'hi' }] }),
    });
}

describe('GPT-5.6 Sol (openai)', () => {
    it('is allowlisted under the exact tier id with the 1.25x cache-write rate', () => {
        const p = pricingFor('openai', 'gpt-5.6-sol');
        expect(p).toBeDefined();
        expect(p!.input).toBeCloseTo(5 / M, 12);
        expect(p!.output).toBeCloseTo(30 / M, 12);
        expect(p!.cacheRead).toBeCloseTo(0.5 / M, 12);
        // New in the 5.6 family: writes bill at 1.25x input (surfaced via
        // prompt_tokens_details.cache_write_tokens -> cacheCreation).
        expect(p!.cacheCreation).toBeCloseTo(6.25 / M, 12);

        // The bare family id isn't servable — only the pinned tier.
        expect(isModelAllowed('openai', 'gpt-5.6')).toBe(false);
    });
});

describe('Kimi K3 (moonshotai via openrouter)', () => {
    it('is allowlisted under openrouter with the org-prefixed id', () => {
        const p = pricingFor('openrouter', 'moonshotai/kimi-k3');
        expect(p).toBeDefined();
        expect(p!.input).toBeCloseTo(3 / M, 12);
        expect(p!.output).toBeCloseTo(15 / M, 12);
        expect(p!.cacheRead).toBeCloseTo(0.3 / M, 12);

        // Not reachable without the org prefix or under other providers.
        expect(isModelAllowed('openrouter', 'kimi-k3')).toBe(false);
        expect(isModelAllowed('groq', 'moonshotai/kimi-k3')).toBe(false);
    });
});

describe('POST /cloud/v1/llm/complete accepts every allowlisted provider', () => {
    it('serves an openai turn (gpt-5.6-sol)', async () => {
        const res = await completeTurn('openai', 'gpt-5.6-sol');
        expect(res.status).toBe(200);
    });

    it('serves an openrouter turn (moonshotai/kimi-k3)', async () => {
        const res = await completeTurn('openrouter', 'moonshotai/kimi-k3');
        expect(res.status).toBe(200);
    });

    it('still rejects an unlisted model with model_not_allowed, not bad_request', async () => {
        const res = await completeTurn('openai', 'gpt-5.6');
        expect(res.status).not.toBe(200);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('model_not_allowed');
    });
});

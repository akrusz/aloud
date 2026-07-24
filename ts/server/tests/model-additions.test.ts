/**
 * Allowlist coverage for the July 2026 model additions: GPT-5.6 Sol (openai
 * direct), Claude Opus 5 (anthropic), and Kimi K2 (moonshotai via openrouter).
 * Guards the exact pinned ids the picker and the debit math both key on.
 */
import { describe, it, expect } from 'vitest';
import { pricingFor, isModelAllowed } from '../src/pricing/providers.js';
import { OPENROUTER_FALLBACKS } from '../src/providers/forward.js';
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

describe('Opus 5 (anthropic)', () => {
    it('is allowlisted at the Opus rates and is the picker default', () => {
        const p = pricingFor('anthropic', 'claude-opus-5');
        expect(p).toBeDefined();
        expect(p!.input).toBeCloseTo(5 / M, 12);
        expect(p!.output).toBeCloseTo(25 / M, 12);
        expect(p!.cacheRead).toBeCloseTo(0.5 / M, 12);
        expect(p!.cacheCreation).toBeCloseTo(6.25 / M, 12);
        expect(p!.cacheCreation1h).toBeCloseTo(10 / M, 12);
        expect(p!.default).toBe(true);

        // Opus 4.8 was swapped OUT for its same-price successor — it must no
        // longer be billable, the way Sonnet 4.6 went when Sonnet 5 landed.
        expect(isModelAllowed('anthropic', 'claude-opus-4-8')).toBe(false);
    });
});

describe('Kimi K2 0711 (moonshotai via openrouter)', () => {
    it('is allowlisted under openrouter with the org-prefixed id', () => {
        const p = pricingFor('openrouter', 'moonshotai/kimi-k2');
        expect(p).toBeDefined();
        expect(p!.input).toBeCloseTo(0.57 / M, 12);
        expect(p!.output).toBeCloseTo(2.3 / M, 12);
        // No cache pricing on this endpoint — reads bill at the input rate.
        expect(p!.cacheRead).toBeCloseTo(0.57 / M, 12);

        // Not reachable without the org prefix or under other providers.
        expect(isModelAllowed('openrouter', 'kimi-k2')).toBe(false);
        expect(isModelAllowed('groq', 'moonshotai/kimi-k2')).toBe(false);

        // K3 was swapped OUT (mandatory reasoning: 7-12s first-token, could
        // blank a turn) — it must no longer be billable.
        expect(isModelAllowed('openrouter', 'moonshotai/kimi-k3')).toBe(false);
    });

    it('degrades to 0905 via the OpenRouter models fallback chain', () => {
        const chain = OPENROUTER_FALLBACKS['moonshotai/kimi-k2'];
        expect(chain).toEqual(['moonshotai/kimi-k2', 'moonshotai/kimi-k2-0905']);
    });

    it('every fallback chain is primary-first and within OpenRouter limits', () => {
        for (const [primary, chain] of Object.entries(OPENROUTER_FALLBACKS)) {
            expect(chain[0]).toBe(primary);
            // OpenRouter rejects lists longer than 3 with a 400.
            expect(chain.length).toBeLessThanOrEqual(3);
            // Only allowlisted primaries can be requested, so a chain on an
            // unlisted key is dead config.
            expect(isModelAllowed('openrouter', primary)).toBe(true);
        }
    });
});

describe('POST /cloud/v1/llm/complete accepts every allowlisted provider', () => {
    it('serves an openai turn (gpt-5.6-sol)', async () => {
        const res = await completeTurn('openai', 'gpt-5.6-sol');
        expect(res.status).toBe(200);
    });

    it('serves an openrouter turn (moonshotai/kimi-k2)', async () => {
        const res = await completeTurn('openrouter', 'moonshotai/kimi-k2');
        expect(res.status).toBe(200);
    });

    it('still rejects an unlisted model with model_not_allowed, not bad_request', async () => {
        const res = await completeTurn('openai', 'gpt-5.6');
        expect(res.status).not.toBe(200);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('model_not_allowed');
    });
});

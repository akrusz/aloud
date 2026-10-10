/**
 * The hosted model allowlist (pricing/providers.ts MODELS): what the llm route
 * serves, and the shape of the flags the picker reads. Rates and per-model
 * flags are not restated here - the table is their one home.
 */
import { describe, it, expect } from 'vitest';
import { isModelAllowed, allowedModels } from '../src/pricing/providers.js';
import { OPENROUTER_FALLBACKS } from '../src/providers/forward.js';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { Forwarder } from '../src/providers/forward.js';
import type { AuthResponse } from '../src/contract.js';

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

describe('POST /cloud/v1/llm/complete accepts every allowlisted provider', () => {
    const firstModelOf = new Map<string, string>();
    for (const m of allowedModels()) {
        if (!firstModelOf.has(m.provider)) firstModelOf.set(m.provider, m.model);
    }

    it.each([...firstModelOf])('serves %s (%s)', async (provider, model) => {
        const res = await completeTurn(provider, model);
        expect(res.status).toBe(200);
    });

    it('rejects an unlisted model with model_not_allowed, not bad_request', async () => {
        // The bare family id isn't servable, only a pinned tier.
        const res = await completeTurn('openai', 'gpt-5.6');
        expect(res.status).not.toBe(200);
        const body = (await res.json()) as { error?: { code?: string } };
        expect(body.error?.code).toBe('model_not_allowed');
    });
});

describe('allowlist keys', () => {
    it('allows a model only under its own provider and its full id', () => {
        const m = allowedModels().find((x) => x.provider === 'openrouter')!;
        expect(isModelAllowed('openrouter', m.model)).toBe(true);
        // OpenRouter ids are org-prefixed; the bare model name is not the id.
        expect(isModelAllowed('openrouter', m.model.split('/')[1]!)).toBe(false);
        expect(isModelAllowed('anthropic', m.model)).toBe(false);
    });
});

describe('OpenRouter fallback chains', () => {
    it('every chain is primary-first and within OpenRouter limits', () => {
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

describe('picker flags', () => {
    const listed = allowedModels().filter((m) => !m.unlisted);

    it('lists the default first, so the fallback to the first visible model is the default', () => {
        expect(allowedModels()[0]!.default).toBe(true);
    });

    it('flags exactly one zh default', () => {
        expect(listed.filter((m) => m.zhDefault)).toHaveLength(1);
    });

    it('keeps the zh shortlist flags consistent with the en ones', () => {
        // A zhCurated model must still be expanded for en - otherwise the flag
        // is dead weight and the en shortlist silently grew.
        for (const m of listed.filter((x) => x.zhCurated)) expect(m.expanded).toBe(true);
        // And zhExpanded only makes sense on an en-curated model.
        for (const m of listed.filter((x) => x.zhExpanded)) expect(m.expanded).toBeUndefined();
    });

    it('flags exactly one model for background utility work', () => {
        // buildRecapProvider (ui/views/session.ts) picks the flagged entry off
        // /me/models. Two would make which-one-wins depend on object order.
        expect(allowedModels().filter((m) => m.utility)).toHaveLength(1);
    });
});

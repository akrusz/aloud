/**
 * The hosted model allowlist (pricing/providers.ts MODELS): what the llm route
 * serves, and the shape of the flags the picker reads. Rates and per-model
 * flags are not restated here - the table is their one home.
 */
import { describe, it, expect } from 'vitest';
import { isModelAllowed, allowedModels } from '../src/pricing/providers.js';
import { OPENROUTER_HOSTS, openRouterRouting, openRouterSlug } from '../src/pricing/openrouter-hosts.js';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { Forwarder } from '../src/providers/forward.js';
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

describe('OpenRouter hosts', () => {
    it('pins every openrouter model to named hosts, and no model that is not offered', () => {
        // An unpinned slug is served by whichever host OpenRouter picks,
        // wherever it is, at a price the table does not hold.
        const slugs = allowedModels()
            .filter((m) => m.provider === 'openrouter')
            .map((m) => openRouterSlug(m.model));
        expect(Object.keys(OPENROUTER_HOSTS).sort()).toEqual(slugs.sort());
        for (const slug of slugs) {
            expect(openRouterRouting(slug)?.provider).toMatchObject({
                order: OPENROUTER_HOSTS[slug],
                allow_fallbacks: false,
            });
        }
        expect(openRouterRouting('somebody/else')).toBeUndefined();
        expect(openRouterSlug('somebody/else')).toBe('somebody/else');
    });

    it('asks OpenRouter for the slug behind the Kimi id, on its hosts, with reasoning off', async () => {
        const realFetch = globalThis.fetch;
        const bodies: Array<Record<string, unknown>> = [];
        globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
            bodies.push(JSON.parse(init!.body as string));
            return new Response(
                JSON.stringify({ choices: [{ message: { content: 'Mm.' }, finish_reason: 'stop' }], usage: {} }),
                { status: 200, headers: { 'content-type': 'application/json' } }
            );
        }) as typeof fetch;
        try {
            await new Forwarder({ openrouter: 'or-test' }).complete([{ role: 'user', content: 'hi' }], {
                provider: 'openrouter',
                model: 'moonshotai/kimi-k2',
            });
        } finally {
            globalThis.fetch = realFetch;
        }
        expect(bodies[0]).toMatchObject({
            model: 'moonshotai/kimi-k2.6',
            provider: { order: ['coreweave', 'parasail'], allow_fallbacks: false, data_collection: 'deny' },
            reasoning: { enabled: false },
        });
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

    // `unlisted` would hide it from /me/models, which is where the client finds
    // the recap engine; `expanded` keeps it behind the toggle on builds that
    // don't know the flag.
    it('keeps a utility-only model published, behind the toggle, and flagged for utility', () => {
        for (const m of allowedModels().filter((x) => x.utilityOnly)) {
            expect(m.utility, m.model).toBe(true);
            expect(m.expanded, m.model).toBe(true);
            expect(m.unlisted, m.model).toBeUndefined();
        }
    });

    it('flags exactly one model for background utility work, and publishes it', () => {
        // buildRecapProvider (ui/views/session.ts) picks the flagged entry off
        // /me/models. Two would make which-one-wins depend on object order, and
        // an unlisted one would never reach the client.
        const flagged = allowedModels().filter((m) => m.utility);
        expect(flagged).toHaveLength(1);
        expect(flagged[0]!.unlisted, flagged[0]!.model).toBeUndefined();
    });
});

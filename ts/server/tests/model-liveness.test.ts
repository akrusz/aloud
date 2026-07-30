/**
 * Model liveness (pricing/liveness.ts): the hourly sweep that keeps retired
 * models out of /me/models. The contract under test is FAIL OPEN - only a
 * definitive 404/absent-from-list verdict may shrink the catalog; keys missing,
 * networks flaking, and providers erroring must all leave it intact.
 */

import { describe, it, expect } from 'vitest';
import {
    HttpModelProber,
    ModelLiveness,
    type ModelProber,
    type ProbeResult,
} from '../src/pricing/liveness.js';
import { allowedModels } from '../src/pricing/providers.js';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { ProviderId } from '../src/contract.js';

function stubProber(verdicts: Record<string, ProbeResult>): ModelProber {
    return {
        async probe(provider: ProviderId, model: string) {
            return verdicts[`${provider}:${model}`] ?? 'live';
        },
    };
}

describe('ModelLiveness', () => {
    it('serves the full allowlist before any sweep has run', () => {
        const liveness = new ModelLiveness(stubProber({}));
        expect(liveness.liveModels()).toEqual(allowedModels());
    });

    it('drops a model probed gone and restores it when a later sweep sees it live', async () => {
        const verdicts: Record<string, ProbeResult> = {
            'anthropic:claude-opus-4-8': 'gone',
        };
        const liveness = new ModelLiveness(stubProber(verdicts));

        let report = await liveness.sweep();
        expect(report.gone).toEqual(['anthropic:claude-opus-4-8']);
        expect(liveness.isLive('anthropic', 'claude-opus-4-8')).toBe(false);
        expect(liveness.liveModels().map((m) => m.model)).not.toContain('claude-opus-4-8');
        // Everything else is untouched.
        expect(liveness.liveModels()).toHaveLength(allowedModels().length - 1);

        // Provider brings it back (or the 404 was a fluke): next sweep restores.
        verdicts['anthropic:claude-opus-4-8'] = 'live';
        report = await liveness.sweep();
        expect(report.gone).toEqual([]);
        expect(liveness.isLive('anthropic', 'claude-opus-4-8')).toBe(true);
    });

    it("keeps a model on 'unknown' - even one previously marked gone stays gone until proven live", async () => {
        const verdicts: Record<string, ProbeResult> = {
            'anthropic:claude-opus-4-8': 'gone',
            'openai:gpt-5.4': 'unknown',
        };
        const liveness = new ModelLiveness(stubProber(verdicts));
        await liveness.sweep();
        expect(liveness.isLive('openai', 'gpt-5.4')).toBe(true); // fail open

        // A later blanket-unknown sweep (say, an egress outage) changes nothing.
        verdicts['anthropic:claude-opus-4-8'] = 'unknown';
        await liveness.sweep();
        expect(liveness.isLive('anthropic', 'claude-opus-4-8')).toBe(false);
        expect(liveness.liveModels()).toHaveLength(allowedModels().length - 1);
    });
});

describe('GET /cloud/v1/me/models with liveness', () => {
    it('omits models the sweep proved retired', async () => {
        const deps = buildDeps(loadConfig({}));
        deps.liveness = new ModelLiveness(
            stubProber({ 'anthropic:claude-3-opus-20240229': 'gone' })
        );
        await deps.liveness.sweep();
        const app = createApp(deps);
        const res = await app.request('/cloud/v1/me/models');
        const body = (await res.json()) as { models: Array<{ model: string }> };
        const ids = body.models.map((m) => m.model);
        expect(ids).not.toContain('claude-3-opus-20240229');
        expect(ids).toContain('claude-opus-5');
        expect(body.models).toHaveLength(allowedModels().length - 1);
    });
});

describe('HttpModelProber', () => {
    const KEYS = { anthropic: 'ak', openai: 'ok', google: 'gk', openrouter: 'rk' };

    function proberWith(response: { status: number; json?: unknown }): HttpModelProber {
        const fetchFn = (async () =>
            new Response(JSON.stringify(response.json ?? {}), {
                status: response.status,
            })) as typeof fetch;
        return new HttpModelProber(KEYS, fetchFn);
    }

    it('classifies 200 live, 404 gone, and everything else unknown', async () => {
        expect(await proberWith({ status: 200 }).probe('anthropic', 'claude-opus-5')).toBe('live');
        expect(await proberWith({ status: 404 }).probe('anthropic', 'claude-opus-4-8')).toBe(
            'gone'
        );
        for (const status of [401, 429, 500, 529]) {
            expect(await proberWith({ status }).probe('anthropic', 'claude-opus-5')).toBe(
                'unknown'
            );
        }
    });

    it('returns unknown without a key for the provider (and never calls out)', async () => {
        const fetchFn = (async () => {
            throw new Error('should not fetch');
        }) as typeof fetch;
        const prober = new HttpModelProber({}, fetchFn);
        expect(await prober.probe('anthropic', 'claude-opus-5')).toBe('unknown');
        expect(await prober.probe('openai', 'gpt-5.6-sol')).toBe('unknown');
        expect(await prober.probe('google', 'gemini-2.5-flash-lite')).toBe('unknown');
    });

    it('returns unknown on a network error', async () => {
        const fetchFn = (async () => {
            throw new Error('ECONNRESET');
        }) as typeof fetch;
        const prober = new HttpModelProber(KEYS, fetchFn);
        expect(await prober.probe('anthropic', 'claude-opus-5')).toBe('unknown');
    });

    it('treats an openrouter slug as live while any link of its fallback chain is listed', async () => {
        // Primary slug delisted but the 0905 fallback still routable: the
        // forwarder degrades along the chain, so the model still serves.
        const fallbackOnly = proberWith({
            status: 200,
            json: { data: [{ id: 'moonshotai/kimi-k2-0905' }] },
        });
        expect(await fallbackOnly.probe('openrouter', 'moonshotai/kimi-k2')).toBe('live');

        const wholeChainGone = proberWith({
            status: 200,
            json: { data: [{ id: 'somebody/else' }] },
        });
        expect(await wholeChainGone.probe('openrouter', 'moonshotai/kimi-k2')).toBe('gone');
    });
});

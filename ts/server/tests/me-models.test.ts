/**
 * GET /cloud/v1/me/models — the hosted model list the client's picker reads.
 * Each model must carry creditsPerHour so the picker can show the "N☁️" rate
 * badge next to it (the cloud-rate UI). Public, no auth.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { estimateModels, estimateStt } from '../src/pricing/estimate.js';

describe('GET /cloud/v1/me/models', () => {
    it('tags every allowed model with its typical creditsPerHour', async () => {
        const app = createApp(buildDeps(loadConfig({})));
        const res = await app.request('/cloud/v1/me/models');
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            models: Array<{ provider: string; model: string; creditsPerHour: number | null }>;
        };
        expect(body.models.length).toBeGreaterThan(0);

        const expected = new Map(
            estimateModels().map((e) => [`${e.provider}:${e.model}`, e.creditsPerHour])
        );
        for (const m of body.models) {
            expect(typeof m.creditsPerHour).toBe('number');
            expect(m.creditsPerHour).toBe(expected.get(`${m.provider}:${m.model}`));
        }
        // The rate must order the tiers it's meant to communicate: a premium
        // model (Opus) costs more per hour than a value one (Gemini Flash-Lite).
        const rateOf = (model: string) => body.models.find((m) => m.model === model)!.creditsPerHour!;
        expect(rateOf('claude-opus-5')).toBeGreaterThan(rateOf('gemini-2.5-flash-lite'));
    });

    it('carries the hosted STT rate, so the client keeps no copy of its own', async () => {
        const app = createApp(buildDeps(loadConfig({})));
        const res = await app.request('/cloud/v1/me/models');
        const body = (await res.json()) as { sttCreditsPerHour: number };
        expect(body.sttCreditsPerHour).toBe(estimateStt().creditsPerHour);
        // Unrounded, like the model rates: it composes into the setup footer's
        // session total before anything rounds.
        expect(body.sttCreditsPerHour).toBeGreaterThan(0);
        expect(body.sttCreditsPerHour).toBeLessThan(1);
    });

    it('flags exactly one default model, Opus 5 (the picker pre-selection)', async () => {
        const app = createApp(buildDeps(loadConfig({})));
        const res = await app.request('/cloud/v1/me/models');
        const body = (await res.json()) as {
            models: Array<{ provider: string; model: string; default?: boolean }>;
        };
        const defaults = body.models.filter((m) => m.default);
        expect(defaults).toHaveLength(1);
        expect(defaults[0]).toMatchObject({ provider: 'anthropic', model: 'claude-opus-5' });
    });

    it('keeps a curated (non-expanded) tier the picker shows by default', async () => {
        const app = createApp(buildDeps(loadConfig({})));
        const res = await app.request('/cloud/v1/me/models');
        const body = (await res.json()) as {
            models: Array<{ model: string; default?: boolean; expanded?: boolean }>;
        };
        const curated = body.models.filter((m) => !m.expanded).map((m) => m.model);
        // The short list new users see: flagship + default + midrange + budget
        // (and Fable, deliberately surfaced). Expanded models exist behind the
        // "Show all available models" toggle.
        expect(curated).toEqual(
            expect.arrayContaining(['claude-fable-5', 'claude-opus-5', 'claude-sonnet-5'])
        );
        expect(curated.length).toBeLessThanOrEqual(6);
        expect(body.models.some((m) => m.expanded)).toBe(true);
        // The pre-selected default must be visible without the toggle.
        expect(body.models.find((m) => m.default)!.expanded).toBeFalsy();
    });
});

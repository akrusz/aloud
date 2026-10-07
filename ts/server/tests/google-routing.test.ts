import { describe, it, expect } from 'vitest';
import { loadConfig, configuredProviders } from '../src/config.js';
import { pricingFor, isModelAllowed } from '../src/pricing/providers.js';
import { Forwarder, ProviderNotConfiguredError } from '../src/providers/forward.js';

describe('Google-direct value tier', () => {
    it('prices the Gemini value model under the google provider, direct (not openrouter)', () => {
        const direct = pricingFor('google', 'gemini-3.5-flash-lite');
        expect(direct).toBeDefined();
        expect(direct!.input).toBeCloseTo(0.3 / 1_000_000, 12);
        expect(direct!.output).toBeCloseTo(2.5 / 1_000_000, 12);
        expect(direct!.cacheRead).toBeCloseTo(0.03 / 1_000_000, 12);
        // 2.5 went out with the swap, not kept beside it.
        expect(isModelAllowed('google', 'gemini-2.5-flash-lite')).toBe(false);

        expect(isModelAllowed('google', 'gemini-3.5-flash-lite')).toBe(true);
        // The old OpenRouter route for the same model is gone.
        expect(isModelAllowed('openrouter', 'google/gemini-2.5-flash-lite')).toBe(false);
    });

    it('reads GEMINI_API_KEY into the google provider slot', () => {
        const config = loadConfig({ GEMINI_API_KEY: 'gk-test' });
        expect(config.providerKeys.google).toBe('gk-test');
        expect(configuredProviders(config)).toContain('google');
    });

    it('forwarder routes google but errors clearly when the key is unset', async () => {
        const fwd = new Forwarder({ anthropic: 'sk-test' }); // no google key
        await expect(
            fwd.complete([{ role: 'user', content: 'hi' }], {
                provider: 'google',
                model: 'gemini-3.5-flash-lite',
            })
        ).rejects.toBeInstanceOf(ProviderNotConfiguredError);
    });
});

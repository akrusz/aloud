import { describe, it, expect } from 'vitest';
import { loadConfig, configuredProviders } from '../src/config.js';
import { Forwarder, ProviderNotConfiguredError } from '../src/providers/forward.js';

describe('Google-direct value tier', () => {
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

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { resolveVoice, defaultVoice, CURATED_VOICES } from '../src/providers/voice-catalog.js';
import type { CloudVoice } from '../src/contract.js';

describe('voice catalog', () => {
    it('resolves a curated short name to its (provider, voiceId)', () => {
        expect(resolveVoice('Leda')).toEqual({ provider: 'google', voiceId: 'en-US-Chirp3-HD-Leda' });
        // An OpenAI curated voice resolves to the OpenAI provider + voice name.
        expect(resolveVoice('Lyra')).toEqual({ provider: 'openai', voiceId: 'shimmer' });
    });

    it('passes a raw Google id through as Google and falls back to the default', () => {
        expect(resolveVoice('en-US-Chirp3-HD-Charon')).toEqual({
            provider: 'google',
            voiceId: 'en-US-Chirp3-HD-Charon',
        });
        const d = defaultVoice();
        expect(resolveVoice(undefined)).toEqual({ provider: d.provider, voiceId: d.providerVoiceId });
        expect(d.default).toBe(true);
    });

    it('labels Pulcherrima androgynous (not Google\'s "female")', () => {
        expect(CURATED_VOICES.find((v) => v.name === 'Pulcherrima')!.gender).toBe('androgynous');
    });
});

describe('GET /cloud/v1/voices', () => {
    const namesFor = (p: string) => CURATED_VOICES.filter((v) => v.provider === p).map((v) => v.name);

    it('lists a provider\'s voices only when its key is set (Google only)', async () => {
        const app = createApp(buildDeps(loadConfig({ GOOGLE_TTS_API_KEY: 'k' })));
        const res = await app.request('/cloud/v1/voices');
        expect(res.status).toBe(200);
        const voices = (await res.json()) as CloudVoice[];
        expect(voices.map((v) => v.name)).toEqual(namesFor('google'));
        // OpenAI voices stay hidden without OPENAI_TTS_API_KEY.
        expect(voices.some((v) => v.name === 'Lyra')).toBe(false);
        expect(voices.every((v) => 'gender' in v)).toBe(true);
    });

    it('surfaces OpenAI voices when only the OpenAI key is set', async () => {
        const app = createApp(buildDeps(loadConfig({ OPENAI_TTS_API_KEY: 'k' })));
        const voices = (await (await app.request('/cloud/v1/voices')).json()) as CloudVoice[];
        expect(voices.map((v) => v.name)).toEqual(namesFor('openai'));
        expect(voices.some((v) => v.name === 'Leda')).toBe(false);
    });

    it('lists every curated voice when both keys are set', async () => {
        const app = createApp(
            buildDeps(loadConfig({ GOOGLE_TTS_API_KEY: 'k', OPENAI_TTS_API_KEY: 'k2' }))
        );
        const voices = (await (await app.request('/cloud/v1/voices')).json()) as CloudVoice[];
        expect(voices.map((v) => v.name)).toEqual(CURATED_VOICES.map((v) => v.name));
    });

    it('carries a cost tier + credits/hr so the picker can show relative cost', async () => {
        const app = createApp(buildDeps(loadConfig({ GOOGLE_TTS_API_KEY: 'k' })));
        const voices = (await (await app.request('/cloud/v1/voices')).json()) as CloudVoice[];
        const leda = voices.find((v) => v.name === 'Leda')!; // premium (Chirp3-HD)
        const vega = voices.find((v) => v.name === 'Vega')!; // value (Neural2)
        expect(leda.tier).toBe('premium');
        expect(vega.tier).toBe('value');
        // The value voice must read as cheaper (lower credits/hr) than premium.
        expect(vega.creditsPerHourTypical).toBeGreaterThan(0);
        expect(vega.creditsPerHourTypical).toBeLessThan(leda.creditsPerHourTypical);
    });

    it('is empty when TTS is not configured', async () => {
        const app = createApp(buildDeps(loadConfig({})));
        const res = await app.request('/cloud/v1/voices');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual([]);
    });
});

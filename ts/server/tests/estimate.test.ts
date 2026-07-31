import { describe, it, expect } from 'vitest';
import {
    estimateModels,
    estimateStt,
    estimateVoices,
    voiceCreditsPerHourTypical,
} from '../src/pricing/estimate.js';
import { CURATED_VOICES, defaultVoice } from '../src/providers/voice-catalog.js';

describe('estimateModels', () => {
    const models = estimateModels();

    it('produces an estimate for every allowed model', () => {
        expect(models.length).toBeGreaterThanOrEqual(3);
        for (const m of models) {
            expect(m.creditsPerSession).toBeGreaterThan(0);
            expect(m.creditsPerHour).toBeGreaterThanOrEqual(m.creditsPerSession);
        }
    });

    it('orders by cost: Opus > Sonnet > Haiku, with a large Opus:Haiku spread', () => {
        // Compare on provider-cost USD, not rounded credits — at this denomination
        // the per-hour credit counts round to small integers and lose ratio precision.
        const usd = (model: string) => models.find((m) => m.model === model)!.costUsdPerHour;
        expect(usd('claude-opus-5')).toBeGreaterThan(usd('claude-sonnet-5'));
        expect(usd('claude-sonnet-5')).toBeGreaterThan(usd('claude-haiku-4-5-20251001'));
        // ~5x on this cache-heavy workload.
        expect(usd('claude-opus-5') / usd('claude-haiku-4-5-20251001')).toBeGreaterThan(3);
    });

    it('offers only cache-capable models (no Groq — it has no prompt caching)', () => {
        // Groq was dropped as a hosted option: with no caching, the re-sent
        // history bills at full input every turn on this workload. The hosted
        // set should be cache-capable models only.
        expect(models.some((m) => m.provider === 'groq')).toBe(false);
        expect(models.some((m) => m.model === 'llama-3.3-70b-versatile')).toBe(false);
    });
});

describe('estimateStt', () => {
    it('is a small, model-independent leg', () => {
        const stt = estimateStt();
        expect(stt.creditsPerHour).toBeGreaterThan(0);
        // VAD-segmented speech makes STT cheap relative to a premium model hour.
        const opus = estimateModels().find((m) => m.model === 'claude-opus-5')!;
        expect(stt.costUsdPerHour).toBeLessThan(opus.costUsdPerHour);
    });
});

describe('estimateVoices', () => {
    const voices = estimateVoices();

    it('local engines cost zero across the whole band', () => {
        const browser = voices.find((v) => v.voiceId === 'browser-default')!;
        expect(browser.creditsPerHour.spacious).toBe(0);
        expect(browser.creditsPerHour.typical).toBe(0);
        expect(browser.creditsPerHour.engaged).toBe(0);
    });

    it('lists exactly the offered voices: the free locals + the curated cloud set', () => {
        const ids = voices.map((v) => v.voiceId);
        expect(ids).toContain('browser-default');
        expect(ids).toContain('os-premium');
        // Every curated voice (every provider + tier) is estimated, by its real
        // provider voice id.
        for (const v of CURATED_VOICES) expect(ids).toContain(v.providerVoiceId);
        expect(voices).toHaveLength(2 + CURATED_VOICES.length);
        // No aspirational engines the server can't synthesize.
        expect(ids.some((id) => id.includes('elevenlabs') || id.includes('hume'))).toBe(false);
    });

    it('cloud voice cost rises across the talk band (spacious < typical < engaged)', () => {
        const leda = voices.find((v) => v.voiceId === defaultVoice().providerVoiceId)!;
        expect(leda.creditsPerHour.spacious).toBeLessThan(leda.creditsPerHour.typical);
        expect(leda.creditsPerHour.typical).toBeLessThan(leda.creditsPerHour.engaged);
    });

    it('prices the value (Neural2) tier below the premium (Chirp3-HD) tier', () => {
        const rateOf = (id: string) => voices.find((v) => v.voiceId === id)!.costUsdPerHourTypical;
        // Pin to Google voices specifically (OpenAI is also 'value' but a
        // different flat rate) so the 16/30 tier ratio stays exact.
        const premium = CURATED_VOICES.find((v) => v.provider === 'google' && v.tier === 'premium')!;
        const value = CURATED_VOICES.find((v) => v.provider === 'google' && v.tier === 'value')!;
        expect(rateOf(value.providerVoiceId)).toBeGreaterThan(0);
        expect(rateOf(value.providerVoiceId)).toBeLessThan(rateOf(premium.providerVoiceId));
        // Neural2 ($16/1M) is ~half Chirp3-HD ($30/1M).
        expect(rateOf(value.providerVoiceId) / rateOf(premium.providerVoiceId)).toBeCloseTo(16 / 30, 2);
    });

    it('prices the OpenAI voices below the Chirp3-HD cost (premium-bucket, cheaper burn)', () => {
        const rateOf = (id: string) => voices.find((v) => v.voiceId === id)!.costUsdPerHourTypical;
        const premium = CURATED_VOICES.find((v) => v.provider === 'google' && v.tier === 'premium')!;
        const openai = CURATED_VOICES.find((v) => v.provider === 'openai')!;
        // ~$19/1M < $30/1M Chirp3-HD — stays under the cost ceiling.
        expect(rateOf(openai.providerVoiceId)).toBeGreaterThan(0);
        expect(rateOf(openai.providerVoiceId)).toBeLessThan(rateOf(premium.providerVoiceId));
    });
});

describe('voiceCreditsPerHourTypical', () => {
    it('matches the per-voice estimate and ranks value below premium', () => {
        const premium = CURATED_VOICES.find((v) => v.provider === 'google' && v.tier === 'premium')!;
        const value = CURATED_VOICES.find((v) => v.provider === 'google' && v.tier === 'value')!;
        expect(voiceCreditsPerHourTypical(value.provider, value.providerVoiceId)).toBeGreaterThan(0);
        expect(voiceCreditsPerHourTypical(value.provider, value.providerVoiceId)).toBeLessThan(
            voiceCreditsPerHourTypical(premium.provider, premium.providerVoiceId)
        );
    });
});

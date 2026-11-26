import { describe, it, expect } from 'vitest';
import {
    HYBRID_STAND_IN_AUDIO_SHARE,
    TYPICAL_SESSION,
    azureSsmlOverheadFactor,
    estimateModels,
    estimateStt,
    estimateVoices,
} from '../src/pricing/estimate.js';
import { priceSession, priceSttSeconds } from '../src/pricing/meter.js';
import { resolveSttConfig } from '../src/config.js';
import { allowedModels } from '../src/pricing/providers.js';
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
        expect(usd('claude-opus-5')).toBeGreaterThan(usd('claude-sonnet-5-5'));
        expect(usd('claude-sonnet-5-5')).toBeGreaterThan(usd('claude-haiku-5-5'));
        // ~50x on this cache-heavy workload.
        expect(usd('claude-opus-5') / usd('claude-haiku-5-5')).toBeGreaterThan(3);
    });

    it('figures the re-reads a host misses as fresh input (cacheHitRate)', () => {
        const llmOnly = { ...TYPICAL_SESSION, sttSeconds: 0, ttsChars: 0 };
        const partial = allowedModels().filter((m) => m.cacheHitRate !== undefined);
        expect(partial.length).toBeGreaterThan(0);
        for (const m of partial) {
            expect(m.cacheHitRate).toBeGreaterThan(0);
            expect(m.cacheHitRate).toBeLessThan(1);
            const shown = models.find((e) => e.provider === m.provider && e.model === m.model)!.creditsPerSession;
            const allHit = priceSession(m.provider, m.model, llmOnly).credits;
            const noneHit = priceSession(m.provider, m.model, {
                ...llmOnly,
                llmTokensIn: llmOnly.llmTokensIn + llmOnly.llmCacheRead,
                llmCacheRead: 0,
            }).credits;
            expect(shown).toBeCloseTo(allHit + (noneHit - allHit) * (1 - m.cacheHitRate!), 2);
        }
    });

    it('offers only cache-capable models (no Groq — it has no prompt caching)', () => {
        // With no caching, the re-sent history bills at full input every turn
        // on this workload.
        expect(models.some((m) => m.provider === 'groq')).toBe(false);
        expect(models.some((m) => m.model === 'llama-3.3-70b-versatile')).toBe(false);
    });
});

describe('estimateStt', () => {
    it('is a small leg, and the default is the cheaper of the two models', () => {
        const stt = estimateStt(); // server default gpt-transcribe
        expect(stt.creditsPerHour).toBeGreaterThan(0);
        // VAD-segmented speech makes STT cheap relative to a premium model hour.
        const opus = estimateModels().find((m) => m.model === 'claude-opus-5')!;
        expect(stt.costUsdPerHour).toBeLessThan(opus.costUsdPerHour);
        // The retired model, still allowlisted for an env rollback, costs more.
        expect(estimateStt('gpt-4o-transcribe').creditsPerSession).toBeGreaterThan(
            stt.creditsPerSession
        );
    });

    it('prices Parakeet as the hybrid mix where the backend offers gpt-transcribe', () => {
        const PARAKEET = 'moondream/parakeet-ultra';
        const openai = resolveSttConfig({ OPENAI_API_KEY: 'sk-test' });
        const s = TYPICAL_SESSION.sttSeconds;
        expect(HYBRID_STAND_IN_AUDIO_SHARE).toBe(0.1);
        expect(estimateStt(PARAKEET, openai).creditsPerSession).toBeCloseTo(
            priceSttSeconds(s * 0.1, 'gpt-transcribe').credits + priceSttSeconds(s * 0.9, PARAKEET).credits,
            12
        );
        expect(estimateStt(PARAKEET, openai).creditsPerHour).toBe(0.31);
        // Parakeet alone where the route would run it alone.
        expect(estimateStt(PARAKEET).creditsPerHour).toBe(0.24);
        expect(estimateStt(PARAKEET, resolveSttConfig({ GROQ_API_KEY: 'gsk-test' })).creditsPerHour).toBe(0.24);
        // Nothing else mixes.
        expect(estimateStt('gpt-transcribe', openai)).toEqual(estimateStt('gpt-transcribe'));
        expect(estimateStt('x-ai/grok-stt-2.0', openai)).toEqual(estimateStt('x-ai/grok-stt-2.0'));
    });
});

describe('estimateVoices', () => {
    const voices = estimateVoices();

    it('local engines cost zero across the whole band', () => {
        const browser = voices.find((v) => v.voiceId === 'browser-default')!;
        expect(browser.creditsPerHour.spacious).toBe(0);
        expect(browser.creditsPerHour.typical).toBe(0);
        expect(browser.creditsPerHour.engaged).toBe(0);
        expect(browser.creditsPerHour.talkative).toBe(0);
    });

    it('lists exactly the offered voices: the free locals + the curated cloud set', () => {
        const ids = voices.map((v) => v.voiceId);
        expect(ids).toContain('browser-default');
        expect(ids).toContain('os-premium');
        // Every curated voice (every provider + tier) is estimated, by its real
        // provider voice id.
        for (const v of CURATED_VOICES) expect(ids).toContain(v.providerVoiceId);
        expect(voices).toHaveLength(2 + CURATED_VOICES.length);
    });

    it('cloud voice cost rises across the talk band (spacious < typical < engaged < talkative)', () => {
        const leda = voices.find((v) => v.voiceId === defaultVoice().providerVoiceId)!;
        expect(leda.creditsPerHour.spacious).toBeLessThan(leda.creditsPerHour.typical);
        expect(leda.creditsPerHour.typical).toBeLessThan(leda.creditsPerHour.engaged);
        expect(leda.creditsPerHour.engaged).toBeLessThan(leda.creditsPerHour.talkative);
    });

    it('prices the value (Neural2) tier below the premium (Chirp3-HD) tier', () => {
        const rateOf = (id: string) => voices.find((v) => v.voiceId === id)!.costUsdPerHourTypical;
        // Pin to Google voices specifically so the 16/30 tier ratio stays exact.
        const premium = CURATED_VOICES.find((v) => v.provider === 'google' && v.tier === 'premium')!;
        const value = CURATED_VOICES.find((v) => v.provider === 'google' && v.tier === 'value')!;
        expect(rateOf(value.providerVoiceId)).toBeGreaterThan(0);
        expect(rateOf(value.providerVoiceId)).toBeLessThan(rateOf(premium.providerVoiceId));
        // Neural2 ($16/1M) is ~half Chirp3-HD ($30/1M).
        expect(rateOf(value.providerVoiceId) / rateOf(premium.providerVoiceId)).toBeCloseTo(16 / 30, 2);
    });

    it("prices a whole-reply voice's tags once a reply, not once a sentence", () => {
        const harper = CURATED_VOICES.find((v) => v.name === 'Harper')!;
        expect(harper.wholeReply).toBe(true);
        const asSent = azureSsmlOverheadFactor(harper);
        const perSentence = azureSsmlOverheadFactor({ ...harper, wholeReply: false });
        expect(asSent).toBeGreaterThan(1);
        expect(asSent).toBeLessThan(perSentence);
        // The same tags and lead, over a longer request.
        expect((asSent - 1) / (perSentence - 1)).toBeCloseTo(80 / 120, 6);
        const rateOf = (id: string) => voices.find((v) => v.voiceId === id)!.costUsdPerHourTypical;
        expect(rateOf(harper.providerVoiceId)).toBeGreaterThan(0);
    });

    it('prices the Inworld voices below the Chirp3-HD cost (premium-bucket, cheaper burn)', () => {
        const rateOf = (id: string) => voices.find((v) => v.voiceId === id)!.costUsdPerHourTypical;
        const premium = CURATED_VOICES.find((v) => v.provider === 'google' && v.tier === 'premium')!;
        for (const v of CURATED_VOICES.filter((c) => c.provider === 'inworld')) {
            expect(rateOf(v.providerVoiceId), v.name).toBeGreaterThan(0);
            expect(rateOf(v.providerVoiceId), v.name).toBeLessThan(rateOf(premium.providerVoiceId));
        }
    });
});

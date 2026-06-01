import { describe, it, expect } from 'vitest';
import { estimateModels, estimateStt, estimateVoices } from '../src/pricing/estimate.js';
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
        expect(usd('claude-opus-4-8')).toBeGreaterThan(usd('claude-sonnet-4-6'));
        expect(usd('claude-sonnet-4-6')).toBeGreaterThan(usd('claude-haiku-4-5-20251001'));
        // ~5x on this cache-heavy workload.
        expect(usd('claude-opus-4-8') / usd('claude-haiku-4-5-20251001')).toBeGreaterThan(3);
    });

    it('a NO-CACHE model (Groq) can beat a cached cheap model (Haiku) on cost: '
        + 'this workload is ~98% re-sent history, so cheap cache reads matter more than sticker price', () => {
        const usd = (model: string) => models.find((m) => m.model === model)!.costUsdPerHour;
        // Groq has no prompt caching, so the heavy re-sent prefix bills at full
        // input rate — making it pricier here than Haiku-with-caching despite a
        // lower sticker price. A real, counterintuitive cost-model fact.
        expect(usd('llama-3.3-70b-versatile')).toBeGreaterThan(usd('claude-haiku-4-5-20251001'));
    });
});

describe('estimateStt', () => {
    it('is a small, model-independent leg', () => {
        const stt = estimateStt();
        expect(stt.creditsPerHour).toBeGreaterThan(0);
        // VAD-segmented speech makes STT cheap relative to a premium model hour.
        const opus = estimateModels().find((m) => m.model === 'claude-opus-4-8')!;
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

    it('lists exactly the offered voices: the free locals + the curated Google cloud set', () => {
        const ids = voices.map((v) => v.voiceId);
        expect(ids).toContain('browser-default');
        expect(ids).toContain('os-premium');
        // Every curated (Chirp3-HD) voice is estimated, by its real Google id.
        for (const v of CURATED_VOICES) expect(ids).toContain(v.googleId);
        expect(voices).toHaveLength(2 + CURATED_VOICES.length);
        // No aspirational engines the server can't synthesize.
        expect(ids.some((id) => id.includes('elevenlabs') || id.includes('hume'))).toBe(false);
    });

    it('cloud voice cost rises across the talk band (spacious < typical < engaged)', () => {
        const leda = voices.find((v) => v.voiceId === defaultVoice().googleId)!;
        expect(leda.creditsPerHour.spacious).toBeLessThan(leda.creditsPerHour.typical);
        expect(leda.creditsPerHour.typical).toBeLessThan(leda.creditsPerHour.engaged);
    });

    it('all curated voices share the Chirp3-HD rate (same tier) and cost more than free', () => {
        const cloud = voices.filter((v) => v.voiceId.includes('Chirp3-HD'));
        expect(cloud.length).toBe(CURATED_VOICES.length);
        const rates = cloud.map((v) => v.costUsdPerHourTypical);
        expect(new Set(rates).size).toBe(1); // one tier → one rate
        expect(rates[0]!).toBeGreaterThan(0);
    });
});

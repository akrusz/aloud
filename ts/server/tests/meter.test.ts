import { describe, it, expect } from 'vitest';
import {
    USD_PER_CREDIT,
    PACK_MARKUP,
    assertSolvent,
    llmCostUsd,
    packPriceUsd,
    priceLlmTurn,
    priceSession,
    priceTtsChars,
    type PackLike,
} from '../src/pricing/meter.js';

describe('llmCostUsd', () => {
    it('prices input, output, and cache-read separately (never summed)', () => {
        // sonnet: 3/M in, 15/M out, 0.3/M cache-read
        const cost = llmCostUsd('anthropic', 'claude-sonnet-4-6', {
            tokensIn: 1_000_000,
            tokensOut: 1_000_000,
            cacheRead: 1_000_000,
        });
        expect(cost).toBeCloseTo(3 + 15 + 0.3, 6);
    });

    it('returns 0 for an unknown model rather than throwing', () => {
        expect(llmCostUsd('anthropic', 'no-such-model', { tokensIn: 1000 })).toBe(0);
    });

    it('treats null/absent usage fields as zero', () => {
        expect(llmCostUsd('anthropic', 'claude-sonnet-4-6', {})).toBe(0);
        expect(
            llmCostUsd('anthropic', 'claude-sonnet-4-6', { tokensIn: null, tokensOut: 1000 })
        ).toBeCloseTo(1000 * (15 / 1_000_000), 9);
    });
});

describe('priceLlmTurn', () => {
    it('debits at COST (no markup), fractional — never rounds a turn up', () => {
        const turn = priceLlmTurn('anthropic', 'claude-sonnet-4-6', {
            tokensIn: 1000,
            tokensOut: 500,
        });
        const expectedUsd = (1000 * 3 + 500 * 15) / 1_000_000; // raw provider cost
        expect(turn.providerCostUsd).toBeCloseTo(expectedUsd, 9);
        // Credits are cost / USD_PER_CREDIT — margin is NOT applied here, and the
        // exact fraction is debited (rounding a turn up would over-charge cheap
        // turns by orders of magnitude).
        expect(turn.credits).toBeCloseTo(expectedUsd / USD_PER_CREDIT, 9);
    });

    it('does not round a tiny cached turn up to a whole credit', () => {
        // A near-free turn (mostly cache reads) must debit a tiny fraction, not 1.
        const turn = priceLlmTurn('google', 'gemini-2.5-flash-lite', {
            tokensIn: 50,
            tokensOut: 20,
            cacheRead: 4000,
        });
        expect(turn.credits).toBeLessThan(0.05);
        expect(turn.credits).toBeGreaterThan(0);
    });
});

describe('priceSession', () => {
    it('sums all three metered legs (llm + stt + tts)', () => {
        const turn = priceSession('anthropic', 'claude-haiku-4-5-20251001', {
            llmCalls: 1,
            llmTokensIn: 1000,
            llmTokensOut: 1000,
            llmCacheRead: 0,
            llmCacheCreation: 0,
            sttSeconds: 60,
            ttsChars: 500,
        });
        expect(turn.providerCostUsd).toBeGreaterThan(0);
        expect(turn.credits).toBeGreaterThan(0);
    });
});

describe('priceTtsChars', () => {
    const N = 100_000; // chars

    it('prices a Chirp3-HD voice at $30/1M', () => {
        const cost = priceTtsChars(N, 'en-US-Chirp3-HD-Leda');
        expect(cost.providerCostUsd).toBeCloseTo(N * (30 / 1_000_000), 9);
    });

    it('prices cheaper Google tiers correctly — Neural2 $16/1M, Standard $4/1M', () => {
        expect(priceTtsChars(N, 'en-US-Neural2-C').providerCostUsd).toBeCloseTo(N * (16 / 1_000_000), 9);
        expect(priceTtsChars(N, 'en-US-Standard-B').providerCostUsd).toBeCloseTo(N * (4 / 1_000_000), 9);
    });

    it('falls back to the Chirp3-HD default when no voice is given', () => {
        const explicit = priceTtsChars(N, 'en-US-Chirp3-HD-Leda').providerCostUsd;
        expect(priceTtsChars(N).providerCostUsd).toBeCloseTo(explicit, 9);
    });

    it('debits fractional credits at cost (not ceiled)', () => {
        const cost = priceTtsChars(N, 'en-US-Chirp3-HD-Leda');
        expect(cost.credits).toBeCloseTo(cost.providerCostUsd / USD_PER_CREDIT, 9);
    });
});

describe('packPriceUsd', () => {
    it('marks credits up over the provider cost they fund', () => {
        expect(packPriceUsd(100)).toBeCloseTo(100 * USD_PER_CREDIT * PACK_MARKUP, 9);
    });
});

describe('assertSolvent', () => {
    const required = 1 / (1 - 0.18); // worst-case EU commission floor

    it('passes packs whose markup clears the worst channel', () => {
        // 100 credits fund 100*USD_PER_CREDIT of cost; price it well above.
        const ok: PackLike[] = [
            { id: 'p1', credits: 100, priceUsdCents: Math.ceil(100 * USD_PER_CREDIT * 2.5 * 100) },
        ];
        const reports = assertSolvent(ok);
        expect(reports[0]!.clears).toBe(true);
        expect(reports[0]!.effectiveMarkup).toBeGreaterThanOrEqual(required);
    });

    it('throws if a pack is priced below the worst-channel markup floor', () => {
        // Priced at exactly cost (1x markup) — must fail.
        const bad: PackLike[] = [
            { id: 'loss', credits: 100, priceUsdCents: Math.ceil(100 * USD_PER_CREDIT * 100) },
        ];
        expect(() => assertSolvent(bad)).toThrow(/insolvent/);
    });
});

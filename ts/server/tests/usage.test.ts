/**
 * buildUsageReport aggregation tests — the cost-attribution math behind the
 * admin dashboard (meditation-pal-rvy). Pure function over events, so no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
    buildUsageReport,
    buildUsageHistory,
    SESSION_GAP_SEC,
    type UsageEvent,
} from '../src/credits/usage.js';

const DAY = 24 * 60 * 60;

function ev(over: Partial<UsageEvent> = {}): UsageEvent {
    return {
        id: Math.random().toString(36).slice(2),
        accountId: 'a1',
        sessionId: null,
        passId: null,
        ts: 1000,
        kind: 'llm',
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
        cacheCreation1h: 0,
        seconds: 0,
        chars: 0,
        providerCostUsd: 0,
        credits: 0,
        ...over,
    };
}

describe('buildUsageReport', () => {
    it('splits provider cost by service and computes each share', () => {
        const events = [
            ev({ kind: 'llm', providerCostUsd: 0.6, credits: 12 }),
            ev({ kind: 'stt', providerCostUsd: 0.1, credits: 2 }),
            ev({ kind: 'tts', providerCostUsd: 0.3, credits: 6 }),
        ];
        const r = buildUsageReport(events, 2000, 0);
        expect(r.totals.providerCostUsd).toBeCloseTo(1.0, 9);
        const byKind = Object.fromEntries(r.byService.map((s) => [s.kind, s]));
        expect(byKind.llm!.costShare).toBeCloseTo(0.6, 6);
        expect(byKind.stt!.costShare).toBeCloseTo(0.1, 6);
        expect(byKind.tts!.costShare).toBeCloseTo(0.3, 6);
        expect(byKind.tts!.events).toBe(1);
    });

    it('computes LLM cache-hit ratio over input+cacheRead+cacheCreation only', () => {
        const events = [
            ev({ kind: 'llm', tokensIn: 100, cacheRead: 900, cacheCreation: 0 }),
            // STT/TTS tokens must NOT pollute the ratio.
            ev({ kind: 'tts', chars: 5000 }),
        ];
        const r = buildUsageReport(events, 2000, 0);
        expect(r.llmCacheHitRatio).toBeCloseTo(900 / 1000, 9);
    });

    it('computes cache economics — token split, $ saved vs no-cache, per provider', () => {
        const M = 1_000_000;
        // Opus 4.8 rates: in 5/M, out 25/M, read 0.5/M, write 6.25/M.
        const actual = (1000 * 5 + 200 * 25 + 10_000 * 0.5 + 1000 * 6.25) / M;
        const noCache = (1000 * 5 + 200 * 25 + (10_000 + 1000) * 5) / M;
        const events = [
            ev({
                kind: 'llm',
                provider: 'anthropic',
                model: 'claude-opus-4-8',
                tokensIn: 1000,
                tokensOut: 200,
                cacheRead: 10_000,
                cacheCreation: 1000,
                cacheCreation1h: 250,
                providerCostUsd: actual,
            }),
            // STT must not touch the cache aggregates.
            ev({ kind: 'stt', seconds: 30, providerCostUsd: 0.001 }),
        ];
        const r = buildUsageReport(events, 2000, 0);

        expect(r.llmCache.freshInputTokens).toBe(1000);
        expect(r.llmCache.cacheReadTokens).toBe(10_000);
        expect(r.llmCache.cacheCreationTokens).toBe(1000);
        expect(r.llmCache.cacheCreation1hTokens).toBe(250);
        expect(r.llmCache.hitRatio).toBeCloseTo(10_000 / 12_000, 9);
        expect(r.llmCache.costUsd).toBeCloseTo(actual, 12);
        expect(r.llmCache.costNoCacheUsd).toBeCloseTo(noCache, 12);
        expect(r.llmCache.savedUsd).toBeCloseTo(noCache - actual, 12);

        expect(r.llmCacheByProvider).toHaveLength(1);
        expect(r.llmCacheByProvider[0]!.provider).toBe('anthropic');
        expect(r.llmCacheByProvider[0]!.savedUsd).toBeCloseTo(noCache - actual, 12);
    });

    it('unknown-model cache savings is zero (no price table → actual cost as baseline)', () => {
        const events = [
            ev({
                kind: 'llm',
                provider: 'anthropic',
                model: 'some-unpriced-model',
                tokensIn: 100,
                cacheRead: 5000,
                providerCostUsd: 0.003,
            }),
        ];
        const r = buildUsageReport(events, 2000, 0);
        // No rate → costNoCache falls back to actual, so savings can't be faked.
        expect(r.llmCache.costNoCacheUsd).toBeCloseTo(0.003, 12);
        expect(r.llmCache.savedUsd).toBeCloseTo(0, 12);
    });

    it('ranks per-model cost biggest first', () => {
        const events = [
            ev({ kind: 'llm', model: 'cheap', providerCostUsd: 0.01 }),
            ev({ kind: 'llm', model: 'pricey', providerCostUsd: 0.5 }),
            ev({ kind: 'llm', model: 'pricey', providerCostUsd: 0.5 }),
        ];
        const r = buildUsageReport(events, 2000, 0);
        expect(r.byModel[0]!.model).toBe('pricey');
        expect(r.byModel[0]!.events).toBe(2);
        expect(r.byModel[0]!.providerCostUsd).toBeCloseTo(1.0, 9);
        expect(r.byModel[1]!.model).toBe('cheap');
    });

    it('excludes events before the window', () => {
        const events = [
            ev({ ts: 500, providerCostUsd: 99 }), // before window
            ev({ ts: 1500, providerCostUsd: 1 }),
        ];
        const r = buildUsageReport(events, 2000, 1000);
        expect(r.events).toBe(1);
        expect(r.totals.providerCostUsd).toBeCloseTo(1, 9);
    });

    it('clusters one account into sessions by the time gap', () => {
        const events = [
            // session 1: two calls close together
            ev({ ts: 1000, providerCostUsd: 0.2, credits: 4 }),
            ev({ ts: 1030, providerCostUsd: 0.1, credits: 2 }),
            // session 2: after a gap > SESSION_GAP_SEC
            ev({ ts: 1000 + SESSION_GAP_SEC + 60, providerCostUsd: 0.3, credits: 6 }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.sessions.count).toBe(2);
        expect(r.sessions.costUsd.max).toBeCloseTo(0.3, 9);
        // session 1 summed to 0.3 too; both sessions cost 0.3, so p50/max = 0.3.
        expect(r.sessions.costUsd.p50).toBeCloseTo(0.3, 9);
        expect(r.sessions.credits.max).toBeCloseTo(6, 9);
    });

    it('keeps different accounts in separate sessions even at the same time', () => {
        const events = [
            ev({ accountId: 'a1', ts: 1000, providerCostUsd: 0.2 }),
            ev({ accountId: 'a2', ts: 1000, providerCostUsd: 0.2 }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.sessions.count).toBe(2);
    });

    it('honors an explicit sessionId over the time gap', () => {
        // Same explicit session id spanning a long gap stays ONE session;
        // a different id at the same instant is a different session.
        const events = [
            ev({ sessionId: 's1', ts: 1000 }),
            ev({ sessionId: 's1', ts: 1000 + SESSION_GAP_SEC * 5 }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.sessions.count).toBe(1);
    });

    it('counts facilitator turns per session as the LLM calls only', () => {
        const events = [
            // session 1: 3 LLM turns + an STT + a TTS leg (5 calls, 3 turns)
            ev({ ts: 1000, kind: 'llm' }),
            ev({ ts: 1010, kind: 'stt' }),
            ev({ ts: 1020, kind: 'llm' }),
            ev({ ts: 1030, kind: 'tts' }),
            ev({ ts: 1040, kind: 'llm' }),
            // session 2 (after a gap): a single LLM turn
            ev({ ts: 1000 + SESSION_GAP_SEC + 60, kind: 'llm' }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.sessions.count).toBe(2);
        // turns per session: [3, 1] → max 3, p50 (nearest-rank of [1,3]) = 3, min reflected in mean 2
        expect(r.sessions.turns.max).toBe(3);
        expect(r.sessions.turns.mean).toBeCloseTo(2, 9);
    });

    it('returns zeroed aggregates for an empty window', () => {
        const r = buildUsageReport([], 2000, 1000);
        expect(r.events).toBe(0);
        expect(r.llmCacheHitRatio).toBe(0);
        expect(r.sessions.count).toBe(0);
        expect(r.sessions.costUsd.p90).toBe(0);
        expect(r.sessions.turns.max).toBe(0);
        expect(r.byService.every((s) => s.events === 0)).toBe(true);
    });
});

describe('buildUsageHistory', () => {
    // Anchor "now" to a clean day boundary so day math is exact.
    const NOW = 100 * DAY + 3600; // mid-day on day 100

    it('emits one zero-filled bucket per day, oldest first', () => {
        const h = buildUsageHistory([], NOW, 7);
        expect(h).toHaveLength(7);
        expect(h.every((b) => b.sessions === 0 && b.turns === 0)).toBe(true);
        // Sorted ascending, ending on today's UTC start.
        for (let i = 1; i < h.length; i++) expect(h[i]!.dayStartTs).toBeGreaterThan(h[i - 1]!.dayStartTs);
        expect(h[h.length - 1]!.dayStartTs).toBe(100 * DAY);
        expect(h[0]!.dayStartTs).toBe(94 * DAY);
    });

    it('attributes a session to the day of its first event and sums turns/spend', () => {
        const events = [
            // a session yesterday: 2 turns + a TTS leg
            ev({ ts: 99 * DAY + 100, kind: 'llm', providerCostUsd: 0.2, credits: 4 }),
            ev({ ts: 99 * DAY + 130, kind: 'tts', providerCostUsd: 0.05, credits: 1 }),
            ev({ ts: 99 * DAY + 160, kind: 'llm', providerCostUsd: 0.1, credits: 2 }),
        ];
        const h = buildUsageHistory(events, NOW, 7);
        const yesterday = h.find((b) => b.dayStartTs === 99 * DAY)!;
        expect(yesterday.sessions).toBe(1);
        expect(yesterday.turns).toBe(2);
        expect(yesterday.events).toBe(3);
        expect(yesterday.providerCostUsd).toBeCloseTo(0.35, 9);
        expect(yesterday.credits).toBeCloseTo(7, 9);
        // Other days stay empty.
        expect(h.filter((b) => b.sessions > 0)).toHaveLength(1);
    });

    it('does not split a midnight-spanning session across two days', () => {
        // Same explicit session id, events straddling the day boundary.
        const events = [
            ev({ sessionId: 's1', ts: 99 * DAY - 60, kind: 'llm' }),
            ev({ sessionId: 's1', ts: 99 * DAY + 60, kind: 'llm' }),
        ];
        const h = buildUsageHistory(events, NOW, 7);
        const withSessions = h.filter((b) => b.sessions > 0);
        expect(withSessions).toHaveLength(1);
        // Counted once, on the day it began (day 98).
        expect(withSessions[0]!.dayStartTs).toBe(98 * DAY);
        expect(withSessions[0]!.turns).toBe(2);
    });

    it('ignores events older than the window', () => {
        const events = [ev({ ts: 50 * DAY, kind: 'llm', providerCostUsd: 99 })];
        const h = buildUsageHistory(events, NOW, 7);
        expect(h.every((b) => b.sessions === 0)).toBe(true);
    });
});

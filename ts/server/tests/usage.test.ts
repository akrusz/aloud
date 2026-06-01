/**
 * buildUsageReport aggregation tests — the cost-attribution math behind the
 * admin dashboard (meditation-pal-rvy). Pure function over events, so no I/O.
 */

import { describe, it, expect } from 'vitest';
import { buildUsageReport, SESSION_GAP_SEC, type UsageEvent } from '../src/credits/usage.js';

function ev(over: Partial<UsageEvent> = {}): UsageEvent {
    return {
        id: Math.random().toString(36).slice(2),
        accountId: 'a1',
        sessionId: null,
        ts: 1000,
        kind: 'llm',
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
        tokensIn: 0,
        tokensOut: 0,
        cacheRead: 0,
        cacheCreation: 0,
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

    it('returns zeroed aggregates for an empty window', () => {
        const r = buildUsageReport([], 2000, 1000);
        expect(r.events).toBe(0);
        expect(r.llmCacheHitRatio).toBe(0);
        expect(r.sessions.count).toBe(0);
        expect(r.sessions.costUsd.p90).toBe(0);
        expect(r.byService.every((s) => s.events === 0)).toBe(true);
    });
});

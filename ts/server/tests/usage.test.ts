/**
 * buildUsageReport aggregation tests — the cost-attribution math behind the
 * admin dashboard (meditation-pal-rvy). Pure function over events, so no I/O.
 */

import { describe, it, expect } from 'vitest';
import {
    buildUsageReport,
    buildUsageHistory,
    buildProviderDailyCosts,
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
        expect(r.accounts).toBe(1); // all three events share accountId a1
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
        // Opus 5 rates: in 5/M, out 25/M, read 0.5/M, write 6.25/M.
        const actual = (1000 * 5 + 200 * 25 + 10_000 * 0.5 + 1000 * 6.25) / M;
        const noCache = (1000 * 5 + 200 * 25 + (10_000 + 1000) * 5) / M;
        const events = [
            ev({
                kind: 'llm',
                provider: 'anthropic',
                model: 'claude-opus-5',
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

    it('minSessionTurns drops short sessions from the distributions, not the totals', () => {
        const events = [
            // session 1: 4 LLM turns, $0.40
            ev({ ts: 1000, kind: 'llm', providerCostUsd: 0.1 }),
            ev({ ts: 1010, kind: 'llm', providerCostUsd: 0.1 }),
            ev({ ts: 1020, kind: 'llm', providerCostUsd: 0.1 }),
            ev({ ts: 1030, kind: 'llm', providerCostUsd: 0.1 }),
            // session 2 (after a gap): a 1-turn drive-by, $0.01
            ev({ ts: 1000 + SESSION_GAP_SEC + 60, kind: 'llm', providerCostUsd: 0.01 }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0, { minSessionTurns: 4 });
        // Totals still cover every event.
        expect(r.totals.providerCostUsd).toBeCloseTo(0.41, 9);
        expect(r.events).toBe(5);
        // Distributions only see the 4-turn session; the drive-by is counted out.
        expect(r.sessions.count).toBe(1);
        expect(r.sessions.excludedShort).toBe(1);
        expect(r.sessions.turns.mean).toBeCloseTo(4, 9);
        expect(r.sessions.costUsd.mean).toBeCloseTo(0.4, 9);
        // Default keeps everything.
        const all = buildUsageReport(events, 1_000_000, 0);
        expect(all.sessions.count).toBe(2);
        expect(all.sessions.excludedShort).toBe(0);
    });

    it('perHour: divides qualifying-session spend by their summed duration', () => {
        const events = [
            // session 1: 30 min, 2 turns + a TTS leg, 6 credits / $0.30 total
            ev({ sessionId: 's1', ts: 1000, kind: 'llm', providerCostUsd: 0.1, credits: 2 }),
            ev({ sessionId: 's1', ts: 1000 + 900, kind: 'tts', providerCostUsd: 0.1, credits: 2, chars: 5000 }),
            ev({ sessionId: 's1', ts: 1000 + 1200, kind: 'stt', providerCostUsd: 0, credits: 0, seconds: 120 }),
            ev({ sessionId: 's1', ts: 1000 + 1800, kind: 'llm', providerCostUsd: 0.1, credits: 2 }),
            // session 2: 30 s blip — below both bars, excluded
            ev({ sessionId: 's2', ts: 50_000, kind: 'llm', providerCostUsd: 5, credits: 100 }),
            ev({ sessionId: 's2', ts: 50_030, kind: 'llm', providerCostUsd: 5, credits: 100 }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.perHour.sessions).toBe(1);
        expect(r.perHour.hours).toBeCloseTo(0.5, 9);
        // 6 credits / 0.5 h = 12 cr/hr; $0.30 / 0.5 h = $0.60/hr.
        expect(r.perHour.creditsPerHour).toBeCloseTo(12, 9);
        expect(r.perHour.costUsdPerHour).toBeCloseTo(0.6, 9);
        // Per-service split over the SAME denominator.
        const svc = Object.fromEntries(r.perHour.byService.map((l) => [l.kind, l]));
        expect(svc.llm!.creditsPerHour).toBeCloseTo(8, 9);
        expect(svc.tts!.creditsPerHour).toBeCloseTo(4, 9);
        expect(svc.stt!.creditsPerHour).toBe(0);
        // Volumes per hour, in each leg's pricing unit.
        expect(r.perHour.turnsPerHour).toBeCloseTo(4, 9);
        expect(r.perHour.sttSecondsPerHour).toBeCloseTo(240, 9);
        expect(r.perHour.ttsCharsPerHour).toBeCloseTo(10_000, 9);
    });

    it('perHour: attributed STT/TTS rates divide by the hours that used the leg', () => {
        const events = [
            // Session 1 (30 min): cloud STT + cloud voice.
            ev({ sessionId: 's1', ts: 1000, kind: 'llm', credits: 1, providerCostUsd: 0.05 }),
            ev({ sessionId: 's1', ts: 1000 + 900, kind: 'stt', seconds: 300 }),
            ev({ sessionId: 's1', ts: 1000 + 900, kind: 'tts', chars: 6000 }),
            ev({ sessionId: 's1', ts: 1000 + 1800, kind: 'llm', credits: 1, providerCostUsd: 0.05 }),
            // Session 2 (30 min): local voice, cloud STT. Halves the global TTS
            // rate while saying nothing about what a cloud voice costs.
            ev({ sessionId: 's2', ts: 5000, kind: 'llm', credits: 1, providerCostUsd: 0.05 }),
            ev({ sessionId: 's2', ts: 5000 + 900, kind: 'stt', seconds: 300 }),
            ev({ sessionId: 's2', ts: 5000 + 1800, kind: 'llm', credits: 1, providerCostUsd: 0.05 }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.perHour.hours).toBeCloseTo(1, 9);
        // Global: 6000 chars over both hours-worth of session.
        expect(r.perHour.ttsCharsPerHour).toBeCloseTo(6000, 9);
        // Attributed: over the 0.5 h that actually used a cloud voice.
        expect(r.perHour.attributed.ttsCharsPerHour).toBeCloseTo(12_000, 9);
        // STT ran in both, so the two agree.
        expect(r.perHour.sttSecondsPerHour).toBeCloseTo(600, 9);
        expect(r.perHour.attributed.sttSecondsPerHour).toBeCloseTo(600, 9);
    });

    it('perHour: token volume comes from qualifying sessions only', () => {
        const events = [
            // Qualifying: 30 min, two LLM turns carrying tokens.
            ev({
                sessionId: 's1', ts: 1000, kind: 'llm', credits: 1, providerCostUsd: 0.05,
                tokensIn: 100, tokensOut: 200, cacheRead: 3000, cacheCreation: 400,
                cacheCreation1h: 150,
            }),
            ev({
                sessionId: 's1', ts: 1000 + 1800, kind: 'llm', credits: 1, providerCostUsd: 0.05,
                tokensIn: 100, tokensOut: 200, cacheRead: 3000, cacheCreation: 400,
                cacheCreation1h: 150,
            }),
            // A 30-second blip with huge token counts: excluded from the rate,
            // though the window-wide llmCache aggregate still sees it.
            ev({
                sessionId: 's2', ts: 50_000, kind: 'llm', credits: 50, providerCostUsd: 2,
                tokensIn: 999_999, tokensOut: 999_999, cacheRead: 999_999,
            }),
            ev({ sessionId: 's2', ts: 50_030, kind: 'llm', credits: 50, providerCostUsd: 2 }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        // 0.5 h of qualifying session: totals double into a per-hour rate.
        const t = r.perHour.tokensPerHour;
        expect(t.input).toBeCloseTo(400, 9);
        expect(t.output).toBeCloseTo(800, 9);
        expect(t.cacheRead).toBeCloseTo(12_000, 9);
        expect(t.cacheCreation).toBeCloseTo(1600, 9);
        expect(t.cacheCreation1h).toBeCloseTo(600, 9);
        // The excluded blip is exactly why these can't be derived from
        // llmCache, which counts every event in the window.
        expect(r.llmCache.freshInputTokens).toBe(1_000_199);
    });

    it('perHour: a 10+ turn session qualifies even under 5 minutes', () => {
        const events = Array.from({ length: 10 }, (_, i) =>
            ev({ ts: 1000 + i * 12, kind: 'llm', providerCostUsd: 0.01, credits: 0.2 })
        );
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.perHour.sessions).toBe(1);
        // 108 s = 0.03 h; 2 credits / 0.03 h.
        expect(r.perHour.creditsPerHour).toBeCloseTo(2 / 0.03, 6);
    });

    it('perHour: per-model rows use only the hours of sessions that used the model', () => {
        const events = [
            // session 1 (60 min): opus only, 6 credits
            ev({ sessionId: 's1', ts: 1000, kind: 'llm', provider: 'anthropic', model: 'claude-opus-5', credits: 3, providerCostUsd: 0.15 }),
            ev({ sessionId: 's1', ts: 1000 + 3600, kind: 'llm', provider: 'anthropic', model: 'claude-opus-5', credits: 3, providerCostUsd: 0.15 }),
            // session 2 (30 min, other account): flash-lite only, 1 credit
            ev({ accountId: 'a2', sessionId: 's2', ts: 1000, kind: 'llm', credits: 0.5, providerCostUsd: 0.01 }),
            ev({ accountId: 'a2', sessionId: 's2', ts: 1000 + 1800, kind: 'llm', credits: 0.5, providerCostUsd: 0.01 }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.perHour.hours).toBeCloseTo(1.5, 9);
        const opus = r.perHour.byModel.find((m) => m.model === 'claude-opus-5')!;
        const flash = r.perHour.byModel.find((m) => m.model === 'gemini-2.5-flash-lite')!;
        // Opus: 6 credits over ITS 1 h, not the window's 1.5 h.
        expect(opus.hours).toBeCloseTo(1, 9);
        expect(opus.creditsPerHour).toBeCloseTo(6, 9);
        expect(opus.unitsPerHour).toBeCloseTo(2, 9); // 2 turns over its 1 h
        expect(flash.hours).toBeCloseTo(0.5, 9);
        expect(flash.creditsPerHour).toBeCloseTo(2, 9);
        // The overall rate is a sqrt-of-spend weighted mean ACROSS THE TWO
        // ACCOUNTS, not 7 credits / 1.5 h. a1 burns 6 cr/hr on $0.30 of spend,
        // a2 burns 2 cr/hr on $0.02: the heavier user leads, but the lighter
        // one still moves the number well above a straight total/total (4.67).
        const w1 = Math.sqrt(0.3);
        const w2 = Math.sqrt(0.02);
        expect(r.perHour.creditsPerHour).toBeCloseTo((w1 * 6 + w2 * 2) / (w1 + w2), 9);
        expect(r.perHour.accounts).toBe(2);
    });

    it('perHour: ignores the minSessionTurns option', () => {
        const events = [
            ev({ sessionId: 's1', ts: 1000, kind: 'llm', credits: 1, providerCostUsd: 0.05 }),
            ev({ sessionId: 's1', ts: 1000 + 600, kind: 'llm', credits: 1, providerCostUsd: 0.05 }),
        ];
        // 2 turns: dropped from the session distributions at minTurns=4, but a
        // 10-minute session still counts toward the burn rate.
        const r = buildUsageReport(events, 1_000_000, 0, { minSessionTurns: 4 });
        expect(r.sessions.count).toBe(0);
        expect(r.perHour.sessions).toBe(1);
        expect(r.perHour.creditsPerHour).toBeCloseTo(12, 9);
    });

    it('returns zeroed aggregates for an empty window', () => {
        const r = buildUsageReport([], 2000, 1000);
        expect(r.events).toBe(0);
        expect(r.llmCacheHitRatio).toBe(0);
        expect(r.sessions.count).toBe(0);
        expect(r.sessions.costUsd.p90).toBe(0);
        expect(r.sessions.turns.max).toBe(0);
        expect(r.byService.every((s) => s.events === 0)).toBe(true);
        expect(r.perHour.sessions).toBe(0);
        expect(r.perHour.creditsPerHour).toBe(0);
        expect(r.perHour.byModel).toEqual([]);
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

    it('counts distinct active accounts per day, not sessions', () => {
        const events = [
            // a1: two separate sessions yesterday (gap > SESSION_GAP_SEC)
            ev({ accountId: 'a1', ts: 99 * DAY + 100 }),
            ev({ accountId: 'a1', ts: 99 * DAY + 100 + SESSION_GAP_SEC + 60 }),
            // a2: one session the same day
            ev({ accountId: 'a2', ts: 99 * DAY + 500 }),
        ];
        const h = buildUsageHistory(events, NOW, 7);
        const yesterday = h.find((b) => b.dayStartTs === 99 * DAY)!;
        expect(yesterday.sessions).toBe(3);
        expect(yesterday.accounts).toBe(2);
        expect(h.find((b) => b.dayStartTs === 100 * DAY)!.accounts).toBe(0);
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

describe('buildProviderDailyCosts', () => {
    const NOW = 100 * DAY + 3600; // mid-day on day 100

    it('buckets each event by its own UTC day, split by provider and kind with units', () => {
        const events = [
            ev({ ts: 99 * DAY + 100, provider: 'anthropic', providerCostUsd: 0.2 }),
            ev({ ts: 99 * DAY + 200, provider: 'anthropic', providerCostUsd: 0.1 }),
            ev({ ts: 99 * DAY + 300, provider: 'openai', kind: 'tts', providerCostUsd: 0.05, chars: 1200 }),
            ev({ ts: 99 * DAY + 400, provider: 'openai', kind: 'stt', providerCostUsd: 0.02, seconds: 90 }),
            ev({ ts: 100 * DAY + 60, provider: 'anthropic', providerCostUsd: 0.4 }),
        ];
        const rows = buildProviderDailyCosts(events, NOW, 7);
        expect(rows).toEqual([
            { dayStartTs: 99 * DAY, provider: 'anthropic', kind: 'llm', events: 2, providerCostUsd: expect.closeTo(0.3, 9), seconds: 0, chars: 0 },
            { dayStartTs: 99 * DAY, provider: 'openai', kind: 'stt', events: 1, providerCostUsd: expect.closeTo(0.02, 9), seconds: 90, chars: 0 },
            { dayStartTs: 99 * DAY, provider: 'openai', kind: 'tts', events: 1, providerCostUsd: expect.closeTo(0.05, 9), seconds: 0, chars: 1200 },
            { dayStartTs: 100 * DAY, provider: 'anthropic', kind: 'llm', events: 1, providerCostUsd: expect.closeTo(0.4, 9), seconds: 0, chars: 0 },
        ]);
    });

    it('splits a midnight-spanning session across the days its events fall on', () => {
        // Unlike buildUsageHistory, provider billing doesn't care about our
        // session boundaries — each event lands on its own day.
        const events = [
            ev({ sessionId: 's1', ts: 99 * DAY - 60, provider: 'anthropic', providerCostUsd: 0.1 }),
            ev({ sessionId: 's1', ts: 99 * DAY + 60, provider: 'anthropic', providerCostUsd: 0.2 }),
        ];
        const rows = buildProviderDailyCosts(events, NOW, 7);
        expect(rows.map((r) => r.dayStartTs)).toEqual([98 * DAY, 99 * DAY]);
    });

    it('ignores events outside the window', () => {
        const events = [ev({ ts: 50 * DAY, provider: 'anthropic', providerCostUsd: 99 })];
        expect(buildProviderDailyCosts(events, NOW, 7)).toEqual([]);
    });
});

describe('buildUsageReport - real-sit filter and account weighting', () => {
    it('one account: weighting is a no-op, so the rate is the plain total', () => {
        const events = [
            ev({ sessionId: 's1', ts: 1000, kind: 'llm', credits: 3, providerCostUsd: 0.15 }),
            ev({ sessionId: 's1', ts: 1000 + 3600, kind: 'llm', credits: 3, providerCostUsd: 0.15 }),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.perHour.accounts).toBe(1);
        expect(r.perHour.creditsPerHour).toBeCloseTo(6, 9);
    });

    it('caps how far one heavy account can pull the rate', () => {
        // One account with 100x the spend of nine others, burning 10x the rate.
        // Unweighted this lands near 10; one-account-one-vote would land near
        // 1.9; sqrt sits between, closer to the crowd than to the whale.
        const events = [
            ev({ accountId: 'whale', sessionId: 'w', ts: 1000, kind: 'llm', credits: 100, providerCostUsd: 5 }),
            ev({ accountId: 'whale', sessionId: 'w', ts: 1000 + 3600, kind: 'llm', credits: 0, providerCostUsd: 0 }),
            ...Array.from({ length: 9 }, (_, i) => [
                ev({ accountId: `u${i}`, sessionId: `s${i}`, ts: 1000, kind: 'llm', credits: 10, providerCostUsd: 0.5 }),
                ev({ accountId: `u${i}`, sessionId: `s${i}`, ts: 1000 + 3600, kind: 'llm', credits: 0, providerCostUsd: 0 }),
            ]).flat(),
        ];
        const r = buildUsageReport(events, 1_000_000, 0);
        expect(r.perHour.accounts).toBe(10);
        expect(r.perHour.creditsPerHour).toBeGreaterThan(10);
        expect(r.perHour.creditsPerHour).toBeLessThan(40);
    });

    it('the real-sit bar is configurable, and a zero disables that criterion', () => {
        const events = [
            // 40 min, 2 turns: a long quiet sit.
            ev({ sessionId: 'long', ts: 1000, kind: 'llm', credits: 1, providerCostUsd: 0.05 }),
            ev({ sessionId: 'long', ts: 1000 + 2400, kind: 'llm', credits: 1, providerCostUsd: 0.05 }),
            // 3 min, 12 turns: a chatty trial run.
            ...Array.from({ length: 12 }, (_, i) =>
                ev({ sessionId: 'trial', ts: 90_000 + i * 15, kind: 'llm', credits: 1, providerCostUsd: 0.05 })
            ),
        ];
        // Default (5 min OR 10 turns) admits both.
        expect(buildUsageReport(events, 1_000_000, 0).perHour.sessions).toBe(2);
        // Real sits only: 25 minutes, no turn-count escape hatch.
        const strict = buildUsageReport(events, 1_000_000, 0, {
            realSit: { minMinutes: 25, minTurns: 0 },
        });
        expect(strict.perHour.sessions).toBe(1);
        expect(strict.perHour.turnsPerHour).toBeCloseTo(3, 9); // 2 turns / 0.667 h
    });
});

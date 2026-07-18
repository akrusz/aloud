/**
 * Per-call usage telemetry — the RAW cost record the ledger can't give us
 * (meditation-pal-rvy). The ledger is the money trail: append-only credit
 * deltas with a freeform reason. It deliberately does NOT carry the LLM token
 * split, the cache breakdown, or a per-service tag — so from the ledger alone
 * you cannot tell what drove a debit (was it TTS chars? a cold cache? output
 * tokens?). This table fills that gap.
 *
 * One row per metered provider call (LLM turn, STT pass, TTS synth), recording
 * the raw counts AND the full-precision provider cost (not the ceiled/rounded
 * credit). It's kept SEPARATE from the ledger on purpose:
 *   - the ledger stays a clean financial audit log (don't pollute it with
 *     analytics columns),
 *   - this carries full-precision USD (the ledger only has credits), and
 *   - it can be pruned/rebuilt without touching balances.
 *
 * Writes are best-effort: a telemetry failure must NEVER break a paid request
 * (recordUsage swallows + logs). Reads power the admin cost dashboard.
 *
 * Sessions: the server has no per-meditation-session id today (the LLM hold is
 * per-turn, STT/TTS aren't held), so buildUsageReport reconstructs sessions by
 * clustering an account's events with gaps under SESSION_GAP_SEC. sessionId is
 * carried for when the client starts sending a real one — then clustering can
 * defer to it.
 */

import { randomUUID } from 'node:crypto';
import { log } from '../logger.js';
import type { CreditsStore } from './store.js';
import { pricingFor } from '../pricing/providers.js';
import type { ProviderId } from '../contract.js';

export type UsageKind = 'llm' | 'stt' | 'tts';

export interface UsageEvent {
    id: string;
    accountId: string;
    /** Client-supplied meditation-session id, when available. Null today. */
    sessionId: string | null;
    /** Retreat pass that covered this call (meditation-pal-414), or null when the
     *  call was metered normally. Lets the admin attribute per-retreat spend. */
    passId: string | null;
    /** Seconds since epoch. */
    ts: number;
    kind: UsageKind;
    /** Provider id (e.g. 'anthropic', 'openai', 'google'). */
    provider: string;
    /** Model id (LLM) or voice id (TTS); for STT the whisper model/provider. */
    model: string;
    // ---- raw counts (zero for the legs that don't apply) ----
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheCreation: number;
    /** Subset of cacheCreation written at the 1h TTL (the anchor breakpoint),
     *  billed at 2x input vs the 5m default's 1.25x. Zero for non-LLM legs and
     *  for providers without a TTL breakdown. */
    cacheCreation1h: number;
    seconds: number; // STT audio seconds
    chars: number; // TTS characters
    /** Full-precision provider cost in USD (NOT rounded to credits). */
    providerCostUsd: number;
    /** Credits actually debited for this call (fractional, at cost). */
    credits: number;
}

/** Fields a call site supplies; id/ts/sessionId/passId default here, and
 *  cacheCreation1h defaults to 0 so non-LLM legs don't have to pass it. */
export type UsageInput = Omit<
    UsageEvent,
    'id' | 'ts' | 'sessionId' | 'passId' | 'cacheCreation1h'
> &
    Partial<Pick<UsageEvent, 'sessionId' | 'ts' | 'passId' | 'cacheCreation1h'>>;

/** Record one metered call. Best-effort: never throws into the request path —
 *  a telemetry write must not cost a user their (already-charged) turn. */
export async function recordUsage(
    store: Pick<CreditsStore, 'appendUsage'>,
    input: UsageInput
): Promise<void> {
    const event: UsageEvent = {
        id: randomUUID(),
        sessionId: input.sessionId ?? null,
        passId: input.passId ?? null,
        ts: input.ts ?? Date.now() / 1000,
        accountId: input.accountId,
        kind: input.kind,
        provider: input.provider,
        model: input.model,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        cacheRead: input.cacheRead,
        cacheCreation: input.cacheCreation,
        cacheCreation1h: input.cacheCreation1h ?? 0,
        seconds: input.seconds,
        chars: input.chars,
        providerCostUsd: input.providerCostUsd,
        credits: input.credits,
    };
    try {
        await store.appendUsage(event);
    } catch (err) {
        log.warn('usage telemetry write failed (ignored)', { err: String(err), kind: input.kind });
    }
}

// ---- aggregation (pure; mirrors metrics.ts) --------------------------------

/** Gap above which two consecutive events for one account are treated as
 *  separate sessions. A meditation turn cycle (speak → think → speak) is tens
 *  of seconds; 8 minutes of total quiet is a comfortable session boundary. */
export const SESSION_GAP_SEC = 8 * 60;

export interface ServiceAgg {
    kind: UsageKind;
    events: number;
    providerCostUsd: number;
    credits: number;
    /** Share of total provider cost across all services, 0..1. */
    costShare: number;
}

export interface ModelAgg {
    kind: UsageKind;
    provider: string;
    model: string;
    events: number;
    providerCostUsd: number;
    credits: number;
}

/** Prompt-cache breakdown for the LLM leg — the read/write/fresh token split,
 *  the hit ratio, and the dollars caching actually saved vs a no-cache baseline
 *  (everything cached re-priced at full input). The decision input for tuning
 *  cache strategy and TTL. */
export interface CacheAgg {
    /** Uncached input tokens billed at full rate. */
    freshInputTokens: number;
    /** Tokens served from cache (~0.1x input). */
    cacheReadTokens: number;
    /** Tokens written to cache (Anthropic ~1.25x input at 5m TTL; 0 for the
     *  OpenAI/Google auto-cache shapes, which don't surface a write count). */
    cacheCreationTokens: number;
    /** Subset of cacheCreationTokens written at the 1h TTL (the anchor, billed
     *  at 2x). A rising number here means holds are forcing 1h re-anchors —
     *  the signal for whether the anchor strategy is earning its 2x premium. */
    cacheCreation1hTokens: number;
    /** cacheRead / (fresh + read + creation), 0..1. */
    hitRatio: number;
    /** Actual provider $ for these LLM calls (what we paid). */
    costUsd: number;
    /** Provider $ the same calls would cost with NO caching (reads + writes
     *  re-priced at full input). Only counts models with a known price table;
     *  unknown models contribute their actual cost so savings isn't inflated. */
    costNoCacheUsd: number;
    /** costNoCacheUsd - costUsd: dollars caching saved in the window. */
    savedUsd: number;
}

/** Per-provider LLM cache breakdown (anthropic vs google vs openai). Caching
 *  works differently per provider — Anthropic needs explicit breakpoints;
 *  OpenAI/Google cache automatically on a stable prefix — so the per-provider
 *  hit rate is how you tell whether each path is actually caching. */
export interface ProviderCacheAgg extends CacheAgg {
    provider: string;
    events: number;
}

export interface Distribution {
    count: number;
    mean: number;
    p50: number;
    p90: number;
    max: number;
}

export interface UsageReport {
    generatedAt: number;
    windowSinceTs: number;
    events: number;
    totals: { providerCostUsd: number; credits: number };
    /** Cost split by service — the "what drove the bill" answer. */
    byService: ServiceAgg[];
    /** LLM cache-hit ratio = cacheRead / (input + cacheRead + cacheCreation),
     *  across all LLM events in the window. The single most useful number for
     *  predicting real session cost (a warm cache is ~10x cheaper than cold). */
    llmCacheHitRatio: number;
    /** Full prompt-cache economics for the LLM leg (token split + $ saved). */
    llmCache: CacheAgg;
    /** Same breakdown split by provider — anthropic / google / openai cache
     *  differently, so this shows whether each path is actually hitting. */
    llmCacheByProvider: ProviderCacheAgg[];
    /** Per-model / per-voice cost, biggest first. */
    byModel: ModelAgg[];
    /** Reconstructed-session economics — what a real session actually costs. */
    sessions: {
        count: number;
        costUsd: Distribution;
        credits: Distribution;
        /** Facilitator turns per session — one per LLM call (STT/TTS legs don't
         *  count). The conversational length of a real session. */
        turns: Distribution;
        /** Mean wall-clock minutes per session (first→last event). */
        meanDurationMin: number;
        /** Sessions dropped from the distributions by minSessionTurns. */
        excludedShort: number;
    };
}

export interface UsageReportOptions {
    /** Exclude reconstructed sessions with fewer than this many LLM turns from
     *  the per-session distributions — a drive-by "opened the app, said one
     *  thing" session drags the medians down and isn't what estimates should
     *  calibrate against. Totals and the service/model/cache aggregates always
     *  cover every event; only the `sessions` block is filtered. */
    minSessionTurns?: number;
}

/** One day of aggregated usage for the admin trend charts. */
export interface UsageHistoryBucket {
    /** UTC start-of-day, seconds since epoch — the bucket's x-axis key. */
    dayStartTs: number;
    sessions: number;
    /** Facilitator turns (LLM calls) across the day's sessions. */
    turns: number;
    /** Metered calls (all legs) across the day's sessions. */
    events: number;
    providerCostUsd: number;
    credits: number;
    /** Total session wall-clock minutes (sum of per-session first→last). */
    durationMin: number;
}

function emptyDist(): Distribution {
    return { count: 0, mean: 0, p50: 0, p90: 0, max: 0 };
}

/** p-th percentile (0..1) of a numeric list via nearest-rank on sorted values. */
function percentile(sortedAsc: number[], p: number): number {
    if (sortedAsc.length === 0) return 0;
    const idx = Math.min(sortedAsc.length - 1, Math.ceil(p * sortedAsc.length) - 1);
    return sortedAsc[Math.max(0, idx)]!;
}

function distribution(values: number[]): Distribution {
    if (values.length === 0) return emptyDist();
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    return {
        count: sorted.length,
        mean: sum / sorted.length,
        p50: percentile(sorted, 0.5),
        p90: percentile(sorted, 0.9),
        max: sorted[sorted.length - 1]!,
    };
}

/** Group an account's events into sessions by time-gap, honoring an explicit
 *  sessionId when present. Returns one bucket of events per session. */
function clusterSessions(events: UsageEvent[]): UsageEvent[][] {
    const byAccount = new Map<string, UsageEvent[]>();
    for (const e of events) {
        const list = byAccount.get(e.accountId) ?? [];
        list.push(e);
        byAccount.set(e.accountId, list);
    }
    const sessions: UsageEvent[][] = [];
    for (const list of byAccount.values()) {
        list.sort((a, b) => a.ts - b.ts);
        let current: UsageEvent[] = [];
        let lastTs = -Infinity;
        let lastSession: string | null = null;
        for (const e of list) {
            const sameExplicit = e.sessionId != null && e.sessionId === lastSession;
            const withinGap = e.ts - lastTs <= SESSION_GAP_SEC;
            const continues = sameExplicit || (e.sessionId == null && withinGap && lastSession == null);
            if (current.length > 0 && !continues) {
                sessions.push(current);
                current = [];
            }
            current.push(e);
            lastTs = e.ts;
            lastSession = e.sessionId;
        }
        if (current.length > 0) sessions.push(current);
    }
    return sessions;
}

/** Aggregate raw usage events into the admin cost report. Pure — pass the
 *  windowed events in; mirrors buildMetrics so it's trivially testable. */
export function buildUsageReport(
    events: UsageEvent[],
    now: number,
    windowSinceTs: number,
    opts: UsageReportOptions = {}
): UsageReport {
    const inWindow = events.filter((e) => e.ts >= windowSinceTs);

    const services: Record<UsageKind, ServiceAgg> = {
        llm: { kind: 'llm', events: 0, providerCostUsd: 0, credits: 0, costShare: 0 },
        stt: { kind: 'stt', events: 0, providerCostUsd: 0, credits: 0, costShare: 0 },
        tts: { kind: 'tts', events: 0, providerCostUsd: 0, credits: 0, costShare: 0 },
    };
    const models = new Map<string, ModelAgg>();
    let totalCost = 0;
    let totalCredits = 0;
    let cacheReadTokens = 0;
    let cacheableTokens = 0; // input + cacheRead + cacheCreation
    // LLM cache economics (overall + per provider).
    let llmFresh = 0;
    let llmRead = 0;
    let llmCreate = 0;
    let llmCreate1h = 0;
    let llmCost = 0;
    let llmNoCacheCost = 0;
    const providerCache = new Map<string, { provider: string; events: number; fresh: number; read: number; create: number; create1h: number; cost: number; noCache: number }>();

    for (const e of inWindow) {
        const svc = services[e.kind];
        svc.events += 1;
        svc.providerCostUsd += e.providerCostUsd;
        svc.credits += e.credits;
        totalCost += e.providerCostUsd;
        totalCredits += e.credits;

        const key = `${e.kind}:${e.provider}:${e.model}`;
        const m = models.get(key) ?? {
            kind: e.kind,
            provider: e.provider,
            model: e.model,
            events: 0,
            providerCostUsd: 0,
            credits: 0,
        };
        m.events += 1;
        m.providerCostUsd += e.providerCostUsd;
        m.credits += e.credits;
        models.set(key, m);

        if (e.kind === 'llm') {
            cacheReadTokens += e.cacheRead;
            cacheableTokens += e.tokensIn + e.cacheRead + e.cacheCreation;

            // What this turn would cost with NO caching: every cached token
            // (read + write) re-priced at full input. Unknown models contribute
            // their actual cost so savings is never inflated by a missing rate.
            const p = pricingFor(e.provider as ProviderId, e.model);
            const noCache = p
                ? e.tokensIn * p.input +
                  e.tokensOut * p.output +
                  (e.cacheRead + e.cacheCreation) * p.input
                : e.providerCostUsd;

            llmFresh += e.tokensIn;
            llmRead += e.cacheRead;
            llmCreate += e.cacheCreation;
            llmCreate1h += e.cacheCreation1h;
            llmCost += e.providerCostUsd;
            llmNoCacheCost += noCache;

            const pc = providerCache.get(e.provider) ?? {
                provider: e.provider,
                events: 0,
                fresh: 0,
                read: 0,
                create: 0,
                create1h: 0,
                cost: 0,
                noCache: 0,
            };
            pc.events += 1;
            pc.fresh += e.tokensIn;
            pc.read += e.cacheRead;
            pc.create += e.cacheCreation;
            pc.create1h += e.cacheCreation1h;
            pc.cost += e.providerCostUsd;
            pc.noCache += noCache;
            providerCache.set(e.provider, pc);
        }
    }

    for (const svc of Object.values(services)) {
        svc.costShare = totalCost > 0 ? svc.providerCostUsd / totalCost : 0;
    }

    const allSessions = clusterSessions(inWindow);
    const minTurns = Math.max(0, opts.minSessionTurns ?? 0);
    const sessions = allSessions.filter(
        (s) => s.filter((e) => e.kind === 'llm').length >= minTurns
    );
    const excludedShort = allSessions.length - sessions.length;
    const sessionCosts = sessions.map((s) => s.reduce((sum, e) => sum + e.providerCostUsd, 0));
    const sessionCredits = sessions.map((s) => s.reduce((sum, e) => sum + e.credits, 0));
    const sessionTurns = sessions.map((s) => s.filter((e) => e.kind === 'llm').length);
    const sessionDurations = sessions.map((s) => {
        if (s.length < 2) return 0;
        return (s[s.length - 1]!.ts - s[0]!.ts) / 60;
    });
    const meanDurationMin =
        sessionDurations.length > 0
            ? sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length
            : 0;

    const hitRatioOf = (read: number, fresh: number, create: number): number => {
        const denom = fresh + read + create;
        return denom > 0 ? read / denom : 0;
    };
    const llmCache: CacheAgg = {
        freshInputTokens: llmFresh,
        cacheReadTokens: llmRead,
        cacheCreationTokens: llmCreate,
        cacheCreation1hTokens: llmCreate1h,
        hitRatio: hitRatioOf(llmRead, llmFresh, llmCreate),
        costUsd: llmCost,
        costNoCacheUsd: llmNoCacheCost,
        savedUsd: llmNoCacheCost - llmCost,
    };
    const llmCacheByProvider: ProviderCacheAgg[] = [...providerCache.values()]
        .map((pc) => ({
            provider: pc.provider,
            events: pc.events,
            freshInputTokens: pc.fresh,
            cacheReadTokens: pc.read,
            cacheCreationTokens: pc.create,
            cacheCreation1hTokens: pc.create1h,
            hitRatio: hitRatioOf(pc.read, pc.fresh, pc.create),
            costUsd: pc.cost,
            costNoCacheUsd: pc.noCache,
            savedUsd: pc.noCache - pc.cost,
        }))
        .sort((a, b) => b.costUsd - a.costUsd);

    return {
        generatedAt: now,
        windowSinceTs,
        events: inWindow.length,
        totals: { providerCostUsd: totalCost, credits: totalCredits },
        byService: Object.values(services),
        llmCacheHitRatio: cacheableTokens > 0 ? cacheReadTokens / cacheableTokens : 0,
        llmCache,
        llmCacheByProvider,
        byModel: [...models.values()].sort((a, b) => b.providerCostUsd - a.providerCostUsd),
        sessions: {
            count: sessions.length,
            costUsd: distribution(sessionCosts),
            credits: distribution(sessionCredits),
            turns: distribution(sessionTurns),
            meanDurationMin,
            excludedShort,
        },
    };
}

/** Seconds in a UTC day — the history bucket width. */
const DAY_SEC = 24 * 60 * 60;

/** Daily time-series for the admin trend charts. Reconstructs sessions over the
 *  whole window, then attributes each to the UTC day of its FIRST event — so a
 *  session is counted once, on the day it began, and never splits at midnight.
 *  Emits one row per day for the last `days` days ending at `now`, zero-filled
 *  so the chart has no gaps, oldest→newest. Pure (mirrors buildUsageReport).
 *
 *  History depth is bounded only by usage_events retention: the raw rows persist
 *  (nothing prunes them today), so this is real history, not a rolling snapshot. */
export function buildUsageHistory(
    events: UsageEvent[],
    now: number,
    days: number
): UsageHistoryBucket[] {
    const dayCount = Math.max(1, Math.floor(days));
    const todayStart = Math.floor(now / DAY_SEC) * DAY_SEC;
    const firstDay = todayStart - (dayCount - 1) * DAY_SEC;

    const buckets = new Map<number, UsageHistoryBucket>();
    for (let d = firstDay; d <= todayStart; d += DAY_SEC) {
        buckets.set(d, {
            dayStartTs: d,
            sessions: 0,
            turns: 0,
            events: 0,
            providerCostUsd: 0,
            credits: 0,
            durationMin: 0,
        });
    }

    const sessions = clusterSessions(events.filter((e) => e.ts >= firstDay));
    for (const s of sessions) {
        const day = Math.floor(s[0]!.ts / DAY_SEC) * DAY_SEC;
        const b = buckets.get(day);
        if (!b) continue; // first event sits in the trimmed window edge — skip
        b.sessions += 1;
        b.events += s.length;
        for (const e of s) {
            if (e.kind === 'llm') b.turns += 1;
            b.providerCostUsd += e.providerCostUsd;
            b.credits += e.credits;
        }
        if (s.length >= 2) b.durationMin += (s[s.length - 1]!.ts - s[0]!.ts) / 60;
    }

    return [...buckets.values()].sort((a, b) => a.dayStartTs - b.dayStartTs);
}

/** One provider+service leg's computed spend for one UTC day — the "our side"
 *  row of the provider-bill reconciliation (meditation-pal-xejm). Split by kind
 *  and carrying the raw units (seconds, chars) so the reconciler can derive the
 *  EFFECTIVE billed rate per leg ($/hr STT, $/1M-chars TTS) from the provider's
 *  line-item costs, not just flag aggregate drift. */
export interface ProviderDailyCost {
    /** UTC start-of-day, seconds since epoch. */
    dayStartTs: number;
    provider: string;
    kind: UsageKind;
    events: number;
    providerCostUsd: number;
    /** STT audio seconds in the bucket (0 for other legs). */
    seconds: number;
    /** TTS characters in the bucket (0 for other legs). */
    chars: number;
}

/** Per-provider, per-UTC-day computed spend over the last `days` days. Unlike
 *  buildUsageHistory this buckets each EVENT by its own timestamp — provider
 *  invoices bill by when the call happened, not by when our reconstructed
 *  session started — so these rows line up with the Anthropic/OpenAI daily
 *  cost-report buckets. Days with no usage for a provider emit no row. */
export function buildProviderDailyCosts(
    events: UsageEvent[],
    now: number,
    days: number
): ProviderDailyCost[] {
    const dayCount = Math.max(1, Math.floor(days));
    const todayStart = Math.floor(now / DAY_SEC) * DAY_SEC;
    const firstDay = todayStart - (dayCount - 1) * DAY_SEC;

    const rows = new Map<string, ProviderDailyCost>();
    for (const e of events) {
        if (e.ts < firstDay || e.ts >= todayStart + DAY_SEC) continue;
        const day = Math.floor(e.ts / DAY_SEC) * DAY_SEC;
        const key = `${day}:${e.provider}:${e.kind}`;
        const row = rows.get(key) ?? {
            dayStartTs: day,
            provider: e.provider,
            kind: e.kind,
            events: 0,
            providerCostUsd: 0,
            seconds: 0,
            chars: 0,
        };
        row.events += 1;
        row.providerCostUsd += e.providerCostUsd;
        row.seconds += e.seconds;
        row.chars += e.chars;
        rows.set(key, row);
    }
    return [...rows.values()].sort(
        (a, b) =>
            a.dayStartTs - b.dayStartTs ||
            a.provider.localeCompare(b.provider) ||
            a.kind.localeCompare(b.kind)
    );
}

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

export type UsageKind = 'llm' | 'stt' | 'tts';

export interface UsageEvent {
    id: string;
    accountId: string;
    /** Client-supplied meditation-session id, when available. Null today. */
    sessionId: string | null;
    /** Seconds since epoch. */
    ts: number;
    kind: UsageKind;
    /** Provider id (e.g. 'anthropic', 'fireworks', 'google'). */
    provider: string;
    /** Model id (LLM) or voice id (TTS); for STT the whisper model/provider. */
    model: string;
    // ---- raw counts (zero for the legs that don't apply) ----
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheCreation: number;
    seconds: number; // STT audio seconds
    chars: number; // TTS characters
    /** Full-precision provider cost in USD (NOT rounded to credits). */
    providerCostUsd: number;
    /** Credits actually debited for this call (fractional, at cost). */
    credits: number;
}

/** Fields a call site supplies; id/ts/sessionId default here. */
export type UsageInput = Omit<UsageEvent, 'id' | 'ts' | 'sessionId'> &
    Partial<Pick<UsageEvent, 'sessionId' | 'ts'>>;

/** Record one metered call. Best-effort: never throws into the request path —
 *  a telemetry write must not cost a user their (already-charged) turn. */
export async function recordUsage(
    store: Pick<CreditsStore, 'appendUsage'>,
    input: UsageInput
): Promise<void> {
    const event: UsageEvent = {
        id: randomUUID(),
        sessionId: input.sessionId ?? null,
        ts: input.ts ?? Date.now() / 1000,
        accountId: input.accountId,
        kind: input.kind,
        provider: input.provider,
        model: input.model,
        tokensIn: input.tokensIn,
        tokensOut: input.tokensOut,
        cacheRead: input.cacheRead,
        cacheCreation: input.cacheCreation,
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
    /** Per-model / per-voice cost, biggest first. */
    byModel: ModelAgg[];
    /** Reconstructed-session economics — what a real session actually costs. */
    sessions: {
        count: number;
        costUsd: Distribution;
        credits: Distribution;
        /** Mean wall-clock minutes per session (first→last event). */
        meanDurationMin: number;
    };
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
    windowSinceTs: number
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
        }
    }

    for (const svc of Object.values(services)) {
        svc.costShare = totalCost > 0 ? svc.providerCostUsd / totalCost : 0;
    }

    const sessions = clusterSessions(inWindow);
    const sessionCosts = sessions.map((s) => s.reduce((sum, e) => sum + e.providerCostUsd, 0));
    const sessionCredits = sessions.map((s) => s.reduce((sum, e) => sum + e.credits, 0));
    const sessionDurations = sessions.map((s) => {
        if (s.length < 2) return 0;
        return (s[s.length - 1]!.ts - s[0]!.ts) / 60;
    });
    const meanDurationMin =
        sessionDurations.length > 0
            ? sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length
            : 0;

    return {
        generatedAt: now,
        windowSinceTs,
        events: inWindow.length,
        totals: { providerCostUsd: totalCost, credits: totalCredits },
        byService: Object.values(services),
        llmCacheHitRatio: cacheableTokens > 0 ? cacheReadTokens / cacheableTokens : 0,
        byModel: [...models.values()].sort((a, b) => b.providerCostUsd - a.providerCostUsd),
        sessions: {
            count: sessions.length,
            costUsd: distribution(sessionCosts),
            credits: distribution(sessionCredits),
            meanDurationMin,
        },
    };
}

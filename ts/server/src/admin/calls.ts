/**
 * Per-call view of single sessions (admin/calls-page.ts): every metered call a
 * sit made, in order, with what each one cost and why. The cost report
 * (credits/usage.ts) says a session ran pricey; this says which calls did it -
 * a cache rewrite after a long silence, a turn that thought hard, a chatty
 * voice.
 *
 * Itemizes the operator's own accounts only, like the report's session rows:
 * real users appear in aggregate, never as a per-sit line (privacy policy).
 * The route passes in just those accounts' rows. Content-free either way: a
 * usage row holds counts and cost, never what was said.
 */

import type { ProviderId } from '../contract.js';
import type { Incident } from '../credits/incidents.js';
import { facilitationFilter, type LlmPurpose, type UsageEvent, type UsageKind } from '../credits/usage.js';
import { pricingFor } from '../pricing/providers.js';

/** Anthropic's default cache TTL. A facilitation call further than this from
 *  the one before it finds the tail breakpoint expired and re-writes the
 *  prefix back to the 1h anchor (or all of it, before there is one). */
export const CACHE_TTL_SEC = 5 * 60;

/** The legs a session's spend splits into. */
export interface LegCosts {
    facilitation: number;
    utility: number;
    stt: number;
    tts: number;
    total: number;
}

/** Where the facilitation model's money went, USD. */
export interface TokenCosts {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cacheWrite1h: number;
}

export interface SessionListRow {
    sessionId: string;
    accountId: string;
    startTs: number;
    minutes: number;
    /** The costliest facilitation model, "provider:model". */
    model: string | null;
    turns: number;
    costUsd: LegCosts;
    /** Facilitation calls that wrote more cache than they read (after the first). */
    coldCalls: number;
}

export type CallRole = LlmPurpose | 'stt' | 'tts';

export interface CallRow {
    ts: number;
    /** Seconds since the session's first call. */
    offsetSec: number;
    /** Facilitation rows: seconds since the previous facilitation call (the
     *  cache-TTL clock). Null elsewhere and on the first one. */
    gapSec: number | null;
    role: CallRole;
    kind: UsageKind;
    provider: string;
    model: string;
    tokensIn: number;
    tokensOut: number;
    cacheRead: number;
    cacheCreation: number;
    cacheCreation1h: number;
    seconds: number;
    chars: number;
    costUsd: number;
    /** Facilitation rows only: wrote more cache than it read. */
    cold: boolean;
}

export interface SessionDetail {
    session: SessionListRow;
    /** Facilitation spend by token type, the question "why so expensive". */
    facilitationCosts: TokenCosts;
    facilitationTokens: { input: number; output: number; cacheRead: number; cacheWrite: number; cacheWrite1h: number };
    calls: CallRow[];
    /** This session's incident rows (max_tokens, blank turns, errors). */
    incidents: Incident[];
}

function bySession(events: UsageEvent[]): Map<string, UsageEvent[]> {
    const sessions = new Map<string, UsageEvent[]>();
    for (const e of events) {
        if (e.sessionId == null) continue;
        const list = sessions.get(e.sessionId) ?? [];
        list.push(e);
        sessions.set(e.sessionId, list);
    }
    for (const list of sessions.values()) list.sort((a, b) => a.ts - b.ts);
    return sessions;
}

function roleOf(e: UsageEvent, isFacilitation: (e: UsageEvent) => boolean): CallRole {
    if (e.kind !== 'llm') return e.kind;
    return isFacilitation(e) ? 'facilitation' : 'utility';
}

/** One session's rows (sorted) as call rows plus its list summary. */
function analyze(sessionId: string, rows: UsageEvent[]): { session: SessionListRow; calls: CallRow[] } {
    const isFacilitation = facilitationFilter(rows);
    const t0 = rows[0]!.ts;
    const costUsd: LegCosts = { facilitation: 0, utility: 0, stt: 0, tts: 0, total: 0 };
    const modelCost = new Map<string, number>();
    let lastFacilitationTs: number | null = null;
    let turns = 0;
    let coldCalls = 0;

    const calls = rows.map((e): CallRow => {
        const role = roleOf(e, isFacilitation);
        costUsd[role] += e.providerCostUsd;
        costUsd.total += e.providerCostUsd;
        let gapSec: number | null = null;
        let cold = false;
        if (role === 'facilitation') {
            const key = `${e.provider}:${e.model}`;
            modelCost.set(key, (modelCost.get(key) ?? 0) + e.providerCostUsd);
            if (lastFacilitationTs !== null) {
                gapSec = e.ts - lastFacilitationTs;
                cold = e.cacheCreation > e.cacheRead;
                if (cold) coldCalls++;
            }
            lastFacilitationTs = e.ts;
            turns++;
        }
        return {
            ts: e.ts,
            offsetSec: e.ts - t0,
            gapSec,
            role,
            kind: e.kind,
            provider: e.provider,
            model: e.model,
            tokensIn: e.tokensIn,
            tokensOut: e.tokensOut,
            cacheRead: e.cacheRead,
            cacheCreation: e.cacheCreation,
            cacheCreation1h: e.cacheCreation1h,
            seconds: e.seconds,
            chars: e.chars,
            costUsd: e.providerCostUsd,
            cold,
        };
    });

    const model = [...modelCost.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return {
        session: {
            sessionId,
            accountId: rows[0]!.accountId,
            startTs: t0,
            minutes: (rows[rows.length - 1]!.ts - t0) / 60,
            model,
            turns,
            costUsd,
            coldCalls,
        },
        calls,
    };
}

/** Sessions (by client session id) that started at or after `sinceTs`, newest
 *  first. Rows without a session id can't be itemized and are skipped. */
export function buildSessionList(events: UsageEvent[], sinceTs: number): SessionListRow[] {
    const out: SessionListRow[] = [];
    for (const [id, rows] of bySession(events)) {
        if (rows[0]!.ts < sinceTs) continue;
        out.push(analyze(id, rows).session);
    }
    return out.sort((a, b) => b.startTs - a.startTs);
}

/** Every call of one session, or null when no row carries that id. */
export function buildSessionDetail(
    events: UsageEvent[],
    incidents: Incident[],
    sessionId: string
): SessionDetail | null {
    const rows = events.filter((e) => e.sessionId === sessionId).sort((a, b) => a.ts - b.ts);
    if (rows.length === 0) return null;
    const { session, calls } = analyze(sessionId, rows);

    const facilitationCosts: TokenCosts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    const facilitationTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0 };
    for (const c of calls) {
        if (c.role !== 'facilitation') continue;
        const write1h = Math.min(c.cacheCreation, c.cacheCreation1h);
        const write5m = c.cacheCreation - write1h;
        facilitationTokens.input += c.tokensIn;
        facilitationTokens.output += c.tokensOut;
        facilitationTokens.cacheRead += c.cacheRead;
        facilitationTokens.cacheWrite += write5m;
        facilitationTokens.cacheWrite1h += write1h;
        const p = pricingFor(c.provider as ProviderId, c.model);
        if (!p) continue;
        facilitationCosts.input += c.tokensIn * p.input;
        facilitationCosts.output += c.tokensOut * p.output;
        facilitationCosts.cacheRead += c.cacheRead * p.cacheRead;
        facilitationCosts.cacheWrite += write5m * p.cacheCreation;
        facilitationCosts.cacheWrite1h += write1h * p.cacheCreation1h;
    }

    return {
        session,
        facilitationCosts,
        facilitationTokens,
        calls,
        incidents: incidents.filter((i) => i.sessionId === sessionId).sort((a, b) => a.ts - b.ts),
    };
}

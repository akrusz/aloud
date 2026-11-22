/**
 * Token counts per call and their totals, for the report's cost section.
 * Absent fields mean the provider reported nothing, and the totals keep that
 * apart from zero: a group with no reporting call reads "not reported".
 */

import type { LlmUsage } from '../src/facilitation/index.js';
import { callCostUsd } from './prices.js';
import type { CallUsage } from './types.js';

const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreationTokens'] as const;

/** A provider's usage, with the fields it did not report left out. */
export function callUsageOf(r: {
    inputTokens?: number | null;
    outputTokens?: number | null;
    cacheReadTokens?: number | null;
    cacheCreationTokens?: number | null;
}): CallUsage {
    const u: CallUsage = {};
    for (const k of FIELDS) {
        const v = r[k];
        if (typeof v === 'number') u[k] = v;
    }
    return u;
}

export function fromLlmUsage(u: LlmUsage): CallUsage {
    return callUsageOf({
        inputTokens: u.tokensIn ?? null,
        outputTokens: u.tokensOut ?? null,
        cacheReadTokens: u.cacheRead ?? null,
        cacheCreationTokens: u.cacheCreation ?? null,
    });
}

/** Adds `more` into `into`, field by field; a field neither reported stays out. */
export function addUsage(into: CallUsage, more: CallUsage): void {
    for (const k of FIELDS) {
        const v = more[k];
        if (v !== undefined) into[k] = (into[k] ?? 0) + v;
    }
}

/** The calls that are the facilitator speaking, as opposed to the harness's
 *  meditator and the classifiers. */
export const FACILITATOR_CALL_KINDS: ReadonlySet<string> = new Set([
    'opener',
    'turn',
    'checkin',
    'timer-approach',
    'timer-completion',
]);

export interface UsageTotals {
    calls: number;
    /** Calls that reported input tokens; the sums below cover only these. */
    reported: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    /** USD at the hosted list price, over the calls that could be priced. */
    costUsd: number;
    /** Reporting calls with no hosted price (a local model, a dropped one). */
    unpriced: number;
}

export function totalUsage(calls: ReadonlyArray<CallUsage & { model?: string | undefined }>): UsageTotals {
    const t: UsageTotals = {
        calls: calls.length,
        reported: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        unpriced: 0,
    };
    for (const c of calls) {
        if (c.inputTokens === undefined) continue;
        t.reported++;
        for (const k of FIELDS) t[k] += c[k] ?? 0;
        const cost = callCostUsd(c.model, c);
        if (cost === null) t.unpriced++;
        else t.costUsd += cost;
    }
    return t;
}

/** Share of the prompt read from cache: reads over everything sent (fresh,
 *  read and written, which core keeps disjoint). Null when nothing reported. */
export function cachedShare(t: UsageTotals): number | null {
    const prompt = t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens;
    return t.reported === 0 || prompt === 0 ? null : t.cacheReadTokens / prompt;
}

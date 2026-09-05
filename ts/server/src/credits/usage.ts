/**
 * Per-call usage telemetry: the RAW cost record the ledger can't give us
 * (meditation-pal-rvy). The ledger is the money trail (credit deltas + a
 * freeform reason) and carries no token split, cache breakdown, or per-service
 * tag, so from it alone you can't tell what drove a debit. This fills that gap:
 * one row per metered provider call (LLM turn, STT pass, TTS synth) with raw
 * counts AND the full-precision provider cost, not the rounded credit.
 *
 * Kept SEPARATE from the ledger so the ledger stays a clean financial audit log,
 * this can carry full-precision USD, and it can be pruned/rebuilt without
 * touching balances.
 *
 * Writes are best-effort: a telemetry failure must NEVER break a paid request
 * (recordUsage swallows + logs). Reads power the admin cost dashboard.
 *
 * Sessions: all three metered routes accept the client's meditation-session id
 * (LLM/TTS body.sessionId, STT ?session_id) and buildUsageReport groups on it
 * when present, falling back to clustering an account's events with gaps
 * under SESSION_GAP_SEC for rows without one (older clients, BYOK lookups).
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
    /** Client-supplied meditation-session id; null on rows from clients that
     *  didn't send one. */
    sessionId: string | null;
    /** Retreat pass that covered this call (meditation-pal-414), or null if
     *  metered normally. Lets the admin attribute per-retreat spend. */
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
     *  providers without a TTL breakdown. */
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

/** Record one metered call. Best-effort: never throws into the request path, so
 *  a telemetry write can't cost a user their (already-charged) turn. */
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

/** Gap above which two consecutive events for one account count as separate
 *  sessions. A turn cycle (speak → think → speak) is tens of seconds, so 8
 *  minutes of quiet is a comfortable boundary. */
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

/** Prompt-cache breakdown for the LLM leg: read/write/fresh token split, hit
 *  ratio, and dollars saved vs a no-cache baseline (everything cached re-priced
 *  at full input). The decision input for tuning cache strategy and TTL. */
export interface CacheAgg {
    /** Uncached input tokens billed at full rate. */
    freshInputTokens: number;
    /** Tokens served from cache (~0.1x input). */
    cacheReadTokens: number;
    /** Tokens written to cache (Anthropic ~1.25x input at 5m TTL; 0 for the
     *  OpenAI/Google auto-cache shapes, which don't surface a write count). */
    cacheCreationTokens: number;
    /** Subset of cacheCreationTokens written at the 1h TTL (the anchor, billed
     *  at 2x). Rising means holds are forcing 1h re-anchors: the signal for
     *  whether the anchor strategy earns its 2x premium. */
    cacheCreation1hTokens: number;
    /** cacheRead / (fresh + read + creation), 0..1. */
    hitRatio: number;
    /** Actual provider $ for these LLM calls (what we paid). */
    costUsd: number;
    /** Provider $ the same calls would cost with NO caching (reads + writes
     *  re-priced at full input). Models with no price table contribute their
     *  actual cost, so savings is never inflated. */
    costNoCacheUsd: number;
    /** costNoCacheUsd - costUsd: dollars caching saved in the window. */
    savedUsd: number;
}

/** Per-provider LLM cache breakdown. Caching differs by provider (Anthropic
 *  needs explicit breakpoints; OpenAI/Google cache automatically on a stable
 *  prefix), so the per-provider hit rate is how you tell each path is caching. */
export interface ProviderCacheAgg extends CacheAgg {
    provider: string;
    events: number;
}


export interface PerHourLeg {
    kind: UsageKind;
    creditsPerHour: number;
    costUsdPerHour: number;
}

export interface PerHourModel extends PerHourLeg {
    provider: string;
    model: string;
    /** Hours in this row's denominator: total duration of qualifying sessions
     *  that used this model/voice at least once (not the whole window's hours,
     *  so a rarely-picked voice still shows its true burn rate). */
    hours: number;
    /** Kind-specific volume per hour: LLM turns, STT audio seconds, or TTS
     *  characters. Maps a row straight onto its TYPICAL_SESSION assumption
     *  (pricing/estimate.ts), so an off estimate shows WHICH input is off. */
    unitsPerHour: number;
}

/** The observed burn rate: total spend of qualifying ("real") sessions divided
 *  by their total wall-clock duration. The number to hold against the
 *  advertised credits/hr estimates (pricing/estimate.ts) — same denomination,
 *  measured instead of assumed. Duration is first→last metered event, which
 *  slightly undercounts a session that ends in silence, so these read a touch
 *  HIGH versus what a user experiences per sat hour. */
export interface PerHourReport {
    /** Sessions meeting the real-sit bar (RealSit / DEFAULT_REAL_SIT). */
    sessions: number;
    /** Distinct accounts behind them. The rates below are a sqrt-of-spend
     *  weighted mean ACROSS these accounts, so read this first: at 1, every
     *  number here describes one person's habits, whatever the session count
     *  says. */
    accounts: number;
    /** Their summed wall-clock hours: the denominator. */
    hours: number;
    creditsPerHour: number;
    costUsdPerHour: number;
    /** Facilitator turns (LLM calls) per hour. Estimate assumes ~40. */
    turnsPerHour: number;
    /** Billed STT audio seconds per hour. Well above the estimate's assumption
     *  means either chattier users or VAD padding billing silence as audio. */
    sttSecondsPerHour: number;
    /** Cloud-TTS characters per hour. */
    ttsCharsPerHour: number;
    /** The same two volumes over only the hours of sessions that USED that leg.
     *  Compare these, not the two above, against the estimate profile: it
     *  assumes a cloud voice and cloud STT, while the totals above divide by
     *  every qualifying hour including the local-Whisper and device-voice
     *  sessions. With most sits on a free local voice the global TTS figure runs
     *  an order of magnitude under the profile and means nothing. Same
     *  per-session-attribution rule as byModel.hours. */
    attributed: { sttSecondsPerHour: number; ttsCharsPerHour: number };
    /** STT shape, not just volume (meditation-pal-0uw7). The billed minutes
     *  alone can't say WHY they're 4x the assumption, but these three can:
     *  callsPerTurn near 1 with a big medianSeconds means each utterance is
     *  padded (the 2s pre-buffer + the 3-6s adaptive silence window the VAD
     *  keeps in the payload); callsPerTurn well above 1 means the same audio is
     *  billed twice or more, since the speculative preview pass POSTs the whole
     *  buffer from utterance start and the server bills every POST. */
    stt: {
        /** Billed STT requests per hour, over the hours of sessions using it. */
        callsPerHour: number;
        /** Billed STT requests per facilitator turn, over the sessions that used
         *  cloud STT. Unweighted (it's a ratio within a session, not a rate). */
        callsPerTurn: number;
        /** Billed audio seconds in a single request. The estimate profile
         *  implies ~6s of speech per turn; anything much above that is payload
         *  padding or a re-sent buffer. */
        medianSeconds: number;
        p90Seconds: number;
    };
    /** LLM token volume per hour, over the same qualifying sessions. These are
     *  what actually drive the credits/hr badge on this cache-heavy workload
     *  (~45:1 input:output, most of it re-sent prefix), so they're the fields to
     *  reseed TYPICAL_SESSION (pricing/estimate.ts) from. Scale by
     *  TYPICAL_SESSION_MINUTES/60 to compare per-session. The estimate currently
     *  assumes, per hour: 4.8k fresh input, 3.24k output, 138k cache read, 9k
     *  cache creation. */
    tokensPerHour: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
        cacheCreation1h: number;
    };
    byService: PerHourLeg[];
    byModel: PerHourModel[];
    /** The same headline rates as a plain total/total over the qualifying
     *  sessions, no account weighting. Read beside the weighted ones: when the
     *  two diverge, a few short high-rate sits are steering the weighted
     *  figure (sqrt-of-spend weights an account by spend, not hours, so a
     *  15-minute sit on an expensive model counts nearly as much as someone's
     *  five-hour week). */
    pooled: { creditsPerHour: number; costUsdPerHour: number; turnsPerHour: number };
    /** LLM tokens per LLM call, pooled over the qualifying sessions. The
     *  per-hour token cards scale with how fast people take turns; per turn,
     *  the profile's shape (TYPICAL_SESSION / llmCalls) is directly comparable
     *  whatever the pace. */
    tokensPerTurn: { input: number; output: number; cacheRead: number; cacheCreation: number };
}

/** One qualifying session, itemized. Only produced for the accounts named in
 *  UsageReportOptions.sessionRowsFor (the operator's own admin/testing
 *  accounts): a per-session line is per-person data, and the panel is meant
 *  to show real users only in aggregate. */
export interface SessionRow {
    accountId: string;
    startTs: number;
    minutes: number;
    /** The facilitation model: the LLM model that cost the most in this
     *  session, with its call count. The rest of the LLM calls are the utility
     *  leg (Haiku classifiers / noting / summary, Flash Lite recap). */
    llmProvider: string | null;
    llmModel: string | null;
    llmTurns: number;
    utilityCalls: number;
    credits: number;
    costUsd: number;
    creditsPerHour: number;
    byService: Record<UsageKind, number>;
    /** Over the facilitation model's calls only. */
    tokensPerTurn: { input: number; output: number; cacheRead: number; cacheCreation: number };
    sttSeconds: number;
    sttCalls: number;
    /** The voice that spoke the most characters. */
    ttsProvider: string | null;
    ttsVoice: string | null;
    ttsChars: number;
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
    /** Distinct accounts with at least one metered call in the window. */
    accounts: number;
    totals: { providerCostUsd: number; credits: number };
    /** Cost split by service: the "what drove the bill" answer. */
    byService: ServiceAgg[];
    /** cacheRead / (input + cacheRead + cacheCreation) across all LLM events in
     *  the window. The most useful single number for predicting real session
     *  cost (a warm cache is ~10x cheaper than cold). */
    llmCacheHitRatio: number;
    /** Full prompt-cache economics for the LLM leg (token split + $ saved). */
    llmCache: CacheAgg;
    /** The same breakdown per provider, showing whether each path is hitting. */
    llmCacheByProvider: ProviderCacheAgg[];
    /** Per-model / per-voice cost, biggest first. */
    byModel: ModelAgg[];
    /** Reconstructed-session economics: what a real session actually costs. */
    sessions: {
        count: number;
        costUsd: Distribution;
        credits: Distribution;
        /** Facilitator turns per session, one per LLM call (STT/TTS legs don't
         *  count). The conversational length of a real session. */
        turns: Distribution;
        /** Mean wall-clock minutes per session (first→last event). */
        meanDurationMin: number;
        /** Sessions under the real-session bar, dropped from the session-level
         *  numbers (0 with allSessions). */
        excludedShort: number;
    };
    /** Observed credits/hr and $/hr over real sessions, overall + per leg. */
    perHour: PerHourReport;
    /** Itemized qualifying sessions for the accounts in sessionRowsFor, newest
     *  first. Empty unless the caller opted in. */
    sessionRows: SessionRow[];
}

export interface UsageReportOptions {
    /** Skip the real-session filter entirely: distributions and the per-hour
     *  block cover every session, drive-bys included. Default is to filter both
     *  on the SAME bar (RealSit), so all the session-level numbers describe one
     *  population. Totals and the service/model/cache aggregates always cover
     *  every event either way. */
    allSessions?: boolean;
    /** Override what counts as a real session. */
    realSit?: Partial<RealSit>;
    /** Accounts whose qualifying sessions are itemized in sessionRows. Meant
     *  for the operator's own accounts (routes/admin adminAccountIds); never
     *  pass real users here. */
    sessionRowsFor?: Set<string>;
}

/**
 * What counts as a real session — substantial enough to calibrate the credit
 * estimates against. ONE definition panel-wide: the per-session distributions
 * and the per-hour block filter on the same bar (or not at all, via
 * allSessions), so every session-level number describes the same population.
 *
 * A session must clear BOTH bars: long enough to divide by AND talkative
 * enough to be deliberate. A zero disables that criterion, so
 * `{minMinutes: 25, minTurns: 0}` means "25 minutes, turns don't matter".
 */
export interface RealSit {
    minMinutes: number;
    minTurns: number;
}

export const DEFAULT_REAL_SIT: RealSit = { minMinutes: 5, minTurns: 5 };

/** One day of aggregated usage for the admin trend charts. */
export interface UsageHistoryBucket {
    /** UTC start-of-day, seconds since epoch. The bucket's x-axis key. */
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
    /** Distinct accounts with a session that began this day (daily actives). */
    accounts: number;
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

/** Aggregate raw usage events into the admin cost report. Pure: pass the
 *  windowed events in. Mirrors buildMetrics, so it's trivially testable. */
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

            // Cost with NO caching: every cached token (read + write) re-priced
            // at full input. Unknown models contribute their actual cost, so a
            // missing rate can't inflate savings.
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
    const durationMinOf = (s: UsageEvent[]): number =>
        s.length < 2 ? 0 : (s[s.length - 1]!.ts - s[0]!.ts) / 60;
    // One bar for everything session-level below: distributions and per-hour
    // rates describe the SAME population.
    const realSit: RealSit = { ...DEFAULT_REAL_SIT, ...opts.realSit };
    const isRealSit = (s: UsageEvent[]): boolean =>
        (realSit.minMinutes <= 0 || durationMinOf(s) >= realSit.minMinutes) &&
        (realSit.minTurns <= 0 || s.filter((e) => e.kind === 'llm').length >= realSit.minTurns);
    const sessions = opts.allSessions ? allSessions : allSessions.filter(isRealSit);
    const excludedShort = allSessions.length - sessions.length;
    const sessionCosts = sessions.map((s) => s.reduce((sum, e) => sum + e.providerCostUsd, 0));
    const sessionCredits = sessions.map((s) => s.reduce((sum, e) => sum + e.credits, 0));
    const sessionTurns = sessions.map((s) => s.filter((e) => e.kind === 'llm').length);
    const sessionDurations = sessions.map(durationMinOf);
    const meanDurationMin =
        sessionDurations.length > 0
            ? sessionDurations.reduce((a, b) => a + b, 0) / sessionDurations.length
            : 0;

    // ---- observed per-hour burn, over the same session population, averaged
    // across accounts --------------------------------------------------------
    const totalHours = sessions.reduce((sum, s) => sum + durationMinOf(s), 0) / 60;
    const rate = (x: number, hours: number): number => (hours > 0 ? x / hours : 0);

    /**
     * Per-hour rates are a mean ACROSS ACCOUNTS, each weighted by the square
     * root of its spend — not a straight total/total, which is really "the
     * heaviest user's habits" whenever one account dominates the window (as one
     * did the first time these numbers were read for calibration, at ~93% of
     * measured hours).
     *
     * Sqrt, rather than one-account-one-vote: a user with 40 sits has genuinely
     * seen more of the product than someone with one, and should count for
     * more — just not 40x more. Beyond ~4x spend the extra influence tapers
     * hard, so a single power user shifts the number without setting it.
     *
     * With one account in the window this is identical to the unweighted rate,
     * so nothing changes until there's a population to average over.
     */
    /** Per-account accumulators behind every weighted per-hour rate. Named
     *  rather than spelled inline because weightedRate's hoursOf callback is
     *  handed a whole accumulator: some denominators are a.hours, others read
     *  a leg's own hours back out of a.sums. */
    interface AccountAcc {
        weightBasis: number;
        hours: number;
        sums: Map<string, number>;
    }
    const accountOf = new Map<string, AccountAcc>();
    const bumpAccount = (accountId: string, hours: number, spendUsd: number): void => {
        const a = accountOf.get(accountId) ?? { weightBasis: 0, hours: 0, sums: new Map() };
        a.hours += hours;
        a.weightBasis += spendUsd;
        accountOf.set(accountId, a);
    };
    const addToAccount = (accountId: string, key: string, value: number): void => {
        const a = accountOf.get(accountId);
        if (!a) return;
        a.sums.set(key, (a.sums.get(key) ?? 0) + value);
    };
    /** Sqrt-of-spend weighted mean of each account's own per-hour rate. */
    const weightedRate = (key: string, hoursOf: (a: AccountAcc) => number = (a) => a.hours): number => {
        let num = 0;
        let den = 0;
        for (const a of accountOf.values()) {
            const hours = hoursOf(a);
            if (hours <= 0) continue;
            const w = Math.sqrt(a.weightBasis);
            if (w <= 0) continue;
            num += w * ((a.sums.get(key) ?? 0) / hours);
            den += w;
        }
        return den > 0 ? num / den : 0;
    };
    const phModels = new Map<string, { kind: UsageKind; provider: string; model: string; credits: number; cost: number; hours: number; units: number }>();
    // Token volume rides the same per-account accumulators as everything else,
    // so it shares one population and one weighting. The window-wide llmCache
    // aggregate can't stand in: it counts every event, including the sessions
    // the real-sit bar excluded, and never sums output tokens.
    // The volume a leg's pricing is driven by: turns for LLM, audio seconds for
    // STT, characters for TTS.
    const unitsOf = (e: UsageEvent): number =>
        e.kind === 'llm' ? 1 : e.kind === 'stt' ? e.seconds : e.chars;
    // Hours of sessions that used each metered leg at least once — the honest
    // denominator for "how much STT/TTS does a session that uses it consume".
    let sttHours = 0;
    let ttsHours = 0;
    // STT call shape (0uw7): counted only over sessions that used cloud STT, so
    // local-Whisper and Web-Speech sits don't dilute the ratio to zero.
    let sttCalls = 0;
    let sttSessionTurns = 0;
    const sttCallSeconds: number[] = [];
    for (const s of sessions) {
        const sessionHours = durationMinOf(s) / 60;
        const usedStt = s.some((e) => e.kind === 'stt');
        const usedTts = s.some((e) => e.kind === 'tts');
        if (usedStt) sttHours += sessionHours;
        if (usedTts) ttsHours += sessionHours;
        if (usedStt) {
            for (const e of s) {
                if (e.kind === 'stt') {
                    sttCalls += 1;
                    sttCallSeconds.push(e.seconds);
                } else if (e.kind === 'llm') sttSessionTurns += 1;
            }
        }
        // Sessions cluster per account, so the first event names the owner.
        const accountId = s[0]!.accountId;
        bumpAccount(accountId, sessionHours, s.reduce((sum, e) => sum + e.providerCostUsd, 0));
        if (usedStt) addToAccount(accountId, 'sttHours', sessionHours);
        if (usedTts) addToAccount(accountId, 'ttsHours', sessionHours);
        const modelsInSession = new Set<string>();
        for (const e of s) {
            addToAccount(accountId, 'credits', e.credits);
            addToAccount(accountId, 'cost', e.providerCostUsd);
            if (e.kind === 'llm') {
                addToAccount(accountId, 'turns', 1);
                addToAccount(accountId, 'tokIn', e.tokensIn);
                addToAccount(accountId, 'tokOut', e.tokensOut);
                addToAccount(accountId, 'tokRead', e.cacheRead);
                addToAccount(accountId, 'tokCreate', e.cacheCreation);
                addToAccount(accountId, 'tokCreate1h', e.cacheCreation1h);
            } else if (e.kind === 'stt') {
                addToAccount(accountId, 'sttSeconds', e.seconds);
                addToAccount(accountId, 'sttCalls', 1);
            }
            else addToAccount(accountId, 'ttsChars', e.chars);
            addToAccount(accountId, `svc:${e.kind}`, e.credits);
            addToAccount(accountId, `svcCost:${e.kind}`, e.providerCostUsd);
            const key = `${e.kind}:${e.provider}:${e.model}`;
            const m = phModels.get(key) ?? {
                kind: e.kind,
                provider: e.provider,
                model: e.model,
                credits: 0,
                cost: 0,
                hours: 0,
                units: 0,
            };
            m.credits += e.credits;
            m.cost += e.providerCostUsd;
            m.units += unitsOf(e);
            // This session's hours count once per model, not once per event.
            if (!modelsInSession.has(key)) m.hours += sessionHours;
            modelsInSession.add(key);
            phModels.set(key, m);
        }
    }
    const sttSecondsSorted = [...sttCallSeconds].sort((a, b) => a - b);
    const pooledSum = (key: string): number => {
        let sum = 0;
        for (const a of accountOf.values()) sum += a.sums.get(key) ?? 0;
        return sum;
    };
    const pooledTurns = pooledSum('turns');
    const perTurn = (key: string): number => (pooledTurns > 0 ? pooledSum(key) / pooledTurns : 0);
    const sttHoursOf = (a: AccountAcc): number => a.sums.get('sttHours') ?? 0;
    const ttsHoursOf = (a: AccountAcc): number => a.sums.get('ttsHours') ?? 0;
    const perHour: PerHourReport = {
        sessions: sessions.length,
        accounts: accountOf.size,
        hours: totalHours,
        creditsPerHour: weightedRate('credits'),
        costUsdPerHour: weightedRate('cost'),
        turnsPerHour: weightedRate('turns'),
        sttSecondsPerHour: weightedRate('sttSeconds'),
        ttsCharsPerHour: weightedRate('ttsChars'),
        attributed: {
            sttSecondsPerHour: weightedRate('sttSeconds', sttHoursOf),
            ttsCharsPerHour: weightedRate('ttsChars', ttsHoursOf),
        },
        stt: {
            callsPerHour: weightedRate('sttCalls', sttHoursOf),
            callsPerTurn: sttSessionTurns > 0 ? sttCalls / sttSessionTurns : 0,
            medianSeconds: percentile(sttSecondsSorted, 0.5),
            p90Seconds: percentile(sttSecondsSorted, 0.9),
        },
        tokensPerHour: {
            input: weightedRate('tokIn'),
            output: weightedRate('tokOut'),
            cacheRead: weightedRate('tokRead'),
            cacheCreation: weightedRate('tokCreate'),
            cacheCreation1h: weightedRate('tokCreate1h'),
        },
        byService: (['llm', 'stt', 'tts'] as UsageKind[]).map((kind) => ({
            kind,
            creditsPerHour: weightedRate(`svc:${kind}`),
            costUsdPerHour: weightedRate(`svcCost:${kind}`),
        })),
        // Unweighted, unlike the rates above: a per-model row already divides
        // by only the hours that used that model, and is read as "what this
        // model costs when chosen", not as a population average.
        byModel: [...phModels.values()]
            .map((m) => ({
                kind: m.kind,
                provider: m.provider,
                model: m.model,
                creditsPerHour: rate(m.credits, m.hours),
                costUsdPerHour: rate(m.cost, m.hours),
                hours: m.hours,
                unitsPerHour: rate(m.units, m.hours),
            }))
            .sort((a, b) => b.costUsdPerHour - a.costUsdPerHour),
        pooled: {
            creditsPerHour: rate(pooledSum('credits'), totalHours),
            costUsdPerHour: rate(pooledSum('cost'), totalHours),
            turnsPerHour: rate(pooledTurns, totalHours),
        },
        tokensPerTurn: {
            input: perTurn('tokIn'),
            output: perTurn('tokOut'),
            cacheRead: perTurn('tokRead'),
            cacheCreation: perTurn('tokCreate'),
        },
    };
    const sessionRows = opts.sessionRowsFor?.size
        ? sessions
              .filter((sess) => opts.sessionRowsFor!.has(sess[0]!.accountId))
              .map((sess) => sessionRow(sess, durationMinOf(sess)))
              .sort((a, b) => b.startTs - a.startTs)
        : [];

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
        accounts: new Set(inWindow.map((e) => e.accountId)).size,
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
        perHour,
        sessionRows,
    };
}

/** Itemize one session (SessionRow). The facilitation model is the LLM model
 *  with the most cost; everything else on the LLM leg is counted as utility. */
function sessionRow(s: UsageEvent[], minutes: number): SessionRow {
    const hours = minutes / 60;
    const per = (x: number): number => (hours > 0 ? x / hours : 0);
    const llmCost = new Map<string, { provider: string; model: string; cost: number }>();
    const ttsChars = new Map<string, { provider: string; voice: string; chars: number }>();
    const byService: Record<UsageKind, number> = { llm: 0, stt: 0, tts: 0 };
    let credits = 0;
    let costUsd = 0;
    let sttSeconds = 0;
    let sttCalls = 0;
    for (const e of s) {
        credits += e.credits;
        costUsd += e.providerCostUsd;
        byService[e.kind] += e.credits;
        if (e.kind === 'llm') {
            const key = `${e.provider}:${e.model}`;
            const m = llmCost.get(key) ?? { provider: e.provider, model: e.model, cost: 0 };
            m.cost += e.providerCostUsd;
            llmCost.set(key, m);
        } else if (e.kind === 'stt') {
            sttSeconds += e.seconds;
            sttCalls += 1;
        } else {
            const key = `${e.provider}:${e.model}`;
            const v = ttsChars.get(key) ?? { provider: e.provider, voice: e.model, chars: 0 };
            v.chars += e.chars;
            ttsChars.set(key, v);
        }
    }
    const top = [...llmCost.values()].sort((a, b) => b.cost - a.cost)[0] ?? null;
    const topVoice = [...ttsChars.values()].sort((a, b) => b.chars - a.chars)[0] ?? null;
    const tok = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    let llmTurns = 0;
    let utilityCalls = 0;
    for (const e of s) {
        if (e.kind !== 'llm') continue;
        if (top && e.provider === top.provider && e.model === top.model) {
            llmTurns += 1;
            tok.input += e.tokensIn;
            tok.output += e.tokensOut;
            tok.cacheRead += e.cacheRead;
            tok.cacheCreation += e.cacheCreation;
        } else utilityCalls += 1;
    }
    const perTurn = (x: number): number => (llmTurns > 0 ? x / llmTurns : 0);
    return {
        accountId: s[0]!.accountId,
        startTs: s[0]!.ts,
        minutes,
        llmProvider: top?.provider ?? null,
        llmModel: top?.model ?? null,
        llmTurns,
        utilityCalls,
        credits,
        costUsd,
        creditsPerHour: per(credits),
        byService,
        tokensPerTurn: {
            input: perTurn(tok.input),
            output: perTurn(tok.output),
            cacheRead: perTurn(tok.cacheRead),
            cacheCreation: perTurn(tok.cacheCreation),
        },
        sttSeconds,
        sttCalls,
        ttsProvider: topVoice?.provider ?? null,
        ttsVoice: topVoice?.voice ?? null,
        ttsChars: [...ttsChars.values()].reduce((sum, v) => sum + v.chars, 0),
    };
}

/** Seconds in a UTC day: the history bucket width. */
const DAY_SEC = 24 * 60 * 60;

/** Daily time-series for the admin trend charts. Reconstructs sessions over the
 *  whole window, then attributes each to the UTC day of its FIRST event, so a
 *  session is counted once, on the day it began, and never splits at midnight.
 *  One row per day for the last `days` days ending at `now`, zero-filled so the
 *  chart has no gaps, oldest→newest. Pure.
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
            accounts: 0,
        });
    }

    const dayAccounts = new Map<number, Set<string>>();
    const sessions = clusterSessions(events.filter((e) => e.ts >= firstDay));
    for (const s of sessions) {
        const day = Math.floor(s[0]!.ts / DAY_SEC) * DAY_SEC;
        const b = buckets.get(day);
        if (!b) continue; // first event sits past the trimmed window edge
        b.sessions += 1;
        b.events += s.length;
        for (const e of s) {
            if (e.kind === 'llm') b.turns += 1;
            b.providerCostUsd += e.providerCostUsd;
            b.credits += e.credits;
        }
        if (s.length >= 2) b.durationMin += (s[s.length - 1]!.ts - s[0]!.ts) / 60;
        const set = dayAccounts.get(day) ?? new Set<string>();
        set.add(s[0]!.accountId);
        dayAccounts.set(day, set);
    }
    for (const [day, set] of dayAccounts) buckets.get(day)!.accounts = set.size;

    return [...buckets.values()].sort((a, b) => a.dayStartTs - b.dayStartTs);
}

/** One provider+service leg's computed spend for one UTC day: the "our side" row
 *  of the provider-bill reconciliation (meditation-pal-xejm). Split by kind and
 *  carrying raw units (seconds, chars) so the reconciler can derive the EFFECTIVE
 *  billed rate per leg ($/hr STT, $/1M-chars TTS) from the provider's line items,
 *  not just flag aggregate drift. */
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
 *  buildUsageHistory this buckets each EVENT by its own timestamp, because
 *  provider invoices bill by when the call happened, not by when our
 *  reconstructed session started; the rows then line up with the Anthropic/OpenAI
 *  daily cost reports. Days with no usage for a provider emit no row. */
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

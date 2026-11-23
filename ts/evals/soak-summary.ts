/**
 * Soak runs (ts/soak-runs/<dir>/run.json) -> the report's whole-session view:
 * facilitator by scenario per tier, check failures grouped by check id, judge
 * scores kept apart per judge model, and the judge's wince quotes.
 *
 * Tolerant by design: run.json has changed shape since August (no `tier` or
 * `cast` before September, `judgeSpec` strings instead), and soak is gaining
 * optional fields (per-call model and tokens, `judgeRuns`, `meta.gitSha`).
 *
 * Judge scores are never pooled across judge models (dev-docs/soak-harness.md:
 * a judge prefers some voices, and identical code moves a score by a point).
 */

import type { CheckFinding, JudgeVerdict } from '../soak/types.js';
import type { TrialUsage } from './records.js';

export type SoakTier = 'headless' | 'browser';

export interface SoakJudgement {
    judgeModel: string;
    verdict: JudgeVerdict;
}

export interface SoakSession {
    run: string;
    tier: SoakTier;
    startedAt: string;
    scenario: string;
    scenarioTitle: string;
    runIndex: number;
    facilitator: string;
    endedBy: string;
    error?: string;
    findings: CheckFinding[];
    judgements: SoakJudgement[];
    judgeError?: string;
    /** Calls that failed outright (an API error, an aborted page): a judge
     *  score on such a session grades the harness. An `empty-reply`
     *  turn-error is the model's own answer and is not counted. */
    turnErrors: number;
    /** Facilitator-side cost from per-call tokens, when the run recorded them. */
    costUsd: number | null;
    gitSha: string | null;
}

export interface SoakRunView {
    dir: string;
    startedAt: string;
    tier: SoakTier;
    battery: string | null;
    facilitators: string[];
    /** Every judge the run cast; the first scored `judge`. */
    judges: string[];
    sessions: number;
    gitSha: string | null;
    gitDirty: boolean | null;
    audio: string | null;
}

export interface JudgeStat {
    judgeModel: string;
    /** Verdicts; above `sessions` when a judge scored sessions repeatedly. */
    n: number;
    sessions: number;
    mean: number;
    min: number;
    max: number;
}

export interface SoakCell {
    sessions: number;
    failedSessions: number;
    fails: number;
    warns: number;
    /** Sessions with failed turns: a judge score there may be grading a broken harness. */
    turnErrorSessions: number;
    judges: JudgeStat[];
    winces: number;
    from: string;
    to: string;
}

export interface CheckGroup {
    id: string;
    level: 'fail' | 'warn';
    sessions: number;
    occurrences: number;
    facilitators: string[];
    scenarios: string[];
    runs: string[];
    samples: string[];
    last: string;
}

export interface Wince {
    run: string;
    startedAt: string;
    facilitator: string;
    scenario: string;
    judgeModel: string;
    quote: string;
    why: string;
}

export interface SoakTierView {
    tier: SoakTier;
    facilitators: string[];
    scenarios: Array<{ id: string; title: string }>;
    /** Keyed `${facilitator}|${scenario}`. */
    cells: Record<string, SoakCell>;
    checks: CheckGroup[];
    winces: Wince[];
    judgeModels: string[];
}

export interface SoakFinding {
    severity: 'critical' | 'serious' | 'warning' | 'info';
    title: string;
    items: Array<{ text: string; tier: SoakTier; check?: string }>;
}

export interface SoakSummary {
    runs: SoakRunView[];
    sessions: SoakSession[];
    tiers: SoakTierView[];
    findings: SoakFinding[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** "anthropic (claude-sonnet-5)" / "anthropic:claude-haiku-4-5" / "anthropic". */
export function modelFromSpec(spec: string): string {
    const paren = /\(([^)]+)\)\s*$/.exec(spec);
    if (paren) return paren[1]!.trim();
    const colon = spec.indexOf(':');
    if (colon !== -1 && colon < spec.length - 1) return spec.slice(colon + 1);
    return `${spec} (default model, unrecorded)`;
}

function judgeModelsOf(meta: Obj): string[] {
    const cast = isObj(meta['cast']) ? meta['cast'] : null;
    const entry = (j: unknown) => (isObj(j) ? (str(j['model']) ?? str(j['spec'])) : null);
    if (cast) {
        const all = Array.isArray(cast['judges']) ? cast['judges'].map(entry) : [entry(cast['judge'])];
        return all.filter((m): m is string => m !== null);
    }
    const spec = str(meta['judgeSpec']);
    return spec ? [modelFromSpec(spec)] : [];
}

function facilitatorsOf(meta: Obj): string[] {
    const cast = isObj(meta['cast']) ? meta['cast'] : null;
    if (cast && Array.isArray(cast['facilitators'])) {
        return cast['facilitators'].map((f) => (isObj(f) ? (str(f['model']) ?? str(f['spec']) ?? '?') : '?'));
    }
    if (Array.isArray(meta['facilitatorSpecs'])) {
        return meta['facilitatorSpecs'].map((s) => (typeof s === 'string' ? modelFromSpec(s) : '?'));
    }
    const one = str(meta['facilitatorSpec']);
    return one ? [modelFromSpec(one)] : [];
}

const quotesOf = (v: unknown): Array<{ quote: string; why: string }> =>
    Array.isArray(v) ? v.filter(isObj).map((w) => ({ quote: str(w['quote']) ?? '', why: str(w['why']) ?? '' })) : [];

/** Rubric 13 and 14 over the session (soak/judge.ts), when the judge was asked. */
function conductOf(v: unknown): JudgeVerdict['conduct'] | null {
    if (!isObj(v)) return null;
    const out: NonNullable<JudgeVerdict['conduct']> = {};
    for (const dim of ['13', '14'] as const) {
        const c = v[dim];
        if (isObj(c) && typeof c['pass'] === 'boolean') out[dim] = { pass: c['pass'], fails: quotesOf(c['fails']) };
    }
    return Object.keys(out).length ? out : null;
}

function verdictOf(v: unknown): JudgeVerdict | null {
    if (!isObj(v) || num(v['overall']) === null) return null;
    const conduct = conductOf(v['conduct']);
    return {
        ...(conduct && { conduct }),
        overall: v['overall'] as number,
        dimensions: isObj(v['dimensions']) ? (v['dimensions'] as Record<string, number | null>) : {},
        winceMoments: quotesOf(v['winceMoments']),
        notes: str(v['notes']) ?? '',
    };
}

/** Every verdict on a session. `judgeRuns` holds them all when present
 *  (repeats of one judge included) and `judge` is then only its first, kept
 *  for older readers; before judgeRuns, `judge` was the one verdict, by the
 *  run's judge model. */
export function judgementsOf(report: Obj, primaryJudge: string | null): SoakJudgement[] {
    const runs: SoakJudgement[] = [];
    if (Array.isArray(report['judgeRuns'])) {
        for (const r of report['judgeRuns']) {
            if (!isObj(r)) continue;
            const verdict = verdictOf(r['verdict']);
            const judgeModel = str(r['judgeModel']);
            if (verdict && judgeModel) runs.push({ judgeModel, verdict });
        }
    }
    if (runs.length) return runs;
    const primary = verdictOf(report['judge']);
    return primary ? [{ judgeModel: primaryJudge ?? 'unrecorded', verdict: primary }] : [];
}

export type PriceByModel = (model: string, usage: TrialUsage) => number | null;

function sessionCost(calls: unknown, facilitator: string, price: PriceByModel | undefined): number | null {
    if (!price || !Array.isArray(calls)) return null;
    let total = 0;
    let priced = false;
    for (const c of calls) {
        if (!isObj(c)) continue;
        const model = str(c['model']);
        if (!model || model !== facilitator) continue;
        const usage: TrialUsage = {
            inputTokens: num(c['inputTokens']),
            outputTokens: num(c['outputTokens']),
            cacheReadTokens: num(c['cacheReadTokens']),
            cacheCreationTokens: num(c['cacheCreationTokens']),
        };
        const cost = price(model, usage);
        if (cost !== null) {
            total += cost;
            priced = true;
        }
    }
    return priced ? total : null;
}

/** One run.json -> its run view and sessions; null when it isn't one. */
export function parseSoakRun(
    dir: string,
    json: unknown,
    price?: PriceByModel
): { run: SoakRunView; sessions: SoakSession[] } | null {
    if (!isObj(json) || !isObj(json['meta']) || !Array.isArray(json['reports'])) return null;
    const meta = json['meta'];
    const tier: SoakTier =
        meta['tier'] === 'browser' || meta['tier'] === 'headless'
            ? meta['tier']
            : dir.startsWith('web-')
              ? 'browser'
              : 'headless';
    const judges = judgeModelsOf(meta);
    const gitSha = str(meta['gitSha']);
    const gitDirty = typeof meta['gitDirty'] === 'boolean' ? meta['gitDirty'] : null;
    const startedAt = str(meta['startedAt']) ?? '';
    const sessions: SoakSession[] = [];
    for (const report of json['reports']) {
        if (!isObj(report) || !isObj(report['result'])) continue;
        const result = report['result'];
        const scenario = isObj(result['scenario']) ? result['scenario'] : {};
        const findings = Array.isArray(report['findings'])
            ? (report['findings'] as unknown[]).filter(
                  (f): f is CheckFinding => isObj(f) && typeof f['id'] === 'string' && typeof f['level'] === 'string'
              )
            : [];
        const facilitator = str(result['facilitatorModel']) ?? '?';
        const error = str(result['error']);
        const runErrors = Array.isArray(report['judgeRunErrors'])
            ? (report['judgeRunErrors'] as unknown[])
                  .filter(isObj)
                  .map((e) => `${str(e['judgeModel']) ?? '?'}: ${str(e['error']) ?? ''}`)
            : [];
        const judgeError = [str(report['judgeError']), ...runErrors].filter((x): x is string => !!x).join('; ') || null;
        sessions.push({
            run: dir,
            tier,
            startedAt: str(result['startedAt']) ?? startedAt,
            scenario: str(scenario['id']) ?? '?',
            scenarioTitle: str(scenario['title']) ?? '',
            runIndex: num(result['runIndex']) ?? 0,
            facilitator,
            endedBy: str(result['endedBy']) ?? '',
            ...(error !== null && { error }),
            findings,
            judgements: judgementsOf(report, judges[0] ?? null),
            ...(judgeError !== null && { judgeError }),
            turnErrors: findings.filter(
                (f) =>
                    f.level === 'fail' &&
                    (f.id === 'session-error' || (f.id === 'turn-error' && !f.detail.startsWith('empty-reply')))
            ).length,
            costUsd: sessionCost(result['calls'], facilitator, price),
            gitSha,
        });
    }
    return {
        run: {
            dir,
            startedAt,
            tier,
            battery: str(meta['battery']),
            facilitators: facilitatorsOf(meta),
            judges,
            sessions: sessions.length,
            gitSha,
            gitDirty,
            audio: str(meta['audio']),
        },
        sessions,
    };
}

export function summarizeSoak(runs: ReadonlyArray<{ dir: string; json: unknown }>, price?: PriceByModel): SoakSummary {
    const runViews: SoakRunView[] = [];
    const sessions: SoakSession[] = [];
    for (const { dir, json } of runs) {
        const parsed = parseSoakRun(dir, json, price);
        if (!parsed) continue;
        runViews.push(parsed.run);
        sessions.push(...parsed.sessions);
    }
    runViews.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    const tiers: SoakTierView[] = [];
    for (const tier of ['headless', 'browser'] as const) {
        const mine = sessions.filter((s) => s.tier === tier);
        if (mine.length === 0) continue;
        const cells: Record<string, SoakCell> = {};
        const scenarioTitles = new Map<string, string>();
        for (const s of mine) {
            if (!scenarioTitles.has(s.scenario) || !scenarioTitles.get(s.scenario)) {
                scenarioTitles.set(s.scenario, s.scenarioTitle);
            }
            const key = `${s.facilitator}|${s.scenario}`;
            const c = (cells[key] ??= {
                sessions: 0,
                failedSessions: 0,
                fails: 0,
                warns: 0,
                turnErrorSessions: 0,
                judges: [],
                winces: 0,
                from: s.startedAt,
                to: s.startedAt,
            });
            const fails = s.findings.filter((f) => f.level === 'fail').length;
            c.sessions++;
            c.fails += fails;
            c.warns += s.findings.filter((f) => f.level === 'warn').length;
            if (fails > 0) c.failedSessions++;
            if (s.turnErrors > 0) c.turnErrorSessions++;
            if (s.startedAt < c.from) c.from = s.startedAt;
            if (s.startedAt > c.to) c.to = s.startedAt;
            const judgedBy = new Set<string>();
            for (const j of s.judgements) {
                c.winces += j.verdict.winceMoments.length;
                const stat = c.judges.find((x) => x.judgeModel === j.judgeModel);
                const score = j.verdict.overall;
                const firstHere = !judgedBy.has(j.judgeModel);
                judgedBy.add(j.judgeModel);
                if (stat) {
                    stat.mean = (stat.mean * stat.n + score) / (stat.n + 1);
                    stat.n++;
                    if (firstHere) stat.sessions++;
                    stat.min = Math.min(stat.min, score);
                    stat.max = Math.max(stat.max, score);
                } else {
                    c.judges.push({ judgeModel: j.judgeModel, n: 1, sessions: 1, mean: score, min: score, max: score });
                }
            }
        }

        const groups = new Map<string, CheckGroup>();
        for (const s of mine) {
            const seen = new Set<string>();
            for (const f of s.findings) {
                if (f.level !== 'fail' && f.level !== 'warn') continue;
                const key = `${f.level}|${f.id}`;
                const g =
                    groups.get(key) ??
                    ({
                        id: f.id,
                        level: f.level,
                        sessions: 0,
                        occurrences: 0,
                        facilitators: [],
                        scenarios: [],
                        runs: [],
                        samples: [],
                        last: s.startedAt,
                    } satisfies CheckGroup);
                groups.set(key, g);
                g.occurrences++;
                if (!seen.has(key)) {
                    g.sessions++;
                    seen.add(key);
                }
                if (!g.facilitators.includes(s.facilitator)) g.facilitators.push(s.facilitator);
                if (!g.scenarios.includes(s.scenario)) g.scenarios.push(s.scenario);
                if (!g.runs.includes(s.run)) g.runs.push(s.run);
                if (g.samples.length < 3 && !g.samples.includes(f.detail)) g.samples.push(f.detail);
                if (s.startedAt > g.last) g.last = s.startedAt;
            }
        }

        const winces: Wince[] = [];
        for (const s of mine) {
            for (const j of s.judgements) {
                for (const w of j.verdict.winceMoments) {
                    winces.push({
                        run: s.run,
                        startedAt: s.startedAt,
                        facilitator: s.facilitator,
                        scenario: s.scenario,
                        judgeModel: j.judgeModel,
                        quote: w.quote,
                        why: w.why,
                    });
                }
            }
        }

        const facilitators = [...new Set(mine.map((s) => s.facilitator))].sort();
        tiers.push({
            tier,
            facilitators,
            scenarios: [...scenarioTitles].map(([id, title]) => ({ id, title })).sort((a, b) => a.id.localeCompare(b.id)),
            cells,
            checks: [...groups.values()].sort(
                (a, b) => (a.level === b.level ? b.sessions - a.sessions : a.level === 'fail' ? -1 : 1)
            ),
            winces,
            judgeModels: [...new Set(mine.flatMap((s) => s.judgements.map((j) => j.judgeModel)))].sort(),
        });
    }
    const summary = { runs: runViews, sessions, tiers, findings: [] };
    return { ...summary, findings: soakFindings(summary) };
}

const TIER_LABEL: Record<SoakTier, string> = { headless: 'tier 1', browser: 'tier 2' };

export function soakFindings(s: Pick<SoakSummary, 'tiers' | 'sessions'>): SoakFinding[] {
    const out: SoakFinding[] = [];
    const failing = s.tiers.flatMap((t) =>
        t.checks
            .filter((g) => g.level === 'fail')
            .map((g) => ({
                text: `${TIER_LABEL[t.tier]} ${g.id}: ${g.sessions} session${g.sessions === 1 ? '' : 's'}, last ${g.last.slice(0, 10)} (${g.facilitators.join(', ')})`,
                tier: t.tier,
                check: g.id,
            }))
    );
    if (failing.length) out.push({ severity: 'serious', title: 'Soak check failures', items: failing });
    const scoredBroken = new Map<string, { tier: SoakTier; n: number }>();
    for (const x of s.sessions) {
        if (x.turnErrors === 0 || x.judgements.length === 0) continue;
        const have = scoredBroken.get(x.run);
        scoredBroken.set(x.run, { tier: x.tier, n: (have?.n ?? 0) + 1 });
    }
    if (scoredBroken.size) {
        out.push({
            severity: 'warning',
            title: 'Judge scored sessions whose turns failed',
            items: [...scoredBroken].map(([run, { tier, n }]) => ({
                text: `${run}: ${n} session${n === 1 ? '' : 's'}`,
                tier,
            })),
        });
    }
    return out;
}

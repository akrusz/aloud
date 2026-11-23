/**
 * Phase 2 verdicts -> what the report shows, per judge and never pooled
 * across judges: each model's binary fails (quoted), wins and last places,
 * weighted means per dimension and overall (rubric.md weights at the
 * fixture's guidance level), the spread across runs of one fixture, and how
 * far each pair of judges agrees. Pure: report.ts does the reading.
 */

import { ACUTE } from './aggregate.js';
import { CHECK_TYPES, isDimensionId, type CheckType, type DimensionId } from './dimensions.js';
import { FIXTURES, type Fixture } from './fixtures.js';
import { familyOfModelId, guidanceOf } from './judge-core.js';
import { ROSTER, type EvalModel } from './models.js';
import type { JudgeVerdictRecord, PanelReplyVerdict, Sweep } from './records.js';
import { typeOfDim, weightAt, type Rubric } from './rubric.js';

/** A binary fail, typed (rubric.md, "Types"): null when the rubric gives the
 *  dimension no type. */
export type TypedFail = PanelReplyVerdict['fails'][number] & { type: CheckType | null };

export interface PanelReplyView extends Omit<PanelReplyVerdict, 'fails'> {
    fails: TypedFail[];
    model: string;
    letter: string;
    /** 1 is best; null when the panel has no ranking. */
    rank: number | null;
}

export interface PanelView {
    id: string;
    judgeModel: string;
    sweep: string;
    fixture: string;
    run: number;
    /** In ranking order when ranked. */
    replies: PanelReplyView[];
    decided?: JudgeVerdictRecord['decided'];
    /** Judged against older instructions than rubric.md gives today. */
    staleRubric: boolean;
    /** A reply was measured at an older prompt than today's. */
    staleInputs: boolean;
    sameFamily: string[];
    error?: string;
    warnings?: string[];
    costUsd?: number;
    latencyMs?: number;
}

export interface ModelJudgement {
    model: string;
    panels: number;
    wins: number;
    lasts: number;
    fails: Array<{ fixture: string; run: number; dim: string; quote: string; quoteFound: boolean; panel: string; type: CheckType | null }>;
    dims: Partial<Record<DimensionId, { mean: number; n: number }>>;
    overall: { mean: number; n: number } | null;
    /** Binary fails per type, and the weighted mean over the type's scored
     *  dimensions (none for Safety: 11 and 15 sit outside the means). */
    types: Record<CheckType, { fails: number; mean: number | null; n: number }>;
    /** Dimension 11, outside the weighted means. 15 is too, and counts only
     *  as a Safety fail. */
    stepOut: { pass: number; n: number } | null;
    /** Turn scores across runs of one fixture; spread is max minus min. */
    variance: { fixturesWithRuns: number; maxSpread: number | null; wide: Array<{ fixture: string; scores: number[] }> };
}

export interface JudgeView {
    judgeModel: string;
    panels: number;
    errors: number;
    staleRubric: number;
    staleInputs: number;
    costUsd: number | null;
    costPerPanel: number | null;
    latencyP50Ms: number | null;
    models: ModelJudgement[];
}

export interface JudgePairView {
    a: string;
    b: string;
    shared: number;
    topAgree: number;
    /** Mean Kendall tau over shared panels, on the models both ranked. */
    tau: number | null;
    /** Mean rank position (0 best, 1 worst) each judge gives a family's
     *  replies, for each judge's own family, on the same panels. */
    tilts: Array<{ family: string; n: number; aPos: number; bPos: number }>;
}

export interface Phase2Summary {
    judges: JudgeView[];
    pairs: JudgePairView[];
    panels: PanelView[];
    dims: Array<{ id: DimensionId; name: string; binary: boolean }>;
    /** rubric.md's Types, key to type ("11 acute", "12"...). */
    dimTypes: Record<string, CheckType>;
}

export interface Phase2Options {
    rubric: Rubric;
    fixtures?: readonly Fixture[];
    roster?: readonly EvalModel[];
    /** judgeInstructions(rubric, fx).hash per current fixture. */
    currentRubricHashes?: Readonly<Record<string, string>>;
    /** promptHashFor(fx) per current fixture. */
    currentPromptHashes?: Readonly<Record<string, string>>;
}

/** A panel verdict, as opposed to a hand-made pair read as a judge file. */
export function isPanelVerdict(v: JudgeVerdictRecord): boolean {
    return v.run !== undefined && (v.replies !== undefined || v.error !== undefined);
}

export function kendallTau(a: readonly string[], b: readonly string[]): number | null {
    const common = a.filter((x) => b.includes(x));
    const n = common.length;
    if (n < 2) return null;
    const ra = new Map(common.map((m, i) => [m, i]));
    const rb = new Map(b.filter((x) => common.includes(x)).map((m, i) => [m, i]));
    let score = 0;
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const x = common[i] as string;
            const y = common[j] as string;
            const da = (ra.get(x) as number) - (ra.get(y) as number);
            const db = (rb.get(x) as number) - (rb.get(y) as number);
            score += Math.sign(da) * Math.sign(db);
        }
    }
    return score / ((n * (n - 1)) / 2);
}

function median(xs: readonly number[]): number | null {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

interface Acc {
    ws: number;
    w: number;
    n: number;
}

/** The weighted cells of one reply: per dimension, score and weight. */
export function replyCells(
    rubric: Rubric,
    dims: readonly string[],
    guidance: number,
    r: PanelReplyVerdict
): { cells: Array<{ dim: DimensionId; score: number; weight: number }>; stepOut: boolean | null } {
    const cells: Array<{ dim: DimensionId; score: number; weight: number }> = [];
    let stepOut: boolean | null = null;
    for (const id of dims) {
        if (!isDimensionId(id)) continue;
        const d = rubric.dimensions.get(id);
        if (!d?.weight) continue;
        const failed = r.fails.some((f) => f.dim === id);
        if (d.weight.kind === 'overriding') {
            if (id === '11') stepOut = !failed;
            continue;
        }
        const weight = weightAt(d.weight, guidance) as number;
        const score = d.binary ? (failed ? 1 : 5) : r.scores[id];
        if (score === undefined) continue;
        cells.push({ dim: id, score, weight });
    }
    return { cells, stepOut };
}

export function summarizePhase2(sweeps: readonly Sweep[], opts: Phase2Options): Phase2Summary {
    const rubric = opts.rubric;
    const fixtures = new Map((opts.fixtures ?? FIXTURES).map((f) => [f.id, f]));
    const roster = opts.roster ?? ROSTER;
    const familyOf = (model: string) => familyOfModelId(roster.find((m) => m.id === model)?.model ?? model);

    const panels: PanelView[] = [];
    const raw: Array<{ v: JudgeVerdictRecord; view: PanelView }> = [];
    for (const s of sweeps) {
        for (const { file } of s.judges) {
            for (const v of file.verdicts) {
                if (!isPanelVerdict(v)) continue;
                const run = v.run as number;
                const rank = new Map((v.ranking ?? []).map((m, i) => [m, i + 1]));
                const letterOf = new Map(Object.entries(v.key ?? {}).map(([l, m]) => [m, l]));
                const typed = (f: PanelReplyVerdict['fails'][number]): TypedFail => ({ ...f, type: typeOfDim(rubric, f.dim, ACUTE(v.fixture)) });
                const replies: PanelReplyView[] = Object.entries(v.replies ?? {})
                    .map(([model, r]) => ({ ...r, fails: r.fails.map(typed), model, letter: letterOf.get(model) ?? '?', rank: rank.get(model) ?? null }))
                    .sort((a, b) => (a.rank ?? 99) - (b.rank ?? 99) || a.letter.localeCompare(b.letter));
                const nowRubric = opts.currentRubricHashes?.[v.fixture];
                const nowPrompt = opts.currentPromptHashes?.[v.fixture];
                const view: PanelView = {
                    id: `${file.meta.judgeModel}|${s.name}|${v.fixture}#${run}`,
                    judgeModel: file.meta.judgeModel,
                    sweep: s.name,
                    fixture: v.fixture,
                    run,
                    replies,
                    ...(v.decided && { decided: v.decided }),
                    staleRubric: nowRubric !== undefined && v.rubricHash !== nowRubric,
                    staleInputs:
                        v.staleInputs === true ||
                        (nowPrompt !== undefined && Object.values(v.promptHashes ?? {}).some((h) => h !== nowPrompt)),
                    sameFamily: v.sameFamily ?? [],
                    ...(v.error !== undefined && { error: v.error }),
                    ...(v.warnings?.length && { warnings: v.warnings }),
                    ...(v.costUsd !== undefined && { costUsd: v.costUsd }),
                    ...(v.latencyMs !== undefined && { latencyMs: v.latencyMs }),
                };
                panels.push(view);
                raw.push({ v, view });
            }
        }
    }

    const judges: JudgeView[] = [];
    for (const judgeModel of [...new Set(panels.map((p) => p.judgeModel))].sort()) {
        const mine = raw.filter((x) => x.view.judgeModel === judgeModel);
        const ok = mine.filter((x) => !x.v.error);
        const costs = mine.map((x) => x.v.costUsd).filter((c): c is number => c !== undefined);
        const models = [...new Set(ok.flatMap((x) => Object.keys(x.v.replies ?? {})))];
        const order = (id: string) => {
            const i = roster.findIndex((m) => m.id === id);
            return i === -1 ? roster.length : i;
        };
        const rows: ModelJudgement[] = models
            .sort((a, b) => order(a) - order(b) || a.localeCompare(b))
            .map((model) => {
                const dimAcc = new Map<DimensionId, Acc>();
                const overall: Acc = { ws: 0, w: 0, n: 0 };
                const typeAcc = Object.fromEntries(CHECK_TYPES.map((t) => [t.id, { ws: 0, w: 0, n: 0, fails: 0 }])) as Record<
                    CheckType,
                    Acc & { fails: number }
                >;
                const turnScores = new Map<string, number[]>();
                const fails: ModelJudgement['fails'] = [];
                let wins = 0;
                let lasts = 0;
                let panelsIn = 0;
                let stepPass = 0;
                let stepN = 0;
                for (const { v, view } of ok) {
                    const r = v.replies?.[model];
                    if (!r) continue;
                    panelsIn++;
                    const ranking = v.ranking ?? [];
                    if (ranking[0] === model) wins++;
                    if (ranking.length >= 2 && ranking[ranking.length - 1] === model) lasts++;
                    const acute = ACUTE(v.fixture);
                    for (const f of r.fails) {
                        const type = typeOfDim(rubric, f.dim, acute);
                        if (type) typeAcc[type].fails++;
                        fails.push({ fixture: v.fixture, run: v.run as number, dim: f.dim, quote: f.quote, quoteFound: f.quoteFound, panel: view.id, type });
                    }
                    const fx = fixtures.get(v.fixture);
                    const g = fx ? guidanceOf(fx) : 2;
                    const { cells, stepOut } = replyCells(rubric, v.dims ?? fx?.dims ?? [], g, r);
                    if (stepOut !== null) {
                        stepN++;
                        if (stepOut) stepPass++;
                    }
                    let ws = 0;
                    let w = 0;
                    const touched = new Set<CheckType>();
                    for (const c of cells) {
                        const type = typeOfDim(rubric, c.dim, acute);
                        if (type) {
                            typeAcc[type].ws += c.score * c.weight;
                            typeAcc[type].w += c.weight;
                            touched.add(type);
                        }
                        const a = dimAcc.get(c.dim) ?? { ws: 0, w: 0, n: 0 };
                        a.ws += c.score * c.weight;
                        a.w += c.weight;
                        a.n++;
                        dimAcc.set(c.dim, a);
                        ws += c.score * c.weight;
                        w += c.weight;
                    }
                    for (const t of touched) typeAcc[t].n++;
                    if (w > 0) {
                        overall.ws += ws;
                        overall.w += w;
                        overall.n++;
                        turnScores.set(v.fixture, [...(turnScores.get(v.fixture) ?? []), ws / w]);
                    }
                }
                const dims: ModelJudgement['dims'] = {};
                for (const [id, a] of dimAcc) dims[id] = { mean: a.ws / a.w, n: a.n };
                const multi = [...turnScores].filter(([, xs]) => xs.length >= 2);
                const spreads = multi.map(([, xs]) => Math.max(...xs) - Math.min(...xs));
                return {
                    model,
                    panels: panelsIn,
                    wins,
                    lasts,
                    fails,
                    dims,
                    overall: overall.w > 0 ? { mean: overall.ws / overall.w, n: overall.n } : null,
                    types: Object.fromEntries(
                        CHECK_TYPES.map((t) => {
                            const a = typeAcc[t.id];
                            return [t.id, { fails: a.fails, mean: a.w > 0 ? a.ws / a.w : null, n: a.n }];
                        })
                    ) as ModelJudgement['types'],
                    stepOut: stepN ? { pass: stepPass, n: stepN } : null,
                    variance: {
                        fixturesWithRuns: multi.length,
                        maxSpread: spreads.length ? Math.max(...spreads) : null,
                        wide: multi
                            .filter(([, xs]) => Math.max(...xs) - Math.min(...xs) >= 2)
                            .map(([fixture, scores]) => ({ fixture, scores })),
                    },
                };
            });
        judges.push({
            judgeModel,
            panels: mine.length,
            errors: mine.length - ok.length,
            staleRubric: mine.filter((x) => x.view.staleRubric).length,
            staleInputs: mine.filter((x) => x.view.staleInputs).length,
            costUsd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
            costPerPanel: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
            latencyP50Ms: median(mine.map((x) => x.v.latencyMs).filter((l): l is number => l !== undefined)),
            models: rows,
        });
    }

    const pairs: JudgePairView[] = [];
    const judgeIds = judges.map((j) => j.judgeModel);
    const byPanel = new Map<string, Map<string, JudgeVerdictRecord>>();
    for (const { v, view } of raw) {
        if (v.error || !v.ranking?.length) continue;
        const key = `${view.sweep}|${v.fixture}#${v.run}`;
        const m = byPanel.get(key) ?? new Map<string, JudgeVerdictRecord>();
        m.set(view.judgeModel, v);
        byPanel.set(key, m);
    }
    for (let i = 0; i < judgeIds.length; i++) {
        for (let j = i + 1; j < judgeIds.length; j++) {
            const a = judgeIds[i] as string;
            const b = judgeIds[j] as string;
            let shared = 0;
            let topAgree = 0;
            const taus: number[] = [];
            const tilt = new Map<string, { n: number; a: number; b: number }>();
            const families = [...new Set([familyOfModelId(a), familyOfModelId(b)])];
            for (const m of byPanel.values()) {
                const va = m.get(a);
                const vb = m.get(b);
                if (!va?.ranking || !vb?.ranking) continue;
                const common = va.ranking.filter((x) => vb.ranking?.includes(x));
                if (common.length < 2) continue;
                const ra = common;
                const rb = vb.ranking.filter((x) => common.includes(x));
                shared++;
                if (ra[0] === rb[0]) topAgree++;
                const t = kendallTau(ra, rb);
                if (t !== null) taus.push(t);
                for (const fam of families) {
                    for (const model of common.filter((x) => familyOf(x) === fam)) {
                        const acc = tilt.get(fam) ?? { n: 0, a: 0, b: 0 };
                        acc.n++;
                        acc.a += ra.indexOf(model) / (common.length - 1);
                        acc.b += rb.indexOf(model) / (common.length - 1);
                        tilt.set(fam, acc);
                    }
                }
            }
            pairs.push({
                a,
                b,
                shared,
                topAgree,
                tau: taus.length ? taus.reduce((x, y) => x + y, 0) / taus.length : null,
                tilts: [...tilt].map(([family, t]) => ({ family, n: t.n, aPos: t.a / t.n, bPos: t.b / t.n })),
            });
        }
    }

    return {
        judges,
        pairs,
        panels,
        dims: [...rubric.dimensions.values()].map((d) => ({ id: d.id, name: d.name, binary: d.binary })),
        dimTypes: Object.fromEntries(rubric.types.map((t) => [t.key, t.type])),
    };
}

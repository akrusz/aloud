/**
 * The eval results store: the record shapes protocol-eval.ts writes and
 * report.ts reads, and the reader for a results directory.
 *
 * Layout: ts/evals/results/<sweep>/, one sweep per directory.
 *   <model-id>.json    a RunEnvelope (or, before 2026-11-22, a bare Trial[])
 *   judge-<name>.json  a JudgeFile: Phase 2 blind verdicts over this sweep
 *   verdict-<name>.json + key-<name>.json
 *                      a blind comparison made by hand before JudgeFile
 *                      existed; read as a JudgeFile, its judge named by
 *   blind-judge.json   { "judgeModel": "..." }, else 'unrecorded'
 * Anything else in the directory (timing probes, logs, notes) is ignored.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { Check } from './grade.js';
import type { EvalProvider } from './models.js';

export type Via = 'api' | 'subscription' | 'local';

export interface TrialUsage {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
}

export interface Trial {
    /** Roster id (models.ts). */
    model: string;
    fixture: string;
    /** The fixture's description when it ran. */
    description: string;
    run: number;
    /** Request to last byte. */
    latencyMs: number;
    raw: string;
    spoken: string;
    checks: Check[];
    score: number;
    error?: string;
    // Everything below arrived with the run envelope and is absent in older
    // files.
    at?: string;
    provider?: EvalProvider;
    /** Provider-native model id. */
    providerModel?: string;
    via?: Via;
    /** Request to the first non-empty text chunk; streamed providers only. */
    firstTextMs?: number;
    finishReason?: string | null;
    usage?: TrialUsage;
    /** At list price (server/src/pricing/providers.ts), API calls only. */
    costUsd?: number;
    /** The upstream host a routing proxy reported (OpenRouter). */
    servedBy?: string;
    /** promptHash() of what was sent (prompt.ts). */
    promptHash?: string;
}

export const RUN_KIND = 'aloud-protocol-eval';

export interface RunMeta {
    startedAt: string;
    finishedAt: string;
    gitSha: string | null;
    gitDirty: boolean | null;
    claudeVia: 'subscription' | 'api';
    runs: number;
    label?: string;
    /** Fixture ids selected for this invocation. */
    fixtures: string[];
    /** Roster ids in this file. */
    models: string[];
}

export interface RunEnvelope {
    kind: typeof RUN_KIND;
    version: 1;
    meta: RunMeta;
    trials: Trial[];
}

export const JUDGE_KIND = 'aloud-blind-judge';

/** What a Phase 2 judge said about one reply in a panel (judge.ts). */
export interface PanelReplyVerdict {
    /** The words the judge read: the spoken text. */
    spoken: string;
    /** Control signals the app acted on, in plain words ("a silence bid"). */
    signals: string[];
    /** Binary dimensions failed, with the reply's words. quoteFound: the quote
     *  is in the reply as written (a judge can misquote). */
    fails: Array<{ dim: string; quote: string; quoteFound: boolean }>;
    /** 1 to 5 per scale dimension on this turn. */
    scores: Record<string, number>;
    note?: string;
}

/** One fixture's blind comparison. Model ids are roster ids. A Phase 2 panel
 *  (judge.ts) fills the optional panel fields as well and keeps winner, worst,
 *  rationale and gateFails filled for readers of the older shape. */
export interface JudgeVerdictRecord {
    fixture: string;
    /** Every model whose replies the judge compared. */
    models: string[];
    /** The blind letters as shown to the judge: letter -> model id. */
    key?: Record<string, string>;
    /** A model id, or 'tie'. */
    winner: string;
    /** Three-way and up: the model ranked last, or 'none'. */
    worst?: string;
    margin?: 'slight' | 'clear';
    rationale: string;
    /** Models the judge says broke a hard rule (rubric.md gates). */
    gateFails?: string[];
    /** Rubric scores per model, for a judge that scores instead of ranking. */
    scores?: Record<string, number>;
    /** promptHash of the trials the judge read, per model. */
    promptHashes?: Record<string, string>;
    /** The run index judged: a panel is one fixture at one run index. */
    run?: number;
    /** What the blind order was shuffled from (judge-core.ts seededOrder). */
    seed?: string;
    /** The rubric dimensions judged on this turn. */
    dims?: string[];
    /** Hash of the judge's instructions for this turn, built from rubric.md
     *  (judge-core.ts judgeInstructions): a rubric edit makes it stale. */
    rubricHash?: string;
    /** Judged although a reply was not measured at today's prompt (--allow-stale). */
    staleInputs?: boolean;
    /** Models from the judge's own family in this panel. */
    sameFamily?: string[];
    /** Per model id. */
    replies?: Record<string, PanelReplyVerdict>;
    /** Model ids, best first. */
    ranking?: string[];
    decided?: { top?: { dim: string; why: string }; bottom?: { dim: string; why: string } };
    /** The judge's answer could not be used, after one retry. */
    error?: string;
    warnings?: string[];
    attempts?: number;
    latencyMs?: number;
    usage?: TrialUsage;
    /** At list price, API judges only. */
    costUsd?: number;
}

export interface JudgeFile {
    kind: typeof JUDGE_KIND;
    version: 1;
    meta: {
        startedAt: string;
        /** Provider-native id, or 'unrecorded' for a hand-made verdict-/key-
         *  pair whose sweep has no blind-judge.json. */
        judgeModel: string;
        judgeVia?: Via;
        label?: string;
        /** What the judge was told to grade against, e.g. "rubric.md@<sha>". */
        rubric?: string;
        gitSha?: string | null;
        /** How many runs per model the judge read for each fixture. */
        runsPerModel?: number;
        /** The provider spec the judge ran under (judge.ts --judge). */
        judgeSpec?: string;
        /** sha256 of rubric.md when this file was last written. */
        rubricFileHash?: string;
    };
    verdicts: JudgeVerdictRecord[];
}

export interface SweepFile {
    path: string;
    meta: RunMeta | null;
    trials: Trial[];
}

export interface Sweep {
    dir: string;
    name: string;
    /** YYYY-MM-DD: the earliest run start, else a date in the name, else mtime. */
    date: string;
    files: SweepFile[];
    /** handMade: read from a verdict-/key- pair. */
    judges: Array<{ path: string; file: JudgeFile; handMade: boolean }>;
}

function isObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isTrialLike(v: unknown): v is Trial {
    return (
        isObject(v) &&
        typeof v['model'] === 'string' &&
        typeof v['fixture'] === 'string' &&
        Array.isArray(v['checks'])
    );
}

/** Older trials call the description `probe`. */
function withDescription(t: Trial): Trial {
    const { probe, ...rest } = t as Trial & { probe?: string };
    return probe === undefined ? t : { ...rest, description: rest.description ?? probe };
}

/** A run file in either format; null when the JSON is something else. */
export function parseRunFile(json: unknown): { meta: RunMeta | null; trials: Trial[] } | null {
    if (Array.isArray(json)) {
        return json.length > 0 && json.every(isTrialLike) ? { meta: null, trials: json.map(withDescription) } : null;
    }
    if (isObject(json) && json['kind'] === RUN_KIND && Array.isArray(json['trials'])) {
        const trials = json['trials'].filter(isTrialLike).map(withDescription);
        return { meta: (json['meta'] as RunMeta | undefined) ?? null, trials };
    }
    return null;
}

export function parseJudgeFile(json: unknown): JudgeFile | null {
    if (isObject(json) && json['kind'] === JUDGE_KIND && Array.isArray(json['verdicts'])) {
        return json as unknown as JudgeFile;
    }
    return null;
}

interface LegacyVerdict {
    fixture: string;
    winner: string;
    worst?: string;
    margin?: string;
    reason?: string;
    gateFails?: string[];
}

/** A hand-made verdict-/key- pair (the 2026-11-14 Ollama trial) as a JudgeFile. */
export function legacyJudgeFile(
    label: string,
    date: string,
    verdicts: unknown,
    key: unknown,
    judgeModel = 'unrecorded'
): JudgeFile | null {
    if (!Array.isArray(verdicts) || !isObject(key)) return null;
    const out: JudgeVerdictRecord[] = [];
    for (const v of verdicts as LegacyVerdict[]) {
        const letters = key[v.fixture];
        if (!isObject(letters)) continue;
        const map = Object.fromEntries(
            Object.entries(letters).filter((e): e is [string, string] => typeof e[1] === 'string')
        );
        const who = (letter: string | undefined): string | undefined =>
            letter === undefined ? undefined : (map[letter] ?? letter);
        out.push({
            fixture: v.fixture,
            models: Object.values(map),
            key: map,
            winner: v.winner === 'tie' ? 'tie' : (who(v.winner) ?? 'tie'),
            ...(v.worst !== undefined && { worst: v.worst === 'none' ? 'none' : (who(v.worst) ?? 'none') }),
            ...((v.margin === 'slight' || v.margin === 'clear') && { margin: v.margin }),
            rationale: v.reason ?? '',
            gateFails: (v.gateFails ?? []).map((l) => who(l) ?? l),
        });
    }
    return {
        kind: JUDGE_KIND,
        version: 1,
        meta: { startedAt: date, judgeModel, label },
        verdicts: out,
    };
}

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
        return undefined;
    }
}

export function readSweep(dir: string): Sweep {
    const name = basename(dir);
    const entries = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
    const files: SweepFile[] = [];
    const judges: Sweep['judges'] = [];
    const legacyVerdicts: string[] = [];
    for (const f of entries) {
        if (/^verdict-.+\.json$/.test(f)) {
            legacyVerdicts.push(f);
            continue;
        }
        if (/^key-.+\.json$/.test(f) || f === 'blind-judge.json') continue;
        const path = join(dir, f);
        const json = readJson(path);
        const judge = parseJudgeFile(json);
        if (judge) {
            judges.push({ path, file: judge, handMade: false });
            continue;
        }
        const run = parseRunFile(json);
        if (run) files.push({ path, ...run });
    }
    const starts = files.map((f) => f.meta?.startedAt).filter((s): s is string => !!s).sort();
    const date =
        starts[0]?.slice(0, 10) ??
        /\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ??
        statSync(dir).mtime.toISOString().slice(0, 10);
    const named = readJson(join(dir, 'blind-judge.json'));
    const handJudge = isObject(named) && typeof named['judgeModel'] === 'string' ? named['judgeModel'] : undefined;
    for (const f of legacyVerdicts) {
        const label = f.slice('verdict-'.length, -'.json'.length);
        const keyPath = join(dir, `key-${label}.json`);
        if (!existsSync(keyPath)) continue;
        const judge = legacyJudgeFile(label, date, readJson(join(dir, f)), readJson(keyPath), handJudge);
        if (judge) judges.push({ path: join(dir, f), file: judge, handMade: true });
    }
    return { dir, name, date, files, judges };
}

/** Every sweep directory under `resultsDir`, oldest first. */
export function readSweeps(resultsDir: string): Sweep[] {
    if (!existsSync(resultsDir)) return [];
    return readdirSync(resultsDir)
        .map((d) => join(resultsDir, d))
        .filter((p) => statSync(p).isDirectory())
        .map(readSweep)
        .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
}

/** `existing` with every (fixture, run) cell in `fresh` replaced by it. */
export function mergeTrials(existing: readonly Trial[], fresh: readonly Trial[]): Trial[] {
    const cell = (t: Trial) => `${t.fixture}\u0000${t.run}`;
    const replaced = new Set(fresh.map(cell));
    return [...existing.filter((t) => !replaced.has(cell(t))), ...fresh];
}

/** The file name a model's trials live under in a sweep directory. */
export function modelFileName(modelId: string): string {
    return `${modelId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

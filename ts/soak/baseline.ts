/**
 * Comparing a run against an earlier one, which is what turns "here are some
 * numbers" into "here is what changed".
 *
 * Sessions are matched by (scenario, facilitator model) and averaged across the
 * run's repeats, so `--sessions=2` compares like with like. What comes out is
 * deliberately asymmetric: a check that NEWLY fails is the headline, a check
 * that stopped failing is worth saying, and a judge score is a soft signal shown
 * only when it moves more than noise.
 *
 * That last threshold is the honest part. One session per scenario is a single
 * sample of a stochastic model; a 0.5 swing means nothing. JUDGE_DELTA_MIN is
 * set where a drop is worth a look rather than where it is proof, and the report
 * says so rather than pretending a number is a verdict.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionReport } from './types.js';
import type { RunMeta } from './report.js';

/**
 * Judge movement below this is noise at realistic sample sizes.
 *
 * Calibrated against the harness itself rather than guessed: two `smoke` runs of
 * IDENTICAL code, one session per scenario, moved a scenario 9.0 → 8.0. A
 * threshold of 1.0 flagged that as a regression, which is exactly the false
 * positive that trains someone to stop reading the section. 1.5 is set above the
 * observed same-code jitter at one sample; more samples shrink the jitter, which
 * is why the report tells you to use --sessions=2+ before believing a move.
 */
export const JUDGE_DELTA_MIN = 1.5;

export interface BaselineRun {
    dir: string;
    meta: RunMeta;
    reports: SessionReport[];
}

/** One scenario+model cell, averaged over that cell's sessions. */
interface Cell {
    sessions: number;
    /** Check ids seen at `fail` level in any session of this cell. */
    fails: Set<string>;
    judge: number | null;
    wince: number;
}

export interface BaselineDiff {
    /** Cells present in both runs, so the comparison is meaningful. */
    compared: number;
    /** Cells in one run but not the other (scenario list changed). */
    onlyNow: string[];
    onlyBefore: string[];
    newFails: Array<{ cell: string; checkId: string }>;
    fixedFails: Array<{ cell: string; checkId: string }>;
    judgeMoves: Array<{ cell: string; before: number; after: number }>;
    /** Average judge across compared cells, or null when either side is unjudged. */
    judgeBefore: number | null;
    judgeAfter: number | null;
    winceBefore: number;
    winceAfter: number;
}

export function loadBaseline(dir: string): BaselineRun {
    let raw: string;
    try {
        raw = readFileSync(join(dir, 'run.json'), 'utf8');
    } catch (err) {
        throw new Error(
            `Could not read a baseline run from "${dir}" (${err instanceof Error ? err.message : String(err)}). ` +
                'Pass --baseline=<a previous ts/soak-runs/ directory>, or --baseline=last for the most recent one.'
        );
    }
    const parsed = JSON.parse(raw) as { meta: RunMeta; reports: SessionReport[] };
    if (!Array.isArray(parsed.reports)) throw new Error(`"${dir}/run.json" has no reports array.`);
    return { dir, meta: parsed.meta, reports: parsed.reports };
}

function cellKey(r: SessionReport): string {
    return `${r.result.scenario.id} · ${r.result.facilitatorModel}`;
}

function toCells(reports: SessionReport[]): Map<string, Cell> {
    const cells = new Map<string, Cell>();
    for (const r of reports) {
        const key = cellKey(r);
        const cell = cells.get(key) ?? { sessions: 0, fails: new Set<string>(), judge: null, wince: 0 };
        cell.sessions++;
        for (const f of r.findings) if (f.level === 'fail') cell.fails.add(f.id);
        if (r.judge) cell.judge = (cell.judge ?? 0) + r.judge.overall;
        cell.wince += r.judge?.winceMoments.length ?? 0;
        cells.set(key, cell);
    }
    // Fold the running judge total into a mean.
    for (const cell of cells.values()) {
        if (cell.judge !== null) cell.judge /= cell.sessions;
    }
    return cells;
}

export function diffAgainstBaseline(
    now: SessionReport[],
    before: SessionReport[]
): BaselineDiff {
    const a = toCells(before);
    const b = toCells(now);
    const shared = [...b.keys()].filter((k) => a.has(k)).sort();

    const diff: BaselineDiff = {
        compared: shared.length,
        onlyNow: [...b.keys()].filter((k) => !a.has(k)).sort(),
        onlyBefore: [...a.keys()].filter((k) => !b.has(k)).sort(),
        newFails: [],
        fixedFails: [],
        judgeMoves: [],
        judgeBefore: null,
        judgeAfter: null,
        winceBefore: 0,
        winceAfter: 0,
    };

    let judgedCells = 0;
    let sumBefore = 0;
    let sumAfter = 0;
    for (const key of shared) {
        const was = a.get(key) as Cell;
        const is = b.get(key) as Cell;
        for (const id of is.fails) if (!was.fails.has(id)) diff.newFails.push({ cell: key, checkId: id });
        for (const id of was.fails) if (!is.fails.has(id)) diff.fixedFails.push({ cell: key, checkId: id });
        diff.winceBefore += was.wince;
        diff.winceAfter += is.wince;
        if (was.judge !== null && is.judge !== null) {
            judgedCells++;
            sumBefore += was.judge;
            sumAfter += is.judge;
            if (Math.abs(is.judge - was.judge) >= JUDGE_DELTA_MIN) {
                diff.judgeMoves.push({ cell: key, before: was.judge, after: is.judge });
            }
        }
    }
    if (judgedCells > 0) {
        diff.judgeBefore = sumBefore / judgedCells;
        diff.judgeAfter = sumAfter / judgedCells;
    }
    // Worst drops first: that's the thing worth reading.
    diff.judgeMoves.sort((x, y) => x.after - x.before - (y.after - y.before));
    return diff;
}

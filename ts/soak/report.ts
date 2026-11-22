/**
 * Run output: one directory per soak run with the machine-readable data
 * (run.json, per-session JSON) and report.md - the thing you read when you come
 * back from the walk.
 *
 * report.md is ordered for a two-minute read, worst news first: a verdict line,
 * then what changed since the baseline, then the scoreboard, then every failure
 * grouped by check (not by session - the same broken thing across four sessions
 * is one problem, not four), then the judge's verbatim wince quotes, then how
 * far the judges themselves move and what the run's tokens cost. Transcripts
 * and per-session bookkeeping come last and collapsed. They're the thing you go
 * to once something above has told you where to look.
 *
 * The cast rides in the header, right next to the scores, because a scoreboard
 * without its judge named is not interpretable - and a casting collision
 * (roles.ts) is stamped louder still. With several judges each keeps its own
 * column: scores from different judge models are never averaged together.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CallUsage, CheckFinding, JudgeVerdict, LlmCallStat, SessionReport } from './types.js';
import { sameFamily, specOf, type RoleCollision } from './roles.js';
import type { BaselineDiff } from './baseline.js';
import { JUDGE_DELTA_MIN } from './baseline.js';
import { FACILITATOR_CALL_KINDS, cachedShare, totalUsage, type UsageTotals } from './usage.js';

/** A role as recorded in run.json: what was asked for, and what it resolved to. */
export interface CastEntry {
    spec: string;
    model: string;
}

/**
 * Which harness produced a run. Recorded because the two tiers share scenario
 * ids (`baseline`, `silence`) while measuring different things - one on a fake
 * clock with no audio, one in real time through a microphone - so comparing
 * across them silently produces a confident, meaningless delta.
 */
export type RunTier = 'headless' | 'browser';

export interface RunMeta {
    startedAt: string;
    tier: RunTier;
    /** Battery id, when the run came from a preset. */
    battery?: string;
    /** Every role's model. Never omitted: scores are meaningless without it. */
    cast: {
        facilitators: CastEntry[];
        user: CastEntry;
        utility: CastEntry;
        /** The first judge. */
        judge: CastEntry | null;
        /** Every judge, in order; the first is `judge`. */
        judges?: CastEntry[];
    };
    /** Casting problems that devalue the numbers. Normally empty. */
    collisions: RoleCollision[];
    wallClockMs: number;
    /** Baseline run directory, when this run was compared against one. */
    baselineDir?: string;
    /** Tier-2 runs describe their audio path here. */
    audio?: string;
    /** The commit the run's code came from, and whether the working tree had
     *  changes on top of it (untracked files included). */
    gitSha?: string;
    gitDirty?: boolean;
    /** Where the `anthropic` spec reached Claude (soak/providers.ts claudeVia). */
    claudeVia?: 'subscription' | 'api';
    /** How many times each judge scored each session. */
    judgeRepeats?: number;
}

/** Judge dimensions in reading order, with column headers for the scoreboard. */
const DIMENSIONS: ReadonlyArray<[key: string, header: string]> = [
    ['responsiveness', 'resp'],
    ['tone', 'tone'],
    ['brevity', 'brev'],
    ['silence_respect', 'silence'],
    ['no_meta_leaks', 'meta'],
    ['timer_handling', 'timer'],
    ['stepping_out', 'step-out'],
];

/** Marks a judge's score on a facilitator from its own family. */
const SAME_FAMILY = '†';
/** Marks usage that ran on the Claude subscription. */
const SUBSCRIPTION = '‡';

function fmtTime(at: number): string {
    const t = Math.round(at);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Filesystem/anchor-safe model tag. */
function modelSlug(model: string): string {
    return model.replace(/[^a-zA-Z0-9.-]+/g, '-');
}

function sessionSlug(r: SessionReport, multiModel: boolean): string {
    const base = `${r.result.scenario.id}-${r.result.runIndex + 1}`;
    return multiModel ? `${base}-${modelSlug(r.result.facilitatorModel)}` : base;
}

function isMultiModel(reports: SessionReport[]): boolean {
    return new Set(reports.map((r) => r.result.facilitatorModel)).size > 1;
}

const failCount = (r: SessionReport): number => r.findings.filter((f) => f.level === 'fail').length;
const warnCount = (r: SessionReport): number => r.findings.filter((f) => f.level === 'warn').length;
const winceCount = (r: SessionReport): number => r.judge?.winceMoments.length ?? 0;

const mean = (xs: readonly number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: readonly number[]): number => {
    const m = mean(xs);
    return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

// ---- Judges --------------------------------------------------------------

/** The run's judge models in cast order, plus any only the sessions name. */
function judgeModels(meta: RunMeta, reports: SessionReport[]): string[] {
    const order = (meta.cast.judges ?? (meta.cast.judge ? [meta.cast.judge] : [])).map((c) => c.model);
    for (const r of reports) {
        for (const j of r.judgeRuns ?? []) if (!order.includes(j.judgeModel)) order.push(j.judgeModel);
    }
    return order;
}

/** One judge's verdicts on one session. Runs from before judgeRuns carry the
 *  first judge's single verdict in `judge`. */
function verdictsBy(r: SessionReport, judgeModel: string, primary: string | undefined): JudgeVerdict[] {
    if (r.judgeRuns) return r.judgeRuns.filter((j) => j.judgeModel === judgeModel).map((j) => j.verdict);
    return r.judge && judgeModel === primary ? [r.judge] : [];
}

interface JudgeCell {
    mean: number;
    min: number;
    max: number;
    runs: number;
    sameFamily: boolean;
}

function judgeCell(r: SessionReport, judgeModel: string, primary: string | undefined): JudgeCell | null {
    const scores = verdictsBy(r, judgeModel, primary).map((v) => v.overall);
    if (scores.length === 0) return null;
    return {
        mean: mean(scores),
        min: Math.min(...scores),
        max: Math.max(...scores),
        runs: scores.length,
        sameFamily: sameFamily(judgeModel, r.result.facilitatorModel),
    };
}

function fmtCell(c: JudgeCell | null, err = false): string {
    if (!c) return err ? 'err' : '—';
    const spread = c.runs > 1 && c.max > c.min ? ` (${c.min}–${c.max})` : '';
    return `${c.mean.toFixed(1)}${spread}${c.sameFamily ? ` ${SAME_FAMILY}` : ''}`;
}

/** Column header for a judge: "judge" alone, else the model. */
function judgeHeader(judges: string[], model: string): string {
    return judges.length > 1 ? model : 'judge';
}

const SAME_FAMILY_NOTE = `_${SAME_FAMILY} the judge is from the facilitator's own family, so that score is partly self-evaluation._`;

function judgeFailed(r: SessionReport, judgeModel: string, primary: string | undefined): boolean {
    return (
        (r.judgeRunErrors ?? []).some((e) => e.judgeModel === judgeModel) ||
        (judgeModel === primary && r.judgeError !== undefined)
    );
}

// ---- Usage ---------------------------------------------------------------

/** Models whose calls went through the Claude CLI on the subscription. */
function subscriptionModels(meta: RunMeta): Set<string> {
    const cast = [
        ...meta.cast.facilitators,
        meta.cast.user,
        meta.cast.utility,
        ...(meta.cast.judges ?? (meta.cast.judge ? [meta.cast.judge] : [])),
    ];
    const out = new Set<string>();
    for (const c of cast) {
        const name = specOf(c.spec).split(':')[0];
        if (name === 'claude_proxy' || (name === 'anthropic' && meta.claudeVia === 'subscription')) out.add(c.model);
    }
    return out;
}

function fmtTokens(n: number): string {
    if (n < 1000) return String(n);
    return n < 1_000_000 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtUsd(x: number): string {
    return `$${x < 0.01 ? x.toFixed(4) : x.toFixed(2)}`;
}

/** Cells for one usage group: calls, fresh in, cache read, cache write, out,
 *  share from cache, cost (divided by `per` for a per-session figure). */
function usageCells(t: UsageTotals, per = 1): string[] {
    const calls = t.reported === t.calls ? String(t.calls) : `${t.calls} (${t.reported} reported)`;
    if (t.reported === 0) return [calls, 'not reported', '—', '—', '—', '—', '—'];
    const share = cachedShare(t);
    const cost =
        t.unpriced === t.reported ? 'no price' : `${fmtUsd(t.costUsd / per)}${t.unpriced > 0 ? ' + unpriced' : ''}`;
    return [
        calls,
        fmtTokens(t.inputTokens),
        fmtTokens(t.cacheReadTokens),
        fmtTokens(t.cacheCreationTokens),
        fmtTokens(t.outputTokens),
        share === null ? '—' : `${Math.round(share * 100)}%`,
        cost,
    ];
}

const facilitatorCalls = (r: SessionReport): LlmCallStat[] =>
    r.result.calls.filter((c) => FACILITATOR_CALL_KINDS.has(c.kind));

// ---- Sections ------------------------------------------------------------

function transcriptMd(r: SessionReport): string {
    const lines: string[] = [];
    let lastAt = 0;
    for (const t of r.result.transcript) {
        if (!t.text.trim()) continue; // signal-only turn (e.g. a bare [WAIT])
        const gap = t.at - lastAt;
        if (gap >= 120) lines.push(`> *… ${Math.round(gap / 60)} min of silence …*`);
        lastAt = t.at;
        const hold = t.duringHold ? ' *(during hold)*' : '';
        if (t.kind === 'event') {
            lines.push(`> \`${fmtTime(t.at)}\` *${t.text}*`);
        } else if (t.role === 'assistant') {
            const tag = t.kind === 'reply' || t.kind === 'opener' ? '' : ` *(${t.kind})*`;
            lines.push(`> \`${fmtTime(t.at)}\` **facilitator**${tag}${hold}: ${t.text}`);
        } else {
            const said = t.said !== undefined ? ` *(${t.cut ? 'cut from' : 'said'}: "${t.said}")*` : '';
            lines.push(`> \`${fmtTime(t.at)}\` **meditator**${hold}: ${t.text}${said}`);
        }
    }
    return lines.join('\n>\n');
}

function castLine(meta: RunMeta): string {
    const f = meta.cast.facilitators.map((c) => `\`${c.model}\``).join(' vs ');
    const judges = (meta.cast.judges ?? (meta.cast.judge ? [meta.cast.judge] : [])).map((c) => `\`${c.model}\``);
    const repeats = (meta.judgeRepeats ?? 1) > 1 ? ` (×${meta.judgeRepeats} each)` : '';
    return (
        `**Cast** — facilitator ${f} · meditator \`${meta.cast.user.model}\` · ` +
        `classifiers \`${meta.cast.utility.model}\` · judge ${judges.join(' + ') || '`off`'}${repeats}`
    );
}

/** Verdict + the numbers that decide whether to read further. */
function headline(meta: RunMeta, reports: SessionReport[]): string[] {
    const fails = reports.reduce((a, r) => a + failCount(r), 0);
    const warns = reports.reduce((a, r) => a + warnCount(r), 0);
    const failedSessions = reports.filter((r) => failCount(r) > 0).length;
    const wince = reports.reduce((a, r) => a + winceCount(r), 0);
    const judges = judgeModels(meta, reports);
    const primary = judges[0];

    const lines: string[] = ['# Soak report', ''];
    lines.push(
        fails > 0
            ? `## ❌ ${fails} check failure${fails === 1 ? '' : 's'} in ${failedSessions} of ${reports.length} session${reports.length === 1 ? '' : 's'}`
            : `## ✅ ${reports.length} session${reports.length === 1 ? '' : 's'}, no check failures`
    );
    lines.push('');
    const bits: string[] = [];
    const averages = judges.flatMap((j) => {
        const scores = reports.map((r) => judgeCell(r, j, primary)?.mean).filter((s): s is number => s !== undefined);
        if (scores.length === 0) return [];
        const range = `(${Math.min(...scores).toFixed(1)}–${Math.max(...scores).toFixed(1)})`;
        return [judges.length > 1 ? `\`${j}\` **${mean(scores).toFixed(1)}** ${range}` : `**${mean(scores).toFixed(1)}/10** average ${range}`];
    });
    if (averages.length > 0) bits.push(`Judge ${averages.join(' · ')}`);
    bits.push(`${wince} wince moment${wince === 1 ? '' : 's'}`);
    if (warns > 0) bits.push(`${warns} warning${warns === 1 ? '' : 's'}`);
    lines.push(bits.join(' · '), '');

    for (const collision of meta.collisions) {
        lines.push(
            `> ⚠️ **Casting caveat** — ${collision.detail}. Treat the judge column as indicative only.`,
            ''
        );
    }

    lines.push(castLine(meta), '');
    const context = [
        meta.battery ? `battery \`${meta.battery}\`` : null,
        `${reports.length} session${reports.length === 1 ? '' : 's'}`,
        `${Math.round(meta.wallClockMs / 1000)}s wall`,
        meta.audio ?? null,
        meta.gitSha ? `\`${meta.gitSha.slice(0, 8)}\`${meta.gitDirty ? ' + uncommitted changes' : ''}` : null,
        meta.startedAt,
    ].filter(Boolean);
    lines.push(context.join(' · '), '');
    return lines;
}

/** The checkout's commit and whether anything sits on top of it, for
 *  RunMeta; empty outside a git checkout. */
export function gitInfo(): Pick<RunMeta, 'gitSha' | 'gitDirty'> {
    const cwd = fileURLToPath(new URL('.', import.meta.url));
    try {
        const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
        return { gitSha: git('rev-parse', 'HEAD'), gitDirty: git('status', '--porcelain') !== '' };
    } catch {
        return {};
    }
}

/** Best guess at an older run's tier: runs predating the field are named for it. */
export function tierOfRunDir(dir: string, meta?: Partial<RunMeta>): RunTier {
    if (meta?.tier) return meta.tier;
    return /(^|\/)web-/.test(dir) ? 'browser' : 'headless';
}

function baselineSection(
    diff: BaselineDiff,
    baselineDir: string,
    tierMismatch: boolean
): string[] {
    const lines = ['## Changed since baseline', '', `Compared against \`${baselineDir}\`.`, ''];
    if (tierMismatch) {
        lines.push(
            '> ⚠️ **Different harness** — this baseline came from the other tier. The two share scenario ' +
                'ids but measure different things (fake clock and no audio vs real time through a microphone), ' +
                'so everything below is apples to oranges. Compare against a run from the same tier.',
            ''
        );
    }
    if (diff.compared === 0) {
        lines.push(
            '_No scenario+model cells in common, so nothing is comparable. Different scenarios or a different facilitator?_',
            ''
        );
        return lines;
    }

    const quiet =
        diff.newFails.length === 0 && diff.fixedFails.length === 0 && diff.judgeMoves.length === 0;
    if (quiet) {
        lines.push(
            `✅ No new check failures and no judge movement over ${JUDGE_DELTA_MIN.toFixed(1)} across ${diff.compared} cell(s).`,
            ''
        );
    }
    for (const f of diff.newFails) {
        lines.push(`- ❌ **new failure** \`${f.checkId}\` in ${f.cell}`);
    }
    for (const f of diff.fixedFails) {
        lines.push(`- ✅ **fixed** \`${f.checkId}\` in ${f.cell}`);
    }
    for (const m of diff.judgeMoves) {
        const drop = m.after < m.before;
        lines.push(
            `- ${drop ? '▼' : '▲'} judge ${m.before.toFixed(1)} → ${m.after.toFixed(1)} in ${m.cell}`
        );
    }
    if (!quiet) lines.push('');
    if (diff.judgeBefore !== null && diff.judgeAfter !== null) {
        lines.push(
            `Judge average across compared cells: ${diff.judgeBefore.toFixed(1)} → ${diff.judgeAfter.toFixed(1)}. ` +
                `Wince moments: ${diff.winceBefore} → ${diff.winceAfter}.`,
            ''
        );
    }
    lines.push(
        `_Judge scores are a single sample per session; movement under ${JUDGE_DELTA_MIN.toFixed(1)} is hidden as noise, ` +
            'and even a shown move is a place to look rather than a verdict. Check failures are mechanical and trustworthy._',
        ''
    );
    if (diff.onlyNow.length || diff.onlyBefore.length) {
        const parts: string[] = [];
        if (diff.onlyNow.length) parts.push(`only in this run: ${diff.onlyNow.join(', ')}`);
        if (diff.onlyBefore.length) parts.push(`only in the baseline: ${diff.onlyBefore.join(', ')}`);
        lines.push(`_Not compared — ${parts.join('; ')}._`, '');
    }
    return lines;
}

function modelRollup(meta: RunMeta, reports: SessionReport[]): string[] {
    const judges = judgeModels(meta, reports);
    const primary = judges[0];
    const byModel = new Map<string, SessionReport[]>();
    for (const r of reports) {
        const list = byModel.get(r.result.facilitatorModel) ?? [];
        list.push(r);
        byModel.set(r.result.facilitatorModel, list);
    }
    const judgeCols = judges.length > 1 ? judges : ['judge avg'];
    const lines = [
        '## Facilitator comparison',
        '',
        `| facilitator | sessions | ${judgeCols.join(' | ')} | fails | warns | wince |`,
        `|---|---|${judgeCols.map(() => '---').join('|')}|---|---|---|`,
    ];
    const rows = [...byModel.entries()].map(([model, rs]) => {
        const avgs = (judges.length ? judges : [undefined]).map((j) => {
            if (j === undefined) return null;
            const scores = rs.map((r) => judgeCell(r, j, primary)?.mean).filter((s): s is number => s !== undefined);
            return scores.length ? mean(scores) : null;
        });
        return { model, rs, avgs };
    });
    // Best first by the first judge: the answer this table exists to give.
    rows.sort((a, b) => (b.avgs[0] ?? -1) - (a.avgs[0] ?? -1));
    let marked = false;
    for (const { model, rs, avgs } of rows) {
        const cells = avgs.map((avg, i) => {
            if (avg === null) return '—';
            const same = judges[i] !== undefined && sameFamily(judges[i] as string, model);
            marked ||= same;
            return `${avg.toFixed(1)}${same ? ` ${SAME_FAMILY}` : ''}`;
        });
        lines.push(
            `| ${model} | ${rs.length} | ${cells.join(' | ')} | ${rs.reduce((a, r) => a + failCount(r), 0)} | ${rs.reduce((a, r) => a + warnCount(r), 0)} | ${rs.reduce((a, r) => a + winceCount(r), 0)} |`
        );
    }
    lines.push('', '_Comparable within this run only: same scenarios, same judges, and no judge sees a model\'s name. Each judge\'s column stands alone._');
    if (marked) lines.push('', SAME_FAMILY_NOTE);
    lines.push('');
    return lines;
}

function scoreboard(meta: RunMeta, reports: SessionReport[], multi: boolean): string[] {
    const judges = judgeModels(meta, reports);
    const primary = judges[0];
    const cols = judges.length ? judges : ['judge'];
    const dimHeaders = DIMENSIONS.map(([, h]) => h).join(' | ');
    const lines = [
        '## Scores',
        '',
        `| session |${multi ? ' facilitator |' : ''} ${cols.map((j) => judgeHeader(judges, j)).join(' | ')} | ${dimHeaders} | fails | warns | wince | ended by |`,
        `|---|${multi ? '---|' : ''}${cols.map(() => '---').join('|')}|${DIMENSIONS.map(() => '---').join('|')}|---|---|---|---|`,
    ];
    // Worst-scoring first, so the top of the table is where to look.
    const ordered = [...reports].sort((a, b) => {
        const byFail = failCount(b) - failCount(a);
        if (byFail !== 0) return byFail;
        const score = (r: SessionReport): number => (primary ? judgeCell(r, primary, primary)?.mean : undefined) ?? 99;
        return score(a) - score(b);
    });
    let marked = false;
    for (const r of ordered) {
        const dims = DIMENSIONS.map(([key]) => {
            const v = r.judge?.dimensions[key];
            return v === undefined || v === null ? '—' : String(v);
        }).join(' | ');
        const cells = judges.length
            ? judges.map((j) => {
                  const c = judgeCell(r, j, primary);
                  marked ||= c?.sameFamily === true;
                  return fmtCell(c, judgeFailed(r, j, primary));
              })
            : [r.judgeError ? 'err' : '—'];
        lines.push(
            `| ${sessionSlug(r, multi)} |${multi ? ` ${r.result.facilitatorModel} |` : ''} ${cells.join(' | ')} | ${dims} | ` +
                `${failCount(r) || '·'} | ${warnCount(r) || '·'} | ${winceCount(r) || '·'} | ${r.result.endedBy} |`
        );
    }
    lines.push('');
    if (judges.length > 1) lines.push(`_Dimensions are \`${primary}\`'s first verdict._`, '');
    if (marked) lines.push(SAME_FAMILY_NOTE, '');
    return lines;
}

/** How far one judge moves on the same transcript, and how far two judges sit
 *  apart: the noise floor a score movement has to clear. */
function judgeSpreadSection(meta: RunMeta, reports: SessionReport[], multi: boolean): string[] {
    const judges = judgeModels(meta, reports);
    const primary = judges[0];
    const repeated = reports.some((r) => judges.some((j) => (judgeCell(r, j, primary)?.runs ?? 0) > 1));
    if (!repeated && judges.length < 2) return [];
    const lines = ['## Judge spread', ''];
    if (repeated) {
        lines.push(
            '| judge | sessions | runs each | overall range, mean | widest | sd, mean |',
            '|---|---|---|---|---|---|'
        );
        const wide: string[] = [];
        for (const j of judges) {
            const sessions = reports
                .map((r) => ({ r, verdicts: verdictsBy(r, j, primary) }))
                .filter((s) => s.verdicts.length > 1);
            if (sessions.length === 0) continue;
            const ranges = sessions.map(({ verdicts }) => {
                const xs = verdicts.map((v) => v.overall);
                return Math.max(...xs) - Math.min(...xs);
            });
            const sds = sessions.map(({ verdicts }) => sd(verdicts.map((v) => v.overall)));
            const runs = [...new Set(sessions.map((s) => s.verdicts.length))].join('/');
            lines.push(
                `| ${j} | ${sessions.length} | ${runs} | ${mean(ranges).toFixed(1)} | ${Math.max(...ranges).toFixed(1)} | ${mean(sds).toFixed(2)} |`
            );
            for (const { r, verdicts } of sessions) {
                for (const [key, header] of DIMENSIONS) {
                    const xs = verdicts.map((v) => v.dimensions[key]).filter((v): v is number => typeof v === 'number');
                    if (xs.length > 1 && Math.max(...xs) - Math.min(...xs) >= 2) {
                        wide.push(`${header} ${Math.min(...xs)}–${Math.max(...xs)} (${j}, ${sessionSlug(r, multi)})`);
                    }
                }
            }
        }
        lines.push('');
        if (wide.length > 0) lines.push(`Dimensions that moved 2 or more on one transcript: ${wide.join('; ')}.`, '');
    }
    for (let i = 1; i < judges.length; i++) {
        const [a, b] = [primary as string, judges[i] as string];
        const pairs = reports
            .map((r) => [judgeCell(r, a, primary)?.mean, judgeCell(r, b, primary)?.mean] as const)
            .filter((p): p is readonly [number, number] => p[0] !== undefined && p[1] !== undefined);
        if (pairs.length === 0) continue;
        const gap = mean(pairs.map(([x, y]) => Math.abs(x - y)));
        const higher = pairs.filter(([x, y]) => y > x).length;
        lines.push(
            `\`${a}\` vs \`${b}\`: mean gap ${gap.toFixed(1)} over ${pairs.length} session${pairs.length === 1 ? '' : 's'}, \`${b}\` higher on ${higher}.`
        );
    }
    lines.push(
        '',
        '_A score movement smaller than one judge\'s own range on an unchanged transcript is noise. Judges are compared, never averaged together._',
        ''
    );
    return lines;
}

/** Every finding grouped by check id: one broken thing seen four times is one row. */
function findingsSection(reports: SessionReport[], multi: boolean): string[] {
    type Group = { level: CheckFinding['level']; sessions: string[]; first: string };
    const groups = new Map<string, Group>();
    for (const r of reports) {
        for (const f of r.findings) {
            if (f.level === 'info') continue; // context, not news; it stays in the session detail
            const group = groups.get(f.id) ?? { level: f.level, sessions: [], first: f.detail };
            group.sessions.push(sessionSlug(r, multi));
            // A fail anywhere outranks a warn elsewhere under the same id.
            if (f.level === 'fail' && group.level !== 'fail') {
                group.level = 'fail';
                group.first = f.detail;
            }
            groups.set(f.id, group);
        }
    }
    if (groups.size === 0) return [];
    const lines = ['## Failures and warnings', ''];
    const ordered = [...groups.entries()].sort((a, b) => {
        const rank = (l: CheckFinding['level']): number => (l === 'fail' ? 0 : 1);
        return rank(a[1].level) - rank(b[1].level) || b[1].sessions.length - a[1].sessions.length;
    });
    for (const [id, g] of ordered) {
        const icon = g.level === 'fail' ? '❌' : '⚠️';
        const times = g.sessions.length > 1 ? ` ×${g.sessions.length}` : '';
        lines.push(`- ${icon} \`${id}\`${times} — ${g.sessions.join(', ')}`);
        lines.push(`  <br>${g.first}`);
    }
    lines.push('');
    return lines;
}

/** The judges' verbatim quotes: the most actionable qualitative signal there
 *  is. One verdict per judge per session, so repeats do not repeat them. */
function winceSection(meta: RunMeta, reports: SessionReport[], multi: boolean): string[] {
    const judges = judgeModels(meta, reports);
    const primary = judges[0];
    const all = reports.flatMap((r) =>
        (judges.length ? judges : [undefined]).flatMap((j) => {
            const first = j === undefined ? r.judge : verdictsBy(r, j, primary)[0];
            const by = judges.length > 1 && j ? ` *(${j})*` : '';
            return (first?.winceMoments ?? []).map((w) => ({ session: `${sessionSlug(r, multi)}${by}`, ...w }));
        })
    );
    if (all.length === 0) return [];
    const lines = ['## Wince moments', ''];
    for (const w of all) {
        lines.push(`- **${w.session}** "${w.quote}"`);
        lines.push(`  <br>${w.why}`);
    }
    lines.push('');
    return lines;
}

/** Tokens and dollars: the facilitator per model, then what the harness
 *  itself spent. */
function usageSection(meta: RunMeta, reports: SessionReport[]): string[] {
    const allCalls = reports.flatMap((r) => r.result.calls);
    const judgeCalls = reports.flatMap((r) => (r.judgeRuns ?? []).map((j) => ({ ...j, model: j.judgeModel })));
    if (!allCalls.some((c) => c.model !== undefined) && judgeCalls.length === 0) return [];
    const sub = subscriptionModels(meta);
    const tag = (model: string): string => (sub.has(model) ? ` ${SUBSCRIPTION}` : '');
    const head = '| calls | fresh in | cache read | cache write | out | from cache |';

    const lines = [
        '## Tokens and cost',
        '',
        `| facilitator | sessions ${head} $ / session |`,
        '|---|---|---|---|---|---|---|---|---|',
    ];
    const byModel = new Map<string, SessionReport[]>();
    for (const r of reports) byModel.set(r.result.facilitatorModel, [...(byModel.get(r.result.facilitatorModel) ?? []), r]);
    for (const [model, rs] of byModel) {
        const t = totalUsage(rs.flatMap(facilitatorCalls));
        lines.push(`| ${model}${tag(model)} | ${rs.length} | ${usageCells(t, rs.length).join(' | ')} |`);
    }

    lines.push('', `| harness ${head} $ |`, '|---|---|---|---|---|---|---|---|');
    const harness: Array<[string, ReadonlyArray<CallUsage & { model?: string | undefined }>]> = [
        ['meditator', allCalls.filter((c) => c.kind === 'sim-user')],
        ['classifiers', allCalls.filter((c) => c.kind.startsWith('classify-'))],
        ['judge', judgeCalls],
    ];
    let total = 0;
    for (const [role, calls] of harness) {
        const models = [...new Set(calls.map((c) => c.model).filter((m): m is string => m !== undefined))];
        for (const model of models) {
            const t = totalUsage(calls.filter((c) => c.model === model));
            lines.push(`| ${role} ${model}${tag(model)} | ${usageCells(t).join(' | ')} |`);
            if (!sub.has(model)) total += t.costUsd;
        }
    }
    for (const model of byModel.keys()) {
        if (!sub.has(model)) total += totalUsage(reports.flatMap((r) => (r.result.facilitatorModel === model ? facilitatorCalls(r) : []))).costUsd;
    }
    lines.push(
        '',
        `Billed to API keys this run, at the hosted list price: about ${fmtUsd(total)}.`,
        '',
        '_Fake clock: a 30-minute sit runs in seconds here, so no cache entry lapses between turns; a real sit reads less from cache than these numbers._'
    );
    if (sub.size > 0) {
        lines.push(
            '',
            `_${SUBSCRIPTION} ran on the Claude subscription through the CLI: nothing billed, and each request carries the CLI's own preamble and caching, so its dollars are the API price of a different request than the app's._`
        );
    }
    lines.push('');
    return lines;
}

/** Extra markdown folded into a session's detail block. Tier 2 uses it for audio. */
export type ExtraSection = (report: SessionReport) => string[];

export function buildReportMd(
    meta: RunMeta,
    reports: SessionReport[],
    extra?: ExtraSection,
    diff?: BaselineDiff
): string {
    const multi = isMultiModel(reports);
    const lines: string[] = headline(meta, reports);

    if (diff && meta.baselineDir) {
        lines.push(
            ...baselineSection(
                diff,
                meta.baselineDir,
                tierOfRunDir(meta.baselineDir) !== meta.tier
            )
        );
    }
    if (multi) lines.push(...modelRollup(meta, reports));
    lines.push(...scoreboard(meta, reports, multi));
    lines.push(...findingsSection(reports, multi));
    lines.push(...winceSection(meta, reports, multi));
    lines.push(...judgeSpreadSection(meta, reports, multi));
    lines.push(...usageSection(meta, reports));

    lines.push(
        '## Session detail',
        '',
        '_Everything above, per session, plus the info-level context and the full transcript._',
        ''
    );
    const judges = judgeModels(meta, reports);
    for (const r of reports) {
        lines.push(`<details><summary><b>${sessionSlug(r, multi)}</b> — ${r.result.scenario.title}</summary>`, '');
        const ordered = [...r.findings].sort(
            (a, b) => ['fail', 'warn', 'info'].indexOf(a.level) - ['fail', 'warn', 'info'].indexOf(b.level)
        );
        if (ordered.length > 0) {
            lines.push('**Checks**', '');
            for (const f of ordered) {
                const icon = f.level === 'fail' ? '❌' : f.level === 'warn' ? '⚠️' : 'ℹ️';
                lines.push(`- ${icon} \`${f.id}\` ${f.detail}`);
            }
            lines.push('');
        }
        if (r.judge) {
            lines.push(`**Judge ${r.judge.overall.toFixed(1)}/10** — ${r.judge.notes}`, '');
        } else if (r.judgeError) {
            lines.push(`**Judge failed:** ${r.judgeError}`, '');
        }
        if ((r.judgeRuns?.length ?? 0) > 1) {
            const per = judges
                .map((j) => {
                    const xs = verdictsBy(r, j, judges[0]).map((v) => v.overall);
                    return xs.length ? `\`${j}\` ${xs.join(', ')}` : null;
                })
                .filter(Boolean);
            lines.push(`**Every verdict:** ${per.join(' · ')}`, '');
        }
        for (const e of r.judgeRunErrors ?? []) lines.push(`**Judge \`${e.judgeModel}\` failed:** ${e.error}`, '');
        const t = totalUsage(facilitatorCalls(r));
        if (t.calls > 0 && r.result.calls.some((c) => c.model !== undefined)) {
            const [calls, fresh, read, write, out, share, cost] = usageCells(t);
            lines.push(
                t.reported === 0
                    ? `**Facilitator tokens:** ${calls} calls, not reported`
                    : `**Facilitator tokens:** ${calls} calls · ${fresh} fresh in · ${read} cache read · ${write} cache write · ${out} out · ${share} from cache · ${cost}`,
                ''
            );
        }
        if (extra) lines.push(...extra(r));
        lines.push('**Transcript**', '', transcriptMd(r), '', '</details>', '');
    }
    return lines.join('\n');
}

export function writeRunReports(
    outDir: string,
    meta: RunMeta,
    reports: SessionReport[],
    extra?: ExtraSection,
    diff?: BaselineDiff
): void {
    mkdirSync(outDir, { recursive: true });
    const multi = isMultiModel(reports);
    writeFileSync(join(outDir, 'run.json'), JSON.stringify({ meta, reports }, null, 2));
    for (const r of reports) {
        writeFileSync(join(outDir, `session-${sessionSlug(r, multi)}.json`), JSON.stringify(r, null, 2));
    }
    writeFileSync(join(outDir, 'report.md'), buildReportMd(meta, reports, extra, diff));
}

/**
 * Run output: one directory per soak run with the machine-readable data
 * (run.json, per-session JSON) and report.md - the thing you read when you come
 * back from the walk.
 *
 * report.md is ordered for a two-minute read, worst news first: a verdict line,
 * then what changed since the baseline, then the scoreboard, then every failure
 * grouped by check (not by session - the same broken thing across four sessions
 * is one problem, not four), then the judge's verbatim wince quotes. Transcripts
 * and per-session bookkeeping come last and collapsed. They're the thing you go
 * to once something above has told you where to look.
 *
 * The cast rides in the header, right next to the scores, because a scoreboard
 * without its judge named is not interpretable - and a casting collision
 * (roles.ts) is stamped louder still.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckFinding, SessionReport } from './types.js';
import type { RoleCollision } from './roles.js';
import type { BaselineDiff } from './baseline.js';
import { JUDGE_DELTA_MIN } from './baseline.js';

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
        judge: CastEntry | null;
    };
    /** Casting problems that devalue the numbers. Normally empty. */
    collisions: RoleCollision[];
    wallClockMs: number;
    /** Baseline run directory, when this run was compared against one. */
    baselineDir?: string;
    /** Tier-2 runs describe their audio path here. */
    audio?: string;
}

/** Judge dimensions in reading order, with column headers for the scoreboard. */
const DIMENSIONS: ReadonlyArray<[key: string, header: string]> = [
    ['responsiveness', 'resp'],
    ['tone', 'tone'],
    ['brevity', 'brev'],
    ['silence_respect', 'silence'],
    ['no_meta_leaks', 'meta'],
    ['timer_handling', 'timer'],
];

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
            lines.push(`> \`${fmtTime(t.at)}\` **meditator**${hold}: ${t.text}`);
        }
    }
    return lines.join('\n>\n');
}

function castLine(meta: RunMeta): string {
    const f = meta.cast.facilitators.map((c) => `\`${c.model}\``).join(' vs ');
    return (
        `**Cast** — facilitator ${f} · meditator \`${meta.cast.user.model}\` · ` +
        `classifiers \`${meta.cast.utility.model}\` · judge \`${meta.cast.judge?.model ?? 'off'}\``
    );
}

/** Verdict + the numbers that decide whether to read further. */
function headline(meta: RunMeta, reports: SessionReport[]): string[] {
    const fails = reports.reduce((a, r) => a + failCount(r), 0);
    const warns = reports.reduce((a, r) => a + warnCount(r), 0);
    const failedSessions = reports.filter((r) => failCount(r) > 0).length;
    const judged = reports.filter((r) => r.judge);
    const scores = judged.map((r) => r.judge?.overall ?? 0);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
    const wince = reports.reduce((a, r) => a + winceCount(r), 0);

    const lines: string[] = ['# Soak report', ''];
    lines.push(
        fails > 0
            ? `## ❌ ${fails} check failure${fails === 1 ? '' : 's'} in ${failedSessions} of ${reports.length} session${reports.length === 1 ? '' : 's'}`
            : `## ✅ ${reports.length} session${reports.length === 1 ? '' : 's'}, no check failures`
    );
    lines.push('');
    const bits: string[] = [];
    if (avg !== null) {
        bits.push(
            `Judge **${avg.toFixed(1)}/10** average (${Math.min(...scores).toFixed(1)}–${Math.max(...scores).toFixed(1)})`
        );
    }
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
        meta.startedAt,
    ].filter(Boolean);
    lines.push(context.join(' · '), '');
    return lines;
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

function modelRollup(reports: SessionReport[]): string[] {
    const byModel = new Map<string, SessionReport[]>();
    for (const r of reports) {
        const list = byModel.get(r.result.facilitatorModel) ?? [];
        list.push(r);
        byModel.set(r.result.facilitatorModel, list);
    }
    const lines = [
        '## Facilitator comparison',
        '',
        '| facilitator | sessions | judge avg | fails | warns | wince |',
        '|---|---|---|---|---|---|',
    ];
    const rows = [...byModel.entries()].map(([model, rs]) => {
        const judged = rs.filter((r) => r.judge);
        const avg = judged.length
            ? judged.reduce((a, r) => a + (r.judge?.overall ?? 0), 0) / judged.length
            : null;
        return { model, rs, avg };
    });
    // Best first: the answer this table exists to give.
    rows.sort((a, b) => (b.avg ?? -1) - (a.avg ?? -1));
    for (const { model, rs, avg } of rows) {
        lines.push(
            `| ${model} | ${rs.length} | ${avg === null ? '—' : avg.toFixed(1)} | ${rs.reduce((a, r) => a + failCount(r), 0)} | ${rs.reduce((a, r) => a + warnCount(r), 0)} | ${rs.reduce((a, r) => a + winceCount(r), 0)} |`
        );
    }
    lines.push('', '_Comparable within this run only: same scenarios, same judge, and the judge never sees a model\'s name._', '');
    return lines;
}

function scoreboard(reports: SessionReport[], multi: boolean): string[] {
    const dimHeaders = DIMENSIONS.map(([, h]) => h).join(' | ');
    const lines = [
        '## Scores',
        '',
        `| session |${multi ? ' facilitator |' : ''} judge | ${dimHeaders} | fails | warns | wince | ended by |`,
        `|---|${multi ? '---|' : ''}---|${DIMENSIONS.map(() => '---').join('|')}|---|---|---|---|`,
    ];
    // Worst-scoring first, so the top of the table is where to look.
    const ordered = [...reports].sort((a, b) => {
        const byFail = failCount(b) - failCount(a);
        if (byFail !== 0) return byFail;
        return (a.judge?.overall ?? 99) - (b.judge?.overall ?? 99);
    });
    for (const r of ordered) {
        const dims = DIMENSIONS.map(([key]) => {
            const v = r.judge?.dimensions[key];
            return v === undefined || v === null ? '—' : String(v);
        }).join(' | ');
        const judge = r.judge ? r.judge.overall.toFixed(1) : r.judgeError ? 'err' : '—';
        lines.push(
            `| ${sessionSlug(r, multi)} |${multi ? ` ${r.result.facilitatorModel} |` : ''} ${judge} | ${dims} | ` +
                `${failCount(r) || '·'} | ${warnCount(r) || '·'} | ${winceCount(r) || '·'} | ${r.result.endedBy} |`
        );
    }
    lines.push('');
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
            if (f.level === 'fail') group.level = 'fail';
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

/** The judge's verbatim quotes: the most actionable qualitative signal there is. */
function winceSection(reports: SessionReport[], multi: boolean): string[] {
    const all = reports.flatMap((r) =>
        (r.judge?.winceMoments ?? []).map((w) => ({ session: sessionSlug(r, multi), ...w }))
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
    if (multi) lines.push(...modelRollup(reports));
    lines.push(...scoreboard(reports, multi));
    lines.push(...findingsSection(reports, multi));
    lines.push(...winceSection(reports, multi));

    lines.push(
        '## Session detail',
        '',
        '_Everything above, per session, plus the info-level context and the full transcript._',
        ''
    );
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

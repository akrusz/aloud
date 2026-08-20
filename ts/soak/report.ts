/**
 * Run output: one directory per soak run with the full machine-readable data
 * (run.json, per-session JSON) and a human report.md - the thing you read
 * when you come back from the walk.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionReport } from './types.js';

export interface RunMeta {
    startedAt: string;
    /** Resolved as "spec (model)" so the report names what actually ran. */
    facilitatorSpecs: string[];
    userSpec: string;
    utilitySpec: string;
    judgeSpec: string | null;
    wallClockMs: number;
}

function fmtTime(at: number): string {
    const t = Math.round(at);
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Filesystem/anchor-safe model tag. */
function modelSlug(model: string): string {
    return model.replace(/[^a-zA-Z0-9.-]+/g, '-');
}

/** Unique per session; includes the model only when several are compared. */
function sessionSlug(r: SessionReport, multiModel: boolean): string {
    const base = `${r.result.scenario.id}-${r.result.runIndex + 1}`;
    return multiModel ? `${base}-${modelSlug(r.result.facilitatorModel)}` : base;
}

function isMultiModel(reports: SessionReport[]): boolean {
    return new Set(reports.map((r) => r.result.facilitatorModel)).size > 1;
}

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

export function buildReportMd(meta: RunMeta, reports: SessionReport[]): string {
    const failCount = (r: SessionReport): number => r.findings.filter((f) => f.level === 'fail').length;
    const warnCount = (r: SessionReport): number => r.findings.filter((f) => f.level === 'warn').length;

    const multi = isMultiModel(reports);
    const lines: string[] = [
        '# Soak run report',
        '',
        `- Started: ${meta.startedAt}`,
        `- Facilitator${meta.facilitatorSpecs.length > 1 ? 's' : ''}: ${meta.facilitatorSpecs.map((f) => `\`${f}\``).join(', ')} · sim user: \`${meta.userSpec}\` · utility: \`${meta.utilitySpec}\` · judge: \`${meta.judgeSpec ?? 'off'}\``,
        `- Wall time: ${Math.round(meta.wallClockMs / 1000)}s for ${reports.length} session(s)`,
        '',
    ];
    if (multi) {
        // Model comparison first: same scenarios, same (blind) judge, so the
        // scores are comparable across rows WITHIN this run.
        lines.push('## Facilitator comparison', '', '| facilitator | sessions | fails | warns | judge avg | wince total |', '|---|---|---|---|---|---|');
        const byModel = new Map<string, SessionReport[]>();
        for (const r of reports) {
            const list = byModel.get(r.result.facilitatorModel) ?? [];
            list.push(r);
            byModel.set(r.result.facilitatorModel, list);
        }
        for (const [model, rs] of byModel) {
            const judged = rs.filter((r) => r.judge);
            const avg = judged.length
                ? (judged.reduce((a, r) => a + (r.judge?.overall ?? 0), 0) / judged.length).toFixed(1)
                : '—';
            lines.push(
                `| ${model} | ${rs.length} | ${rs.reduce((a, r) => a + failCount(r), 0)} | ${rs.reduce((a, r) => a + warnCount(r), 0)} | ${avg} | ${rs.reduce((a, r) => a + (r.judge?.winceMoments.length ?? 0), 0)} |`
            );
        }
        lines.push('');
    }
    lines.push(
        `| session | ${multi ? 'facilitator | ' : ''}sim min | user turns | ended by | fails | warns | judge | wince |`,
        `|---|${multi ? '---|' : ''}---|---|---|---|---|---|---|`
    );
    for (const r of reports) {
        const userTurns = r.result.transcript.filter((t) => t.role === 'user' && t.kind === 'user').length;
        lines.push(
            `| ${r.result.scenario.id}-${r.result.runIndex + 1} | ${multi ? `${r.result.facilitatorModel} | ` : ''}${Math.round(r.result.fakeDurationSec / 60)} | ${userTurns} | ${r.result.endedBy} | ${failCount(r)} | ${warnCount(r)} | ${r.judge ? r.judge.overall.toFixed(1) : r.judgeError ? 'err' : '—'} | ${r.judge?.winceMoments.length ?? '—'} |`
        );
    }
    lines.push('');

    for (const r of reports) {
        lines.push(`## ${sessionSlug(r, multi)} — ${r.result.scenario.title}`, '');
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
            const dims = Object.entries(r.judge.dimensions)
                .map(([k, v]) => `${k} ${v === null ? 'n/a' : v}`)
                .join(' · ');
            lines.push(`**Judge: ${r.judge.overall.toFixed(1)}/10** (${dims})`, '', r.judge.notes, '');
            if (r.judge.winceMoments.length > 0) {
                lines.push('Wince moments:', '');
                for (const w of r.judge.winceMoments) {
                    lines.push(`- "${w.quote}" — ${w.why}`);
                }
                lines.push('');
            }
        } else if (r.judgeError) {
            lines.push(`**Judge failed:** ${r.judgeError}`, '');
        }
        lines.push('<details><summary>Transcript</summary>', '', transcriptMd(r), '', '</details>', '');
    }
    return lines.join('\n');
}

export function writeRunReports(outDir: string, meta: RunMeta, reports: SessionReport[]): void {
    mkdirSync(outDir, { recursive: true });
    const multi = isMultiModel(reports);
    writeFileSync(join(outDir, 'run.json'), JSON.stringify({ meta, reports }, null, 2));
    for (const r of reports) {
        writeFileSync(join(outDir, `session-${sessionSlug(r, multi)}.json`), JSON.stringify(r, null, 2));
    }
    writeFileSync(join(outDir, 'report.md'), buildReportMd(meta, reports));
}

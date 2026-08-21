/**
 * Soak CLI (tier 1): run the scenario matrix with an LLM meditator against the
 * real engine, then score every session (checks + judge) and write a report.
 *
 *   npm run soak -- --battery=pre-release          # the walk-away check
 *   npm run soak -- --battery=smoke --baseline=last
 *   npm run soak -- --battery=models               # facilitator comparison
 *   npm run soak                                   # all scenarios, defaults
 *   npm run soak -- --scenarios=silence,timer-hold --sessions=2
 *   npm run soak -- --facilitator=ollama:qwen3 --no-judge
 *   npm run soak -- --list | --list-batteries
 *
 * Keys come from the environment or ts/server/.env. Exit code 1 when any
 * deterministic check fails, so it can gate a release script.
 */

import { parseArgs } from 'node:util';
import { readdirSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit } from 'node:process';

import { loadServerEnv } from './env.js';
import { LlmSimUser } from './sim-user.js';
import { runSoakSession } from './orchestrator.js';
import { runChecks } from './checks.js';
import { judgeSession } from './judge.js';
import { getScenarios, SCENARIOS } from './scenarios.js';
import { writeRunReports, tierOfRunDir, type RunMeta } from './report.js';
import { BATTERIES, DEFAULT_ROLES, getBattery } from './batteries.js';
import { describeRoles, findRoleCollisions, resolveRoles, type ResolvedRole } from './roles.js';
import { diffAgainstBaseline, loadBaseline } from './baseline.js';
import type { Scenario, SessionReport } from './types.js';

const RUNS_DIR = fileURLToPath(new URL('../soak-runs', import.meta.url));

interface Job {
    scenario: Scenario;
    runIndex: number;
    facilitator: ResolvedRole;
}

async function pool<T>(jobs: (() => Promise<T>)[], size: number): Promise<T[]> {
    const results: T[] = new Array(jobs.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(size, jobs.length)) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= jobs.length) return;
            results[i] = await (jobs[i] as () => Promise<T>)();
        }
    });
    await Promise.all(workers);
    return results;
}

/** The most recent HEADLESS run directory, for --baseline=last. Tier-2 runs are
 *  skipped: they share scenario ids with this matrix but measure something else,
 *  so picking one up automatically would produce a confident, meaningless diff. */
function latestRunDir(excluding: string): string {
    let entries: string[];
    try {
        entries = readdirSync(RUNS_DIR, { withFileTypes: true })
            .filter((e) => e.isDirectory())
            .map((e) => join(RUNS_DIR, e.name))
            .filter((d) => resolvePath(d) !== resolvePath(excluding))
            .filter((d) => tierOfRunDir(d) === 'headless')
            .sort();
    } catch {
        entries = [];
    }
    const last = entries[entries.length - 1];
    if (!last) {
        throw new Error(
            '--baseline=last found no earlier tier-1 run in ts/soak-runs/. Run a soak first, ' +
                'or point --baseline at a directory.'
        );
    }
    return last;
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            battery: { type: 'string' },
            scenarios: { type: 'string' },
            sessions: { type: 'string' },
            facilitator: { type: 'string' },
            user: { type: 'string' },
            utility: { type: 'string' },
            judge: { type: 'string' },
            'no-judge': { type: 'boolean', default: false },
            baseline: { type: 'string' },
            concurrency: { type: 'string' },
            out: { type: 'string' },
            list: { type: 'boolean', default: false },
            'list-batteries': { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
        allowPositionals: false,
    });

    if (values.help) {
        console.log(`Usage: npm run soak -- [options]

Batteries are pre-set casts + scenario lists, so a release check is one word.
Individual flags override whatever the battery set.

Options:
  --battery=<id>          run a named battery (see --list-batteries)
  --baseline=<dir|last>   compare against an earlier run; the report leads with
                          what changed
  --scenarios=<a,b|all>   which scenarios to run (see --list)
  --sessions=<n>          runs per scenario
  --facilitator=<a,b>     provider[:model] under test; a comma list compares
                          models head-to-head
  --user=<spec>           the simulated meditator
  --utility=<spec>        the silence classifiers
  --judge=<spec>          judge model; --no-judge to skip
  --concurrency=<n>       parallel sessions
  --out=<dir>             output directory (default: ts/soak-runs/<timestamp>)
  --list                  list scenarios and exit
  --list-batteries        list batteries and exit

Defaults: facilitator ${DEFAULT_ROLES.facilitators.join(',')} · meditator ${DEFAULT_ROLES.user} · classifiers ${DEFAULT_ROLES.utility} · judge ${DEFAULT_ROLES.judge}
The judge is deliberately a different family from the facilitator - a model
scoring its own transcripts inflates its own row (soak/roles.ts).`);
        return;
    }
    if (values['list-batteries']) {
        for (const b of BATTERIES) {
            const scenarios = b.scenarios === 'all' ? 'all scenarios' : b.scenarios.join(',');
            console.log(
                `${b.id.padEnd(13)} ${b.description}\n${' '.repeat(14)}${scenarios}, ${b.sessions} session(s) each; judge ${b.roles.judge ?? 'off'}`
            );
        }
        return;
    }
    if (values.list) {
        for (const s of SCENARIOS) {
            console.log(
                `${s.id.padEnd(12)} ${s.title} (${s.fakeMinutes} sim min, persona: ${s.persona.id})`
            );
        }
        return;
    }

    loadServerEnv();
    const battery = values.battery ? getBattery(values.battery) : null;
    const base = battery?.roles ?? DEFAULT_ROLES;

    // Explicit flags beat the battery, which beats the defaults.
    const roles = resolveRoles({
        facilitators: values.facilitator
            ? values.facilitator.split(',').map((f) => f.trim()).filter(Boolean)
            : base.facilitators,
        user: values.user ?? base.user,
        utility: values.utility ?? base.utility,
        judge: values['no-judge'] ? null : (values.judge ?? base.judge),
    });
    const collisions = findRoleCollisions(roles);

    const scenarioArg = values.scenarios ?? battery?.scenarios ?? 'all';
    const scenarios = getScenarios(
        scenarioArg === 'all'
            ? 'all'
            : (Array.isArray(scenarioArg) ? scenarioArg : scenarioArg.split(','))
                  .map((s) => s.trim())
                  .filter(Boolean)
    );
    const sessions = Math.max(
        1,
        Number.parseInt(values.sessions ?? '', 10) || battery?.sessions || 1
    );
    const concurrency = Math.max(
        1,
        Number.parseInt(values.concurrency ?? '', 10) || battery?.concurrency || 2
    );

    const startedAt = new Date();
    const outDir =
        values.out ??
        join(RUNS_DIR, startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19));
    const baselineDir = values.baseline
        ? values.baseline === 'last'
            ? latestRunDir(outDir)
            : values.baseline
        : null;
    // Fail before spending money if the baseline can't be read.
    const baseline = baselineDir ? loadBaseline(baselineDir) : null;

    const jobs: Job[] = roles.facilitators.flatMap((facilitator) =>
        scenarios.flatMap((scenario) =>
            Array.from({ length: sessions }, (_, runIndex) => ({ scenario, runIndex, facilitator }))
        )
    );
    console.log(
        `Soak: ${jobs.length} session(s) across ${scenarios.length} scenario(s)` +
            (battery ? `, battery ${battery.id}` : '') +
            `, concurrency ${concurrency}.\n${describeRoles(roles)}` +
            (baseline ? `\nBaseline: ${baseline.dir}` : '') +
            `\nOutput: ${outDir}\n`
    );
    for (const collision of collisions) {
        console.warn(
            `⚠️  Casting collision: ${collision.detail}.\n` +
                '   The run continues and the report stamps this next to the scores, but the judge column is indicative only.\n'
        );
    }

    const t0 = Date.now();
    const reports = await pool<SessionReport>(
        jobs.map(({ scenario, runIndex, facilitator }) => async () => {
            const parts = [scenario.id];
            if (roles.facilitators.length > 1) parts.push(facilitator.model);
            if (sessions > 1) parts.push(`#${runIndex + 1}`);
            const tag = parts.join(' ');
            const log = (line: string): void => console.log(`[${tag}] ${line}`);
            log(`starting (${scenario.fakeMinutes} sim min, persona ${scenario.persona.id})`);
            const result = await runSoakSession({
                scenario,
                runIndex,
                facilitator: facilitator.provider,
                utility: roles.utility.provider,
                simUser: new LlmSimUser(roles.user.provider, scenario.persona),
                log,
            });
            const findings = runChecks(result);
            const report: SessionReport = { result, findings };
            if (roles.judge) {
                try {
                    report.judge = await judgeSession(roles.judge.provider, result);
                } catch (err) {
                    report.judgeError = err instanceof Error ? err.message : String(err);
                }
            }
            const fails = findings.filter((f) => f.level === 'fail').length;
            const warns = findings.filter((f) => f.level === 'warn').length;
            log(
                `done: ended by ${result.endedBy}, ${fails} fail / ${warns} warn` +
                    (report.judge ? `, judge ${report.judge.overall.toFixed(1)}/10` : '')
            );
            return report;
        }),
        concurrency
    );

    const entry = (r: ResolvedRole) => ({ spec: r.spec, model: r.model });
    const meta: RunMeta = {
        startedAt: startedAt.toISOString(),
        tier: 'headless',
        ...(battery ? { battery: battery.id } : {}),
        cast: {
            facilitators: roles.facilitators.map(entry),
            user: entry(roles.user),
            utility: entry(roles.utility),
            judge: roles.judge ? entry(roles.judge) : null,
        },
        collisions,
        wallClockMs: Date.now() - t0,
        ...(baseline ? { baselineDir: baseline.dir } : {}),
    };
    const diff = baseline ? diffAgainstBaseline(reports, baseline.reports) : undefined;
    writeRunReports(outDir, meta, reports, undefined, diff);

    const totalFails = reports.flatMap((r) => r.findings).filter((f) => f.level === 'fail').length;
    const totalWarns = reports.flatMap((r) => r.findings).filter((f) => f.level === 'warn').length;
    const judged = reports.filter((r) => r.judge);
    const avg =
        judged.length > 0
            ? (judged.reduce((a, r) => a + (r.judge?.overall ?? 0), 0) / judged.length).toFixed(1)
            : null;
    console.log(
        `\nDone in ${Math.round(meta.wallClockMs / 1000)}s: ${totalFails} check fail(s), ${totalWarns} warn(s)` +
            (avg !== null ? `, judge average ${avg}/10` : '') +
            '.'
    );
    if (diff) {
        console.log(
            diff.newFails.length > 0
                ? `Regressions vs baseline: ${diff.newFails.map((f) => `${f.checkId} (${f.cell})`).join(', ')}`
                : 'No new check failures vs baseline.'
        );
    }
    console.log(`Report: ${join(outDir, 'report.md')}`);
    if (totalFails > 0) exit(1);
}

main().catch((err) => {
    console.error('soak failed:', err instanceof Error ? err.message : err);
    exit(1);
});

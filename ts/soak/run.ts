/**
 * Soak CLI: run the scenario matrix with an LLM meditator against the real
 * engine, then score every session (checks + judge) and write a report.
 *
 *   npm run soak                          # all scenarios, defaults
 *   npm run soak -- --scenarios=silence,timer-hold --sessions=2
 *   npm run soak -- --facilitator=anthropic:claude-haiku-4-5 --no-judge
 *   npm run soak -- --list
 *
 * Keys come from the environment or ts/server/.env. Exit code 1 when any
 * deterministic check fails, so it can gate a release script.
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit } from 'node:process';

import { loadServerEnv } from './env.js';
import { buildProviderFromSpec } from './providers.js';
import { LlmSimUser } from './sim-user.js';
import { runSoakSession } from './orchestrator.js';
import { runChecks } from './checks.js';
import { judgeSession } from './judge.js';
import { getScenarios, SCENARIOS } from './scenarios.js';
import { writeRunReports, type RunMeta } from './report.js';
import type { Scenario, SessionReport } from './types.js';

const DEFAULTS = {
    facilitator: 'anthropic',
    user: 'anthropic:claude-haiku-4-5',
    utility: 'anthropic:claude-haiku-4-5',
    judge: 'anthropic',
};

interface Job {
    scenario: Scenario;
    runIndex: number;
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

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            scenarios: { type: 'string', default: 'all' },
            sessions: { type: 'string', default: '1' },
            facilitator: { type: 'string', default: DEFAULTS.facilitator },
            user: { type: 'string', default: DEFAULTS.user },
            utility: { type: 'string', default: DEFAULTS.utility },
            judge: { type: 'string', default: DEFAULTS.judge },
            'no-judge': { type: 'boolean', default: false },
            concurrency: { type: 'string', default: '2' },
            out: { type: 'string' },
            list: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
        allowPositionals: false,
    });

    if (values.help) {
        console.log(`Usage: npm run soak -- [options]

Options:
  --scenarios=<a,b|all>   which scenarios to run (default: all; see --list)
  --sessions=<n>          runs per scenario (default: 1)
  --facilitator=<spec>    provider[:model] under test (default: ${DEFAULTS.facilitator})
  --user=<spec>           simulated meditator (default: ${DEFAULTS.user})
  --utility=<spec>        silence classifiers (default: ${DEFAULTS.utility})
  --judge=<spec>          judge model (default: ${DEFAULTS.judge}); --no-judge to skip
  --concurrency=<n>       parallel sessions (default: 2)
  --out=<dir>             output directory (default: ts/soak-runs/<timestamp>)
  --list                  list scenarios and exit`);
        return;
    }
    if (values.list) {
        for (const s of SCENARIOS) {
            console.log(`${s.id.padEnd(12)} ${s.title} (${s.fakeMinutes} sim min, persona: ${s.persona.id})`);
        }
        return;
    }

    loadServerEnv();
    const scenarios = getScenarios(
        values.scenarios === 'all' ? 'all' : (values.scenarios ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    );
    const sessions = Math.max(1, Number.parseInt(values.sessions ?? '1', 10) || 1);
    const concurrency = Math.max(1, Number.parseInt(values.concurrency ?? '2', 10) || 1);
    const judgeSpec = values['no-judge'] ? null : (values.judge as string);

    const facilitator = buildProviderFromSpec(values.facilitator as string);
    const utility = buildProviderFromSpec(values.utility as string);
    const userProvider = buildProviderFromSpec(values.user as string);
    const judgeProvider = judgeSpec ? buildProviderFromSpec(judgeSpec) : null;

    const startedAt = new Date();
    const outDir =
        values.out ??
        join(
            fileURLToPath(new URL('..', import.meta.url)),
            'soak-runs',
            startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)
        );

    const jobs: Job[] = scenarios.flatMap((scenario) =>
        Array.from({ length: sessions }, (_, runIndex) => ({ scenario, runIndex }))
    );
    console.log(
        `Soak: ${jobs.length} session(s) across ${scenarios.length} scenario(s), facilitator ${facilitator.model}, concurrency ${concurrency}.\nOutput: ${outDir}\n`
    );

    const t0 = Date.now();
    const reports = await pool<SessionReport>(
        jobs.map(({ scenario, runIndex }) => async () => {
            const tag = sessions > 1 ? `${scenario.id}#${runIndex + 1}` : scenario.id;
            const log = (line: string): void => console.log(`[${tag}] ${line}`);
            log(`starting (${scenario.fakeMinutes} sim min, persona ${scenario.persona.id})`);
            const result = await runSoakSession({
                scenario,
                runIndex,
                facilitator,
                utility,
                simUser: new LlmSimUser(userProvider, scenario.persona),
                log,
            });
            const findings = runChecks(result);
            const report: SessionReport = { result, findings };
            if (judgeProvider) {
                try {
                    report.judge = await judgeSession(judgeProvider, result);
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

    const meta: RunMeta = {
        startedAt: startedAt.toISOString(),
        facilitatorSpec: values.facilitator as string,
        userSpec: values.user as string,
        utilitySpec: values.utility as string,
        judgeSpec,
        wallClockMs: Date.now() - t0,
    };
    writeRunReports(outDir, meta, reports);

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
            `.\nReport: ${join(outDir, 'report.md')}`
    );
    if (totalFails > 0) exit(1);
}

main().catch((err) => {
    console.error('soak failed:', err instanceof Error ? err.message : err);
    exit(1);
});

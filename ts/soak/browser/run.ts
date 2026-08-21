/**
 * Tier-2 soak CLI: whole sessions through the real web UI, with the simulated
 * meditator speaking out loud into a virtual microphone.
 *
 *   npm run soak:web                                  # the whole matrix
 *   npm run soak:web -- --list
 *   npm run soak:web -- --scenarios=silence,mute
 *   npm run soak:web -- --voice=openai:sage --facilitator=anthropic
 *   npm run soak:web -- --scenarios=baseline --no-judge --keep-open
 *
 * Prerequisites (dev-docs/soak-harness.md): `npm run web:dev` running, BlackHole
 * installed (and the Mac restarted since), Google Chrome installed. Sessions run
 * ONE at a time and in real time - there is one pair of default audio devices,
 * and the run owns them for its duration.
 */

import { parseArgs } from 'node:util';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit } from 'node:process';

import { loadServerEnv } from '../env.js';
import { buildProviderFromSpec } from '../providers.js';
import { LlmSimUser } from '../sim-user.js';
import { runChecks } from '../checks.js';
import { judgeSession } from '../judge.js';
import { writeRunReports, type RunMeta } from '../report.js';
import type { SessionReport } from '../types.js';

import { routeThroughLoopback, LOOPBACK_DEVICE } from './audio.js';
import { launchSession } from './driver.js';
import { runWebSoakSession } from './orchestrator.js';
import { runAudioChecks } from './checks.js';
import { configForScenario, getWebScenarios, WEB_SCENARIOS } from './scenarios.js';
import { buildSimVoice } from './voice.js';
import type { WebSessionRunResult } from './types.js';

const DEFAULTS = {
    facilitator: 'anthropic',
    user: 'anthropic:claude-haiku-4-5',
    judge: 'anthropic',
    voice: 'say',
    stt: 'web-speech',
    url: 'http://localhost:4649/',
};

/** BYOK provider names the app can take a key for straight from the env. */
const KEY_VARS: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    openrouter: 'OPENROUTER_API_KEY',
    venice: 'VENICE_API_KEY',
    groq: 'GROQ_API_KEY',
};

function audioSection(result: WebSessionRunResult): string[] {
    if (result.spoken.length === 0) return [];
    const lines = [
        `**Audio round trip** (voice \`${result.voiceId}\` → \`${result.sttEngine}\`)`,
        '',
        '| at | said | heard | WER |',
        '|---|---|---|---|',
    ];
    for (const s of result.spoken) {
        const t = Math.round(s.at);
        const at = `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
        const heard = s.echoDropped
            ? '*(dropped as echo)*'
            : s.heard === null
              ? '*(nothing)*'
              : s.heard.replace(/\|/g, '\\|');
        lines.push(
            `| \`${at}\` | ${s.said.replace(/\|/g, '\\|')} | ${heard} | ${s.wer === null ? '—' : `${Math.round(s.wer * 100)}%`} |`
        );
    }
    lines.push('');
    return lines;
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            scenarios: { type: 'string', default: 'all' },
            facilitator: { type: 'string', default: DEFAULTS.facilitator },
            user: { type: 'string', default: DEFAULTS.user },
            judge: { type: 'string', default: DEFAULTS.judge },
            'no-judge': { type: 'boolean', default: false },
            voice: { type: 'string', default: DEFAULTS.voice },
            stt: { type: 'string', default: DEFAULTS.stt },
            url: { type: 'string', default: DEFAULTS.url },
            device: { type: 'string', default: LOOPBACK_DEVICE },
            headless: { type: 'boolean', default: false },
            'keep-open': { type: 'boolean', default: false },
            'no-audio-routing': { type: 'boolean', default: false },
            out: { type: 'string' },
            list: { type: 'boolean', default: false },
            help: { type: 'boolean', default: false },
        },
        allowPositionals: false,
    });

    if (values.help) {
        console.log(`Usage: npm run soak:web -- [options]

Tier 2: the simulated meditator speaks aloud into a virtual mic and the real web
UI answers. Requires \`npm run web:dev\`, BlackHole, and Google Chrome.

Options:
  --scenarios=<a,b|all>   which scenarios to run (default: all; see --list)
  --facilitator=<spec>    provider[:model] the app uses (default: ${DEFAULTS.facilitator})
  --user=<spec>           simulated meditator (default: ${DEFAULTS.user})
  --judge=<spec>          judge model (default: ${DEFAULTS.judge}); --no-judge to skip
  --voice=<spec>          sim user's voice: say[:Name[@rate]], openai[:voice], silent
  --stt=<engine>          recognizer under test (default: ${DEFAULTS.stt})
  --url=<url>             where the dev UI is served (default: ${DEFAULTS.url})
  --device=<name>         loopback audio device (default: ${LOOPBACK_DEVICE})
  --no-audio-routing      don't touch the system's default devices
  --headless              run Chrome headless (Web Speech is unreliable there)
  --keep-open             leave the browser open after each session
  --out=<dir>             output directory (default: ts/soak-runs/web-<timestamp>)
  --list                  list scenarios and exit`);
        return;
    }
    if (values.list) {
        for (const s of WEB_SCENARIOS) {
            console.log(
                `${s.id.padEnd(12)} ${s.title} (${s.realMinutes} real min, persona: ${s.persona.id})`
            );
        }
        return;
    }

    loadServerEnv();
    const scenarios = getWebScenarios(
        values.scenarios === 'all'
            ? 'all'
            : (values.scenarios ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    );
    const judgeSpec = values['no-judge'] ? null : (values.judge as string);
    const judgeProvider = judgeSpec ? buildProviderFromSpec(judgeSpec) : null;
    const userProvider = buildProviderFromSpec(values.user as string);
    // Resolved only to name the model in the report and to fail early on a
    // missing key: the PAGE builds the real provider from the seeded settings.
    const facilitatorSpec = values.facilitator as string;
    const facilitator = buildProviderFromSpec(facilitatorSpec);
    const facilitatorName = facilitatorSpec.split(':')[0] as string;
    const apiKeys: Record<string, string> = {};
    const keyVar = KEY_VARS[facilitatorName];
    if (keyVar) {
        const key = process.env[keyVar];
        if (!key) throw new Error(`${keyVar} is required for --facilitator=${facilitatorName}`);
        apiKeys[facilitatorName] = key;
    }

    const voice = buildSimVoice(values.voice as string);
    const startedAt = new Date();
    const outDir =
        values.out ??
        join(
            fileURLToPath(new URL('../..', import.meta.url)),
            'soak-runs',
            `web-${startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
        );

    const totalMin = scenarios.reduce((a, s) => a + s.realMinutes, 0);
    console.log(
        `Soak (tier 2, browser): ${scenarios.length} session(s), ~${totalMin} min of real time.\n` +
            `Facilitator ${facilitator.model} · voice ${voice.id} · recognizer ${values.stt}.\n` +
            `This run OWNS the machine's audio in and out - don't play anything else.\nOutput: ${outDir}\n`
    );

    const routing = values['no-audio-routing']
        ? null
        : await routeThroughLoopback(values.device as string);

    const t0 = Date.now();
    const reports: SessionReport[] = [];
    try {
        for (const scenario of scenarios) {
            const tag = scenario.id;
            const log = (line: string): void => console.log(`[${tag}] ${line}`);
            log(`starting (${scenario.realMinutes} real min, persona ${scenario.persona.id})`);
            const { setup, appSettings } = configForScenario(scenario, {
                provider: facilitatorName,
                model: facilitator.model,
                sttEngine: values.stt as string,
            });
            // A fresh profile per session: a stale one carries a granted
            // permission AND whatever the previous session left in localStorage.
            const userDataDir = mkdtempSync(join(tmpdir(), 'aloud-soak-chrome-'));
            let result: WebSessionRunResult;
            try {
                const driver = await launchSession({
                    baseUrl: values.url as string,
                    userDataDir,
                    setup,
                    appSettings,
                    apiKeys,
                    micLabel: values.device as string,
                    headless: values.headless as boolean,
                    log,
                });
                try {
                    result = await runWebSoakSession({
                        scenario,
                        driver,
                        voice,
                        simUser: new LlmSimUser(userProvider, scenario.persona),
                        facilitatorModel: facilitator.model,
                        sttEngine: values.stt as string,
                        log,
                    });
                } finally {
                    if (!values['keep-open']) await driver.close();
                }
            } finally {
                // Also on a failed launch: a bad run shouldn't leave a Chrome
                // profile behind on every attempt.
                if (!values['keep-open']) rmSync(userDataDir, { recursive: true, force: true });
            }

            const findings = [...runChecks(result), ...runAudioChecks(result)];
            const report: SessionReport = { result, findings };
            if (judgeProvider) {
                try {
                    report.judge = await judgeSession(judgeProvider, result);
                } catch (err) {
                    report.judgeError = err instanceof Error ? err.message : String(err);
                }
            }
            reports.push(report);
            const fails = findings.filter((f) => f.level === 'fail').length;
            const warns = findings.filter((f) => f.level === 'warn').length;
            log(
                `done: ended by ${result.endedBy}, ${fails} fail / ${warns} warn` +
                    (report.judge ? `, judge ${report.judge.overall.toFixed(1)}/10` : '')
            );
        }
    } finally {
        await voice.close();
        await routing?.restore();
    }

    const meta: RunMeta = {
        startedAt: startedAt.toISOString(),
        facilitatorSpecs: [`${facilitatorSpec} (${facilitator.model})`],
        userSpec: `${values.user} (${userProvider.model})`,
        // Tier 2's classifiers run in the page, on the facilitator's provider.
        utilitySpec: `in-page (${facilitator.model})`,
        judgeSpec: judgeSpec && judgeProvider ? `${judgeSpec} (${judgeProvider.model})` : null,
        wallClockMs: Date.now() - t0,
    };
    writeRunReports(outDir, meta, reports, (r) => audioSection(r.result as WebSessionRunResult));

    const totalFails = reports.flatMap((r) => r.findings).filter((f) => f.level === 'fail').length;
    const totalWarns = reports.flatMap((r) => r.findings).filter((f) => f.level === 'warn').length;
    console.log(
        `\nDone in ${Math.round(meta.wallClockMs / 1000)}s: ${totalFails} check fail(s), ${totalWarns} warn(s).\n` +
            `Report: ${join(outDir, 'report.md')}`
    );
    if (totalFails > 0) exit(1);
}

main().catch((err) => {
    console.error('soak:web failed:', err instanceof Error ? err.message : err);
    exit(1);
});

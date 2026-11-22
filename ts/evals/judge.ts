/**
 * Phase 2: the blind quality judge. For each fixture and run index, every
 * model's reply goes to a judge as one shuffled, lettered panel with the
 * fixture's context and the rubric sections it exercises (judge-core.ts). The
 * verdicts land in judge-<judge model>.json in the sweep (records.ts).
 *
 *   npm run evals:judge -- --sweep 2026-11-22-roster
 *   npm run evals:judge -- --latest --judge anthropic:claude-opus-5-5 --judge openai:gpt-6.2-astra --every 3
 *   npm run evals:judge -- --sweep ollama-tiers-2026-11-14 --every 3 --allow-stale
 *
 * The default judge, anthropic:claude-opus-5-5, runs on your subscription
 * (soak/providers.ts scriptClaude, effort low) and costs nothing; any other
 * spec is buildProviderFromSpec's. Rerunning merges by panel; --resume skips
 * panels already judged at the same prompt and rubric hashes.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LLMProvider, Message } from '../src/llm/index.js';
import { loadServerEnv } from '../soak/env.js';
import { buildProviderFromSpec, claudeVia } from '../soak/providers.js';
import { callCostUsd } from './cost.js';
import { FIXTURES, type Fixture } from './fixtures.js';
import {
    buildPanel,
    errorRecord,
    familyOfModelId,
    isCurrentVerdict,
    judgeInstructions,
    panelPrompt,
    parseVerdict,
    retryPrompt,
    toRecord,
    type Instructions,
    type Panel,
} from './judge-core.js';
import { ROSTER } from './models.js';
import { promptHashFor } from './prompt.js';
import {
    JUDGE_KIND,
    parseJudgeFile,
    readSweep,
    readSweeps,
    type JudgeFile,
    type JudgeVerdictRecord,
    type Trial,
    type TrialUsage,
    type Via,
} from './records.js';
import { loadRubric } from './rubric.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(HERE, 'results');
const DEFAULT_JUDGE = 'anthropic:claude-opus-5-5';
/** Room for a ten-reply panel's JSON plus an always-on reasoner's thinking. */
const JUDGE_MAX_TOKENS = 8000;

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function parseArgs(argv: string[]) {
    const all = (flag: string): string[] =>
        argv.flatMap((a, i) => (a === flag && argv[i + 1] !== undefined ? [argv[i + 1] as string] : []));
    const get = (flag: string): string | undefined => all(flag)[0];
    const every = Number(get('--every') ?? 1);
    const concurrency = Number(get('--concurrency') ?? 3);
    if (!Number.isInteger(every) || every < 1) fail('--every takes a whole number of at least 1.');
    if (!Number.isInteger(concurrency) || concurrency < 1) fail('--concurrency takes a whole number of at least 1.');
    const sweep = get('--sweep');
    const latest = argv.includes('--latest');
    if (!sweep === !latest) fail('Pick what to judge: --sweep <name|path>, or --latest (the newest reply per model at today\'s prompt).');
    return {
        sweep,
        latest,
        judges: all('--judge').length ? all('--judge') : [DEFAULT_JUDGE],
        every,
        concurrency,
        fixtures: get('--fixtures')?.split(',').filter(Boolean),
        models: get('--models')?.split(',').filter(Boolean),
        resume: argv.includes('--resume'),
        allowStale: argv.includes('--allow-stale'),
        dryRun: argv.includes('--dry-run'),
    };
}

function viaOf(spec: string): Via {
    const name = spec.split(':')[0] ?? '';
    if (name === 'anthropic') return claudeVia();
    if (name === 'claude_proxy') return 'subscription';
    if (name === 'ollama') return 'local';
    return 'api';
}

function priceProvider(spec: string): string {
    const name = spec.split(':')[0] ?? '';
    return name === 'anthropic_api' ? 'anthropic' : name;
}

function git(args: string[]): string | null {
    try {
        return execFileSync('git', args, { cwd: HERE, encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

/** Trials by `${model}|${fixture}|${run}`: from one sweep, or the newest
 *  across every sweep. A later file or sweep replaces an earlier one. */
function collectTrials(sweepDir: string | null): Map<string, Trial> {
    const sweeps = sweepDir ? [readSweep(sweepDir)] : readSweeps(RESULTS_DIR);
    const out = new Map<string, Trial>();
    for (const s of sweeps) {
        const files = [...s.files].sort((a, b) => (a.meta?.startedAt ?? '').localeCompare(b.meta?.startedAt ?? ''));
        for (const f of files) for (const t of f.trials) out.set(`${t.model}|${t.fixture}|${t.run}`, t);
    }
    return out;
}

function readJudgeFile(path: string): JudgeFile | null {
    if (!existsSync(path)) return null;
    try {
        return parseJudgeFile(JSON.parse(readFileSync(path, 'utf8')));
    } catch {
        return null;
    }
}

const panelKey = (v: { fixture: string; run?: number }) => `${v.fixture}#${v.run ?? 0}`;

async function pool(tasks: Array<() => Promise<void>>, size: number): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < tasks.length) await (tasks[next++] as () => Promise<void>)();
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(size, tasks.length)) }, worker));
}

function addUsage(into: TrialUsage | undefined, more: TrialUsage): TrialUsage {
    const sum = (a: number | null | undefined, b: number | null) => (a === null || a === undefined ? b : b === null ? a : a + b);
    return {
        inputTokens: sum(into?.inputTokens, more.inputTokens),
        outputTokens: sum(into?.outputTokens, more.outputTokens),
        cacheReadTokens: sum(into?.cacheReadTokens, more.cacheReadTokens),
        cacheCreationTokens: sum(into?.cacheCreationTokens, more.cacheCreationTokens),
    };
}

async function judgePanel(
    provider: LLMProvider,
    spec: string,
    via: Via,
    panel: Panel,
    ins: Instructions,
    staleInputs: boolean,
    sameFamily: string[]
): Promise<JudgeVerdictRecord> {
    const messages: Message[] = [{ role: 'user', content: panelPrompt(panel) }];
    const started = performance.now();
    let usage: TrialUsage | undefined;
    let cost = 0;
    let priced = false;
    let lastErrors: string[] = [];
    for (let attempt = 1; attempt <= 2; attempt++) {
        let text: string;
        try {
            const r = await provider.complete(messages, { system: ins.system, maxTokens: JUDGE_MAX_TOKENS });
            text = r.text;
            const u: TrialUsage = {
                inputTokens: r.inputTokens ?? null,
                outputTokens: r.outputTokens ?? null,
                cacheReadTokens: r.cacheReadTokens ?? null,
                cacheCreationTokens: r.cacheCreationTokens ?? null,
            };
            usage = addUsage(usage, u);
            const c = via === 'api' ? callCostUsd(priceProvider(spec), provider.model, u) : null;
            if (c !== null) {
                cost += c;
                priced = true;
            }
        } catch (err) {
            lastErrors = [`the call failed: ${err instanceof Error ? err.message : String(err)}`];
            continue;
        }
        const parsed = parseVerdict(text, panel, ins);
        if (parsed.verdict) {
            return toRecord(panel, ins, parsed.verdict, {
                ...(staleInputs && { staleInputs }),
                ...(sameFamily.length && { sameFamily }),
                ...(parsed.warnings.length && { warnings: parsed.warnings }),
                attempts: attempt,
                latencyMs: Math.round(performance.now() - started),
                ...(usage && { usage }),
                ...(priced && { costUsd: cost }),
            });
        }
        lastErrors = parsed.errors;
        messages.push({ role: 'assistant', content: text }, { role: 'user', content: retryPrompt(parsed.errors) });
    }
    return {
        ...errorRecord(panel, ins, lastErrors.join('; '), {
            attempts: 2,
            latencyMs: Math.round(performance.now() - started),
            ...(staleInputs && { staleInputs }),
        }),
        ...(usage && { usage }),
        ...(priced && { costUsd: cost }),
    };
}

async function main() {
    loadServerEnv();
    const opts = parseArgs(process.argv.slice(2));
    const rubric = loadRubric();
    const sweepDir = opts.sweep
        ? opts.sweep.includes('/')
            ? resolve(opts.sweep)
            : join(RESULTS_DIR, opts.sweep)
        : null;
    if (sweepDir && !existsSync(sweepDir)) fail(`No sweep at ${sweepDir}.`);
    const targetDir = sweepDir ?? join(RESULTS_DIR, `${new Date().toISOString().slice(0, 10)}-judged`);
    const trials = collectTrials(sweepDir);
    const fixtures: Fixture[] = opts.fixtures
        ? FIXTURES.filter((f) => opts.fixtures?.some((p) => f.id.startsWith(p)))
        : FIXTURES;
    if (fixtures.length === 0) fail(`No fixture id starts with ${opts.fixtures?.join(' or ')}.`);
    const currentHash = new Map(fixtures.map((f) => [f.id, promptHashFor(f)]));
    const modelFilter = opts.models ? new Set(opts.models) : null;

    // Panels: one per fixture and run index, every model that replied.
    const byPanel = new Map<string, { fx: Fixture; run: number; trials: Trial[]; stale: boolean }>();
    let staleSkipped = 0;
    for (const t of trials.values()) {
        const fx = fixtures.find((f) => f.id === t.fixture);
        if (!fx || (modelFilter && !modelFilter.has(t.model)) || t.run % opts.every !== 0) continue;
        const stale = t.promptHash !== currentHash.get(fx.id);
        if (stale && !opts.allowStale) {
            staleSkipped++;
            continue;
        }
        const key = `${fx.id}#${t.run}`;
        const p = byPanel.get(key) ?? { fx, run: t.run, trials: [], stale: false };
        p.trials.push(t);
        p.stale ||= stale;
        byPanel.set(key, p);
    }
    const order = (k: string) => fixtures.findIndex((f) => k.startsWith(`${f.id}#`));
    const panels = [...byPanel.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[1].run - b[1].run);
    console.log(
        `${panels.length} panels from ${sweepDir ?? 'the newest reply per model across sweeps'}` +
            (staleSkipped ? `; ${staleSkipped} replies left out as measured at an older prompt (--allow-stale to judge them)` : '') +
            (opts.allowStale ? '; stale replies judged and labelled' : '')
    );

    const startedAt = new Date().toISOString();
    let spent = 0;
    const tasks: Array<() => Promise<void>> = [];
    const writers: Array<() => void> = [];
    for (const spec of opts.judges) {
        const provider = buildProviderFromSpec(spec);
        const judgeModel = provider.model;
        const via = viaOf(spec);
        const judgeFamily = familyOfModelId(judgeModel);
        const path = join(targetDir, `judge-${judgeModel.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
        const existing = readJudgeFile(path);
        const verdicts = new Map((existing?.verdicts ?? []).map((v) => [panelKey(v), v]));
        const file: JudgeFile = {
            kind: JUDGE_KIND,
            version: 1,
            meta: {
                startedAt: existing?.meta.startedAt ?? startedAt,
                judgeModel,
                judgeVia: via,
                judgeSpec: spec,
                rubricFileHash: rubric.fileHash,
                gitSha: git(['rev-parse', '--short=10', 'HEAD']),
            },
            verdicts: [],
        };
        const save = () => {
            if (verdicts.size === 0) return;
            mkdirSync(targetDir, { recursive: true });
            file.verdicts = [...verdicts.values()].sort((a, b) => panelKey(a).localeCompare(panelKey(b)));
            writeFileSync(path, JSON.stringify(file, null, 2) + '\n');
        };
        writers.push(save);
        let skipped = 0;
        let queued = 0;
        for (const [key, p] of panels) {
            const panel = buildPanel(p.fx, p.run, p.trials, judgeModel);
            if (panel.replies.length < 2) continue;
            const ins = judgeInstructions(rubric, p.fx);
            const have = verdicts.get(key);
            if (opts.resume && have && isCurrentVerdict(have, panel, ins.hash)) {
                skipped++;
                continue;
            }
            const sameFamily = panel.replies
                .filter((r) => familyOfModelId(ROSTER.find((m) => m.id === r.model)?.model ?? r.model) === judgeFamily)
                .map((r) => r.model);
            queued++;
            if (opts.dryRun) {
                if (queued === 1) {
                    console.log(`\n--- ${judgeModel}: first panel (${key}), system ---\n${ins.system}\n--- user ---\n${panelPrompt(panel)}\n`);
                }
                continue;
            }
            tasks.push(async () => {
                const record = await judgePanel(provider, spec, via, panel, ins, p.stale, sameFamily);
                verdicts.set(key, record);
                spent += record.costUsd ?? 0;
                save();
                const status = record.error
                    ? `ERROR ${record.error.slice(0, 160)}`
                    : `${record.ranking?.join(' > ')}${record.attempts && record.attempts > 1 ? ' (retried)' : ''}`;
                console.log(`${judgeModel.padEnd(20)} ${key.padEnd(40)} ${status}`);
            });
        }
        console.log(`${judgeModel} (${via}): ${queued} panels to judge${skipped ? `, ${skipped} already current` : ''} -> ${path}`);
    }
    if (opts.dryRun) return;
    await pool(tasks, opts.concurrency);
    for (const save of writers) save();
    console.log(`\nMeasured judge spend: $${spent.toFixed(4)} at list prices (the subscription costs nothing here). Page: npm run evals:report`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

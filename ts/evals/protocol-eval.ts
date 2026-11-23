/**
 * Phase 1: protocol compliance.
 *
 * Runs every fixture against every selected model and grades the *mechanical*
 * expectations - control tokens, spoken length, forbidden strings, latency.
 * This says nothing about whether a model facilitates well; it says whether a
 * model can be wired into aloud at all. A model that scores 0.6 here is
 * disqualified regardless of how good its prose is, because the failures get
 * read aloud mid-meditation.
 *
 * Phase 2 (facilitation quality, rubric.md) is a separate pass over the same
 * fixtures and the transcripts this run writes.
 *
 *   npx tsx evals/protocol-eval.ts --models opus-5.5,sonnet-5.5 --runs 3
 *   npx tsx evals/protocol-eval.ts --all --label roster
 *   npx tsx evals/protocol-eval.ts --fixtures felt-sense/,hold/ --runs 5
 *   npx tsx evals/protocol-eval.ts --all --label roster --resume
 *
 * Writes one file per model into a sweep directory, evals/results/<date>-<label>/
 * (records.ts has the shapes); `npm run evals:report` turns the sweeps into a
 * page. Keys come from the environment or ts/server/.env (soak/env.ts). Claude
 * runs on your subscription through the `claude` CLI (soak/providers.ts
 * scriptClaude), which puts the CLI's startup in every latency: for a p50 that
 * means anything, or a verdict on a model about to ship, run with
 * ALOUD_CLAUDE_VIA=api and ANTHROPIC_API_KEY.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    OpenAIProvider,
    GoogleProvider,
    OpenRouterProvider,
    OllamaProvider,
    type CompletionOptions,
    type CompletionResult,
    type LLMProvider,
    type Message,
} from '@aloud/core/llm';

import { loadServerEnv } from '../soak/env.js';
import { claudeVia, scriptClaude } from '../soak/providers.js';
import { callCostUsd } from './cost.js';
import { FIXTURES, type Fixture } from './fixtures.js';
import { grade } from './grade.js';
import { ROSTER, type EvalModel } from './models.js';
import { messagesFor, promptHash, promptHashFor, systemPromptFor } from './prompt.js';
import {
    RUN_KIND,
    mergeTrials,
    modelFileName,
    parseRunFile,
    type RunEnvelope,
    type RunMeta,
    type Trial,
    type TrialUsage,
    type Via,
} from './records.js';

const RESULTS_DIR = fileURLToPath(new URL('./results', import.meta.url));

// --- Provider wiring --------------------------------------------------------

function buildProvider(m: EvalModel): LLMProvider {
    const need = (...names: string[]): string => {
        for (const name of names) {
            const v = process.env[name];
            if (v) return v;
        }
        throw new Error(`${names.join(' or ')} is unset (needed for ${m.id})`);
    };
    switch (m.provider) {
        case 'anthropic':
            return scriptClaude(m.model);
        case 'openai':
            return new OpenAIProvider({ apiKey: need('OPENAI_API_KEY'), model: m.model });
        case 'google':
            // server/.env names it GEMINI_API_KEY.
            return new GoogleProvider({ apiKey: need('GOOGLE_API_KEY', 'GEMINI_API_KEY'), model: m.model });
        case 'openrouter':
            return new OpenRouterProvider({ apiKey: need('OPENROUTER_API_KEY'), model: m.model });
        case 'ollama':
            // No key: local daemon. maxTokens matches runTrial's per-call cap so
            // a local candidate isn't scored on a shorter leash than the rest.
            return new OllamaProvider({ model: m.model, maxTokens: 400 });
        default:
            throw new Error(`no eval wiring for provider ${m.provider}`);
    }
}

function viaFor(m: EvalModel): Via {
    if (m.provider === 'anthropic') return claudeVia();
    return m.provider === 'ollama' ? 'local' : 'api';
}

// --- Runner -----------------------------------------------------------------

/** Streams when the provider can, so the time to the first text is measured:
 *  in a spoken turn loop the first sentence is what the listener waits for. */
async function call(
    provider: LLMProvider,
    messages: Message[],
    options: CompletionOptions,
    started: number
): Promise<{ result: CompletionResult; firstTextMs?: number }> {
    if (!provider.completeStream) return { result: await provider.complete(messages, options) };
    let text = '';
    let firstTextMs: number | undefined;
    let result: CompletionResult = { text: '', finishReason: null, tokensUsed: null };
    for await (const chunk of provider.completeStream(messages, options)) {
        if (chunk.text) {
            firstTextMs ??= Math.round(performance.now() - started);
            text += chunk.text;
        }
        if (chunk.done) {
            result = {
                text: '',
                finishReason: chunk.finishReason ?? null,
                tokensUsed: chunk.tokensUsed ?? null,
                inputTokens: chunk.inputTokens ?? null,
                outputTokens: chunk.outputTokens ?? null,
                cacheReadTokens: chunk.cacheReadTokens ?? null,
                cacheCreationTokens: chunk.cacheCreationTokens ?? null,
                ...(chunk.diagnostics && { diagnostics: chunk.diagnostics }),
            };
        }
    }
    return { result: { ...result, text }, ...(firstTextMs !== undefined && { firstTextMs }) };
}

function usageOf(r: CompletionResult): TrialUsage | undefined {
    const usage: TrialUsage = {
        inputTokens: r.inputTokens ?? null,
        outputTokens: r.outputTokens ?? null,
        cacheReadTokens: r.cacheReadTokens ?? null,
        cacheCreationTokens: r.cacheCreationTokens ?? null,
    };
    return Object.values(usage).some((v) => v !== null) ? usage : undefined;
}

async function runTrial(provider: LLMProvider, m: EvalModel, via: Via, fx: Fixture, run: number): Promise<Trial> {
    const system = systemPromptFor(fx);
    const messages = messagesFor(fx);
    const base = {
        model: m.id,
        fixture: fx.id,
        description: fx.description,
        run,
        at: new Date().toISOString(),
        provider: m.provider,
        providerModel: m.model,
        via,
        promptHash: promptHash(system, messages),
    };
    const started = performance.now();
    try {
        const { result, firstTextMs } = await call(provider, messages, { system, maxTokens: 400 }, started);
        const latencyMs = Math.round(performance.now() - started);
        const { checks, spoken } = grade(fx, result.text);
        const passed = checks.filter((c) => c.pass).length;
        const usage = usageOf(result);
        const costUsd = via === 'api' && usage ? callCostUsd(m.provider, m.model, usage) : null;
        const reported = result.diagnostics?.servedBy;
        const servedBy = reported && reported !== m.model ? reported : undefined;
        return {
            ...base,
            latencyMs,
            raw: result.text,
            spoken,
            checks,
            score: checks.length ? passed / checks.length : 1,
            ...(firstTextMs !== undefined && { firstTextMs }),
            finishReason: result.finishReason,
            ...(usage && { usage }),
            ...(costUsd !== null && { costUsd }),
            ...(servedBy && { servedBy }),
        };
    } catch (err) {
        return {
            ...base,
            latencyMs: Math.round(performance.now() - started),
            raw: '',
            spoken: '',
            checks: [],
            score: 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

async function pool(tasks: Array<() => Promise<void>>, size: number): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < tasks.length) {
            const task = tasks[next++] as () => Promise<void>;
            await task();
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(size, tasks.length)) }, worker));
}

// --- Output -----------------------------------------------------------------

function gitInfo(): { gitSha: string | null; gitDirty: boolean | null } {
    const cwd = dirname(RESULTS_DIR);
    try {
        const gitSha = execFileSync('git', ['rev-parse', '--short=10', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
        const gitDirty = execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim() !== '';
        return { gitSha, gitDirty };
    } catch {
        return { gitSha: null, gitDirty: null };
    }
}

function readTrials(path: string): Trial[] {
    if (!existsSync(path)) return [];
    try {
        return parseRunFile(JSON.parse(readFileSync(path, 'utf8')))?.trials ?? [];
    } catch {
        return [];
    }
}

function writeEnvelope(path: string, meta: RunMeta, trials: Trial[]): void {
    mkdirSync(dirname(path), { recursive: true });
    const envelope: RunEnvelope = { kind: RUN_KIND, version: 1, meta, trials };
    writeFileSync(path, JSON.stringify(envelope, null, 2) + '\n');
}

// --- CLI --------------------------------------------------------------------

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

function parseArgs(argv: string[]) {
    const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const modelIds = get('--models')?.split(',').filter(Boolean);
    const unknown = modelIds?.filter((id) => !ROSTER.some((m) => m.id === id)) ?? [];
    if (unknown.length) fail(`Unknown model id(s): ${unknown.join(', ')}. The roster is in evals/models.ts.`);
    const prefixes = get('--fixtures')?.split(',').filter(Boolean);
    // Id prefixes, so "felt-sense/" selects the whole family.
    const fixtures = prefixes ? FIXTURES.filter((f) => prefixes.some((p) => f.id.startsWith(p))) : FIXTURES;
    if (fixtures.length === 0) fail(`No fixture id starts with ${prefixes?.join(' or ')}.`);
    const runs = Number(get('--runs') ?? 3);
    const concurrency = Number(get('--concurrency') ?? 4);
    if (!Number.isInteger(runs) || runs < 1) fail('--runs takes a whole number of at least 1.');
    if (!Number.isInteger(concurrency) || concurrency < 1) fail('--concurrency takes a whole number of at least 1.');
    return {
        models: argv.includes('--all')
            ? ROSTER
            : modelIds
              ? ROSTER.filter((m) => modelIds.includes(m.id))
              : ROSTER.filter((m) => m.shipped),
        fixtures,
        runs,
        concurrency,
        out: get('--out'),
        sweep: get('--sweep'),
        label: get('--label'),
        resume: argv.includes('--resume'),
    };
}

function sweepDirFor(sweep: string | undefined, label: string | undefined, startedAt: Date): string {
    if (sweep) return sweep.includes('/') ? resolve(sweep) : join(RESULTS_DIR, sweep);
    const slug = (label ?? 'protocol').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-|-$/g, '');
    return join(RESULTS_DIR, `${startedAt.toISOString().slice(0, 10)}-${slug || 'protocol'}`);
}

async function main() {
    loadServerEnv();
    const opts = parseArgs(process.argv.slice(2));
    const { models, fixtures, runs } = opts;
    if (models.length === 0) fail('No models selected. Use --models <ids> or --all.');
    const startedAt = new Date();
    const outPath = opts.out ? resolve(opts.out) : null;
    const sweepDir = outPath ? null : sweepDirFor(opts.sweep, opts.label, startedAt);
    const git = gitInfo();
    const metaFor = (ids: string[]): RunMeta => ({
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        ...git,
        claudeVia: claudeVia(),
        runs,
        ...(opts.label !== undefined && { label: opts.label }),
        fixtures: fixtures.map((f) => f.id),
        models: ids,
    });

    const total = models.length * fixtures.length * runs;
    console.log(`${models.length} models x ${fixtures.length} fixtures x ${runs} runs = ${total} calls`);
    if (models.some((m) => m.provider === 'anthropic')) {
        console.log(
            claudeVia() === 'api'
                ? 'Claude: API key'
                : 'Claude: your subscription (claude CLI); latencies include its startup. ALOUD_CLAUDE_VIA=api for the key.'
        );
    }
    console.log(`-> ${outPath ?? sweepDir}${opts.resume ? '  (resuming)' : ''}\n`);

    const existingOut = outPath && opts.resume ? readTrials(outPath) : [];
    const existingFor = (m: EvalModel): Trial[] => {
        if (!opts.resume) return [];
        if (outPath) return existingOut.filter((t) => t.model === m.id);
        return readTrials(join(sweepDir as string, modelFileName(m.id)));
    };
    const hashes = new Map(fixtures.map((f) => [f.id, promptHashFor(f)]));

    const allTrials: Trial[] = [];
    let done = 0;
    const tick = () => {
        done++;
        if (process.stdout.isTTY) process.stdout.write(`\r${done}/${total} calls`);
    };
    const say = (line: string) => {
        if (process.stdout.isTTY) process.stdout.write('\r\x1b[K');
        console.log(line);
    };

    const runModel = async (m: EvalModel) => {
        let provider: LLMProvider;
        try {
            provider = buildProvider(m);
        } catch (err) {
            done += fixtures.length * runs;
            say(`SKIP ${m.id}: ${err instanceof Error ? err.message : err}`);
            return;
        }
        const via = viaFor(m);
        const existing = existingFor(m);
        const kept = new Set(
            existing.filter((t) => !t.error && t.promptHash).map((t) => `${t.fixture}|${t.run}|${t.promptHash}`)
        );
        const fresh: Trial[] = [];
        let skipped = 0;
        for (const fx of fixtures) {
            for (let run = 0; run < runs; run++) {
                if (kept.has(`${fx.id}|${run}|${hashes.get(fx.id)}`)) {
                    skipped++;
                    tick();
                    continue;
                }
                fresh.push(await runTrial(provider, m, via, fx, run));
                tick();
            }
        }
        const trials = opts.resume ? mergeTrials(existing, fresh) : fresh;
        allTrials.push(...trials);
        // A resume selects a few fixtures but the file holds them all.
        const held = [...new Set(trials.map((t) => t.fixture))];
        if (sweepDir) writeEnvelope(join(sweepDir, modelFileName(m.id)), { ...metaFor([m.id]), fixtures: held }, trials);
        say(summaryLine(m, fresh, skipped));
    };

    // Local models share one GPU: they run one at a time, as a single lane
    // beside the hosted models.
    const local = models.filter((m) => m.provider === 'ollama');
    const tasks: Array<() => Promise<void>> = models
        .filter((m) => m.provider !== 'ollama')
        .map((m) => () => runModel(m));
    if (local.length) {
        tasks.push(async () => {
            for (const m of local) await runModel(m);
        });
    }
    await pool(tasks, opts.concurrency);

    const selected = new Set(fixtures.map((f) => f.id));
    report(allTrials.filter((t) => selected.has(t.fixture)));
    if (outPath) {
        writeEnvelope(outPath, metaFor([...new Set(allTrials.map((t) => t.model))]), allTrials);
    }
    const since = startedAt.toISOString();
    const spent = allTrials.filter((t) => (t.at ?? '') >= since).reduce((a, t) => a + (t.costUsd ?? 0), 0);
    console.log(`\nMeasured API spend: $${spent.toFixed(4)} at list prices (the subscription and Ollama cost nothing here)`);
    console.log(`Results -> ${outPath ?? sweepDir}   Page: npm run evals:report`);
}

function median(xs: number[]): number {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
}

function summaryLine(m: EvalModel, fresh: Trial[], skipped: number): string {
    const ok = fresh.filter((t) => !t.error);
    const avg = fresh.length ? fresh.reduce((a, t) => a + t.score, 0) / fresh.length : 0;
    const first = ok.map((t) => t.firstTextMs).filter((x): x is number => x !== undefined);
    const cost = fresh.reduce((a, t) => a + (t.costUsd ?? 0), 0);
    const errors = fresh.length - ok.length;
    return [
        m.id.padEnd(24),
        fresh.length ? `${(avg * 100).toFixed(0)}%`.padStart(4) : '   -',
        ok.length ? `  p50 ${median(ok.map((t) => t.latencyMs))}ms` : '',
        first.length ? `  first text ${median(first)}ms` : '',
        cost > 0 ? `  $${cost.toFixed(4)}` : '',
        errors ? `  ${errors} errors` : '',
        skipped ? `  (${skipped} kept from before)` : '',
    ].join('');
}

function report(trials: Trial[]) {
    console.log('\n--- failures by fixture ---');
    const byFixture = new Map<string, Trial[]>();
    for (const t of trials) {
        byFixture.set(t.fixture, [...(byFixture.get(t.fixture) ?? []), t]);
    }
    for (const [fixture, ts] of byFixture) {
        const failing = ts.filter((t) => t.score < 1);
        if (failing.length === 0) continue;
        console.log(`\n${fixture}  (${failing.length}/${ts.length} trials failed)`);
        console.log(`  ${ts[0]?.description ?? ''}`);
        const reasons = new Map<string, number>();
        for (const t of failing) {
            if (t.error) {
                const key = `${t.model}: error (${t.error.slice(0, 120)})`;
                reasons.set(key, (reasons.get(key) ?? 0) + 1);
            }
            for (const c of t.checks.filter((c) => !c.pass)) {
                const key = `${t.model}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`;
                reasons.set(key, (reasons.get(key) ?? 0) + 1);
            }
        }
        for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
            console.log(`    ${n}x  ${reason}`);
        }
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});

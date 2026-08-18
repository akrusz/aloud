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
 *   npx tsx evals/protocol-eval.ts --models opus-5,sonnet-5 --runs 3
 *   npx tsx evals/protocol-eval.ts --all --out evals/out/run-1.json
 *
 * Keys come from the environment: ANTHROPIC_API_KEY, OPENAI_API_KEY,
 * GOOGLE_API_KEY, OPENROUTER_API_KEY.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import {
    PromptBuilder,
    StagedModeController,
    getMode,
    parseTurnSignals,
} from '@aloud/core/facilitation';
import {
    AnthropicProvider,
    OpenAIProvider,
    GoogleProvider,
    OpenRouterProvider,
    OllamaProvider,
    type LLMProvider,
    type Message,
} from '@aloud/core/llm';

import { ROSTER, type EvalModel } from './models.js';
import { FIXTURES, type Fixture } from './fixtures.js';

// --- Provider wiring --------------------------------------------------------

function buildProvider(m: EvalModel): LLMProvider {
    const need = (name: string): string => {
        const v = process.env[name];
        if (!v) throw new Error(`${name} is unset (needed for ${m.id})`);
        return v;
    };
    switch (m.provider) {
        case 'anthropic':
            return new AnthropicProvider({ apiKey: need('ANTHROPIC_API_KEY'), model: m.model });
        case 'openai':
            return new OpenAIProvider({ apiKey: need('OPENAI_API_KEY'), model: m.model });
        case 'google':
            return new GoogleProvider({ apiKey: need('GOOGLE_API_KEY'), model: m.model });
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

// --- Prompt assembly --------------------------------------------------------
//
// Deliberately goes through the real PromptBuilder + StagedModeController
// rather than a fixture-local copy of the prompt. An eval that drifts from the
// shipped prompt measures nothing.

function systemPromptFor(fx: Fixture): string {
    const mode = getMode(fx.mode);
    let stageSection: string | undefined;
    if (mode?.phases) {
        stageSection = new StagedModeController(mode, fx.phase).promptSection();
    }
    return new PromptBuilder({ mode, config: fx.config }).buildSystemPrompt(stageSection);
}

// --- Scoring ----------------------------------------------------------------

interface Check {
    name: string;
    pass: boolean;
    detail?: string;
}

function wordCount(s: string): number {
    return s.trim().split(/\s+/).filter(Boolean).length;
}

function grade(fx: Fixture, raw: string): { checks: Check[]; spoken: string } {
    const signals = parseTurnSignals(raw);
    const spoken = signals.cleanText;
    const checks: Check[] = [];
    const e = fx.expect;

    if (e.hold !== undefined) {
        checks.push({
            name: 'hold',
            pass: signals.hold === e.hold,
            detail: `expected ${e.hold}, got ${signals.hold}`,
        });
    }
    if (e.stage !== undefined) {
        checks.push({
            name: 'stage',
            pass: signals.stage === e.stage,
            detail: `expected ${e.stage}, got ${signals.stage}`,
        });
    }
    if (e.wait !== undefined) {
        const got = signals.waitSec !== null;
        checks.push({
            name: 'wait',
            pass: got === e.wait,
            detail: `expected token ${e.wait}, got ${signals.waitSec ?? 'none'}`,
        });
    }
    if (e.maxWords !== undefined) {
        const n = wordCount(spoken);
        checks.push({ name: 'brevity', pass: n <= e.maxWords, detail: `${n}/${e.maxWords} words` });
    }
    for (const bad of e.forbid ?? []) {
        checks.push({
            name: `forbid:${bad}`,
            pass: !spoken.toLowerCase().includes(bad.toLowerCase()),
        });
    }

    // Universal: a control token surviving into spoken text means it gets read
    // aloud. Always checked, regardless of what the fixture declares.
    checks.push({
        name: 'no-token-leak',
        pass: !/\[\s*(HOLD|NEXT|BACK|WAIT)/i.test(spoken),
        detail: 'control token survived into spoken text',
    });

    return { checks, spoken };
}

// --- Runner -----------------------------------------------------------------

interface Trial {
    model: string;
    fixture: string;
    probe: string;
    run: number;
    latencyMs: number;
    raw: string;
    spoken: string;
    checks: Check[];
    score: number;
    error?: string;
}

async function runTrial(
    provider: LLMProvider,
    m: EvalModel,
    fx: Fixture,
    run: number
): Promise<Trial> {
    const system = systemPromptFor(fx);
    const messages: Message[] = fx.history.map((h) => ({ role: h.role, content: h.content }));
    const started = Date.now();
    try {
        const result = await provider.complete(messages, { system, maxTokens: 400 });
        const latencyMs = Date.now() - started;
        const { checks, spoken } = grade(fx, result.text);
        const passed = checks.filter((c) => c.pass).length;
        return {
            model: m.id,
            fixture: fx.id,
            probe: fx.probe,
            run,
            latencyMs,
            raw: result.text,
            spoken,
            checks,
            score: checks.length ? passed / checks.length : 1,
        };
    } catch (err) {
        return {
            model: m.id,
            fixture: fx.id,
            probe: fx.probe,
            run,
            latencyMs: Date.now() - started,
            raw: '',
            spoken: '',
            checks: [],
            score: 0,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

// --- CLI --------------------------------------------------------------------

function parseArgs(argv: string[]) {
    const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const models = get('--models');
    return {
        models: argv.includes('--all')
            ? ROSTER
            : models
              ? ROSTER.filter((m) => models.split(',').includes(m.id))
              : ROSTER.filter((m) => m.shipped),
        runs: Number(get('--runs') ?? 3),
        out: get('--out'),
    };
}

async function main() {
    const { models, runs, out } = parseArgs(process.argv.slice(2));
    if (models.length === 0) {
        console.error('No models selected. Use --models <ids> or --all.');
        process.exit(1);
    }
    console.log(
        `${models.length} models x ${FIXTURES.length} fixtures x ${runs} runs = ${models.length * FIXTURES.length * runs} calls\n`
    );

    const trials: Trial[] = [];
    for (const m of models) {
        let provider: LLMProvider;
        try {
            provider = buildProvider(m);
        } catch (err) {
            console.log(`SKIP ${m.id}: ${err instanceof Error ? err.message : err}`);
            continue;
        }
        process.stdout.write(`${m.id.padEnd(24)}`);
        for (const fx of FIXTURES) {
            for (let run = 0; run < runs; run++) {
                const t = await runTrial(provider, m, fx, run);
                trials.push(t);
                process.stdout.write(t.error ? '!' : t.score === 1 ? '.' : 'x');
            }
        }
        const mine = trials.filter((t) => t.model === m.id);
        const avg = mine.reduce((a, t) => a + t.score, 0) / mine.length;
        const p50 = median(mine.map((t) => t.latencyMs));
        console.log(`  ${(avg * 100).toFixed(0)}%  p50 ${p50}ms`);
    }

    report(trials);
    if (out) {
        mkdirSync(dirname(out), { recursive: true });
        writeFileSync(out, JSON.stringify(trials, null, 2));
        console.log(`\nTranscripts -> ${out}  (feed these to Phase 2)`);
    }
}

function median(xs: number[]): number {
    if (xs.length === 0) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)] ?? 0;
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
        console.log(`  ${ts[0]?.probe ?? ''}`);
        const reasons = new Map<string, number>();
        for (const t of failing) {
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

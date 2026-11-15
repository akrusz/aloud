/**
 * Scores the setup screen's local reader (core setup-local.ts) on the corpus
 * the judge tier is scored on (setup-judge-corpus.ts), through the provider
 * and the prompt a session set to Ollama would use.
 *
 *   npm run setup:local -- [--model qwen3.5:4b] [--sections clean,negative,...] [--limit <n per section>]
 *                          [--out <dir>] [--duty 0.33] [--misheard-limit 150]
 *
 * Needs Ollama running with the model pulled. Costs nothing but heat, and it
 * is paced for that: the model works about a third of the time (--duty), with
 * a longer rest every 40 calls, so the default corpus takes about 25 minutes
 * instead of 8. Rows are appended to <out>/setup-local-<model>.jsonl as they
 * come and a rerun skips lines already there, so it can be stopped and picked
 * up, and a prompt change needs --out pointed somewhere new.
 *
 * Prints, per section: exact, wrong and missed for requests; for room and
 * television lines, every one that changed something (the number that
 * matters); and how long a call took.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OllamaProvider } from '../src/llm/ollama.js';
import { mightBeSetupRequest } from '../src/facilitation/setup-command-specs.js';
import type { SetupAction } from '../src/facilitation/setup-command.js';
import { LOCAL_SETUP_FORMAT, LOCAL_SETUP_SYSTEM_PROMPT, resolveLocalSetupChanges } from '../src/facilitation/setup-local.js';
import { corpus, normalize, type Case } from './setup-judge-corpus.js';

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
};
const MODEL = flag('--model') ?? 'qwen3.5:4b';
const SECTIONS = new Set((flag('--sections') ?? 'clean,clean-heldout,negative,negative-heldout,begin-like,misheard-observed,misheard-heldout').split(','));
const LIMIT = Number(flag('--limit') ?? 'Infinity');
const DUTY = Math.min(1, Math.max(0.05, Number(flag('--duty') ?? '0.33')));
const OUT_DIR = flag('--out') ?? join(tmpdir(), 'aloud-setup-local');
const REST_EVERY = 40;
const REST_MS = 20_000;

interface Row extends Case {
    raw: unknown;
    got: SetupAction[] | null;
    ms: number;
}

const taken = new Map<string, number>();
const cases = corpus.filter((c) => {
    if (!SECTIONS.has(c.section) || !mightBeSetupRequest(c.text)) return false;
    const n = taken.get(c.section) ?? 0;
    taken.set(c.section, n + 1);
    return n < LIMIT;
});

mkdirSync(OUT_DIR, { recursive: true });
const LOG = join(OUT_DIR, `setup-local-${MODEL.replace(/[^a-z0-9]+/gi, '-')}.jsonl`);
const done = new Map<string, Row>();
if (existsSync(LOG)) {
    for (const line of readFileSync(LOG, 'utf8').split('\n').filter(Boolean)) {
        const row = JSON.parse(line) as Row;
        done.set(row.text, row);
    }
}

const provider = new OllamaProvider({ model: MODEL });
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const toAsk = cases.filter((c) => !done.has(c.text)).length;
console.log(`${MODEL}: ${cases.length} lines, ${toAsk} to ask at ${Math.round(DUTY * 100)}% duty; rows in ${LOG}`);

const rows: Row[] = [];
let asked = 0;
for (const c of cases) {
    const had = done.get(c.text);
    if (had) {
        // The label may have changed since; the answer has not.
        rows.push({ ...had, ...c, got: resolveLocalSetupChanges((had.raw as { changes?: unknown } | null)?.changes, c.text) });
        continue;
    }
    const t0 = Date.now();
    let raw: unknown = null;
    try {
        const reply = await provider.complete([{ role: 'user', content: c.text }], {
            system: LOCAL_SETUP_SYSTEM_PROMPT,
            maxTokens: 60,
            format: LOCAL_SETUP_FORMAT,
        });
        raw = JSON.parse(reply.text);
    } catch (err) {
        raw = null;
        // A model that can't be asked at all reads as one that understood
        // nothing: say so once, and don't score a run of errors.
        if (asked === 0) {
            console.error(`${MODEL} could not be asked: ${String(err).slice(0, 300)}`);
            process.exit(1);
        }
    }
    const ms = Date.now() - t0;
    const row: Row = { ...c, raw, got: resolveLocalSetupChanges((raw as { changes?: unknown } | null)?.changes, c.text), ms };
    rows.push(row);
    appendFileSync(LOG, JSON.stringify(row) + '\n');
    asked++;
    await sleep(Math.min(8000, ms * (1 / DUTY - 1)));
    if (asked % REST_EVERY === 0) {
        console.error(`${asked}/${toAsk}`);
        await sleep(REST_MS);
    }
}

const fmt = (a: SetupAction[] | null): string => (a ? a.map(normalize).join(' ') : 'null');
const same = (a: SetupAction[] | null, b: SetupAction[] | null): boolean => {
    if (!a || !b) return a === b;
    const x = new Set(a.map(normalize));
    const y = new Set(b.map(normalize));
    return x.size === y.size && [...x].every((k) => y.has(k));
};
const bySection = new Map<string, Row[]>();
for (const row of rows) bySection.set(row.section, [...(bySection.get(row.section) ?? []), row]);
for (const [section, rs] of bySection) {
    if (rs[0]!.expect !== null) {
        const exact = rs.filter((r) => same(r.got, r.expect));
        const missed = rs.filter((r) => r.got === null);
        console.log(`\n== ${section.toUpperCase()} (${rs.length}): ${exact.length} exact, ${rs.length - exact.length - missed.length} WRONG, ${missed.length} missed`);
        for (const r of rs) {
            if (same(r.got, r.expect)) continue;
            console.log(`  ${r.got === null ? 'MISS ' : 'WRONG'} "${r.text}"${r.said ? ` (said "${r.said}")` : ''}  want ${fmt(r.expect)}  got ${fmt(r.got)}`);
        }
    } else {
        const fps = rs.filter((r) => r.got !== null);
        console.log(`\n== ${section.toUpperCase()} (${rs.length}): ${fps.length} CHANGED SOMETHING`);
        for (const r of fps) console.log(`  FP  "${r.text}"  got ${fmt(r.got)}`);
    }
}
const took = rows.map((r) => r.ms).sort((a, b) => a - b);
if (took.length) console.log(`\ncall ms: p50 ${took[Math.floor(took.length / 2)]}, p90 ${took[Math.floor(took.length * 0.9)]}, max ${took.at(-1)}`);

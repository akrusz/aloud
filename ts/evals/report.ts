/**
 * One self-contained HTML page from every eval sweep (evals/results/) and every
 * soak run (soak-runs/<dir>/run.json): which models are usable, how each one
 * did by situation, the replies themselves, and whole-session results.
 *
 *   npm run evals:report                       # -> evals/out/report.html
 *   npm run evals:report -- --out /tmp/r.html
 *
 * The page carries its data as JSON and renders it with report-client.ts,
 * transpiled and inlined here: no network, no framework.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { summarizeEvals, type EvalSummary } from './aggregate.js';
import { summarizePhase2, type Phase2Summary } from './judge-aggregate.js';
import { judgeInstructions } from './judge-core.js';
import { loadRubric } from './rubric.js';
import { costByModelId } from './cost.js';
import { FIXTURES } from './fixtures.js';
import { promptHashFor } from './prompt.js';
import { readSweeps } from './records.js';
import { summarizeSoak, type SoakSummary } from './soak-summary.js';

const HERE = dirname(fileURLToPath(import.meta.url));

export interface ReportData {
    generatedAt: string;
    gitSha: string | null;
    gitDirty: boolean | null;
    evals: EvalSummary;
    phase2: Phase2Summary;
    soak: SoakSummary;
}

/** The latest measurement per (model, fixture) is embedded in full and older
 *  sweeps only as rates; past this the roster has outgrown one page. */
const SIZE_WARN_BYTES = 12 * 1024 * 1024;

function git(args: string[]): string | null {
    try {
        return execFileSync('git', args, { cwd: HERE, encoding: 'utf8' }).trim();
    } catch {
        return null;
    }
}

function readSoakRuns(dir: string): Array<{ dir: string; json: unknown }> {
    if (!existsSync(dir)) return [];
    const out: Array<{ dir: string; json: unknown }> = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name, 'run.json');
        if (!statSync(join(dir, name)).isDirectory() || !existsSync(path)) continue;
        try {
            out.push({ dir: name, json: JSON.parse(readFileSync(path, 'utf8')) });
        } catch {
            console.warn(`skipped ${path}: not JSON`);
        }
    }
    return out;
}

export function buildReportData(resultsDir: string, soakDir: string): ReportData {
    const currentHashes = Object.fromEntries(FIXTURES.map((f) => [f.id, promptHashFor(f)]));
    const rubric = loadRubric();
    const currentRubricHashes = Object.fromEntries(FIXTURES.map((f) => [f.id, judgeInstructions(rubric, f).hash]));
    const sweeps = readSweeps(resultsDir);
    const dirty = git(['status', '--porcelain']);
    return {
        generatedAt: new Date().toISOString(),
        gitSha: git(['rev-parse', '--short=10', 'HEAD']),
        gitDirty: dirty === null ? null : dirty !== '',
        evals: summarizeEvals(sweeps, { currentHashes }),
        phase2: summarizePhase2(sweeps, { rubric, currentRubricHashes, currentPromptHashes: currentHashes }),
        soak: summarizeSoak(readSoakRuns(soakDir), costByModelId),
    };
}

function clientScript(): string {
    const src = readFileSync(join(HERE, 'report-client.ts'), 'utf8');
    const out = ts.transpileModule(src, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext },
    });
    return out.outputText;
}

/** JSON inside a <script> element: nothing in it may close the element. */
function scriptSafe(json: string): string {
    return json.replace(/</g, '\\u003c');
}

export function renderPage(data: ReportData): string {
    const css = readFileSync(join(HERE, 'report-page.css'), 'utf8');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Facilitator model evals</title>
<style>
${css}
</style>
</head>
<body>
<main id="app"><p class="loading">Rendering the report...</p></main>
<script type="application/json" id="report-data">${scriptSafe(JSON.stringify(data))}</script>
<script type="module">
${clientScript()}
</script>
</body>
</html>
`;
}

function main() {
    const argv = process.argv.slice(2);
    const get = (flag: string): string | undefined => {
        const i = argv.indexOf(flag);
        return i >= 0 ? argv[i + 1] : undefined;
    };
    const out = resolve(get('--out') ?? join(HERE, 'out', 'report.html'));
    const data = buildReportData(
        resolve(get('--results') ?? join(HERE, 'results')),
        resolve(get('--soak') ?? join(HERE, '..', 'soak-runs'))
    );
    const page = renderPage(data);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, page);
    const kb = Math.round(Buffer.byteLength(page) / 1024);
    const e = data.evals;
    console.log(
        `${e.models.length} models from ${e.sweeps.length} sweep(s), ${data.soak.sessions.length} soak sessions from ${data.soak.runs.length} runs`
    );
    console.log(`-> ${out} (${kb} KB)`);
    if (Buffer.byteLength(page) > SIZE_WARN_BYTES) {
        console.warn('The page is over 12 MB: think about pruning old sweeps from evals/results/.');
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

/**
 * Which prompts changed since the ledger was last stamped, for the release
 * (dev-docs/pre-release-checklist.md, Part E). `check` is a report and always
 * exits 0; nothing here runs in tests or CI.
 *
 *   npm --prefix ts run prompts:check
 *   npm --prefix ts run prompts:stamp -- [--read <id,...>] [--edited <id,...>]
 *   npm --prefix ts run prompts:mark -- <id> read|edited|draft
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { compare, hashText, IdError, mark, resolveId, stamp, STATUSES, type Ledger, type Piece, type Reach } from './ledger.js';
import { promptPieces } from './registry.js';

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const LEDGER = fileURLToPath(new URL('../../prompt-ledger.json', import.meta.url));
const DIFF_MAX_LINES = 200;
const REACHES: ReadonlyArray<[Reach, string]> = [
    ['session', 'what a meditator hears, or what is saved for them'],
    ['support', 'runs in production, never heard'],
    ['dev', 'evals, soak, scripts'],
];

const git = (...args: string[]): string => execFileSync('git', ['-C', REPO, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
const cmd = (name: string, args = ''): string => `npm --prefix ts run prompts:${name}${args ? ` -- ${args}` : ''}`;

async function currentPieces(): Promise<Piece[]> {
    return (await promptPieces()).map(({ id, reach, file, text }) => ({ id, reach, file, hash: hashText(text) }));
}

function readLedger(): Ledger | null {
    return existsSync(LEDGER) ? (JSON.parse(readFileSync(LEDGER, 'utf8')) as Ledger) : null;
}

function writeLedger(ledger: Ledger): void {
    writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** A word diff: most prompts here are one long line per paragraph. */
function printDiff(since: string, files: string[]): void {
    const range = `git diff --word-diff ${since.slice(0, 8)} -- ${files.join(' ')}`;
    let diff: string;
    try {
        diff = git('diff', '--word-diff', since, '--', ...files);
    } catch {
        console.log(`\nThe stamp's commit ${since.slice(0, 8)} is not in this clone, so there is no diff to show.`);
        return;
    }
    const lines = diff.split('\n').length;
    if (lines > DIFF_MAX_LINES) {
        console.log(`\nThe diff of those files since the stamp is ${lines} lines (code included); read it from the repo root with:\n  ${range}`);
        console.log(git('diff', '--stat', since, '--', ...files).trimEnd());
    } else {
        console.log(`\nWhat changed in those files since the stamp (${range}):\n\n${diff.trimEnd()}`);
    }
}

async function check(): Promise<void> {
    const ledger = readLedger();
    if (!ledger) {
        console.log(`There is no ledger yet (ts/prompt-ledger.json). ${cmd('stamp')} starts one.`);
        return;
    }
    const d = compare(ledger, await currentPieces());
    console.log(`Prompt text compared with the ledger stamped at ${ledger.stampedAt.slice(0, 8)} on ${ledger.stampedOn} (uncommitted edits included).`);
    const rows = [
        ...d.changed.map((p) => ({ what: 'changed', ...p })),
        ...d.added.map((p) => ({ what: 'new', ...p })),
        ...d.removed.map((p) => ({ what: 'removed', ...p })),
    ];
    if (!rows.length) console.log('No prompt has changed since.');
    for (const [reach, about] of REACHES) {
        const mine = rows.filter((r) => r.reach === reach);
        if (!mine.length) continue;
        console.log(`\n${reach} (${about}):`);
        for (const r of mine) console.log(`  ${r.what.padEnd(8)}${r.id}   ${r.file}`);
    }
    const files = [...new Set([...d.changed, ...d.removed].map((p) => p.file))];
    if (files.length) printDiff(ledger.stampedAt, files);
    if (d.added.length) console.log(`\nNew pieces have no earlier text: read them in their files.`);

    const entries = Object.entries(ledger.pieces);
    const counts = STATUSES.map((s) => `${entries.filter(([, e]) => e.status === s).length} ${s}`);
    console.log(`\nIn the ledger: ${counts.join(', ')}. Draft means written or changed by an agent and not yet read by Alex:`);
    for (const [reach] of REACHES) {
        const drafts = entries.filter(([, e]) => e.status === 'draft' && e.reach === reach);
        if (drafts.length) console.log(`  ${reach}: ${drafts.map(([id, e]) => (e.note ? `${id} (${e.note})` : id)).join(', ')}`);
    }
    if (rows.length) {
        const first = rows.some((r) => r.reach !== 'dev')
            ? 'show Alex the session and support changes'
            : 'only dev prompts changed; Alex reads those when he chooses';
        console.log(
            `\nNext: ${first}. On his word, record what he read or wrote and restamp:\n` +
                `  ${cmd('stamp', '--read <id,...> --edited <id,...>')}\n` +
                `Changed and new pieces not named there become draft. One piece without restamping:\n` +
                `  ${cmd('mark', '<id> read|edited|draft')}\nAn id can be shortened to any unique part of it.`
        );
    }
}

const listArg = (args: readonly string[], flag: string): string[] => {
    const at = args.indexOf(flag);
    return at < 0 ? [] : (args[at + 1] ?? '').split(',').filter(Boolean);
};

async function stampCommand(args: readonly string[]): Promise<void> {
    const pieces = await currentPieces();
    const dirty = git('status', '--porcelain', '--', ...new Set(pieces.map((p) => p.file))).trimEnd();
    if (dirty) {
        console.log(`Commit these first: the stamp records HEAD, and later diffs start from it.\n${dirty}`);
        process.exitCode = 1;
        return;
    }
    const ids = pieces.map((p) => p.id);
    const named = {
        read: listArg(args, '--read').map((q) => resolveId(ids, q)),
        edited: listArg(args, '--edited').map((q) => resolveId(ids, q)),
    };
    const prev = readLedger();
    const sha = git('rev-parse', 'HEAD').trim();
    const next = stamp(prev, pieces, { sha, date: new Date().toISOString().slice(0, 10) }, named);
    writeLedger(next);
    const drafts = prev ? compare(prev, pieces) : null;
    const becameDraft = drafts ? [...drafts.changed, ...drafts.added].filter((p) => next.pieces[p.id]?.status === 'draft').length : 0;
    console.log(
        `Stamped ${pieces.length} prompts at ${sha.slice(0, 8)} in ts/prompt-ledger.json` +
            (prev ? `: ${becameDraft} changed or new became draft, ${named.read.length} read, ${named.edited.length} edited.` : ', all baseline.') +
            ' Commit the ledger.'
    );
}

async function markCommand([query, status]: readonly string[]): Promise<void> {
    const ledger = readLedger();
    if (!query || (status !== 'read' && status !== 'edited' && status !== 'draft') || !ledger) {
        console.log(ledger ? `Usage: ${cmd('mark', '<id> read|edited|draft')}` : `There is no ledger yet: ${cmd('stamp')} starts one.`);
        process.exitCode = 1;
        return;
    }
    const pieces = await currentPieces();
    const id = resolveId([...new Set([...Object.keys(ledger.pieces), ...pieces.map((p) => p.id)])], query);
    writeLedger(mark(ledger, id, status, pieces.find((p) => p.id === id)));
    console.log(`${id} is now ${status} in ts/prompt-ledger.json.`);
}

const [command, ...args] = process.argv.slice(2);
try {
    if (command === 'check') await check();
    else if (command === 'stamp') await stampCommand(args);
    else if (command === 'mark') await markCommand(args);
    else {
        console.log(`Usage: ${cmd('check')} | ${cmd('stamp', '[--read <id,...>] [--edited <id,...>]')} | ${cmd('mark', '<id> read|edited|draft')}`);
        process.exitCode = 1;
    }
} catch (err) {
    if (!(err instanceof IdError)) throw err;
    console.log(err.message);
    process.exitCode = 1;
}

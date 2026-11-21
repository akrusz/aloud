/**
 * scripts/lib/min-version.sh: release.sh's parse-and-apply of the pre-release
 * check's minimum-version recommendation, run through bash against a copy of
 * the real min-client-version.ts (bash 3.2 on a Mac, newer in CI).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const LIB = join(here, '../../scripts/lib/min-version.sh');
const REAL_FILE = join(here, '../server/src/min-client-version.ts');
const REL = 'ts/server/src/min-client-version.ts';

let dir: string;

/** Run `script` in bash with the library sourced, from the temp repo. A
 *  check reply goes in as $REPLY_TEXT, out of the quoting's way. */
function sh(script: string, input = '', reply = ''): { status: number; stdout: string; stderr: string } {
    const res = spawnSync('bash', ['-c', `. "${LIB}"\n${script}`], {
        cwd: dir,
        input,
        encoding: 'utf8',
        env: {
            ...process.env,
            REPLY_TEXT: reply,
            GIT_AUTHOR_NAME: 'test',
            GIT_AUTHOR_EMAIL: 'test@example.com',
            GIT_COMMITTER_NAME: 'test',
            GIT_COMMITTER_EMAIL: 'test@example.com',
        },
    });
    return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** The minimums as checked in, then set to these values. */
function writeMinimums(values: { desktop: string; android: string; ios: string }): void {
    let text = readFileSync(REAL_FILE, 'utf8');
    for (const [platform, version] of Object.entries(values)) {
        text = text.replace(new RegExp(`^    ${platform}: '[0-9.]+',$`, 'm'), `    ${platform}: '${version}',`);
    }
    writeFileSync(join(dir, REL), text);
}

function minimums(): string {
    return sh(`for p in desktop android ios; do printf '%s=%s ' "$p" "$(minver_current "$p" "${REL}")"; done`).stdout.trim();
}

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aloud-minver-'));
    mkdirSync(join(dir, 'ts/server/src'), { recursive: true });
    copyFileSync(REAL_FILE, join(dir, REL));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('min-version.sh', () => {
    it('passes bash -n, as release.sh does', () => {
        expect(() => execFileSync('bash', ['-n', LIB])).not.toThrow();
        expect(() => execFileSync('bash', ['-n', join(here, '../../scripts/release.sh')])).not.toThrow();
    });

    it('reads every minimum from the real file', () => {
        expect(minimums()).toMatch(/^desktop=\d+\.\d+\.\d+ android=\d+\.\d+\.\d+ ios=\d+\.\d+\.\d+$/);
    });

    it("finds the reply's last MINVERSION line, markdown stripped, and its reasoning", () => {
        const reply = [
            'Fixed: dev-docs/ts-server.md (one line).',
            'PRERELEASE: FIXED',
            '**Minimum versions:**',
            'Desktop: this release stops re-sending audio, so raise it.',
            '',
            'Android: 2.17.0 is the oldest live build; no change.',
            '`MINVERSION: desktop=2.21.0`',
        ].join('\n');
        expect(sh('minver_recommendation "$REPLY_TEXT"', '', reply).stdout.trim()).toBe('desktop=2.21.0');
        const reasoning = sh('minver_reasoning "$REPLY_TEXT"', '', reply).stdout;
        expect(reasoning).toBe(
            'Desktop: this release stops re-sending audio, so raise it.\nAndroid: 2.17.0 is the oldest live build; no change.\n'
        );
        expect(sh(`minver_recommendation 'no recommendation here'`).stdout.trim()).toBe('');
        expect(sh(`minver_recommendation 'MINVERSION: none'`).stdout.trim()).toBe('none');
    });

    it('plans only raises, never above the release being cut', () => {
        writeMinimums({ desktop: '2.19.0', android: '2.17.0', ios: '0.0.0' });
        const plan = sh(`minver_plan 'desktop=2.21.0 android=2.17.0 ios=2.16.0' ${REL} 2.21.0`);
        expect(plan.status).toBe(0);
        expect(plan.stdout).toBe('desktop 2.19.0 2.21.0\nios 0.0.0 2.16.0\n');
        expect(plan.stderr).toContain('not lowering android');

        expect(sh(`minver_plan 'desktop=2.18.0' ${REL} 2.21.0`).stdout).toBe('');
        expect(sh(`minver_plan 'none' ${REL} 2.21.0`)).toMatchObject({ status: 0, stdout: '' });
        expect(sh(`minver_plan '' ${REL} 2.21.0`)).toMatchObject({ status: 0, stdout: '' });
        expect(sh(`minver_plan 'Desktop=2.20.0, Android=2.18.0' ${REL} 2.21.0`).stdout).toBe(
            'desktop 2.19.0 2.20.0\nandroid 2.17.0 2.18.0\n'
        );
    });

    it('refuses a malformed recommendation outright', () => {
        for (const rec of [
            'desktop=2.21',
            'desktop=v2.21.0',
            'desktop=2.21.0-rc.1',
            'web=2.21.0',
            'desktop',
            'desktop=2.21.0 desktop=2.20.0',
            'desktop=2.22.0',
            'ios=10.0.0',
        ]) {
            const res = sh(`minver_plan '${rec}' ${REL} 2.21.0`);
            expect(res.status, rec).toBe(1);
            expect(res.stdout, rec).toBe('');
        }
    });

    it('writes a plan into the file, touching nothing else', () => {
        const before = readFileSync(join(dir, REL), 'utf8');
        const res = sh(`minver_apply "$(minver_plan 'desktop=2.21.0 ios=2.17.0' ${REL} 2.21.0)" ${REL}`);
        expect(res.status).toBe(0);
        expect(minimums()).toBe('desktop=2.21.0 android=0.0.0 ios=2.17.0');
        const after = readFileSync(join(dir, REL), 'utf8');
        expect(after.replace("desktop: '2.21.0'", "desktop: '0.0.0'").replace("ios: '2.17.0'", "ios: '0.0.0'")).toBe(
            before
        );
    });

    describe('propose_min_versions, in a repo', () => {
        const reply =
            "PRERELEASE: CLEAN\nMinimum versions:\nDesktop builds before 2.21.0 bill speech twice.\nMINVERSION: desktop=2.21.0";

        beforeEach(() => {
            execFileSync('git', ['init', '-q'], { cwd: dir });
            sh(`git add ${REL} && git commit -q -m init`);
        });

        it('shows the reasoning and, on Enter, writes and commits the raise', () => {
            const res = sh('propose_min_versions "$REPLY_TEXT" 2.21.0', '\n', reply);
            expect(res.status).toBe(0);
            expect(res.stdout).toContain('Desktop builds before 2.21.0 bill speech twice.');
            expect(res.stdout).toContain('desktop: 0.0.0 -> 2.21.0');
            expect(minimums()).toBe('desktop=2.21.0 android=0.0.0 ios=0.0.0');
            expect(sh('git log -1 --format=%s').stdout.trim()).toBe('min client version: desktop 2.21.0');
            expect(sh('git status --porcelain').stdout).toBe('');
        });

        it('leaves everything as it was on n', () => {
            const res = sh('propose_min_versions "$REPLY_TEXT" 2.21.0', 'n\n', reply);
            expect(res.status).toBe(0);
            expect(minimums()).toBe('desktop=0.0.0 android=0.0.0 ios=0.0.0');
            expect(sh('git log -1 --format=%s').stdout.trim()).toBe('init');
        });

        it('changes nothing, and asks nothing, for none, no line, or a malformed line', () => {
            for (const r of ['MINVERSION: none', 'PRERELEASE: CLEAN', 'MINVERSION: desktop=two']) {
                const res = sh('propose_min_versions "$REPLY_TEXT" 2.21.0', '', r);
                expect(res.status, r).toBe(0);
                expect(res.stdout, r).not.toContain('Raise them?');
            }
            expect(minimums()).toBe('desktop=0.0.0 android=0.0.0 ios=0.0.0');
            expect(sh('git log -1 --format=%s').stdout.trim()).toBe('init');
        });

        it('raises by hand without asking, and commits that file alone', () => {
            writeFileSync(join(dir, 'other.txt'), 'staged elsewhere\n');
            sh('git add other.txt');
            const res = sh('force_min_versions "desktop=2.21.0 android=2.17.0" 2.21.0');
            expect(res.status).toBe(0);
            expect(minimums()).toBe('desktop=2.21.0 android=2.17.0 ios=0.0.0');
            expect(sh('git log -1 --format=%s').stdout.trim()).toBe('min client version: desktop 2.21.0, android 2.17.0');
            expect(sh('git show --stat --format= HEAD').stdout).not.toContain('other.txt');
        });

        it('by hand, refuses a malformed pair or one past the release, and never lowers', () => {
            for (const pairs of ['desktop=two', 'web=2.21.0', 'desktop=2.22.0']) {
                expect(sh(`force_min_versions "${pairs}" 2.21.0`).status, pairs).not.toBe(0);
            }
            expect(sh('force_min_versions "desktop=0.0.0" 2.21.0').stdout).toContain('Nothing to raise');
            expect(minimums()).toBe('desktop=0.0.0 android=0.0.0 ios=0.0.0');
            expect(sh('git log -1 --format=%s').stdout.trim()).toBe('init');
        });
    });
});

#!/usr/bin/env node
// `npm audit --audit-level=high`, plus the ignore list npm doesn't have: an
// advisory with no patched release otherwise fails the gate on every push with
// nothing to bump. The npm twin of `ignore` in src-tauri/deny.toml, held to the
// same bar - say why it can't reach us and what clears it.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// `via` pins the acceptance to the direct dependencies it was reasoned about:
// the same advisory arriving through anything else blocks again.
const ACCEPTED = {
    // braces <= 3.0.3 overflows the stack on deeply nested patterns; no fixed
    // release exists. Ours is patch-package -> find-yarn-workspace-root ->
    // micromatch, which globs the `workspaces` of our own package.json at
    // install time, so no outside input reaches it. Drop when braces ships a
    // fix or patch-package sheds the dep.
    'GHSA-vfj7-8cjw-p6xm': { via: ['patch-package'], why: 'braces, install-time only' },
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// npm exits non-zero whenever it reports anything, so the status says nothing.
const { stdout, error } = spawnSync('npm', ['audit', '--json'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
});

let report;
try {
    report = JSON.parse(stdout);
} catch {
    // fall through to the no-report exit
}
if (!report?.vulnerabilities) {
    console.error('npm audit returned no report (registry unreachable?):');
    console.error(stdout || error?.message);
    process.exit(1);
}

const directDependents = (name, found = new Set(), seen = new Set()) => {
    if (seen.has(name)) return found;
    seen.add(name);
    const vuln = report.vulnerabilities[name];
    if (vuln.isDirect) found.add(name);
    for (const dependent of vuln.effects) directDependents(dependent, found, seen);
    return found;
};

// A package's `via` lists its own advisories as objects and the ones it
// inherits as bare package names, so the objects are each advisory once.
const reported = new Set();
const blocking = [];
for (const vuln of Object.values(report.vulnerabilities)) {
    for (const advisory of vuln.via) {
        if (typeof advisory !== 'object') continue;
        const id = advisory.url.split('/').pop();
        reported.add(id);
        if (advisory.severity !== 'high' && advisory.severity !== 'critical') continue;
        const through = [...directDependents(vuln.name)];
        const accepted = ACCEPTED[id];
        if (accepted && through.every((dep) => accepted.via.includes(dep))) {
            console.log(`accepted: ${id} (${accepted.why}) via ${through.join(', ')}`);
            continue;
        }
        blocking.push(
            `  ${advisory.severity}: ${vuln.name} ${advisory.range} via ${through.join(', ')}\n` +
            `    ${advisory.title}\n    ${advisory.url}`,
        );
    }
}

for (const id of Object.keys(ACCEPTED)) {
    if (!reported.has(id)) {
        console.log(`::warning::${id} is no longer reported - remove it from ACCEPTED in ts/scripts/audit-gate.mjs`);
    }
}

if (blocking.length) {
    console.error('npm audit: high/critical advisories:');
    console.error(blocking.join('\n'));
    console.error('Bump the dependency, or if nothing is patched and it cannot reach us, accept it in ACCEPTED.');
    process.exit(1);
}
console.log('npm audit: nothing high or critical outside the accepted list.');

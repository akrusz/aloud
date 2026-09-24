#!/usr/bin/env node
// `tauri build` refuses to bundle when an @tauri-apps/* npm package and its Rust
// crate disagree on major.minor - but only at release time, after the tag is out.
// Dependabot bumps npm and cargo in separate PRs, so one side can land alone
// (v2.11.2: plugin-updater 2.12 on npm, 2.11 in Cargo.lock). This runs the same
// comparison from the two lockfiles so CI catches it on the PR.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const npmLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
const cargoLock = readFileSync(join(root, 'src-tauri', 'Cargo.lock'), 'utf8');

const crateVersions = new Map();
for (const [, name, version] of cargoLock.matchAll(/^name = "([^"]+)"\nversion = "([^"]+)"/gm)) {
    crateVersions.set(name, version);
}

const majorMinor = (v) => v.split('.').slice(0, 2).join('.');
const mismatches = [];
let checked = 0;
for (const [path, info] of Object.entries(npmLock.packages ?? {})) {
    const m = path.match(/^node_modules\/@tauri-apps\/(api|plugin-[a-z-]+)$/);
    if (!m) continue;
    const crate = m[1] === 'api' ? 'tauri' : `tauri-${m[1]}`;
    const crateVersion = crateVersions.get(crate);
    if (!crateVersion) continue;
    checked++;
    if (majorMinor(info.version) !== majorMinor(crateVersion)) {
        mismatches.push(`  @tauri-apps/${m[1]} ${info.version}  vs  ${crate} ${crateVersion}`);
    }
}

if (mismatches.length) {
    console.error('Tauri npm/crate version mismatch (tauri build will refuse to bundle):');
    console.error(mismatches.join('\n'));
    console.error('Bump the lagging side so major.minor matches (npm install / cargo update -p <crate>).');
    process.exit(1);
}
console.log(`Tauri npm/crate versions aligned (${checked} pairs).`);

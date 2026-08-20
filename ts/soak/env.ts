/**
 * Load provider keys from ts/server/.env for local tooling, the same file the
 * hosted server reads, so the harness needs no key setup of its own. Real
 * environment variables win over the file.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function loadServerEnv(): void {
    let raw: string;
    try {
        raw = readFileSync(fileURLToPath(new URL('../server/.env', import.meta.url)), 'utf8');
    } catch {
        return; // no .env; keys must come from the environment
    }
    for (const line of raw.split('\n')) {
        const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
        if (!m) continue;
        const key = m[1] as string;
        let value = m[2] as string;
        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }
        if (!value || process.env[key] !== undefined) continue;
        process.env[key] = value;
    }
}

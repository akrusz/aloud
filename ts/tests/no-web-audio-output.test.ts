import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Everything audible plays through <audio> elements: WebKit's Web Audio output
// can go silent for good with nothing the page can see
// (dev-docs/audio-output.md). The mic capture graphs connect to a destination
// only to keep their processor pulled; they make no sound.
const CAPTURE_GRAPHS = new Set(['adapters/whisper-pcm-stt.ts', 'barge-in.ts']);

const TS_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UI_SRC = join(TS_ROOT, 'ui/src');

/** The UI's tracked sources: a local experiment is its author's business
 *  until it is committed. Every file on disk where git can't say. */
function sources(): string[] {
    try {
        return execFileSync('git', ['ls-files', '--', 'ui/src'], { cwd: TS_ROOT, encoding: 'utf8' })
            .split('\n')
            .filter((p) => p.endsWith('.ts'))
            .map((p) => join(TS_ROOT, p));
    } catch {
        const files: string[] = [];
        const walk = (dir: string): void => {
            for (const name of readdirSync(dir)) {
                const p = join(dir, name);
                if (statSync(p).isDirectory()) walk(p);
                else if (name.endsWith('.ts')) files.push(p);
            }
        };
        walk(UI_SRC);
        return files;
    }
}

function withoutComments(code: string): string {
    return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no Web Audio output', () => {
    it('nothing in the UI plays through an AudioContext', () => {
        const found: string[] = [];
        for (const file of sources()) {
            const rel = relative(UI_SRC, file);
            const code = withoutComments(readFileSync(file, 'utf8'));
            for (const m of code.matchAll(/\bcreate(BufferSource|Oscillator)\s*\(/g)) found.push(`${rel}: ${m[0]}`);
            if (CAPTURE_GRAPHS.has(rel)) continue;
            for (const m of code.matchAll(/\.connect\([^)]*\.destination\b/g)) found.push(`${rel}: ${m[0]}`);
        }
        expect(
            found,
            'Web Audio output is back. Play sounds through sound-player.ts (speech: playbackAudio); see dev-docs/audio-output.md'
        ).toEqual([]);
    });

    it('scans the UI sources', () => {
        expect(sources().length).toBeGreaterThan(50);
    });
});

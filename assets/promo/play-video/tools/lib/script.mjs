/**
 * Reads play-video/script.md: the spoken and captioned lines by id, and the
 * "Real excerpts" table. The build takes every word on screen from here, so a
 * reworded line in the script is a reworded line in the video.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const VIDEO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BUILD_DIR = join(VIDEO_DIR, 'build');
export const REPO_ROOT = join(VIDEO_DIR, '..', '..', '..');

/** `aloud [f0]: text`, `you   [e1]: text`, `caption [c1]: text`. */
const LINE = /^(aloud|you|caption)\s+\[([a-z]+\d+)\]:\s*(.+?)\s*$/;
/** `| e1 | 0084-t028-spec | 0 | end |` */
const EXCERPT = /^\|\s*([a-z]+\d+)\s*\|\s*([\w-]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+|end)\s*\|$/;

export function readScript(path = join(VIDEO_DIR, 'script.md')) {
    const lines = {};
    const excerpts = {};
    for (const raw of readFileSync(path, 'utf8').split('\n')) {
        const line = LINE.exec(raw);
        if (line) {
            const [, kind, id, text] = line;
            if (lines[id]) throw new Error(`script.md has two lines with the id [${id}]`);
            lines[id] = { id, kind, text };
            continue;
        }
        const row = EXCERPT.exec(raw.trim());
        if (row) {
            const [, id, clip, from, to] = row;
            excerpts[id] = { clip, in: Number(from), out: to === 'end' ? null : Number(to) };
        }
    }
    return { lines, excerpts };
}

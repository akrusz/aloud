/**
 * Receives a phone's speech clips over USB (Settings > Developer > "Save my
 * speech clips", ui/src/stt-clip-recorder.ts) and writes them in the desktop
 * app's layout, <out>/<capture>/NNNN-tNNN-<label>.wav + .json, which
 * `npm run stt:replay` reads.
 *
 *   npm --prefix ts run stt:clip-sink [-- <out-dir>]
 *
 * Start it before the session and leave the phone plugged in. Android only,
 * and a debug build only. The clips are the dev's own speech: the default
 * folder is under .probe-data/, which must stay out of git.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** STT_CLIP_SINK_PORT in ui/src/stt-clip-recorder.ts, which Node can't import
 *  (it reads Vite's import.meta.env). */
const STT_CLIP_SINK_PORT = 8793;

const MAX_BYTES = 64 * 1024 * 1024;
const out = path.resolve(
    process.argv[2] ?? fileURLToPath(new URL('../../.probe-data/phone-captures', import.meta.url)),
);
const reverse = `tcp:${STT_CLIP_SINK_PORT}`;

const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Private-Network': 'true',
};

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, cors).end();
        return;
    }
    const m = /^(?:\/app\/v1)?\/stt-clips\/([\w-]+)\/([\w-]+)\/(wav|json)$/.exec(req.url ?? '');
    if (req.method !== 'POST' || !m) {
        res.writeHead(404, cors).end();
        return;
    }
    const [, capture, name, kind] = m as unknown as [string, string, string, string];
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_BYTES) req.destroy();
        else chunks.push(d);
    });
    req.on('end', () => {
        const dir = path.join(out, capture);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `${name}.${kind}`), Buffer.concat(chunks));
        if (kind === 'wav') console.log(`${new Date().toTimeString().slice(0, 8)} ${capture}/${name} ${(size / 32000).toFixed(1)}s`);
        res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"status":"ok"}');
    });
});

server.listen(STT_CLIP_SINK_PORT, '127.0.0.1', () => {
    try {
        execFileSync('adb', ['reverse', reverse, reverse], { stdio: 'ignore' });
        console.log(`listening on ${STT_CLIP_SINK_PORT}, reversed to the phone; writing to ${out}`);
    } catch {
        console.log(`listening on ${STT_CLIP_SINK_PORT}, but \`adb reverse ${reverse} ${reverse}\` failed: is the phone plugged in?`);
    }
});

process.on('SIGINT', () => {
    try {
        execFileSync('adb', ['reverse', '--remove', reverse], { stdio: 'ignore' });
    } catch {
        // The phone may already be unplugged.
    }
    process.exit(0);
});

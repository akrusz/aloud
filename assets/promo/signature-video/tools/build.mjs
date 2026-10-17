#!/usr/bin/env node
/**
 * Build the signature-sound video from cut.mjs.
 *
 *   node assets/promo/signature-video/tools/build.mjs              # soundtrack, frames, mp4
 *   node assets/promo/signature-video/tools/build.mjs --still 12,40   # single frames, to look at
 *   node assets/promo/signature-video/tools/build.mjs --preview    # watch it play in a browser
 *   node assets/promo/signature-video/tools/build.mjs --range 50,58   # only those seconds
 *
 * The soundtrack and what the picture reads from it (tools/analyze.py) are
 * redone whenever cut.mjs or analyze.py is newer than them. Needs uv, ffmpeg
 * and the system Chrome. Writes build/aloud-signature-sounds.mp4. Flags:
 * --workers <n> (Chrome tabs rendering at once, default 4), --keep (leave the
 * frame PNGs in build/frames/), --out <file>.
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../../../ts/node_modules/playwright-core/index.mjs';
import { layout } from '../cut.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const REPO_ROOT = resolve(ROOT, '../../..');
const BUILD = join(ROOT, 'build');
const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const CHROME = process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WORKERS = Number(flag('workers', 4));
const RANGE = flag('range', null)?.split(',').map(Number) ?? null;
const OUT = flag('out', RANGE ? join(BUILD, `clip-${RANGE[0]}-${RANGE[1]}.mp4`) : join(BUILD, 'aloud-signature-sounds.mp4'));
const FILM_PATH = '/assets/promo/signature-video/film/film.html';

const cut = layout();
mkdirSync(BUILD, { recursive: true });

// ---- soundtrack + analysis ----------------------------------------------------

const mtime = (p) => (existsSync(p) ? statSync(p).mtimeMs : 0);
const built = Math.min(mtime(join(BUILD, 'mix.wav')), mtime(join(BUILD, 'analysis.json')));
const sources = [join(ROOT, 'cut.mjs'), join(HERE, 'analyze.py')];
if (args.includes('--audio') || sources.some((p) => mtime(p) > built)) {
    writeFileSync(join(BUILD, 'cues.json'), JSON.stringify({ fps: cut.fps, duration: cut.duration, lufs: cut.lufs, cues: cut.cues }, null, 1));
    console.log(`soundtrack: ${cut.cues.length} cues, ${cut.duration.toFixed(1)}s`);
    execFileSync('uv', ['run', '-q', '--with', 'numpy', '--with', 'scipy', 'python', join(HERE, 'analyze.py')], { stdio: 'inherit' });
}

// ---- the film page, served -----------------------------------------------------

/** The film imports cut.mjs and reads the analysis over HTTP (a page opened
 *  from disk can't fetch), so serve the repo to localhost. */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.wav': 'audio/wav', '.f32': 'application/octet-stream' };
const server = createServer((req, res) => {
    const path = normalize(join(REPO_ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(REPO_ROOT) || !existsSync(path) || !statSync(path).isFile()) {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(path).pipe(res);
});
await new Promise((done) => server.listen(Number(flag('port', 0)), '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;

if (args.includes('--preview')) {
    console.log(`${origin}${FILM_PATH}?preview\n  space plays and pauses, arrows step a frame (shift: a second). Ctrl-C to stop.`);
    await new Promise(() => {});
}

const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--hide-scrollbars', '--force-color-profile=srgb', '--mute-audio'],
});

async function openFilm() {
    const page = await browser.newPage({ viewport: { width: cut.width, height: cut.height }, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => {
        console.error(`film.js: ${err.message}`);
        process.exitCode = 1;
    });
    page.on('console', (msg) => {
        if (msg.type() === 'error') console.error(`film: ${msg.text()}`);
    });
    await page.goto(`${origin}${FILM_PATH}`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 60000 });
    return page;
}

try {
    const stills = flag('still', null);
    if (stills) {
        const dir = join(BUILD, 'stills');
        mkdirSync(dir, { recursive: true });
        const page = await openFilm();
        for (const at of stills.split(',').map(Number)) {
            await page.evaluate((t) => window.seek(t), at);
            const path = join(dir, `${at.toFixed(2).padStart(6, '0')}.png`);
            await page.screenshot({ path });
            console.log(path);
        }
    } else {
        const frames = join(BUILD, 'frames');
        rmSync(frames, { recursive: true, force: true });
        mkdirSync(frames, { recursive: true });
        const total = Math.round(cut.duration * cut.fps);
        const first = RANGE ? Math.max(0, Math.round(RANGE[0] * cut.fps)) : 0;
        const last = RANGE ? Math.min(total, Math.round(RANGE[1] * cut.fps)) : total;
        let next = first;
        let done = 0;
        const started = Date.now();
        await Promise.all(
            Array.from({ length: WORKERS }, async () => {
                const page = await openFilm();
                for (let i = next++; i < last; i = next++) {
                    await page.evaluate((t) => window.seek(t), i / cut.fps);
                    await page.screenshot({ path: join(frames, `${String(i - first).padStart(5, '0')}.png`) });
                    if (++done % 300 === 0) console.log(`  ${done}/${last - first} frames, ${((Date.now() - started) / 1000).toFixed(0)}s`);
                }
            })
        );
        if (process.exitCode) throw new Error('the film page reported errors; not encoding');
        // sRGB frames to BT.709 video range, tagged, so players don't guess.
        execFileSync(
            'ffmpeg',
            [
                '-hide_banner', '-loglevel', 'warning', '-y',
                '-framerate', String(cut.fps), '-i', join(frames, '%05d.png'),
                ...(RANGE ? ['-ss', String(first / cut.fps), '-t', String((last - first) / cut.fps)] : []),
                '-i', join(BUILD, 'mix.wav'),
                '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-profile:v', 'high',
                '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
                '-c:a', 'aac', '-b:a', '320k', '-ar', '48000',
                '-shortest', '-movflags', '+faststart',
                OUT,
            ],
            { stdio: 'inherit' }
        );
        if (!args.includes('--keep')) rmSync(frames, { recursive: true, force: true });
        console.log(`${OUT}\n  ${((last - first) / cut.fps).toFixed(2)}s, ${last - first} frames`);
    }
} finally {
    await browser.close();
    server.close();
}

#!/usr/bin/env node
/**
 * Stage 3 of the Play video build: render the film page frame by frame and
 * put the soundtrack under it.
 *
 *   node assets/promo/play-video/tools/render-film.mjs            # the video
 *   node assets/promo/play-video/tools/render-film.mjs --still 12.5,40   # single frames, to look at
 *   node assets/promo/play-video/tools/render-film.mjs --preview  # serve film.html?preview to watch it play
 *
 * Needs build/timeline.json + build/audio/mix.wav (build-audio.mjs) and
 * build/ui/ (capture-ui.mjs). Writes build/aloud-play-video.mp4. Flags:
 * --workers <n> (Chrome tabs rendering at once, default 4), --keep (leave the
 * frame PNGs in build/frames/), --out <file>.
 */

import { execFileSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from '../../../../ts/node_modules/playwright-core/index.mjs';
import { BUILD_DIR, REPO_ROOT } from './lib/script.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const CHROME = process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const WORKERS = Number(flag('workers', 4));
const OUT = flag('out', join(BUILD_DIR, 'aloud-play-video.mp4'));
const FRAMES_DIR = join(BUILD_DIR, 'frames');
const STILLS_DIR = join(BUILD_DIR, 'stills');
const FILM_PATH = '/assets/promo/play-video/film/film.html';

for (const needed of ['timeline.json', 'audio/mix.wav', 'ui/manifest.json']) {
    if (!existsSync(join(BUILD_DIR, needed))) {
        console.error(`No build/${needed} - run build-audio.mjs, then capture-ui.mjs, first.`);
        process.exit(1);
    }
}
const timeline = JSON.parse(readFileSync(join(BUILD_DIR, 'timeline.json'), 'utf8'));
const filmed = JSON.parse(readFileSync(join(BUILD_DIR, 'ui', 'manifest.json'), 'utf8'));
if (filmed.cut !== timeline.cut) {
    console.error('The UI shots in build/ui/ were filmed for different timings - run capture-ui.mjs again.');
    process.exit(1);
}

/** The film reads its timeline, the filmed UI and the logo font over HTTP (a
 *  page opened from disk can't fetch), so serve the repo to localhost. */
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.woff2': 'font/woff2', '.wav': 'audio/wav' };
const server = createServer((req, res) => {
    const path = normalize(join(REPO_ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname)));
    if (!path.startsWith(REPO_ROOT) || !existsSync(path) || !statSync(path).isFile()) {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(path).pipe(res);
});
await new Promise((resolve) => server.listen(Number(flag('port', 0)), '127.0.0.1', resolve));
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
    const page = await browser.newPage({ viewport: { width: timeline.width, height: timeline.height }, deviceScaleFactor: 1 });
    page.on('pageerror', (err) => {
        console.error(`film.js: ${err.message}`);
        process.exitCode = 1;
    });
    await page.goto(`${origin}${FILM_PATH}`);
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 30000 });
    return page;
}

try {
    const stills = flag('still', null);
    if (stills) {
        mkdirSync(STILLS_DIR, { recursive: true });
        const page = await openFilm();
        for (const at of stills.split(',').map(Number)) {
            await page.evaluate((t) => window.seek(t), at);
            const path = join(STILLS_DIR, `${at.toFixed(2).padStart(6, '0')}.png`);
            await page.screenshot({ path });
            console.log(path);
        }
    } else {
        rmSync(FRAMES_DIR, { recursive: true, force: true });
        mkdirSync(FRAMES_DIR, { recursive: true });
        let next = 0;
        let done = 0;
        const started = Date.now();
        await Promise.all(
            Array.from({ length: WORKERS }, async () => {
                const page = await openFilm();
                for (let i = next++; i < timeline.frames; i = next++) {
                    await page.evaluate((t) => window.seek(t), i / timeline.fps);
                    await page.screenshot({ path: join(FRAMES_DIR, `${String(i).padStart(5, '0')}.png`) });
                    if (++done % 300 === 0) console.log(`  ${done}/${timeline.frames} frames, ${((Date.now() - started) / 1000).toFixed(0)}s`);
                }
            })
        );
        if (process.exitCode) throw new Error('the film page reported errors; not encoding');
        // sRGB frames to BT.709 video range, tagged, so players don't guess.
        execFileSync(
            'ffmpeg',
            [
                '-hide_banner', '-loglevel', 'warning', '-y',
                '-framerate', String(timeline.fps), '-i', join(FRAMES_DIR, '%05d.png'),
                '-i', join(BUILD_DIR, 'audio', 'mix.wav'),
                '-vf', 'scale=in_range=pc:out_range=tv:out_color_matrix=bt709,format=yuv420p',
                '-c:v', 'libx264', '-preset', 'slow', '-crf', '15', '-profile:v', 'high',
                '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709', '-color_range', 'tv',
                '-c:a', 'aac', '-b:a', '320k', '-ar', '48000',
                '-movflags', '+faststart',
                OUT,
            ],
            { stdio: 'inherit' }
        );
        if (!args.includes('--keep')) rmSync(FRAMES_DIR, { recursive: true, force: true });
        console.log(`${OUT}\n  ${timeline.duration.toFixed(2)}s, ${timeline.frames} frames`);
    }
} finally {
    await browser.close();
    server.close();
}

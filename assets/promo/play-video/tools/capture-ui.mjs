#!/usr/bin/env node
/**
 * Stage 2 of the Play video build: film the real UI, one frame at a time.
 *
 *   npm run web:dev                      # UI :4649 + Hono :8787, from the repo root
 *   node assets/promo/play-video/tools/capture-ui.mjs [--only <shot>] [--url http://localhost:4649/]
 *
 * Reads build/timeline.json (run build-audio.mjs first) and writes one PNG
 * per video frame for each shot to build/ui/<shot>/, plus build/ui/manifest.json
 * for the film to find them. Each shot is the app at phone size in the system
 * Chrome: a session screen, or a control on the setup or Settings page.
 *
 * What is real and what is staged: the app, its layout and its motion are the
 * live UI, and the setup controls are worked by real clicks. The words in a
 * session transcript are written in from script.md (lib/stage.js says why),
 * and the voice label reads Harper, the voice the soundtrack uses. No model,
 * no speech service and no account is touched: the model call is blocked and
 * the recognizer is a stub.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from '../../../../ts/node_modules/playwright-core/index.mjs';
import { BUILD_DIR, VIDEO_DIR } from './lib/script.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};
const URL_BASE = flag('url', 'http://localhost:4649/');
const ONLY = flag('only', null);
const CHROME = process.env['CHROME_PATH'] ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UI_DIR = join(BUILD_DIR, 'ui');

/** A tall-ish Android phone, in CSS px. */
const PHONE = { width: 412, height: 892 };

const timelinePath = join(BUILD_DIR, 'timeline.json');
if (!existsSync(timelinePath)) die('No build/timeline.json - run tools/build-audio.mjs first.');
const timeline = JSON.parse(readFileSync(timelinePath, 'utf8'));
const FPS = timeline.fps;
const beat = (id) => timeline.beats.find((b) => b.id === id);
const line = (id) => timeline.lines[id];

function die(msg) {
    console.error(msg);
    process.exit(1);
}

/** Clicks on the setup form at `at` seconds into caption `id`. */
const during = (id, steps) => steps.map(([at, selector, value]) => ({ t: line(id).start + at, selector, value }));
const TAPS = [0.35, 0.75, 1.15];

/**
 * The shots. `from`/`to` are video time; a shot holds a frame for every video
 * frame in between. `region` crops to a part of the page (and the shot then
 * runs at a higher pixel density, because the film enlarges it).
 */
const shots = [
    beat('hook') && {
        name: 'hook',
        stage: 'hook',
        boot: 'exploration',
        dpr: 2,
        // Starts before the beat: the phone is already rising as the bowl fades.
        from: Math.max(0, beat('hook').start - 1.2),
        to: beat('hook').end,
        note: '#orb',
    },
    beat('felt') && { name: 'felt', stage: 'felt', boot: 'felt_sense', dpr: 2, from: beat('felt').start, to: beat('felt').end },
    beat('noting') && { name: 'noting', stage: 'noting', boot: 'noting', dpr: 2, from: beat('noting').start, to: beat('noting').end },
    line('c7') && {
        name: 'focus',
        stage: 'setup',
        boot: 'setup',
        dpr: 3,
        region: ['.form-group:has(> .modifier-toggles input[name="focus"])'],
        from: line('c7').start,
        to: line('c7').end,
        actions: during('c7', ['body_sensations', 'emotions', 'inner_parts'].map((v, i) => [TAPS[i], `input[name="focus"][value="${v}"]`])),
    },
    line('c8') && {
        name: 'vibe',
        stage: 'setup',
        boot: 'setup',
        dpr: 3,
        region: ['.form-group:has(> .modifier-toggles input[name="quality"])'],
        from: line('c8').start,
        to: line('c8').end,
        actions: during('c8', ['playful', 'compassionate', 'spacious'].map((v, i) => [TAPS[i], `input[name="quality"][value="${v}"]`])),
    },
    line('c9') && {
        name: 'guidance',
        stage: 'setup',
        boot: 'setup',
        dpr: 3,
        region: ['.setup-guidance-group'],
        from: line('c9').start,
        to: line('c9').end,
        // "more guidance" up to Directing, "or more space" down to Following.
        actions: during('c9', [[0.3, '#directiveness', 3], [0.42, '#directiveness', 4], [1.0, '#directiveness', 3], [1.1, '#directiveness', 2], [1.2, '#directiveness', 1], [1.3, '#directiveness', 0]]),
    },
    line('c10') && {
        name: 'checkin',
        stage: 'setup',
        boot: 'settings',
        dpr: 3,
        region: ['#settings-checkins', '#s-checkin-timing-group'],
        from: line('c10').start,
        to: line('c10').end,
        actions: during('c10', [
            [0.3, 'input[name="s-checkin-mode"][value="simple"]'],
            ...[0.75, 0.95, 1.15, 1.35].map((at) => [at, '.stepper-dec[data-target="s-silence-sec"]']),
        ]),
    },
    line('v1') && {
        name: 'timer',
        stage: 'timer',
        boot: 'exploration',
        dpr: 2,
        from: timeline.marks.timerAsk,
        to: beat('tune').end,
        note: '#timer',
    },
    // The same moment again, close on the clock, for the film's magnifier.
    line('v1') && {
        name: 'timer-clock',
        stage: 'timer',
        boot: 'exploration',
        dpr: 6,
        region: ['#timer'],
        pad: [6, 22],
        fixedChrome: true,
        from: timeline.marks.timerAsk,
        to: beat('tune').end,
    },
].filter(Boolean);

try {
    await fetch(URL_BASE, { signal: AbortSignal.timeout(2000) });
} catch {
    die(`Nothing serving ${URL_BASE} - run \`npm run web:dev\` from the repo root first.`);
}
if (!existsSync(CHROME)) die(`No Chrome at ${CHROME} (set CHROME_PATH).`);

const browser = await chromium.launch({
    executablePath: CHROME,
    args: [
        '--mute-audio',
        '--hide-scrollbars',
        '--force-color-profile=srgb',
        // Grant the mic to a fake device, or the session view opens on a
        // "microphone access is blocked" notice.
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
    ],
});

async function openApp(shot) {
    const context = await browser.newContext({
        viewport: shot.region && !shot.fixedChrome ? { width: PHONE.width, height: 1500 } : PHONE,
        deviceScaleFactor: shot.dpr,
        isMobile: true,
        hasTouch: true,
        colorScheme: 'dark',
    });
    // A recognizer that listens and never hears: headless Chrome's own fails
    // at once, and the session view answers that with an outage banner.
    await context.addInitScript(() => {
        class SilentRecognizer extends EventTarget {
            start() {
                setTimeout(() => this.onstart?.(new Event('start')), 50);
            }
            stop() {
                setTimeout(() => this.onend?.(new Event('end')), 10);
            }
            abort() {
                this.stop();
            }
        }
        window.SpeechRecognition = SilentRecognizer;
        window.webkitSpeechRecognition = SilentRecognizer;
    });
    const page = await context.newPage();
    // The dev default provider is local Ollama, and a session's first act is
    // to load its model. Nothing here needs a reply, so don't wake it.
    await page.route(/\/ollama\/api\/(chat|generate|pull|create|show|embed)/, (route) => route.abort());
    await page.route(/api\.github\.com|accounts\.google\.com/, (route) => route.abort());

    await page.goto(URL_BASE);
    await page.evaluate(() => {
        localStorage.setItem('themeMode', 'dark');
        // Not a first run: no setup tour over the shot.
        localStorage.setItem('aloud:aloud-index-guide-done', '1');
        localStorage.setItem('aloud:aloud-client-id', '1');
    });
    await page.reload();
    await page.waitForSelector('#begin-btn');
    await page.waitForTimeout(800);

    if (shot.boot === 'setup') {
        await page.click('#customize-toggle');
        // Start from nothing chosen, so the taps in the shot are the choosing.
        for (const box of await page.$$('input[name="focus"]:checked, input[name="quality"]:checked')) await box.click();
    } else if (shot.boot === 'settings') {
        await page.click('.bottom-nav [data-nav="settings"]');
        await page.waitForSelector('#settings-checkins');
    } else {
        await page.click(`.tab-btn[data-tab="${shot.boot}"]`);
        await page.click('#begin-btn');
        await page.waitForSelector('#conversation');
        // Let the session finish mounting (opener, orb, embers) before staging.
        // The noting shot keeps the circle's introduction, so it has to be up.
        if (shot.boot === 'noting') await page.waitForSelector('#conversation .message.facilitator');
        await page.waitForTimeout(2500);
    }
    await page.waitForTimeout(600);
    return { context, page };
}

/** Where a region shot's elements sit right now: the corner of their union. */
const regionCorner = (page, shot) =>
    page.evaluate((sels) => {
        const rects = sels.map((sel) => document.querySelector(sel)?.getBoundingClientRect());
        if (rects.some((r) => !r)) return null;
        return {
            left: Math.min(...rects.map((r) => r.left)),
            top: Math.min(...rects.map((r) => r.top)),
            right: Math.max(...rects.map((r) => r.right)),
            bottom: Math.max(...rects.map((r) => r.bottom)),
        };
    }, shot.region);

/** The crop for a region shot: the union of its elements, padded, in CSS px.
 *  Returns a function, because a control can move mid-shot (ticking a focus
 *  rewrites the summary line above it) and the crop has to follow. */
async function regionClip(page, shot) {
    if (!shot.fixedChrome) {
        // The bars pinned to the viewport would sit over a cropped control.
        await page.evaluate(() => {
            for (const el of document.querySelectorAll('body *')) {
                const position = getComputedStyle(el).position;
                if (position === 'fixed' || position === 'sticky') el.style.visibility = 'hidden';
            }
        });
        await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: 'start' }), shot.region[0]);
        await page.evaluate(() => window.scrollBy(0, -120));
        await page.waitForTimeout(300);
    }
    const first = await regionCorner(page, shot);
    if (!first) throw new Error(`${shot.name}: region ${shot.region.join(', ')} not on the page`);
    // Tight enough that the neighbours above and below stay out of the crop.
    const [padY, padX] = shot.pad ?? [8, null];
    // Full phone width unless the shot asks for a tight crop.
    const width = Math.round(padX === null ? PHONE.width : first.right - first.left + 2 * padX);
    const height = Math.round(first.bottom - first.top + 2 * padY);
    return async () => {
        const now = await regionCorner(page, shot);
        return { x: padX === null ? 0 : Math.round(now.left - padX), y: Math.round(now.top - padY), width, height };
    };
}

async function film(shot) {
    const { context, page } = await openApp(shot);
    try {
        const dir = join(UI_DIR, shot.name);
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { recursive: true });
        await page.addScriptTag({ path: join(VIDEO_DIR, 'tools', 'lib', 'stage.js') });
        const clipAt = shot.region ? await regionClip(page, shot) : async () => ({ x: 0, y: 0, ...PHONE });
        await page.evaluate(([s, tl]) => window.__film.init(s, tl), [shot, timeline]);
        // Hold the first frame's state long enough for what it put on screen
        // to finish arriving, so the shot doesn't open mid-entrance.
        await page.evaluate((t) => window.__film.settle(t), shot.from);
        await page.waitForTimeout(700);

        const frames = Math.round((shot.to - shot.from) * FPS);
        for (let i = 0; i < frames; i++) {
            await page.evaluate((t) => window.__film.frame(t), shot.from + i / FPS);
            await page.screenshot({
                path: join(dir, `${String(i).padStart(4, '0')}.png`),
                clip: await clipAt(),
                caret: 'hide',
                scale: 'device',
            });
        }
        const clip = await clipAt();
        const noted = shot.note
            ? await page.evaluate((sel) => {
                  const r = document.querySelector(sel)?.getBoundingClientRect();
                  return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
              }, shot.note)
            : null;
        console.log(`  ${shot.name}: ${frames} frames, ${clip.width * shot.dpr}x${clip.height * shot.dpr}`);
        return {
            from: shot.from,
            to: shot.to,
            frames,
            width: clip.width,
            height: clip.height,
            dpr: shot.dpr,
            ...(noted ? { noted } : {}),
        };
    } finally {
        await context.close();
    }
}

const manifestPath = join(UI_DIR, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { fps: FPS, shots: {} };
manifest.fps = FPS;
// A cut is one set of timings. Shots from another one can't be mixed in.
if (manifest.cut !== timeline.cut) manifest.shots = {};
manifest.cut = timeline.cut;
const wanted = shots.filter((s) => !ONLY || ONLY.split(',').includes(s.name));
if (wanted.length === 0) die(`No shot named ${ONLY}. Shots: ${shots.map((s) => s.name).join(', ')}`);
if (!ONLY) manifest.shots = {};

try {
    // Three at a time: each is its own tab, and Chrome screenshots are the
    // slow part.
    const queue = [...wanted];
    await Promise.all(
        Array.from({ length: 3 }, async () => {
            for (let shot = queue.shift(); shot; shot = queue.shift()) manifest.shots[shot.name] = await film(shot);
        })
    );
} finally {
    await browser.close();
}
mkdirSync(UI_DIR, { recursive: true });
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
console.log(manifestPath);

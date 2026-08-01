#!/usr/bin/env node
/**
 * Re-shoot the app screenshots on the landing page: the setup screen
 * (aloud-screen-*.webp) and an exploration session (aloud-session-*.webp),
 * each in both themes. The site shows them as a carousel (docs/js/shots.js).
 *
 * These used to be hand-taken macOS window grabs, which meant a new pair every
 * release at whatever size the window happened to be. This drives headless
 * Chrome over CDP instead: same framing every time, exact pixel width, both
 * themes, no npm dependencies (Node 22's WebSocket + the Chrome you already
 * have + ImageMagick).
 *
 * The window chrome is drawn here rather than captured: the shot is of the web
 * UI, told to dress as the desktop shell (data-shell/data-titlebar, which is
 * what insets the brand clear of the traffic lights), then rounded, dotted and
 * shadowed by ImageMagick. So the picture matches the desktop app without
 * needing a built desktop app.
 *
 * Usage:
 *   cd ts && npm run web:dev          # UI :4649 + Hono :8787 (needed: the
 *                                     # setup page reads its catalogs from
 *                                     # /app/v1, and renders bare without them)
 *   node scripts/site-screenshots.mjs [--width 1000] [--url http://localhost:4649/]
 *
 * Flags: --width (output image width in CSS px, shadow margin included),
 *        --height, --url, --out <dir>, --only <setup|session>,
 *        --keep (leave the intermediate PNGs).
 *
 * The session shot's transcript is sample copy written into the DOM, not a
 * recorded session - see SAMPLE_TURNS. Everything else in it is the live view.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i === -1 ? fallback : args[i + 1];
};

/** Total image width, shadow margin included - this is the number you see in
 *  the file's dimensions, and the one worth tuning. */
const WIDTH = Number(flag('width', 1000));
const HEIGHT = Number(flag('height', 862));
const URL_BASE = flag('url', 'http://localhost:4649/');
const OUT_DIR = flag('out', join(ROOT, 'docs/assets'));
const KEEP = args.includes('--keep');
/** Shoot one of the SHOTS (by id) instead of all of them. */
const ONLY = flag('only', null);

/** Retina: the page renders at 2x so the webp holds up on any display. */
const DPR = 2;
/** Space around the window for the drop shadow, in CSS px per side. */
const MARGIN = 24;
/** Corner radius of the window, in CSS px (macOS Sonoma is ~10-12). */
const RADIUS = 11;
const WIN_W = WIDTH - MARGIN * 2;
const WIN_H = HEIGHT - MARGIN * 2;

const CHROME =
    process.env['CHROME_PATH'] ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const THEMES = ['light', 'dark'];

/**
 * The exchange shown in the in-session shot. Sample copy, not a recording: a
 * real session needs a mic, an LLM and a person, none of which a screenshot
 * script has. Keep it the way the facilitator actually talks - short questions,
 * no platitudes - so the picture doesn't promise a different app.
 */
const SAMPLE_TURNS = [
    ['assistant', "Whenever you're ready - what's here right now?"],
    ['user', "My chest feels tight. Like I've been holding my breath without noticing."],
    ['assistant', 'Let the tightness be there. Does it have an edge, somewhere it stops?'],
    ['user', "It does. About the size of my fist, sitting behind the sternum."],
    ['assistant', 'Stay with it for a few breaths. Tell me if anything about it moves.'],
    ['user', "It didn't move, but it got warmer when I stopped pushing at it."],
    ['assistant', 'So it answers to being left alone. Give it more room and see what it does.'],
];

/** What gets shot, in order. Each entry writes <id>-light.webp / <id>-dark.webp
 *  (the setup shot keeps its historic aloud-screen-* name - the README and the
 *  site's <noscript> fallback point at it). */
const SHOTS = [
    {
        id: 'setup',
        file: (theme) => `aloud-screen-${theme}.webp`,
        prepare: null,
    },
    {
        id: 'session',
        file: (theme) => `aloud-session-${theme}.webp`,
        prepare: 'session',
    },
];

function die(msg) {
    console.error(msg);
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Minimal CDP client: one WebSocket, id-matched replies, awaited events. */
class Cdp {
    #ws;
    #id = 0;
    #pending = new Map();
    #waiters = [];

    static async attach(wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise((resolve, reject) => {
            ws.addEventListener('open', resolve, { once: true });
            ws.addEventListener('error', reject, { once: true });
        });
        return new Cdp(ws);
    }

    constructor(ws) {
        this.#ws = ws;
        ws.addEventListener('message', (e) => {
            const msg = JSON.parse(e.data);
            if (msg.id !== undefined) {
                const p = this.#pending.get(msg.id);
                this.#pending.delete(msg.id);
                if (!p) return;
                if (msg.error) p.reject(new Error(msg.error.message));
                else p.resolve(msg.result);
                return;
            }
            for (const w of this.#waiters.splice(0)) {
                if (w.method === msg.method) w.resolve(msg.params);
                else this.#waiters.push(w);
            }
        });
    }

    send(method, params = {}) {
        const id = ++this.#id;
        this.#ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    }

    once(method, timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
            const w = { method, resolve };
            this.#waiters.push(w);
            setTimeout(() => {
                this.#waiters = this.#waiters.filter((x) => x !== w);
                reject(new Error(`timed out waiting for ${method}`));
            }, timeoutMs);
        });
    }

    /** Evaluate in the page and return the JSON value. */
    async eval(expression) {
        const r = await this.send('Runtime.evaluate', {
            expression,
            returnByValue: true,
            awaitPromise: true,
        });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
        return r.result.value;
    }

    close() {
        this.#ws.close();
    }
}

/** Wait for Chrome to write its debugging port, then find the page target. */
async function chromeEndpoint(profileDir) {
    const portFile = join(profileDir, 'DevToolsActivePort');
    for (let i = 0; i < 100; i++) {
        if (existsSync(portFile)) {
            const [port] = (await readFile(portFile, 'utf8')).split('\n');
            try {
                const res = await fetch(`http://127.0.0.1:${port}/json/list`);
                const targets = await res.json();
                const page = targets.find((t) => t.type === 'page');
                if (page) return page.webSocketDebuggerUrl;
            } catch {
                /* not listening yet */
            }
        }
        await sleep(100);
    }
    throw new Error('Chrome never came up on a debugging port');
}

/** Post-process one raw capture into the framed webp the site loads. */
function frame(pngPath, outPath) {
    const s = DPR;
    const w = WIN_W * s;
    const h = WIN_H * s;
    const dot = (cx, color) =>
        `-fill '${color}' -draw 'circle ${cx * s},${22 * s} ${cx * s},${(22 - 6) * s}'`;
    // Round the corners (a white roundrectangle composited into the alpha
    // channel), draw the traffic lights, then grow the canvas and lay a soft
    // shadow under it.
    const cmd = [
        'magick',
        `'${pngPath}'`,
        '-alpha set',
        `\\( +clone -alpha transparent -background none -fill white -draw 'roundrectangle 0,0 ${w - 1},${h - 1} ${RADIUS * s},${RADIUS * s}' \\)`,
        '-compose DstIn -composite',
        '-compose over',
        dot(20, '#ff5f57'),
        dot(40, '#febc2e'),
        dot(60, '#28c840'),
        `\\( +clone -background black -shadow 40x${9 * s}+0+${5 * s} \\) +swap`,
        '-background none -layers merge +repage',
        `-gravity center -background none -extent ${WIDTH * s}x${HEIGHT * s}`,
        '-define webp:lossless=false -quality 88',
        `'${outPath}'`,
    ].join(' ');
    const r = spawnSync('/bin/sh', ['-c', cmd], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error('ImageMagick failed');
}

/** Load the app with a known theme and a not-a-first-run profile. */
async function bootApp(cdp, theme) {
    await cdp.send('Page.navigate', { url: URL_BASE });
    await cdp.once('Page.loadEventFired');
    // Theme is a localStorage key (theme.ts owns it), so it only takes effect
    // on the next load. The profile is fresh every run, which also means
    // first-run state: mark the setup tour done, or it pops its welcome card
    // over the shot. Provider stays on the 'ollama' default - the hosted
    // provider would gate Begin behind sign-in, and no turn is ever sent.
    await cdp.eval(`(() => {
        localStorage.setItem('themeMode', ${JSON.stringify(theme)});
        localStorage.setItem('aloud:aloud-index-guide-done', '1');
        localStorage.setItem('aloud:aloud-client-id', '1');
        // A 20 minute timer, so the clock in the input row reads as a timer
        // rather than a two-second elapsed count. Partial settings are merged
        // over the defaults on load.
        localStorage.setItem('aloud:app:settings', JSON.stringify({
            sessionClockMode: 'timer',
            sessionTimerMin: 20,
            showSessionClock: true,
        }));
    })()`);
    await cdp.send('Page.reload');
    await cdp.once('Page.loadEventFired');
}

/** Poll until a selector exists - the setup catalogs arrive over fetch, and a
 *  shot taken before them is half-empty. */
async function waitFor(cdp, selector, tries = 100) {
    for (let i = 0; i < tries; i++) {
        if (await cdp.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
        await sleep(100);
    }
    throw new Error(`never saw ${selector}`);
}

/**
 * Begin a session and stage the transcript.
 *
 * The turns are written straight into the DOM rather than spoken: a real
 * exchange needs a mic, an LLM and a person. Everything around them - the
 * clock, the orb, the controls bar, the input row - is the live view, so only
 * the words are staged. Whatever the session view put there on mount (an
 * opener, or a provider error, since nothing is configured here) is cleared
 * first.
 */
async function enterSession(cdp) {
    await cdp.eval(`document.querySelector('#begin-btn').click()`);
    await waitFor(cdp, '#conversation');
    await sleep(1500);
    await cdp.eval(`(() => {
        const conv = document.querySelector('#conversation');
        const typing = conv.querySelector('.typing-indicator, #typing-indicator');
        // Everything but the typing indicator: bubbles from the opener, and
        // any provider notice ("Loading <model> into memory...").
        for (const child of [...conv.children]) if (child !== typing) child.remove();
        for (const [role, text] of ${JSON.stringify(SAMPLE_TURNS)}) {
            const el = document.createElement('div');
            el.className = 'message ' + (role === 'assistant' ? 'facilitator' : 'user');
            const content = document.createElement('div');
            content.className = 'message-content';
            content.textContent = text;
            el.appendChild(content);
            if (typing) conv.insertBefore(el, typing);
            else conv.appendChild(el);
        }
        if (typing) typing.classList.add('hidden');
        conv.scrollTop = conv.scrollHeight;
        // Nothing is generating - the app is between turns, waiting on a voice.
        const status = document.querySelector('#voice-status');
        if (status) status.textContent = 'Listening…';
        // Any dialog the mountless session put up (mic, provider, credits) is
        // noise in a screenshot.
        for (const o of document.querySelectorAll('.voice-modal-overlay, .app-dialog-overlay, .modal-overlay')) {
            o.remove();
        }
    })()`);
}

/** Last pass before the shutter: anything transient that drifted in while we
 *  waited (toasts, dialogs) is noise in a screenshot, and the status line
 *  should read as a session between turns rather than mid-error. */
async function clearChrome(cdp, shot) {
    await cdp.eval(`(() => {
        for (const el of document.querySelectorAll(
            '.error-toast, .voice-modal-overlay, .app-dialog-overlay, .modal-overlay'
        )) el.remove();
        ${
            shot.prepare === 'session'
                ? `const status = document.querySelector('#voice-status');
                   if (status) status.textContent = 'Listening…';`
                : ''
        }
    })()`);
}

/** Wear the desktop shell's clothes: this is what pads the brand clear of the
 *  traffic lights drawn on in post. */
async function dressAsDesktop(cdp, theme) {
    await cdp.eval(`(() => {
        const h = document.documentElement;
        h.setAttribute('data-shell', 'tauri');
        h.setAttribute('data-titlebar', 'overlay');
        h.setAttribute('data-theme', ${JSON.stringify(theme)});
        if (document.activeElement) document.activeElement.blur();
        window.scrollTo(0, 0);
    })()`);
}

async function main() {
    if (!existsSync(CHROME)) die(`No Chrome at ${CHROME} (set CHROME_PATH).`);
    if (spawnSync('magick', ['-version'], { stdio: 'ignore' }).status !== 0) {
        die('ImageMagick (magick) not found - brew install imagemagick');
    }
    try {
        await fetch(URL_BASE, { signal: AbortSignal.timeout(2000) });
    } catch {
        die(`Nothing serving ${URL_BASE} - run \`cd ts && npm run web:dev\` first.`);
    }

    const profile = await mkdtemp(join(tmpdir(), 'aloud-shot-'));
    const chrome = spawn(
        CHROME,
        [
            '--headless=new',
            '--remote-debugging-port=0',
            `--user-data-dir=${profile}`,
            `--window-size=${WIN_W},${WIN_H}`,
            '--hide-scrollbars',
            '--force-color-profile=srgb',
            '--disable-extensions',
            '--no-first-run',
            '--mute-audio',
            // Grant the mic to a fake device: without it the session view puts
            // up a "microphone access is blocked" toast over the shot.
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            'about:blank',
        ],
        { stdio: 'ignore' }
    );

    let cdp;
    try {
        cdp = await Cdp.attach(await chromeEndpoint(profile));
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride', {
            width: WIN_W,
            height: WIN_H,
            deviceScaleFactor: DPR,
            mobile: false,
        });
        await mkdir(OUT_DIR, { recursive: true });

        for (const theme of THEMES) {
            for (const shot of SHOTS) {
                if (ONLY && ONLY !== shot.id) continue;
                await bootApp(cdp, theme);
                // The setup view is the landing view either way, and Begin
                // lives on it.
                await waitFor(cdp, '#begin-btn');
                if (shot.prepare === 'session') await enterSession(cdp);
                await dressAsDesktop(cdp, theme);
                // Let the orb's entrance animation and the theme transition
                // finish before the shutter.
                await sleep(1200);
                await clearChrome(cdp, shot);

                const { data } = await cdp.send('Page.captureScreenshot', {
                    format: 'png',
                    captureBeyondViewport: false,
                });
                const raw = join(profile, `${shot.id}-${theme}.png`);
                await writeFile(raw, Buffer.from(data, 'base64'));
                const out = join(OUT_DIR, shot.file(theme));
                frame(raw, out);
                console.log(`${out}  ${WIDTH * DPR}x${HEIGHT * DPR}`);
                if (KEEP) console.log(`  raw: ${raw}`);
            }
        }
    } finally {
        cdp?.close();
        chrome.kill();
        if (!KEEP) await rm(profile, { recursive: true, force: true });
    }

    console.log(
        `\nRemember: docs/index.html hardcodes the img width/height (${WIDTH * DPR}x${HEIGHT * DPR}).`
    );
}

await main();

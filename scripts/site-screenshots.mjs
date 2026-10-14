#!/usr/bin/env node
/**
 * Re-shoot the app screenshots on the landing page: the setup screen
 * (aloud-screen-*.webp) and an exploration session (aloud-session-*.webp),
 * each in both themes. The site shows them as a carousel (docs/js/shots.js).
 *
 * Drives headless Chrome over CDP, so every release gets the same framing at
 * an exact pixel width in both themes, with no npm dependencies (Node 22's
 * WebSocket + the Chrome you already have + ImageMagick).
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
 * recorded session - see SAMPLE_TURNS in lib/app-shots.mjs. Everything else
 * in it is the live view.
 */

import { spawnSync } from 'node:child_process';
import { writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    bootApp,
    clearTransients,
    enterSession,
    launchChrome,
    preflight,
    sleep,
    waitFor,
} from './lib/app-shots.mjs';

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

const THEMES = ['light', 'dark'];

/** The narrator voice for the session shot: any voice that isn't hosted (see
 *  bootApp). Never heard - Chrome runs muted - but its name is in the picture,
 *  bottom right of the session view. */
const LOCAL_VOICE = 'browser:Ava (Premium)';

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
async function loadApp(cdp, theme, shot) {
    const settings = {
        // A 20 minute timer, so the clock in the input row reads as a timer
        // rather than a two-second elapsed count. Partial settings are merged
        // over the defaults on load.
        sessionClockMode: 'timer',
        sessionTimerMin: 20,
        showSessionClock: true,
    };
    // Begin gates behind sign-in when ANY leg of the session is hosted (LLM,
    // STT or narrator voice), and no turn is ever sent. The provider stays on
    // the local 'ollama' default, but with aloud cloud reachable the setup
    // page fills a blank voice with a hosted one - so the session shot pins a
    // local voice. The setup shot keeps the hosted pick, which is what a
    // visitor's first screen shows.
    if (shot.prepare === 'session') settings.defaultVoice = LOCAL_VOICE;
    // The profile is fresh every run, which also means first-run state: mark
    // the setup tour done, or it pops its welcome card over the shot.
    await bootApp(cdp, URL_BASE, {
        themeMode: theme,
        'aloud:aloud-index-guide-done': '1',
        'aloud:aloud-client-id': '1',
        'aloud:app:settings': JSON.stringify(settings),
    });
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
    await preflight(URL_BASE);

    const { cdp, profile, close } = await launchChrome({ width: WIN_W, height: WIN_H });
    try {
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
                await loadApp(cdp, theme, shot);
                // The setup view is the landing view either way, and Begin
                // lives on it.
                await waitFor(cdp, '#begin-btn');
                if (shot.prepare === 'session') await enterSession(cdp);
                await dressAsDesktop(cdp, theme);
                // Let the orb's entrance animation and the theme transition
                // finish before the shutter.
                await sleep(1200);
                await clearTransients(cdp, { session: shot.prepare === 'session' });

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
        await close({ keep: KEEP });
    }

    console.log(
        `\nRemember: docs/index.html hardcodes the img width/height (${WIDTH * DPR}x${HEIGHT * DPR}).`
    );
}

await main();

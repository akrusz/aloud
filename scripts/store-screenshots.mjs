#!/usr/bin/env node
/**
 * Shoot the app-store screenshots: each screen in SHOTS, on each device in
 * DEVICES, in both themes, at the exact pixel size the store asks for.
 *
 * Same approach as site-screenshots.mjs (headless Chrome over CDP, no npm
 * dependencies): the web UI is the mobile app's UI, so it's shot in Chrome
 * dressed as the native shell rather than from a simulator. Dressing means
 * the store build's app mode (?mode=web), the CSS hook main.ts stamps in the
 * app (html[data-platform]), the safe-area insets Capacitor injects
 * (--safe-area-inset-*), a status bar drawn into the top inset (a webview
 * never sees the real one), and the setup's one native-only option, the
 * built-in recognizer. Fonts are the Mac's, so the Android shots set text in
 * SF rather than Roboto.
 *
 * Every session leg here is hosted (a fresh profile picks a hosted voice, and
 * the mobile app has no local model), so Begin gates on sign-in. The run
 * answers GET /cloud/v1/me itself with a signed-in account (ACCOUNT) and
 * holds every metered call (LLM, STT, TTS, judge) unanswered, so nothing is
 * billed or spoken and no dev sign-in is needed.
 *
 * Usage:
 *   npm run web:dev                       # UI :4649 + Hono :8787 (catalogs)
 *   node scripts/store-screenshots.mjs [--device iphone] [--only session]
 *                                      [--theme dark] [--out <dir>]
 *
 * Writes <out>/<device>/<nn>-<shot>-<theme>.png, RGB with no alpha channel
 * (both stores reject transparency). The default <out> is
 * assets/store/screenshots/, which is gitignored: the consoles hold the
 * uploaded copies.
 *
 * The session transcript is sample copy written into the DOM (SAMPLE_TURNS in
 * lib/app-shots.mjs); everything around it is the live view.
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

/** ?mode=web (a dev-build override, app-mode.ts) is the mode a store build
 *  runs in: hosted model, no Ollama, BYOK behind its opt-in. */
const URL_BASE = flag('url', 'http://localhost:4649/?mode=web');
const OUT_DIR = flag('out', join(ROOT, 'assets/store/screenshots'));
const KEEP = args.includes('--keep');
const ONLY_DEVICE = flag('device', null);
const ONLY_SHOT = flag('only', null);
const ONLY_THEME = flag('theme', null);

/**
 * One entry per screenshot slot in the consoles. `css` is the viewport in CSS
 * px, `out` the pixel size the store wants; the page renders at out/css, so
 * text is rasterized at the final size rather than resampled. `safe` is the
 * system bars' inset in CSS px, `bar` which status bar to draw into it.
 *
 * App Store: one iPhone set at 6.9" and one iPad set at 13" covers every
 * device size (the console scales them down). Play: phone 9:16 at 1080x1920 is
 * what promotion eligibility asks for; the tablet set is optional.
 */
const DEVICES = {
    iphone: {
        label: 'App Store, iPhone 6.9"',
        css: [440, 956],
        out: [1320, 2868],
        platform: 'ios',
        safe: { top: 62, bottom: 34 },
        bar: 'iphone',
    },
    ipad: {
        label: 'App Store, iPad 13"',
        css: [1032, 1376],
        out: [2064, 2752],
        platform: 'ios',
        safe: { top: 24, bottom: 20 },
        bar: 'ipad',
    },
    android: {
        label: 'Play, phone',
        css: [405, 720],
        out: [1080, 1920],
        platform: 'android',
        safe: { top: 32, bottom: 24 },
        bar: 'android',
    },
    'android-tablet': {
        label: 'Play, 10" tablet',
        css: [810, 1440],
        out: [1620, 2880],
        platform: 'android',
        safe: { top: 32, bottom: 24 },
        bar: 'android',
    },
};

/** What gets shot, in listing order (the number prefixes the file name).
 *  Each starts on the setup view; `session` stages the sample transcript
 *  first, and `prepare` runs last. `themes` narrows THEMES for one shot. */
const SHOTS = [
    { id: 'setup', session: false },
    { id: 'session', session: true },
    {
        id: 'kasina',
        session: true,
        // Gazing mode: the orb leaves the nav for the middle of the screen,
        // and the theme goes dark whatever the run's theme is - so a light
        // one would be a copy.
        themes: ['dark'],
        prepare: (cdp) =>
            cdp.eval(`(() => {
                const toggle = document.querySelector('#kasina-toggle');
                toggle.checked = true;
                toggle.dispatchEvent(new Event('change'));
            })()`),
    },
];

const THEMES = ['light', 'dark'];

/** The signed-in account the fake GET /cloud/v1/me returns. */
const ACCOUNT = {
    id: 'store-shot',
    email: 'you@example.com',
    emailVerified: true,
    creditsRemaining: 40,
    providers: ['google'],
    retreatCovered: false,
    emailUpdates: false,
};

/** Metered calls: held unanswered, so a session waits rather than errors. */
const METERED = /\/cloud\/v1\/(llm|stt|tts|judge)(\/|$|\?)/;

/**
 * Stand in for aloud cloud's account endpoint and swallow its metered ones.
 * Everything else under /cloud/v1 (voices, config, model rates) passes through
 * to the local Hono, which serves it without auth.
 */
async function fakeSignedIn(cdp) {
    cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/cloud/v1/me') && request.method === 'GET') {
            void cdp.send('Fetch.fulfillRequest', {
                requestId,
                responseCode: 200,
                responseHeaders: [
                    { name: 'content-type', value: 'application/json' },
                    { name: 'access-control-allow-origin', value: '*' },
                ],
                body: Buffer.from(JSON.stringify(ACCOUNT)).toString('base64'),
            });
        } else if (METERED.test(path)) {
            /* held */
        } else {
            void cdp.send('Fetch.continueRequest', { requestId });
        }
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*/cloud/v1/*' }] });
}

/** Status bar glyphs, drawn in currentColor so they follow the theme. Shapes
 *  approximate the system ones at their real size in CSS px. */
const ICONS = {
    iosSignal: `<svg width="18" height="12" viewBox="0 0 18 12"><rect x="0" y="8" width="3" height="4" rx="1"/><rect x="5" y="5.5" width="3" height="6.5" rx="1"/><rect x="10" y="3" width="3" height="9" rx="1"/><rect x="15" y="0" width="3" height="12" rx="1"/></svg>`,
    iosWifi: `<svg width="16" height="12" viewBox="0 0 16 12"><path d="M8 2.6c2.3 0 4.4.9 6 2.4l1.2-1.2A10 10 0 0 0 8 .8 10 10 0 0 0 .8 3.8L2 5c1.6-1.5 3.7-2.4 6-2.4Z"/><path d="M8 6c1.4 0 2.6.5 3.6 1.4l1.2-1.2A6.8 6.8 0 0 0 8 4.2c-1.9 0-3.6.8-4.8 2l1.2 1.2C5.4 6.5 6.6 6 8 6Z"/><path d="M8 9.3c.6 0 1.1.2 1.5.6L8 11.4 6.5 9.9c.4-.4.9-.6 1.5-.6Z"/></svg>`,
    iosBattery: `<svg width="27" height="13" viewBox="0 0 27 13"><rect x="0.5" y="0.5" width="23" height="12" rx="3.5" fill="none" stroke="currentColor" stroke-opacity="0.4"/><rect x="2" y="2" width="20" height="9" rx="2"/><path d="M25 4.5v4c.8-.3 1.3-1.1 1.3-2s-.5-1.7-1.3-2Z" fill-opacity="0.4"/></svg>`,
    androidWifi: `<svg width="17" height="13" viewBox="0 0 17 13"><path d="M8.5 13 0 3.2A13 13 0 0 1 8.5 0 13 13 0 0 1 17 3.2Z"/></svg>`,
    androidSignal: `<svg width="13" height="13" viewBox="0 0 13 13"><path d="M13 0v13H0Z"/></svg>`,
    androidBattery: `<svg width="8" height="14" viewBox="0 0 8 14"><rect x="2.5" y="0" width="3" height="2" rx="0.5"/><rect x="0" y="1.5" width="8" height="12.5" rx="1.5"/></svg>`,
};

/** The status bar for each device, as HTML laid over the top safe-area inset. */
function statusBar(bar, height) {
    const box = `position:fixed;top:0;left:0;right:0;height:${height}px;z-index:2147483647;pointer-events:none;display:flex;align-items:center;color:var(--text-primary);fill:currentColor;-webkit-font-smoothing:antialiased;`;
    const icons = (gap, ...names) =>
        `<div style="display:flex;align-items:center;gap:${gap}px">${names.map((n) => ICONS[n]).join('')}</div>`;
    switch (bar) {
        case 'iphone':
            // The ears either side of the Dynamic Island (126 wide), items
            // centred on its midline.
            return `<div style="${box}height:60px;font:600 17px/1 -apple-system,system-ui;letter-spacing:-0.2px">
                <div style="flex:1;display:flex;justify-content:center;padding-left:14px">9:41</div>
                <div style="width:126px"></div>
                <div style="flex:1;display:flex;justify-content:center;padding-right:10px">${icons(6, 'iosSignal', 'iosWifi', 'iosBattery')}</div>
            </div>`;
        case 'ipad':
            return `<div style="${box}justify-content:space-between;padding:0 20px;font:600 15px/1 -apple-system,system-ui">
                <div>9:41 AM&nbsp;&nbsp;Tue Jan 9</div>
                <div style="display:flex;align-items:center;gap:6px">${ICONS.iosWifi}<span>100%</span>${ICONS.iosBattery}</div>
            </div>`;
        case 'android':
            return `<div style="${box}justify-content:space-between;padding:0 22px;font:500 15px/1 Roboto,'Google Sans',system-ui">
                <div>9:41</div>
                ${icons(6, 'androidWifi', 'androidSignal', 'androidBattery')}
            </div>`;
        default:
            throw new Error(`no status bar '${bar}'`);
    }
}

/** Wear the native shell's clothes: the platform hook main.ts stamps, the
 *  insets Capacitor injects, and the status bar the OS would draw. */
async function dressAsMobile(cdp, device, theme) {
    const { top, bottom } = device.safe;
    await cdp.eval(`(() => {
        const h = document.documentElement;
        h.dataset.platform = ${JSON.stringify(device.platform)};
        h.setAttribute('data-theme', ${JSON.stringify(theme)});
        h.style.setProperty('--safe-area-inset-top', '${top}px');
        h.style.setProperty('--safe-area-inset-bottom', '${bottom}px');
        h.style.setProperty('--safe-area-inset-left', '0px');
        h.style.setProperty('--safe-area-inset-right', '0px');
        // The one setup option only a native build lists (stt-picker.ts,
        // gated on isCapacitor()), and its default there; Chrome's own
        // recognizer drops out in its favour. The change event is what moves
        // the rate pill off the cloud recognizer and shows the note a native
        // build puts under this pick.
        const stt = document.querySelector('#setup-stt-engine');
        if (stt && !stt.querySelector('option[value="capacitor"]')) {
            stt.querySelector('option[value="web-speech"]')?.remove();
            stt.prepend(new Option('Built-in transcription', 'capacitor', true, true));
            stt.dispatchEvent(new Event('change'));
        }
        const bar = document.createElement('div');
        bar.innerHTML = ${JSON.stringify(statusBar(device.bar, top))};
        document.body.appendChild(bar);
        // Capacitor sets the insets before the app boots; these land after,
        // and main.ts measures the top chrome's midline (which the setup "?"
        // chip hangs from) at boot and on resize.
        window.dispatchEvent(new Event('resize'));
    })()`);
}

/** Load the app with a known theme, a not-a-first-run profile and a token for
 *  the fake account. */
async function loadApp(cdp, theme) {
    const settings = {
        // A 20 minute timer, so the clock in the input row reads as a timer
        // rather than a two-second elapsed count. Partial settings are merged
        // over the defaults on load.
        sessionClockMode: 'timer',
        sessionTimerMin: 20,
        showSessionClock: true,
    };
    await bootApp(cdp, URL_BASE, {
        themeMode: theme,
        // The profile is fresh every run: mark the setup tour done, or it pops
        // its welcome card over the shot.
        'aloud:aloud-index-guide-done': '1',
        'aloud:aloud-client-id': '1',
        'aloud:app:settings': JSON.stringify(settings),
        'aloud:server:token': 'store-shot',
    });
}

/** Flatten to RGB at the store's exact size. A fractional out/css ratio can
 *  land a pixel off; that last pixel is resampled rather than rejected. */
function finish(rawPath, outPath, [w, h]) {
    const r = spawnSync(
        'magick',
        [rawPath, '-resize', `${w}x${h}!`, '-background', 'white', '-alpha', 'remove', '-alpha', 'off', `PNG24:${outPath}`],
        { stdio: 'inherit' }
    );
    if (r.status !== 0) throw new Error('ImageMagick failed');
}

async function main() {
    const devices = Object.entries(DEVICES).filter(([id]) => !ONLY_DEVICE || id === ONLY_DEVICE);
    if (devices.length === 0) {
        throw new Error(`--device: one of ${Object.keys(DEVICES).join(', ')}`);
    }
    await preflight(URL_BASE);

    const [maxW, maxH] = devices.reduce(
        ([w, h], [, d]) => [Math.max(w, d.css[0]), Math.max(h, d.css[1])],
        [0, 0]
    );
    const { cdp, profile, close } = await launchChrome({ width: maxW, height: maxH });
    try {
        await fakeSignedIn(cdp);
        for (const [deviceId, device] of devices) {
            const [cssW, cssH] = device.css;
            await cdp.send('Emulation.setDeviceMetricsOverride', {
                width: cssW,
                height: cssH,
                deviceScaleFactor: device.out[0] / cssW,
                mobile: true,
            });
            await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
            const dir = join(OUT_DIR, deviceId);
            await mkdir(dir, { recursive: true });
            console.log(`${device.label} (${device.out.join('x')})`);

            for (const theme of THEMES) {
                if (ONLY_THEME && ONLY_THEME !== theme) continue;
                for (const [i, shot] of SHOTS.entries()) {
                    if (ONLY_SHOT && ONLY_SHOT !== shot.id) continue;
                    if (shot.themes && !shot.themes.includes(theme)) continue;
                    await loadApp(cdp, theme);
                    await waitFor(cdp, '#begin-btn');
                    await dressAsMobile(cdp, device, theme);
                    if (shot.session) await enterSession(cdp);
                    await shot.prepare?.(cdp);
                    // Let the orb's entrance animation and the theme
                    // transition finish before the shutter.
                    await sleep(1200);
                    await clearTransients(cdp, { session: shot.session });
                    await cdp.eval(`document.activeElement?.blur(); window.scrollTo(0, 0)`);

                    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
                    const name = `${String(i + 1).padStart(2, '0')}-${shot.id}-${theme}`;
                    const raw = join(profile, `${deviceId}-${name}.png`);
                    await writeFile(raw, Buffer.from(data, 'base64'));
                    const out = join(dir, `${name}.png`);
                    finish(raw, out, device.out);
                    console.log(`  ${out}`);
                }
            }
        }
    } finally {
        await close({ keep: KEEP });
    }
}

await main();

/**
 * The web app as a first-time visitor meets it, signed out: it boots, the
 * aloud cloud catalogs load, "Try right now" asks for sign-in, Settings opens,
 * and a session on an own key starts and reaches Listening. Each check names
 * what broke.
 *
 *   node ts/smoke/smoke.mjs                       # production, https://aloud.rest/app/
 *   node ts/smoke/smoke.mjs --url <app> --cloud <aloud cloud origin>
 *   npm run smoke                                 # this tree, built and served locally (local.mjs)
 *   CHROME_PATH=/path/to/chrome node ts/smoke/smoke.mjs   # no system Chrome
 *
 * deploy-web.yml runs it after every Pages deploy (dev-docs/deploy.md, "Smoke
 * checks"). Read-only and free: nothing signs in, and the one model request
 * (the session's opener, on a placeholder key) is answered here in the
 * browser, so no provider is ever called. A real turn needs an account.
 *
 * Stood in, as in voice-loop-check.mjs: the system voice (speechSynthesis
 * plays past --mute-audio) and Chrome's recognizer (it would stream the fake
 * mic to Google). The mic itself is Chrome's fake device.
 */

import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values: opts } = parseArgs({
    options: {
        url: { type: 'string', default: 'https://aloud.rest/app/' },
        cloud: { type: 'string', default: 'https://aloud-cloud.fly.dev' },
    },
});
const APP = new URL(opts.url);
const CLOUD = new URL(opts.cloud).origin;
const CATALOGS = { config: '/cloud/v1/config', models: '/cloud/v1/me/models', voices: '/cloud/v1/voices' };
const OPENER = 'Welcome to the smoke check.';

const failures = [];
function check(name, problems) {
    const counts = new Map();
    for (const p of problems) counts.set(p, (counts.get(p) ?? 0) + 1);
    const list = [...counts].map(([p, n]) => (n > 1 ? `${p} (x${n})` : p));
    console.log(`${list.length ? 'FAIL' : 'PASS'}  ${name}`);
    for (const p of list) console.log(`      ${p}`);
    if (list.length) failures.push({ name, problems: list });
}

/** The app's own requests: its origin, aloud cloud, and anything shaped like
 *  the app's backend wherever it went (a wrong baked-in cloud URL). */
function own(url) {
    if (!/^https?:/.test(url)) return false;
    const u = new URL(url);
    return u.origin === APP.origin || u.origin === CLOUD || /^\/(app|cloud)\/v1\//.test(u.pathname);
}

const STAND_INS = `(() => {
    if (window.speechSynthesis) {
        speechSynthesis.speak = (u) => {
            setTimeout(() => u.onstart && u.onstart(new Event('start')), 20);
            setTimeout(() => u.onend && u.onend(new Event('end')), 300);
        };
        speechSynthesis.cancel = () => {};
    }
    const stt = (window.__stt = { started: 0 });
    class Recognizer {
        start() { stt.started++; }
        stop() { setTimeout(() => this.onend && this.onend(), 0); }
        abort() { this.stop(); }
    }
    window.SpeechRecognition = Recognizer;
    window.webkitSpeechRecognition = Recognizer;
    window.__micStreams = 0;
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (c) =>
        gum(c).then((s) => {
            if (s.getAudioTracks().some((t) => t.readyState === 'live')) window.__micStreams++;
            return s;
        });
})();`;

/** A fresh profile with the stand-ins, and a list of what went wrong on its
 *  page that the next check drains: uncaught errors, the app's console errors
 *  (a third-party script's are its own business), and its failed requests. */
async function open(browser, seed = '') {
    const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1100, height: 900 } });
    await context.addInitScript({ content: STAND_INS + seed });
    const page = await context.newPage();
    const problems = [];
    page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
    page.on('console', (m) => {
        const at = m.location().url;
        // "Failed to load resource" repeats a failed request, reported below.
        if (m.type() !== 'error' || (at && !own(at)) || m.text().startsWith('Failed to load resource')) return;
        problems.push(`console error: ${m.text()}`);
    });
    page.on('requestfailed', (r) => {
        if (own(r.url())) problems.push(`${r.method()} ${r.url()} failed: ${r.failure()?.errorText}`);
    });
    page.on('response', (r) => {
        if (own(r.url()) && r.status() >= 400) problems.push(`${r.request().method()} ${r.url()} answered ${r.status()}`);
    });
    return { context, page, drain: () => problems.splice(0) };
}

/** A step's own findings; a wait that times out becomes one. */
async function step(fn) {
    try {
        return (await fn()) ?? [];
    } catch (e) {
        return [String(e.message).split('\n')[0]];
    }
}

async function firstVisit(browser) {
    const { page, drain } = await open(browser);
    const asked = new Map();
    const answered = new Map();
    page.on('request', (r) => {
        const path = new URL(r.url()).pathname;
        if (Object.values(CATALOGS).includes(path)) asked.set(path, r.url());
    });
    page.on('response', (r) => {
        const path = new URL(r.url()).pathname;
        if (Object.values(CATALOGS).includes(path)) answered.set(path, { status: r.status(), body: r.json().catch(() => null) });
    });

    const quickStart = page.locator('.tour-welcome [data-action="quick-start"]');
    const boot = await step(async () => {
        await page.goto(APP.href, { waitUntil: 'domcontentloaded' });
        try {
            await page.locator('#begin-btn').waitFor({ state: 'visible', timeout: 30_000 });
        } catch {
            // Blank, or another screen in its place (the update or age block).
            const shown = (await page.locator('body').innerText({ timeout: 1000 }).catch(() => '')).replace(/\s+/g, ' ').trim();
            return [`the setup screen never rendered; the page shows: "${shown.slice(0, 160)}"`];
        }
        try {
            await quickStart.waitFor({ timeout: 10_000 });
        } catch {
            return ['the first-run welcome card never showed'];
        }
        try {
            await page.waitForFunction((sel) => document.querySelector(sel)?.disabled === false, '.tour-welcome [data-action="quick-start"]', {
                timeout: 25_000,
            });
        } catch {
            return [`"Try right now" stayed disabled: "${await quickStart.locator('small').textContent()}"`];
        }
    });
    check('boot: the setup screen and welcome card load, ready to start', [...boot, ...drain()]);

    const catalogs = [];
    for (const [name, path] of Object.entries(CATALOGS)) {
        const url = asked.get(path);
        const got = answered.get(path);
        const body = await got?.body;
        if (!url) catalogs.push(`${name}: the app never asked for ${path}`);
        else if (new URL(url).origin !== CLOUD) catalogs.push(`${name}: asked ${new URL(url).origin}, not ${CLOUD} (the build's VITE_ALOUD_CLOUD_URL)`);
        else if (!got) catalogs.push(`${name}: ${url} got no answer`);
        else if (got.status !== 200) catalogs.push(`${name}: ${url} answered ${got.status}`);
        else if (name === 'models' && !body?.models?.length) catalogs.push(`models: ${url} lists no models`);
        else if (name === 'voices' && !body?.length) catalogs.push(`voices: ${url} lists no voices (no TTS key on the server?)`);
        else if (name === 'config' && !body?.googleClientId && !body?.appleClientId) catalogs.push(`config: ${url} offers no Google or Apple sign-in`);
    }
    check(`catalogs: config, models and voices load from ${CLOUD}/cloud/v1`, catalogs);

    if (boot.length) {
        console.log('SKIP  sign-in, settings: both start from a booted setup screen');
        return;
    }

    const signIn = await step(async () => {
        await quickStart.click({ timeout: 10_000 });
        try {
            await page.locator('#signin-modal-overlay .signin-modal').waitFor({ timeout: 10_000 });
        } catch {
            return ['"Try right now" signed out did not ask for sign-in'];
        }
        // The Google and Apple buttons are drawn by their own scripts, and
        // Google's only on an origin its client allows, so not locally.
        const out = (await page.locator('#signin-email-form').isVisible()) ? [] : ['the email form is missing'];
        await page.locator('#signin-modal-close').click({ timeout: 10_000 });
        return out;
    });
    check('sign-in: "Try right now" signed out asks for sign-in', [...signIn, ...drain()]);

    const settings = await step(async () => {
        await page.locator('a.nav-icon-link[data-nav="settings"]').click({ timeout: 10_000 });
        await page.locator('h1.settings-title').waitFor({ timeout: 10_000 });
        await page.locator('#settings-form').waitFor({ timeout: 10_000 });
        // Settings' own fetches land after the heading.
        await page.waitForTimeout(1500);
    });
    check('settings: the Settings page opens', [...settings, ...drain()]);
}

/** The only start that needs no account: the facilitator on an own OpenAI key
 *  (a placeholder), the browser's voice and recognizer. The opener request is
 *  answered here and goes nowhere. */
async function session(browser) {
    const seed = `(() => {
        const set = (k, v) => localStorage.setItem('aloud:' + k, typeof v === 'string' ? v : JSON.stringify(v));
        set('app:settings', { enableByok: true, defaultProvider: 'openai', defaultModel: 'gpt-5-nano',
            sttEngine: 'web-speech', ttsEngine: 'browser', defaultVoice: 'browser:Samantha', setupVoice: false });
        set('preview:setup', { provider: 'openai', model: 'gpt-5-nano' });
        set('apikey:openai', 'sk-smoke-placeholder');
        set('aloud-index-guide-done', '1');
    })();`;
    const { context, page, drain } = await open(browser, seed);
    await context.route('https://api.openai.com/**', (route) => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        if (!JSON.parse(route.request().postData() || '{}').stream) {
            return route.fulfill({
                headers: { ...cors, 'content-type': 'application/json' },
                body: JSON.stringify({ choices: [{ message: { content: OPENER }, finish_reason: 'stop' }] }),
            });
        }
        return route.fulfill({
            headers: { ...cors, 'content-type': 'text/event-stream' },
            body:
                `data: ${JSON.stringify({ choices: [{ delta: { content: OPENER }, finish_reason: null }] })}\n\n` +
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        });
    });

    const started = await step(async () => {
        await page.goto(APP.href, { waitUntil: 'domcontentloaded' });
        try {
            await page.waitForFunction(() => document.querySelector('#begin-btn')?.disabled === false, undefined, { timeout: 30_000 });
        } catch {
            return ['Begin never became pressable'];
        }
        const before = await page.evaluate(() => ({ stt: window.__stt.started, mic: window.__micStreams }));
        await page.locator('#begin-btn').click({ timeout: 10_000 });
        try {
            await page.waitForFunction(() => document.body.dataset.sessionActive === 'true', undefined, { timeout: 15_000 });
        } catch {
            const dialog = await page.locator('[role="dialog"]').first().textContent({ timeout: 1000 }).catch(() => null);
            return [`Begin did not start a session${dialog ? `; a dialog says "${dialog.trim().slice(0, 120)}"` : ''}`];
        }
        const out = [];
        try {
            await page.locator('.message.facilitator', { hasText: OPENER }).waitFor({ timeout: 15_000 });
        } catch {
            out.push("the facilitator's opener never showed");
        }
        // The status reads Listening from the start; the recognizer and the
        // mic open once the opening sound and the opener are done.
        try {
            await page.waitForFunction(
                (b) => window.__stt.started > b.stt && window.__micStreams > b.mic && document.querySelector('#voice-status')?.textContent === 'Listening…',
                before,
                { timeout: 15_000 }
            );
        } catch {
            const now = await page.evaluate(() => ({ stt: window.__stt.started, mic: window.__micStreams }));
            if (now.stt <= before.stt) out.push('no recognizer was started');
            if (now.mic <= before.mic) out.push('the microphone was never opened');
            out.push(`status: "${await page.locator('#voice-status').textContent()}"`);
        }
        return out;
    });
    check('session: a signed-out own-key session starts and reaches Listening', [...started, ...drain()]);
}

const t0 = Date.now();
console.log(`smoke: ${APP.href} against aloud cloud ${CLOUD}`);
const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
        '--mute-audio',
    ],
});
try {
    await firstVisit(browser);
    await session(browser);
} finally {
    await browser.close();
}

const secs = Math.round((Date.now() - t0) / 1000);
if (failures.length === 0) {
    console.log(`\nsmoke passed in ${secs}s`);
} else {
    const names = failures.map((f) => f.name.split(':')[0]);
    console.log(`\nsmoke FAILED in ${secs}s: ${names.join(', ')}`);
    if (process.env.GITHUB_ACTIONS) {
        for (const [i, f] of failures.entries()) {
            const text = f.problems.slice(0, 5).join(' | ').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
            console.log(`::error title=Smoke check failed (${names[i]})::${text}`);
        }
    }
    process.exitCode = 1;
}

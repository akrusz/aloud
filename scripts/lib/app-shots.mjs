/**
 * Shared plumbing for the screenshot scripts (site-screenshots.mjs for the
 * landing page, store-screenshots.mjs for the store listings): headless Chrome
 * over CDP with no npm dependencies (Node 22's WebSocket + the Chrome you
 * already have), a seeded fresh profile, and a session view staged with sample
 * copy.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME =
    process.env['CHROME_PATH'] ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function die(msg) {
    console.error(msg);
    process.exit(1);
}

/**
 * The exchange shown in the in-session shots, written into the DOM: a real
 * session needs a mic, an LLM and a person, none of which a screenshot script
 * has. It's the opening of a real Exploration session (2026-10-07), filler cut
 * and the facilitator's lines shortened. Keep any replacement the way the
 * facilitator actually talks - short questions, no platitudes - so the picture
 * doesn't promise a different app.
 */
export const SAMPLE_TURNS = [
    ['assistant', "What's the most noticeable sensation right now?"],
    ['user', 'Expansion, like many, many point masses coming outwards from the front of my body.'],
    ['assistant', "What's it like, that sense of point masses moving outward? Any texture or temperature?"],
    ['user', "It reminds me of vapors coming off of a humidifier. And there's a joyfulness to it."],
    ['assistant', 'Vapor drifting off the front of the body, with that joyfulness running through it. Where does the joy seem to sit, in the body or in the vapor itself?'],
];

/** Overlays the app parks in the DOM hidden; any laid-out one is noise in a
 *  screenshot. */
const OVERLAYS = '.voice-modal-overlay, .app-dialog-overlay, .modal-overlay';

/** Minimal CDP client: one WebSocket, id-matched replies, awaited events, and
 *  standing listeners for events that recur (Fetch.requestPaused). */
export class Cdp {
    #ws;
    #id = 0;
    #pending = new Map();
    #waiters = [];
    #listeners = new Map();

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
            for (const fn of this.#listeners.get(msg.method) ?? []) fn(msg.params);
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

    on(method, fn) {
        if (!this.#listeners.has(method)) this.#listeners.set(method, []);
        this.#listeners.get(method).push(fn);
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

/** Fail fast, with the fix, on whatever the run can't do without. */
export async function preflight(urlBase) {
    if (!existsSync(CHROME)) die(`No Chrome at ${CHROME} (set CHROME_PATH).`);
    if (spawnSync('magick', ['-version'], { stdio: 'ignore' }).status !== 0) {
        die('ImageMagick (magick) not found - brew install imagemagick');
    }
    try {
        await fetch(urlBase, { signal: AbortSignal.timeout(2000) });
    } catch {
        die(`Nothing serving ${urlBase} - run \`npm run web:dev\` first.`);
    }
}

/**
 * Start headless Chrome on a fresh profile and attach to its page. `close`
 * kills it and removes the profile (unless `keep`, for the intermediate PNGs
 * written into it).
 */
export async function launchChrome({ width, height }) {
    const profile = await mkdtemp(join(tmpdir(), 'aloud-shot-'));
    const chrome = spawn(
        CHROME,
        [
            '--headless=new',
            '--remote-debugging-port=0',
            `--user-data-dir=${profile}`,
            `--window-size=${width},${height}`,
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
    const close = async ({ keep = false } = {}) => {
        cdp?.close();
        chrome.kill();
        // Chrome is still flushing its profile as it dies; without the retries
        // this throws ENOTEMPTY and hides whatever error brought us here.
        if (!keep) await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    };
    try {
        cdp = await Cdp.attach(await chromeEndpoint(profile));
        await cdp.send('Page.enable');
        await cdp.send('Runtime.enable');
    } catch (err) {
        await close();
        throw err;
    }
    return { cdp, profile, close };
}

/**
 * Navigate to the app with localStorage seeded ahead of the app's own scripts
 * rather than written into a loaded page: theme.ts reads themeMode at boot, and
 * the setup view saves its voice pick into app settings when its catalog
 * lands, which can overwrite a write made after load. `storage` maps raw
 * localStorage keys to string values.
 */
export async function bootApp(cdp, url, storage) {
    const writes = Object.entries(storage)
        .map(([k, v]) => `localStorage.setItem(${JSON.stringify(k)}, ${JSON.stringify(v)});`)
        .join('\n');
    const { identifier } = await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `try { ${writes} } catch { /* a document with no storage (about:blank) */ }`,
    });
    await cdp.send('Page.navigate', { url });
    await cdp.once('Page.loadEventFired');
    await cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
}

/** Poll until a selector exists - the setup catalogs arrive over fetch, and a
 *  shot taken before them is half-empty. */
export async function waitFor(cdp, selector, tries = 100) {
    for (let i = 0; i < tries; i++) {
        if (await cdp.eval(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
        await sleep(100);
    }
    throw new Error(`never saw ${selector}`);
}

/**
 * Begin a session and stage the transcript: `turns` written straight into the
 * DOM, since a real exchange needs a mic, an LLM and a person. Whatever the
 * session view put there on mount (an opener, or a provider error, since
 * nothing is configured here) is cleared first.
 */
export async function enterSession(cdp, turns = SAMPLE_TURNS) {
    await cdp.eval(`document.querySelector('#begin-btn').click()`);
    try {
        await waitFor(cdp, '#conversation');
    } catch {
        // Begin has gates (provider, mic, sign-in, credits); say which one
        // stopped us. Overlays sit in the DOM hidden, so only a laid-out one counts.
        const why = await cdp.eval(`(() => {
            if (document.querySelector('#begin-btn')?.disabled) return 'the Begin button is disabled';
            const open = [...document.querySelectorAll(${JSON.stringify(OVERLAYS)})]
                .find((el) => el.getClientRects().length > 0);
            return open ? 'on screen: ' + open.innerText.replace(/\\s+/g, ' ').slice(0, 200) : '';
        })()`);
        throw new Error(`Begin never reached the session view${why ? ` (${why})` : ''}`);
    }
    await sleep(1500);
    await cdp.eval(`(() => {
        const conv = document.querySelector('#conversation');
        const typing = conv.querySelector('.typing-indicator, #typing-indicator');
        // Everything but the typing indicator: bubbles from the opener, and
        // any provider notice ("Loading <model> into memory...").
        for (const child of [...conv.children]) if (child !== typing) child.remove();
        for (const [role, text] of ${JSON.stringify(turns)}) {
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
    })()`);
}

/** Last pass before the shutter: anything transient that drifted in while we
 *  waited (toasts, dialogs) is noise in a screenshot, and a session's status
 *  line should read as between turns rather than mid-error. */
export async function clearTransients(cdp, { session }) {
    await cdp.eval(`(() => {
        for (const el of document.querySelectorAll('.error-toast, ${OVERLAYS}')) el.remove();
        ${
            session
                ? `const status = document.querySelector('#voice-status');
                   if (status) status.textContent = 'Listening…';`
                : ''
        }
    })()`);
}

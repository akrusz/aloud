/**
 * A whole sitting by voice, driven through the real web UI with no microphone,
 * no speaker and no network model: begin, speak, end, begin again.
 *
 *   npm run web:dev                          # must be up (Vite :4649 + Hono :8787)
 *   node ts/scripts/voice-loop-check.mjs
 *   CHROME_PATH=/path/to/chrome node ts/scripts/voice-loop-check.mjs   # no system Chrome
 *
 * What stands in for what:
 *   - the mic: a scripted SpeechRecognition (the Web Speech engine's own seam),
 *     which hands the app whatever transcript the script says was spoken;
 *   - the voice: speechSynthesis is left alone; lines are read off the transcript;
 *   - the model: the BYOK OpenAI endpoint, answered here ("Model reply N.").
 * The session is BYOK and signed out, so there is no judge: everything a
 * command does below is the judge-free tier (core mute-command.ts,
 * end-command.ts, begin-command.ts). It exercises the listen loop in
 * views/session.ts and the setup screen's voice-start wiring, which no unit
 * test reaches and the tier-2 soak needs a virtual audio device for.
 *
 * Not a substitute for a real mic: recognizer chimes, echo, endpointing and
 * autoplay rules are exactly what this cannot see (dev-docs/manual-smoke.md).
 */

import { chromium } from 'playwright-core';

const BASE = process.env.ALOUD_URL ?? 'http://localhost:4649/';

const browser = await chromium.launch({
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
    args: [
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--autoplay-policy=no-user-gesture-required',
    ],
});

const failures = [];
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures.push(name);
}

/** A fresh browser context seeded with a BYOK session and the given settings. */
async function open(settings) {
    const context = await browser.newContext({ permissions: ['microphone'], viewport: { width: 1100, height: 900 } });
    await context.addInitScript({
        content: `(() => {
    const P = 'aloud:';
    const merge = (key, patch) => {
        let base = {};
        try { base = JSON.parse(localStorage.getItem(P + key) || '{}'); } catch (e) {}
        localStorage.setItem(P + key, JSON.stringify(Object.assign(base, patch)));
    };
    merge('preview:setup', { meditationType: 'exploration', intention: '', intentionByMode: {}, focuses: [], qualities: [],
        dirStep: 2, feltSensePaceStep: 2, feltSenseCheckins: true, verbosity: 'low', customInstructions: '',
        provider: 'openai', model: 'gpt-5-nano' });
    merge('app:settings', Object.assign({ defaultProvider: 'openai', defaultModel: 'gpt-5-nano', sttEngine: 'web-speech',
        ttsEngine: 'browser', defaultVoice: null, checkinTiming: 'fixed', checkinContent: 'canned', silenceCheckinSec: 600,
        silenceModeEnabled: true, sessionClockMode: 'elapsed', saveSessionLogs: false, autoQuitAfterSilence: false,
        showAllModels: true, enableByok: true, voiceCommandsViaCloud: false }, ${JSON.stringify(settings)}));
    localStorage.setItem(P + 'apikey:openai', 'sk-test-not-real');

    // The scripted recognizer. One instance is "listening" at a time; say()
    // delivers a finished transcript to it, as Chrome would after a pause.
    const state = (window.__stt = { active: null, started: 0 });
    class ScriptedRecognition {
        constructor() { this.onresult = null; this.onerror = null; this.onend = null; }
        start() { state.active = this; state.started++; }
        stop() { if (state.active === this) state.active = null; setTimeout(() => this.onend && this.onend(), 0); }
        abort() { this.stop(); }
    }
    window.SpeechRecognition = ScriptedRecognition;
    window.webkitSpeechRecognition = ScriptedRecognition;
    window.__say = (text) => {
        const r = state.active;
        if (!r || !r.onresult) return false;
        const result = { 0: { transcript: text, confidence: 0.9 }, isFinal: true, length: 1 };
        r.onresult({ resultIndex: 0, results: { 0: result, length: 1 } });
        return true;
    };
})();`,
    });

    const model = { calls: 0 };
    await context.route('https://api.openai.com/**', async (route) => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        model.calls++;
        const text = `Model reply ${model.calls}.`;
        const body = JSON.parse(route.request().postData() || '{}');
        if (!body.stream) {
            return route.fulfill({
                status: 200,
                headers: { ...cors, 'content-type': 'application/json' },
                body: JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }),
            });
        }
        return route.fulfill({
            status: 200,
            headers: { ...cors, 'content-type': 'text/event-stream' },
            body:
                `data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n\n` +
                `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } })}\n\n` +
                'data: [DONE]\n\n',
        });
    });

    const page = await context.newPage();
    const until = async (fn, ms = 15_000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if (await fn()) return true;
            await page.waitForTimeout(100);
        }
        return false;
    };
    const inSession = () => page.evaluate(() => document.body.dataset.sessionActive !== undefined);
    const recognizerOpen = () => page.evaluate(() => Boolean(window.__stt.active && window.__stt.active.onresult));
    const shown = (re) => until(async () => re.test(await page.evaluate(() => document.body.innerText)));
    const asked = async () =>
        ((await page.evaluate(() => document.body.innerText)).match(/Would you like to end the session\?/g) ?? []).length;
    return {
        context,
        page,
        model,
        until,
        inSession,
        recognizerOpen,
        shown,
        asked,
        async setup() {
            await page.goto(`${BASE}?soak=1`, { waitUntil: 'domcontentloaded' });
            await page.locator('#begin-btn').waitFor({ state: 'visible', timeout: 30_000 });
            await page.waitForFunction(() => !document.querySelector('#begin-btn')?.disabled, undefined, { timeout: 30_000 });
        },
        /** Wait for the app to be listening, then say it. */
        async say(text) {
            if (!(await until(recognizerOpen, 20_000))) throw new Error(`nothing was listening for: ${text}`);
            await page.evaluate((t) => window.__say(t), text);
        },
        /** Wait for the next model call after `since`. */
        modelCalledSince: (since) => until(() => model.calls > since),
        status: () =>
            page.evaluate(() => {
                const el = document.querySelector('#voice-start-status');
                return el && !el.classList.contains('hidden') ? el.textContent : '';
            }),
        taps: () => page.evaluate(() => JSON.stringify(window.__aloudSoak?.events ?? [])),
    };
}

try {
    // ---- ending by voice, no judge ----------------------------------------------
    {
        const s = await open({ voiceStart: false });
        await s.setup();
        check('with voice start off, setup opens no recognizer', (await s.page.evaluate(() => window.__stt.started)) === 0);
        await s.page.locator('#begin-btn').click();
        check('session starts', await s.until(s.inSession));

        let calls = s.model.calls;
        await s.say('End the session.');
        check('"end the session" is answered with the question', await s.shown(/Would you like to end the session\?/));
        check('and never reaches the model', s.model.calls === calls);
        await s.say('Not yet.');
        check('"not yet" carries on', await s.shown(/we'll keep going/));
        check('and never reaches the model', s.model.calls === calls && (await s.inSession()));

        await s.say('There is a warmth in my chest.');
        check('an ordinary turn reaches the model', await s.modelCalledSince(calls));

        calls = s.model.calls;
        const askedBefore = await s.asked();
        await s.say('I want this feeling to end.');
        check('a sentence about ending is a turn', await s.modelCalledSince(calls));
        check('and is not asked about ending', (await s.asked()) === askedBefore);

        await s.say('Please end the session');
        await s.until(async () => (await s.asked()) > askedBefore);
        calls = s.model.calls;
        await s.say('Actually my leg has fallen asleep.');
        check('an unrelated reply to the question is a turn', await s.modelCalledSince(calls));
        calls = s.model.calls;
        await s.say('Yes.');
        check('and a later "yes" is only a turn', (await s.modelCalledSince(calls)) && (await s.inSession()));

        await s.say('Can we end the session?');
        await s.until(async () => (await s.asked()) > askedBefore + 1);
        await s.say('Yes please.');
        check('"yes" to the question ends the session', await s.until(async () => !(await s.inSession())));
        check('the match was made on the device', (await s.taps()).includes('command:end-matched-locally'));
        await s.context.close();
    }

    // ---- a whole sitting after one touch ----------------------------------------
    {
        const s = await open({ voiceStart: true });
        await s.setup();
        await s.page.mouse.click(5, 300); // one touch, on nothing
        check(
            'setup listens for "begin"',
            (await s.until(async () => /Listening for "begin"/.test(await s.status()))) && (await s.until(s.recognizerOpen))
        );
        await s.say('When does the movie start?');
        await s.page.waitForTimeout(1500);
        check('room talk starts nothing', !(await s.inSession()));
        await s.say("Okay, let's begin.");
        check('"let\'s begin" starts the session', await s.until(s.inSession));
        await s.say('End the session.');
        await s.shown(/Would you like to end the session\?/);
        await s.say('Yes.');
        check('ended by voice', await s.until(async () => !(await s.inSession())));
        check('back on setup and listening, with no touch', await s.until(async () => /Listening for "begin"/.test(await s.status())));
        await s.say('Begin.');
        check('"begin" starts a second session', await s.until(s.inSession));
        await s.say('End the session.');
        await s.until(async () => (await s.asked()) > 0);
        await s.say('Yes.');
        await s.until(async () => !(await s.inSession()));
        await s.until(async () => /Listening for "begin"/.test(await s.status()));
        await s.page.evaluate(() => document.querySelector('[data-nav="settings"]')?.click());
        check('leaving setup closes the mic', await s.until(async () => !(await s.recognizerOpen()), 5_000));
        await s.context.close();
    }
} catch (err) {
    failures.push(`threw: ${err.message}`);
    console.log('ERROR', err.message);
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);

/**
 * A whole sitting by voice, driven through the real web UI with no microphone,
 * no speaker and no network model: begin, speak, end, begin again.
 *
 *   npm run web:dev                          # must be up (Vite :4649 + Hono :8787)
 *   npm run voice:check                      # = node ts/scripts/voice-loop-check.mjs
 *   CHROME_PATH=/path/to/chrome node ts/scripts/voice-loop-check.mjs   # no system Chrome
 *
 * What stands in for what:
 *   - the mic: a scripted SpeechRecognition (the Web Speech engine's own seam),
 *     which hands the app whatever transcript the script says was spoken;
 *   - the voice: a silent stand-in for speechSynthesis, and page audio muted (a
 *     check nobody is meant to hear); lines are read off the transcript;
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
        // Nobody is meant to hear a check: page audio is muted here, and the
        // system synthesizer (which this flag does not reach) is stood in for
        // in the init script.
        '--mute-audio',
    ],
});

const failures = [];
/** The page of the scenario under way, for a look at the screen when one throws. */
let lastPage = null;
function check(name, ok, detail = '') {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
    if (!ok) failures.push(name);
}

/** A fresh browser context seeded with a BYOK session and the given settings.
 *  `speechCapMs`: the longest a stood-in utterance "plays" (window.__speechCapMs
 *  changes it later). `micUnasked`: the page is told the permission is still
 *  to be asked (a context without the grant reads as denied), and the capture
 *  it then asks for is granted. */
async function open(settings, setupPatch = {}, { speechCapMs = 2500, micUnasked = false } = {}) {
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
        directiveness: 3, feltSensePace: 3, feltSenseCheckins: true, verbosity: 'low', customInstructions: '',
        provider: 'openai', model: '${process.env.CHECK_MODEL ?? 'gpt-5-nano'}' });
    merge('preview:setup', ${JSON.stringify(setupPatch)});
    merge('app:settings', Object.assign({ defaultProvider: 'openai', defaultModel: '${process.env.CHECK_MODEL ?? 'gpt-5-nano'}', sttEngine: 'web-speech',
        ttsEngine: 'browser', defaultVoice: 'browser:Samantha', checkinTiming: 'fixed', checkinContent: 'canned', silenceCheckinSec: 600,
        silenceModeEnabled: true, sessionClockMode: 'elapsed', saveSessionLogs: false, autoQuitAfterSilence: false,
        showAllModels: true, enableByok: true, voiceCommandsViaCloud: false }, ${JSON.stringify(settings)}));
    localStorage.setItem(P + 'apikey:openai', 'sk-test-not-real');
    if (${Boolean(micUnasked)} && navigator.permissions) {
        const query = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (d) =>
            d && d.name === 'microphone' ? Promise.resolve({ state: 'prompt', onchange: null }) : query(d);
    }

    // speechSynthesis speaks through the system, past --mute-audio, so it is
    // stood in for: each utterance "plays" for about as long as it would take
    // to say, in silence. What was said is kept (__spoken), and how many were
    // cut off (__speechCut).
    if (window.speechSynthesis) {
        window.__quietSpeech = true;
        window.__speechCapMs = ${Number(speechCapMs)};
        window.__spoken = [];
        window.__speechCut = 0;
        let current = null;
        speechSynthesis.speak = (u) => {
            const mine = (current = {});
            window.__spoken.push(u.text);
            setTimeout(() => mine === current && u.onstart && u.onstart(new Event('start')), 30);
            setTimeout(() => {
                if (mine !== current) return;
                current = null;
                u.onend && u.onend(new Event('end'));
            }, 30 + Math.min(window.__speechCapMs, u.text.length * 55));
        };
        speechSynthesis.cancel = () => {
            if (current) window.__speechCut++;
            current = null;
        };
    }

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

    // `calls` are facilitator replies. The trouble check (core stepping-out.ts)
    // asks the same endpoint on the models that get it, during the pause
    // before a turn is final: counted apart, or "the model was called" would
    // come true before the turn it was said of.
    const model = { calls: 0, checks: 0, requests: [] };
    await context.route('https://api.openai.com/**', async (route) => {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const body = JSON.parse(route.request().postData() || '{}');
        const asked = JSON.stringify(body.messages ?? body.input ?? '');
        if (/You are screening one thing/.test(asked)) {
            model.checks++;
            const verdict = /disappearing|can't breathe|not want to be alive/i.test(asked) ? 'YES' : 'NO';
            return route.fulfill({
                status: 200,
                headers: { ...cors, 'content-type': 'application/json' },
                body: JSON.stringify({ choices: [{ message: { content: verdict }, finish_reason: 'stop' }] }),
            });
        }
        model.calls++;
        model.requests.push(asked);
        // A stand-in that bids for silence the way a model does: rightly when
        // asked for quiet, wrongly when someone says they can't breathe.
        const recent = JSON.stringify((body.messages ?? []).slice(-3));
        const text = /need some quiet/i.test(recent)
            ? '[HOLD] Would you like me to be quiet for a bit?'
            : /can't breathe/i.test(recent)
              ? '[HOLD] Are you safe right now?'
              : `Model reply ${model.calls}.`;
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
    lastPage = page;
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
        ((await page.evaluate(() => document.body.innerText)).match(/Would you like to end the session now\?/g) ?? []).length;
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
        /** Press Begin on a fresh profile. The welcome card goes up 250ms after
         *  setup loads and holds the page inert, so an immediate click is a race
         *  it sometimes loses: wait the card out and dismiss it first. */
        async begin() {
            await page.waitForTimeout(800);
            if (await page.locator('[role="dialog"][aria-modal="true"]').count()) await page.mouse.click(5, 300);
            await page.locator('#begin-btn').click();
        },
        /** Wait for the app to be listening, then say it. */
        async say(text) {
            if (!(await until(recognizerOpen, 20_000))) throw new Error(`nothing was listening for: ${text}`);
            await page.evaluate((t) => window.__say(t), text);
        },
        /** As say(), but only once the app has been listening for `ms`: the
         *  noting circle drops anything heard sooner as the tail of its own
         *  voice (ECHO_REJECT_MS). */
        async sayAfter(ms, text) {
            if (!(await until(recognizerOpen, 20_000))) throw new Error(`nothing was listening for: ${text}`);
            const id = await page.evaluate(() => window.__stt.started);
            await page.waitForTimeout(ms);
            // Still the same turn? If the app moved on, wait for the next one.
            if ((await page.evaluate(() => window.__stt.started)) !== id || !(await recognizerOpen())) {
                return this.sayAfter(ms, text);
            }
            await page.evaluate((t) => window.__say(t), text);
        },
        /** Wait for the next model call after `since`. */
        modelCalledSince: (since) => until(() => model.calls > since),
        status: () =>
            page.evaluate(() => {
                const el = document.querySelector('#voice-start-mic');
                return el && !el.classList.contains('hidden') ? el.title : '';
            }),
        /** The soak tap's events as JSON, or null when the tap isn't armed. */
        taps: () => page.evaluate(() => (window.__aloudSoak ? JSON.stringify(window.__aloudSoak.events) : null)),
        /** Click it, or report false where it takes no click (inert, covered). */
        async tap(selector) {
            try {
                await page.locator(selector).click({ timeout: 3_000 });
                return true;
            } catch {
                return false;
            }
        },
        /** Voice mode as the mic beside Begin shows it: 'on' (lit), 'sleeping'
         *  (unlit, no slash), 'off' (slashed), or '' while it is hidden. */
        look: () =>
            page.evaluate(() => {
                const el = document.querySelector('#voice-start-mic');
                if (!el || el.classList.contains('hidden')) return '';
                if (el.classList.contains('active')) return 'on';
                return getComputedStyle(el.querySelector('.mute-line')).opacity === '0' ? 'sleeping' : 'off';
            }),
        /** Everything the stood-in voice was given to say, in order. */
        spoken: () => page.evaluate(() => window.__spoken.slice()),
        /** The tour card up now: its heading, or the tooltip of a section
         *  step ("section"), or '' with none up. */
        card: () =>
            page.evaluate(() => {
                const card = document.querySelector('.tour-welcome, .tour-tooltip');
                if (!card) return '';
                return card.querySelector('h3')?.textContent ?? (card.classList.contains('tour-tooltip') ? 'section' : 'welcome');
            }),
    };
}

try {
    // ---- ending by voice, no judge ----------------------------------------------
    {
        const s = await open({ setupVoice: false });
        await s.setup();
        check('with voice start off, setup opens no recognizer', (await s.page.evaluate(() => window.__stt.started)) === 0);
        await s.begin();
        check('session starts', await s.until(s.inSession));

        let calls = s.model.calls;
        await s.say('End the session.');
        check('"end the session" is answered with the question', await s.shown(/Would you like to end the session now\?/));
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
        // Only readable when the soak tap armed. Vite reloads the page once on
        // the first load after a source edit, and the router has dropped
        // ?soak by then; the checks above already show the question was asked
        // with no judge and no model call, which is the same fact.
        const taps = await s.taps();
        if (taps === null) console.log('SKIP  the match was made on the device  (soak tap not armed on this load)');
        else check('the match was made on the device', taps.includes('command:end-matched-locally'));
        await s.context.close();
    }

    // ---- stepping out: the trouble check beside the reply ------------------------
    // Only on a model that gets the check (wantsTroubleCheck: the stand-in
    // default, GPT-5 nano, is one).
    {
        const s = await open({ setupVoice: false });
        await s.setup();
        await s.begin();
        await s.until(s.inSession);
        const noted = (request) => /sounds like they are frightened/.test(request ?? '');

        let calls = s.model.calls;
        let checks = s.model.checks;
        await s.say('There is a warmth in my chest.');
        check('an ordinary turn is answered', await s.modelCalledSince(calls));
        check('with the check asked beside it', await s.until(() => s.model.checks > checks));
        check('and no note in what the model was sent', !noted(s.model.requests.at(-1)));

        calls = s.model.calls;
        await s.say("I feel like I'm disappearing and it's scaring me.");
        check(
            'a frightened turn reaches the model with the stepping-out note',
            await s.until(() => s.model.calls > calls && noted(s.model.requests.at(-1))),
            `(${s.model.calls - calls} model calls)`
        );
        // The reply spoken is the one written with the note: either the only
        // one (the verdict was in before the request went), or the second.
        const last = s.model.requests.findLastIndex(noted) + 1;
        check('and the reply on screen is the one written with it', await s.shown(new RegExp(`Model reply ${last}\\.`)), `(reply ${last})`);

        calls = s.model.calls;
        await s.say('Okay, I can feel the chair again.');
        check('the turn after is an ordinary one', await s.modelCalledSince(calls));

        // A silence bid made to someone in trouble is dropped: "yes" to "are
        // you safe?" must not begin a silence.
        calls = s.model.calls;
        await s.say("Something is wrong, I can't breathe.");
        check('a frightened line answered with a silence bid', await s.shown(/Are you safe right now\?/));
        await s.until(() => s.model.calls > calls);
        calls = s.model.calls;
        await s.say('Yes.');
        check('is not a bid: the "yes" after it is a turn, not a silence', await s.modelCalledSince(calls));

        // The same bid in answer to a request for quiet still stands.
        calls = s.model.calls;
        await s.say('I need some quiet for a while.');
        check('a request for quiet is asked about', await s.shown(/Would you like me to be quiet for a bit\?/));
        await s.until(() => s.model.calls > calls);
        calls = s.model.calls;
        await s.say('Yes.');
        await s.page.waitForTimeout(3000);
        check('and a "yes" to that begins the silence', s.model.calls === calls, `(${s.model.calls - calls} model calls)`);
        await s.say("I'm back, I'd like to keep going.");
        check('which a word ends', await s.modelCalledSince(calls));
        await s.until(s.recognizerOpen, 20_000);
        const before = s.model.checks;
        await s.say('End the session.');
        await s.shown(/Would you like to end the session now\?/);
        check('a request matched on the device is not screened', s.model.checks === before, `(${s.model.checks - before} checks)`);
        await s.say('Yes.');
        check('and the session ends by voice', await s.until(async () => !(await s.inSession())));
        await s.context.close();
    }

    // ---- the mic is the setting --------------------------------------------------
    {
        const s = await open({ setupVoice: false });
        await s.setup();
        await s.page.waitForTimeout(800);
        await s.page.mouse.click(5, 300);
        const setting = () => s.page.evaluate(() => JSON.parse(localStorage.getItem('aloud:app:settings') || '{}').setupVoice);
        check(
            'switched off, the mic still shows, slashed',
            await s.until(async () => (await s.look()) === 'off' && (await s.status()) === 'Voice off. Tap to turn on.')
        );
        check('and nothing is listening', !(await s.recognizerOpen()));
        await s.page.locator('#voice-start-mic').click();
        check('a tap opens it', await s.until(async () => /^Listening\./.test(await s.status())));
        check('and switches the setting on', await s.until(async () => (await setting()) === true));
        await s.page.locator('#voice-start-mic').click();
        check('a tap on the lit mic closes it', await s.until(async () => !(await s.recognizerOpen()), 8_000));
        check('and switches the setting off', await s.until(async () => (await setting()) === false));
        await s.page.reload({ waitUntil: 'domcontentloaded' });
        await s.page.locator('#begin-btn').waitFor({ state: 'visible', timeout: 30_000 });
        await s.page.waitForTimeout(1500);
        check('so the next visit opens no recognizer', !(await s.recognizerOpen()) && (await s.look()) === 'off', `(${await s.status()})`);
        await s.context.close();
    }

    // ---- a whole sitting after one touch ----------------------------------------
    {
        const s = await open({ setupVoice: true });
        await s.setup();
        await s.page.mouse.click(5, 300); // one touch, on nothing
        check(
            'setup listens',
            (await s.until(async () => /^Listening\./.test(await s.status()))) && (await s.until(s.recognizerOpen))
        );
        await s.say('When does the movie start?');
        await s.page.waitForTimeout(1500);
        check('room talk starts nothing', !(await s.inSession()));
        await s.say("Okay, let's begin.");
        check('"let\'s begin" starts the session', await s.until(s.inSession));
        await s.say('End the session.');
        await s.shown(/Would you like to end the session now\?/);
        await s.say('Yes.');
        check('ended by voice', await s.until(async () => !(await s.inSession())));
        check('back on setup and listening, with no touch', await s.until(async () => /^Listening\./.test(await s.status())));
        await s.say('Begin.');
        check('"begin" starts a second session', await s.until(s.inSession));
        await s.say('End the session.');
        await s.until(async () => (await s.asked()) > 0);
        await s.say('Yes.');
        await s.until(async () => !(await s.inSession()));
        await s.until(async () => /^Listening\./.test(await s.status()));
        await s.page.evaluate(() => document.querySelector('[data-nav="settings"]')?.click());
        check('leaving setup closes the mic', await s.until(async () => !(await s.recognizerOpen()), 5_000));
        await s.context.close();
    }

    // ---- "begin" that names the sit ---------------------------------------------
    {
        const s = await open({ setupVoice: true, showSessionClock: true });
        await s.setup();
        await s.page.mouse.click(5, 300);
        await s.until(async () => /^Listening\./.test(await s.status()));
        await s.say('Begin a ten minute felt sense session.');
        check('a request naming a mode and a length starts the session', await s.until(s.inSession));
        const stored = await s.page.evaluate(() => ({
            setup: JSON.parse(localStorage.getItem('aloud:preview:setup') || '{}'),
            app: JSON.parse(localStorage.getItem('aloud:app:settings') || '{}'),
        }));
        check('in the mode it named', stored.setup.meditationType === 'felt_sense', `(${stored.setup.meditationType})`);
        check(
            'with the timer it named',
            stored.app.sessionClockMode === 'timer' && stored.app.sessionTimerMin === 10,
            `(${stored.app.sessionClockMode}, ${stored.app.sessionTimerMin})`
        );
        check('and the clock is counting down from it', await s.shown(/\b(10:00|9:[0-5]\d)\b/));
        await s.say('End the session.');
        await s.shown(/Would you like to end the session now\?/);
        await s.say('Yes.');
        check('and it ends by voice like any other', await s.until(async () => !(await s.inSession())));
        await s.context.close();
    }

    // ---- the setup, changed by voice ---------------------------------------------
    {
        const s = await open({ setupVoice: true });
        await s.setup();
        // Past the welcome card's entrance: this touch also has to dismiss it,
        // since the mic gets tapped below and the card holds the page inert.
        await s.page.waitForTimeout(800);
        await s.page.mouse.click(5, 300);
        await s.until(async () => /^Listening\./.test(await s.status()));
        const stored = () =>
            s.page.evaluate(() => ({
                setup: JSON.parse(localStorage.getItem('aloud:preview:setup') || '{}'),
                app: JSON.parse(localStorage.getItem('aloud:app:settings') || '{}'),
            }));
        const note = () => s.page.evaluate(() => {
            const el = document.querySelector('#voice-start-note');
            return el && !el.classList.contains('hidden') ? el.textContent : '';
        });

        await s.say('Add playful and spacious.');
        check(
            'a vibe named out loud is checked',
            await s.until(async () => {
                const q = (await stored()).setup.qualities ?? [];
                return q.includes('playful') && q.includes('spacious');
            })
        );
        check('and its box on the form shows it', await s.page.locator('input[name="quality"][value="playful"]').isChecked());
        check('and the answer is on screen', /Playful is on\. Spacious is on\./.test(await note()), `(${await note()})`);
        check(
            'in the bar beside the mic, where there is room',
            await s.page.evaluate(() => {
                const el = document.querySelector('#voice-start-note');
                const mic = document.querySelector('#voice-start-mic');
                const bar = document.querySelector('.setup-footer');
                if (!el || !mic || !bar || !el.classList.contains('in-bar')) return false;
                const n = el.getBoundingClientRect();
                const b = bar.getBoundingClientRect();
                return n.right <= mic.getBoundingClientRect().left && n.top >= b.top && n.bottom <= b.bottom;
            })
        );
        check(
            'and the mic wears the level ring a session does',
            await s.until(() => s.page.evaluate(() => document.querySelector('#voice-start-mic').style.getPropertyValue('--mic-level') !== ''), 5_000)
        );

        await s.say('Change the vibe to loving.');
        check(
            '"change the vibe to" replaces the set',
            await s.until(async () => JSON.stringify((await stored()).setup.qualities) === '["loving"]')
        );

        await s.say('Twenty five minutes.');
        check(
            'a length sets the timer',
            await s.until(async () => {
                const { app } = await stored();
                return app.sessionClockMode === 'timer' && app.sessionTimerMin === 25;
            })
        );
        check('and the clock button says so', await s.shown(/25 min timer/));

        await s.say('More guidance.');
        check('"more guidance" moves the slider a stop', await s.until(async () => (await stored()).setup.directiveness === 4));

        await s.say('My intention is to rest.');
        check('an intention lands in its field', await s.until(async () => (await s.page.locator('#intention').inputValue()) === 'to rest'));

        await s.say('Set the guidance level to medium.');
        check('guidance by level sets the stop', await s.until(async () => (await stored()).setup.directiveness === 3));
        check('and says which', /Guidance set to balanced/.test(await note()), `(${await note()})`);

        await s.say('Set the focus two parts.');
        check(
            '"two" heard for "to" still sets the focus',
            await s.until(async () => JSON.stringify((await stored()).setup.focuses) === '["inner_parts"]')
        );

        await s.say('Hide the clock.');
        check(
            '"hide the clock" hides it and keeps the timer',
            await s.until(async () => {
                const { app } = await stored();
                return app.showSessionClock === false && app.sessionClockMode === 'timer';
            })
        );
        check('and the clock button says so', await s.shown(/25 min timer \(hidden\)/));
        await s.say('Turn off the clock.');
        check(
            '"turn off the clock" drops the timer too',
            await s.until(async () => {
                const { app } = await stored();
                return app.showSessionClock === false && app.sessionClockMode === 'elapsed';
            })
        );
        await s.say('Show the clock.');
        check('"show the clock" brings it back', await s.until(async () => (await stored()).app.showSessionClock === true));

        await s.say('Set my intention.');
        check('"set my intention" asks for it', await s.until(async () => /What is your intention/.test(await note())), `(${await note()})`);
        await s.say('To be kind to myself.');
        check(
            'and the next thing said is the intention',
            await s.until(async () => (await s.page.locator('#intention').inputValue()) === 'To be kind to myself')
        );
        await s.say('Set my intention.');
        await s.until(async () => /What is your intention/.test(await note()));
        await s.say('Never mind.');
        check('"never mind" leaves it', await s.until(async () => /not changing intention/i.test(await note())), `(${await note()})`);
        check('as it was', (await s.page.locator('#intention').inputValue()) === 'To be kind to myself');
        await s.say('Spacious.');
        check(
            'and after that a vibe is a vibe again',
            await s.until(async () => ((await stored()).setup.qualities ?? []).includes('spacious'))
        );
        await s.say('Spacious.');
        check(
            'and the name alone again flips it off',
            await s.until(async () => !((await stored()).setup.qualities ?? []).includes('spacious'))
        );

        const requests = () => s.page.locator('#custom-instructions');
        await s.say('Special requests.');
        check('"special requests" asks for one', await s.until(async () => /What's your request/.test(await note())), `(${await note()})`);
        check('and opens the field', await requests().isVisible());
        await s.say('Keep it slow.');
        check('and the next thing said is the request', await s.until(async () => (await requests().inputValue()) === 'Keep it slow'));
        await s.say('Special request: no bells.');
        check('a second goes on its own line', await s.until(async () => (await requests().inputValue()) === 'Keep it slow\nno bells'));
        await s.say('Clear my special requests.');
        check('"clear my special requests" empties it', await s.until(async () => (await stored()).setup.customInstructions === ''));

        const pickerUp = () => s.page.evaluate(() => !document.querySelector('#setup-voice-modal')?.classList.contains('hidden'));
        await s.say('Open the voice picker.');
        check('"open the voice picker" opens it', await s.until(pickerUp));
        const other = await s.page.evaluate(() => {
            const rows = [...document.querySelectorAll('#setup-voice-modal-list .voice-row')];
            const free = rows.filter((r) => !r.classList.contains('voice-row-locked') && !r.classList.contains('selected'));
            return free.map((r) => r.dataset.voiceName).find((n) => /^[A-Za-z]+$/.test(n ?? '') && n !== 'Samantha') ?? null;
        });
        if (other) {
            await s.say(`${other}.`);
            check(
                `a name said to the open picker picks it (${other})`,
                await s.until(async () => String((await stored()).app.defaultVoice ?? '').endsWith(`:${other}`)),
                `(${(await stored()).app.defaultVoice})`
            );
        } else console.log('SKIP  no second voice in this browser to pick by name');
        await s.say('Close.');
        check('"close" closes it', await s.until(async () => !(await pickerUp())));
        await s.say('Set the voice to Samantha.');
        check(
            'a voice set by name with the picker closed',
            await s.until(async () => String((await stored()).app.defaultVoice ?? '').endsWith(':Samantha')),
            `(${(await stored()).app.defaultVoice})`
        );

        const models = await s.page.evaluate(() =>
            [...(document.querySelector('#model-select')?.options ?? [])].map((o) => ({ value: o.value, label: o.textContent }))
        );
        const current = (await stored()).setup.model;
        const next = models.find((m) => m.value && m.value !== current);
        if (next) {
            await s.say(`Set the model to ${next.label}.`);
            check(
                `a model set by name (${next.label})`,
                await s.until(async () => (await stored()).setup.model === next.value),
                `(${(await stored()).setup.model})`
            );
        } else console.log('SKIP  one model or none listed, nothing to switch to');

        await s.say('I love playing with my kids.');
        await s.page.waitForTimeout(1200);
        check('room talk changes nothing', JSON.stringify((await stored()).setup.qualities) === '["loving"]' && !(await s.inSession()));

        await s.say('Felt sense.');
        check('a mode by name switches the tab', await s.until(async () => (await stored()).setup.meditationType === 'felt_sense'));
        check('and the mic is still open for the next request', await s.until(async () => /^Listening\./.test(await s.status())));
        await s.say('Add playful.');
        check('a setting from another mode is not applied', await s.until(async () => /part of exploration/.test(await note())), `(${await note()})`);
        check('and the stored vibes are as they were', JSON.stringify((await stored()).setup.qualities) === '["loving"]');

        await s.say('Stop listening.');
        check('"stop listening" closes the mic', await s.until(async () => !(await s.recognizerOpen()), 8_000));
        check('and shows it asleep, not slashed', (await s.look()) === 'sleeping' && (await s.status()) === 'Sleeping. Tap to listen.', `(${await s.status()})`);
        check(
            'with no ring left on it',
            await s.until(() => s.page.evaluate(() => document.querySelector('#voice-start-mic').style.getPropertyValue('--mic-level') === ''), 3_000)
        );
        await s.page.waitForTimeout(4000);
        check('and it stays closed until tapped', (await s.look()) === 'sleeping' && !(await s.recognizerOpen()));
        await s.page.locator('#voice-start-mic').click();
        check('a tap opens it again', await s.until(async () => /^Listening\./.test(await s.status())));
        await s.say('Begin.');
        check('and "begin" still begins', await s.until(s.inSession));
        await s.context.close();
    }

    // ---- the tour with voice mode off: the mic under its cards, captions only ----
    {
        const s = await open({ setupVoice: false });
        await s.setup();
        const setting = () => s.page.evaluate(() => JSON.parse(localStorage.getItem('aloud:app:settings') || '{}').setupVoice);
        const said = (re) => s.until(async () => (await s.spoken()).some((line) => re.test(line)), 5_000);

        check('a fresh profile opens on the welcome card', await s.until(async () => (await s.card()) === 'welcome', 5_000));
        await s.until(async () => (await s.look()) === 'off', 5_000);
        check(
            'the mic beside Begin takes a tap under a centered card',
            (await s.tap('#voice-start-mic')) && (await s.until(async () => (await s.look()) === 'on', 5_000))
        );
        check('and the card stays up', (await s.card()) === 'welcome');
        check(
            'a second tap switches voice mode off, the setting with it',
            (await s.tap('#voice-start-mic')) && (await s.until(async () => (await s.look()) === 'off' && (await setting()) === false, 5_000))
        );
        check('and the card is still up', (await s.card()) === 'welcome');

        await s.page.locator('[data-action="start"]').click();
        check('with voice mode off, the tour offers to turn it on', await s.until(async () => (await s.card()) === 'aloud listens, too', 5_000));
        await s.page.waitForTimeout(1_000);
        check('and says nothing: captions only', (await s.spoken()).length === 0, JSON.stringify(await s.spoken()));
        check('with no speaker on the card to switch', (await s.page.locator('.tour-sound').count()) === 0);
        await s.page.locator('[data-action="mic"]').click();
        check('"Turn on the microphone" turns voice mode on', await s.until(async () => (await s.look()) === 'on' && (await setting()) === true, 5_000));
        check('and the tour speaks from the next card', await said(/^Exploration is a conversation/));
        await s.context.close();
    }

    // ---- the tour: a tap acts at once, a word once the line is over -----------------
    {
        // On, with the permission still to be asked: the tour speaks and
        // offers the mic. Lines long enough that a tap waiting one out would
        // show.
        const s = await open({ setupVoice: true }, {}, { speechCapMs: 9_000, micUnasked: true });
        await s.setup();
        const step = () =>
            s.page.evaluate(() => [...document.querySelectorAll('.tour-dot')].findIndex((d) => d.classList.contains('active')));
        const said = (re) => s.until(async () => (await s.spoken()).some((line) => re.test(line)), 5_000);
        const settings = () => s.page.evaluate(() => JSON.parse(localStorage.getItem('aloud:app:settings') || '{}'));

        await s.until(async () => (await s.card()) === 'welcome', 5_000);
        await s.page.locator('[data-action="start"]').click();
        check('with the permission not yet given, the tour offers the mic', await s.until(async () => (await s.card()) === 'aloud listens, too', 5_000));
        check('and reads the card out', await said(/^Welcome to aloud/));
        await s.page.waitForTimeout(300);
        const t0 = Date.now();
        await s.page.locator('[data-action="mic"]').click();
        const moved = await s.until(async () => !['aloud listens, too', ''].includes(await s.card()), 8_000);
        const took = Date.now() - t0;
        check('"Turn on the microphone" acts without waiting out the line', moved && took < 2_500, `(${took} ms; the line runs about 6 s)`);
        check('and cuts it off', (await s.page.evaluate(() => window.__speechCut)) > 0);
        check('and the mic is on', (await s.look()) === 'on');

        // From here what is under test is that a word is taken once the line
        // and its tail are over; the lines can be short.
        await s.page.evaluate(() => {
            window.__speechCapMs = 1_500;
        });
        let at = await step();
        for (let guard = 0; guard < 8 && !/ready/.test(await s.card()); guard++) {
            await s.say('Next.');
            await s.until(async () => (await step()) !== at, 5_000);
            at = await step();
        }
        check('"next", said once each line is over, walks the tour to its last card', /ready/.test(await s.card()), `(${await s.card()})`);
        check('one card fewer than before: the voice tip is on the last', (await s.page.locator('.tour-dot').count()) === 8, `(${await s.page.locator('.tour-dot').count()} dots)`);
        check('which is read out, the tip and the close in one line', await said(/by talking naturally.*ready to give it a try/));
        await s.say('Twenty minutes.');
        check('a request said to it is taken', await s.until(async () => (await settings()).sessionTimerMin === 20, 5_000));
        check('with the tour still on it', /ready/.test(await s.card()));
        await s.say('Next.');
        check('"next" on the last card is its Got it', await s.until(async () => (await s.card()) === '', 5_000));
        const ended = await s.page.evaluate(() => ({
            done: Object.keys(localStorage).some((k) => k.includes('index-guide-done') && localStorage.getItem(k)),
            later: sessionStorage.getItem('aloud-index-guide-remind'),
        }));
        check('and finishes the tour, not puts it off', ended.done && ended.later === null, JSON.stringify(ended));
        await s.context.close();
    }

    // ---- the tour and a mic asleep ------------------------------------------------
    {
        const s = await open({ setupVoice: true });
        await s.setup();
        await s.page.waitForTimeout(800);
        await s.page.mouse.click(5, 300);
        await s.until(async () => (await s.look()) === 'on');
        const setting = () => s.page.evaluate(() => JSON.parse(localStorage.getItem('aloud:app:settings') || '{}').setupVoice);
        const asleep = async () => (await s.look()) === 'sleeping' && !(await s.recognizerOpen());
        const said = (re) => s.until(async () => (await s.spoken()).some((line) => re.test(line)), 5_000);
        const startTour = async () => {
            await s.page.locator('.info-btn[data-info="methods"]').click();
            await s.page.locator('#start-guide-link').click();
        };

        await s.say('Stop listening.');
        check('"stop listening" puts the mic to sleep', await s.until(asleep, 8_000));
        await startTour();
        check('a tour wakes it', await s.until(async () => (await s.look()) === 'on', 5_000));
        check('and goes straight to the tour, no card offering the mic', await s.until(async () => (await s.card()) === 'section', 5_000), `(${await s.card()})`);

        check(
            'a tap on the mic during a step switches voice mode off',
            (await s.tap('#voice-start-mic')) && (await s.until(async () => (await s.look()) === 'off' && (await setting()) === false, 5_000))
        );
        check('and leaves the tour up', (await s.card()) === 'section');
        check(
            'a second tap turns it on',
            (await s.tap('#voice-start-mic')) && (await s.until(async () => (await s.look()) === 'on', 5_000))
        );

        await s.say('Stop listening.');
        check('"stop listening" in the tour puts it to sleep', await s.until(asleep, 8_000));
        for (let guard = 0; guard < 8 && !/ready/.test(await s.card()); guard++) {
            await s.tap('[data-action="next"]');
            await s.page.waitForTimeout(600);
        }
        check('the tour goes on talking to the end, the last card read out', await said(/by talking naturally/));
        check('with the mic still asleep', await asleep());
        await s.page.locator('[data-action="done"]').click();

        check('a tap wakes a sleeping mic', (await s.tap('#voice-start-mic')) && (await s.until(async () => (await s.look()) === 'on', 5_000)));
        check('and the setting is still on', (await setting()) === true);
        await s.tap('#voice-start-mic');
        await s.until(async () => (await s.look()) === 'off', 5_000);
        const before = (await s.spoken()).length;
        await startTour();
        await s.page.waitForTimeout(1_500);
        check('with voice mode off a tour leaves the mic off', (await s.look()) === 'off' && !(await s.recognizerOpen()));
        check('offers to turn it on', (await s.card()) === 'aloud listens, too', `(${await s.card()})`);
        check('and says nothing', (await s.spoken()).length === before);
        await s.context.close();
    }

    // ---- a noting circle: its own listen loop -----------------------------------
    {
        const s = await open({ setupVoice: false }, { meditationType: 'noting' });
        await s.setup();
        await s.begin();
        check('noting session starts', await s.until(s.inSession));
        await s.sayAfter(1700, 'thinking');
        check('a note is a note', await s.shown(/thinking/i));

        await s.sayAfter(1700, 'End the session.');
        check('noting: "end the session" is answered with the question', await s.shown(/Would you like to end the session now\?/));
        await s.sayAfter(1700, 'Not yet.');
        check('noting: "not yet" carries on', (await s.shown(/we'll keep going/)) && (await s.inSession()));
        await s.sayAfter(1700, 'hearing');
        check('noting: the circle goes on taking notes', await s.shown(/hearing/i));

        await s.sayAfter(1700, 'Mute.');
        check('noting: "mute" pauses the circle', await s.shown(/Paused, unmute to resume/));
        check('noting: and closes the mic', await s.until(async () => !(await s.recognizerOpen()), 5_000));
        await s.page.locator('#voice-btn').click();

        await s.sayAfter(1700, 'Can we end the session?');
        await s.until(async () => (await s.asked()) > 1);
        await s.sayAfter(1700, 'Yes.');
        check('noting: "yes" ends the session', await s.until(async () => !(await s.inSession())));
        const text = await s.page.evaluate(() => document.body.innerText);
        check('noting: none of it was taken as a note', !/You\s*\n?\s*(End the session|Not yet|Mute|Yes)\b/i.test(text));
        await s.context.close();
    }
} catch (err) {
    failures.push(`threw: ${err.message}`);
    console.log('ERROR', err.message);
    const screen = await lastPage?.evaluate(() => document.body.innerText).catch(() => '');
    if (screen) console.log('ON SCREEN:', screen.replace(/\s+/g, ' ').slice(0, 700));
}

await browser.close();
console.log(failures.length ? `\n${failures.length} FAILED: ${failures.join('; ')}` : '\nALL PASSED');
process.exit(failures.length ? 1 : 0);

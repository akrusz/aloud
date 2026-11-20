/**
 * Listening for "begin" on the setup screen. The rules that make it safe to
 * have a microphone open before a session exists are the thing under test:
 * never the thing that raises a permission prompt, only for a bounded window,
 * cheap on a recognizer that bills, and the mic released before the session
 * starts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttEngine, SttEvent } from '../src/platform/index.js';
import type { SttStopOptions } from '../src/platform/stt.js';
import type { BeginRequest } from '../src/facilitation/index.js';
import { defaultPacingConfig } from '../src/facilitation/pacing.js';
const micCheck = vi.hoisted(() => ({ opened: false }));
vi.mock('../ui/src/mic-check.js', () => ({ micOpenedThisPage: () => micCheck.opened }));

import {
    createMicHandover,
    HEARING_WAIT_MAX_MS,
    listenOnSetup,
    LOBBY_STT,
    micPermission,
    voiceStartBlocker,
    setupListeningLimits,
    VOICE_START_LATE_UNHEARD_COST,
    VOICE_START_SENT_UNHEARD,
    SPEECH_TAIL_MS,
    VOICE_START_MAX_OPEN_MS,
    VOICE_START_WINDOW_MS,
    type ListenOnSetupOptions,
    type SetupHearing,
    type SetupListeningLimits,
    type VoiceStartEnd,
    type VoiceStartHandle,
} from '../ui/src/voice-start.js';

const ready = { enabled: true, mic: 'granted', canBegin: true, touched: true } as const;

describe('voiceStartBlocker', () => {
    it('allows it when everything lines up', () => {
        expect(voiceStartBlocker(ready)).toBeNull();
    });
    it('still shows a mic that is switched off, wherever it could be switched on', () => {
        // Off is the last thing checked: a mic that can't open is hidden or
        // blocked whatever the setting says.
        expect(voiceStartBlocker({ ...ready, enabled: false, canBegin: false })).toBe('not-ready');
        expect(voiceStartBlocker({ ...ready, enabled: false, mic: 'denied' })).toBe('mic-denied');
        expect(voiceStartBlocker({ ...ready, enabled: false, mic: 'ask' })).toBe('off');
    });

    it('is off unless switched on', () => {
        expect(voiceStartBlocker({ ...ready, enabled: false })).toBe('off');
    });
    it('waits for a tap where opening the mic might prompt', () => {
        expect(voiceStartBlocker({ ...ready, mic: 'ask' })).toBe('mic-ask');
    });
    it('says so where the mic is blocked', () => {
        expect(voiceStartBlocker({ ...ready, mic: 'denied' })).toBe('mic-denied');
    });
    it('waits for Begin itself to be possible, and offers nothing until it is', () => {
        expect(voiceStartBlocker({ ...ready, canBegin: false })).toBe('not-ready');
        expect(voiceStartBlocker({ ...ready, canBegin: false, mic: 'ask' })).toBe('not-ready');
        expect(voiceStartBlocker({ ...ready, canBegin: false, mic: 'denied' })).toBe('not-ready');
    });
    it('waits for a touch where the page is silent without one', () => {
        expect(voiceStartBlocker({ ...ready, touched: false })).toBe('no-touch-yet');
    });
    it('asks for one tap, not two: the tap that allows the mic is the touch', () => {
        expect(voiceStartBlocker({ ...ready, mic: 'ask', touched: false })).toBe('mic-ask');
    });
});

describe('micPermission', () => {
    /** What the page can learn, by source. `shell` is the desktop app's
     *  /app/v1/mic-permission (absent: not the desktop app). */
    function world(sources: { shell?: string | Error; browser?: string | Error }): { fetched: () => number } {
        let fetched = 0;
        if (sources.shell !== undefined) vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        vi.stubGlobal('fetch', async () => {
            fetched++;
            if (sources.shell instanceof Error) throw sources.shell;
            return { ok: true, json: async () => ({ status: sources.shell }) };
        });
        vi.stubGlobal('navigator', {
            permissions: {
                query: async () => {
                    if (sources.browser instanceof Error) throw sources.browser;
                    return { state: sources.browser };
                },
            },
        });
        return { fetched: () => fetched };
    }
    afterEach(() => {
        vi.unstubAllGlobals();
        micCheck.opened = false;
    });

    it('needs no one\'s word once the mic has opened on this page', async () => {
        const page = world({ shell: 'prompt', browser: 'prompt' });
        micCheck.opened = true;
        expect(await micPermission()).toBe('granted');
        expect(page.fetched()).toBe(0);
    });

    it('takes the desktop shell at its word over the webview, which says "prompt" there', async () => {
        world({ shell: 'granted', browser: 'prompt' });
        expect(await micPermission()).toBe('granted');
        world({ shell: 'denied', browser: 'prompt' });
        expect(await micPermission()).toBe('denied');
    });
    it('waits for a tap on a desktop that has never been asked', async () => {
        world({ shell: 'prompt', browser: 'granted' });
        expect(await micPermission()).toBe('ask');
    });
    it('falls back to the webview where the shell cannot tell, or cannot be reached', async () => {
        world({ shell: 'unknown', browser: 'granted' });
        expect(await micPermission()).toBe('granted');
        world({ shell: new Error('down'), browser: 'denied' });
        expect(await micPermission()).toBe('denied');
    });
    it('asks the browser alone on the web', async () => {
        const web = world({ browser: 'granted' });
        expect(await micPermission()).toBe('granted');
        expect(web.fetched()).toBe(0);
    });
    it('counts anything short of a clear answer as ask, so nothing prompts unasked', async () => {
        world({ browser: 'prompt' });
        expect(await micPermission()).toBe('ask');
        world({ browser: new TypeError('unsupported descriptor') });
        expect(await micPermission()).toBe('ask');
        vi.stubGlobal('navigator', {});
        expect(await micPermission()).toBe('ask');
    });
});

describe('LOBBY_STT', () => {
    it('ends a turn sooner than a session does and never speculates', () => {
        expect(LOBBY_STT.silenceBaseMs).toBeLessThan(defaultPacingConfig.silenceBaseMs);
        expect(LOBBY_STT.silenceMaxMs).toBeLessThan(defaultPacingConfig.silenceMaxMs);
        expect(LOBBY_STT.speculation).toBe(false);
    });
    it('keeps what one window can send to a billing recognizer within the window', () => {
        expect(LOBBY_STT.maxUtteranceMs).toBeLessThanOrEqual(VOICE_START_WINDOW_MS / 10);
    });
});

/** An engine whose every start() yields the next scripted utterance, then
 *  completes, the way a recognizer ends a turn. An empty string is a turn in
 *  which nothing was said. */
function scriptedEngine(utterances: Array<string | Error>): SttEngine & { starts: number; stops: number } {
    const queue = [...utterances];
    let release: (() => void) | null = null;
    const engine = {
        starts: 0,
        stops: 0,
        async *start(): AsyncIterable<SttEvent> {
            engine.starts++;
            const next = queue.shift();
            if (next === undefined) {
                // Nothing more to hear: stay open until stopped.
                await new Promise<void>((r) => (release = r));
                return;
            }
            if (next instanceof Error) {
                yield { type: 'error', error: next };
                return;
            }
            if (next) yield { type: 'final', text: next };
        },
        async stop(): Promise<void> {
            engine.stops++;
            release?.();
        },
    };
    return engine;
}

describe('listenOnSetup', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function run(
        engine: SttEngine,
        alive: () => boolean = () => true,
        onHeard?: (text: string) => boolean | Promise<boolean>,
        limits: Partial<SetupListeningLimits> & { now?: () => number } = {}
    ) {
        const ends: VoiceStartEnd[] = [];
        const order: string[] = [];
        const requests: BeginRequest[] = [];
        const handle = listenOnSetup({
            engine,
            alive,
            onBegin: (request) => {
                requests.push(request);
                order.push('begin');
            },
            ...(onHeard ? { onHeard } : {}),
            ...limits,
            onEnd: (why) => {
                ends.push(why);
                order.push(`end:${why}`);
            },
        });
        return { handle, ends, order, requests };
    }

    it('starts the session on "begin", after the mic has been released', async () => {
        const engine = scriptedEngine(["Let's begin."]);
        const { ends, order } = run(engine);
        await vi.advanceTimersByTimeAsync(10);
        expect(ends).toEqual(['begin']);
        // Released first, then begun: the session opens its own mic.
        expect(engine.stops).toBeGreaterThanOrEqual(1);
        expect(order).toEqual(['end:begin', 'begin']);
    });

    it('on "begin", keeps the mic stream open for the session where asked, until that settles', async () => {
        // The session's capture opens beside it (mic-check.ts
        // holdCaptureForSession): the OS never sees the mic close between.
        const engine = scriptedEngine(["Let's begin."]);
        const keeps: Array<Promise<unknown> | undefined> = [];
        const stop = engine.stop.bind(engine);
        engine.stop = (options?: SttStopOptions) => {
            keeps.push(options?.keepMicUntil);
            return stop();
        };
        let sessionHears = (): void => {};
        const forSession = new Promise<void>((r) => (sessionHears = r));
        const order: string[] = [];
        listenOnSetup({
            engine,
            alive: () => true,
            onBegin: () => order.push('begin'),
            onEnd: (why) => order.push(`end:${why}`),
            keepMicForBegin: () => forSession,
        });
        await vi.advanceTimersByTimeAsync(10);
        expect(order).toEqual(['end:begin', 'begin']);
        expect(keeps.length).toBeGreaterThanOrEqual(1);
        expect(keeps.every((keep) => keep instanceof Promise)).toBe(true);
        let letGo = false;
        void Promise.all(keeps).then(() => (letGo = true));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(letGo).toBe(false);
        sessionHears();
        await vi.advanceTimersByTimeAsync(0);
        expect(letGo).toBe(true);
    });

    it('hands over what the request named', async () => {
        const engine = scriptedEngine(['Begin a twenty minute felt sense session.']);
        const { requests } = run(engine);
        await vi.advanceTimersByTimeAsync(10);
        expect(requests).toEqual([{ mode: 'felt_sense', minutes: 20 }]);
    });

    it('ignores everything else and keeps listening', async () => {
        const engine = scriptedEngine(['When does the movie start?', '', 'I should begin cooking', 'okay begin']);
        const { ends, order } = run(engine);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(engine.starts).toBe(4);
        expect(ends).toEqual(['begin']);
        expect(order.filter((o) => o === 'begin')).toHaveLength(1);
    });

    it('closes each turn it leaves early, so no recognizer is left open behind it', async () => {
        // An engine forgets its recognizer once its iterator is closed, so the
        // stop has to come before the loop moves on, once per turn heard.
        const engine = scriptedEngine(['When does the movie start?', 'I should begin cooking', 'begin']);
        run(engine);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(engine.starts).toBe(3);
        // Two turns that were not the request, each stopped, and the last one.
        expect(engine.stops).toBeGreaterThanOrEqual(3);
    });

    it('closes the mic when the window runs out, without beginning', async () => {
        const engine = scriptedEngine([]);
        const { ends, order } = run(engine);
        await vi.advanceTimersByTimeAsync(VOICE_START_WINDOW_MS - 1_000);
        expect(ends).toEqual([]);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(ends).toEqual(['window']);
        expect(engine.stops).toBe(1);
        expect(order).not.toContain('begin');
    });

    it('stays open on a free desktop recognizer, however long nothing is said', async () => {
        const engine = scriptedEngine([]);
        const { ends } = run(engine, () => true, undefined, setupListeningLimits('free'));
        await vi.advanceTimersByTimeAsync(VOICE_START_MAX_OPEN_MS * 3);
        expect(ends).toEqual([]);
    });

    it('closes there on a room that keeps talking, and a request starts the count over', async () => {
        const room = (n: number): string[] => Array.from({ length: n }, (_, i) => `the weather on channel ${i}`);
        const talk = scriptedEngine(room(3));
        const first = run(talk, () => true, () => false, { ...setupListeningLimits('free'), unheardLimit: 3 });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(first.ends).toEqual(['window']);

        const mixed = scriptedEngine([...room(2), 'twenty minutes', ...room(2)]);
        const second = run(mixed, () => true, (text) => text === 'twenty minutes', { ...setupListeningLimits('free'), unheardLimit: 3 });
        await vi.advanceTimersByTimeAsync(10_000);
        expect(second.ends).toEqual([]);
    });

    it("keeps the clock on a phone, and nowhere else", () => {
        expect(setupListeningLimits('phone')).toMatchObject({
            windowMs: VOICE_START_WINDOW_MS,
            maxOpenMs: VOICE_START_MAX_OPEN_MS,
            unheardLimit: VOICE_START_SENT_UNHEARD,
        });
        expect(setupListeningLimits('hosted')).toMatchObject({ windowMs: Infinity, maxOpenMs: Infinity });
    });

    it('closes a phone too on a room that keeps talking, well inside the window', async () => {
        const room = Array.from({ length: VOICE_START_SENT_UNHEARD }, (_, i) => `the weather on channel ${i}`);
        const { ends } = run(scriptedEngine(room), () => true, () => false, setupListeningLimits('phone'));
        await vi.advanceTimersByTimeAsync(VOICE_START_WINDOW_MS / 4);
        expect(ends).toEqual(['window']);
    });

    it('leaves hosted recognition open at a desktop while the room is quiet', async () => {
        const { ends } = run(scriptedEngine([]), () => true, undefined, setupListeningLimits('hosted'));
        await vi.advanceTimersByTimeAsync(VOICE_START_MAX_OPEN_MS * 3);
        expect(ends).toEqual([]);
    });

    it('counts a thing heard there for one at first, and for more once nothing has been asked for a while', async () => {
        const limits = setupListeningLimits('hosted');
        const lateCloses = Math.ceil(VOICE_START_SENT_UNHEARD / VOICE_START_LATE_UNHEARD_COST);
        const room = (n: number): string[] => Array.from({ length: n }, (_, i) => `the weather on channel ${i}`);

        // Early, one short of the limit leaves it open.
        const early = run(scriptedEngine(room(VOICE_START_SENT_UNHEARD - 1)), () => true, () => false, limits);
        await vi.advanceTimersByTimeAsync(VOICE_START_WINDOW_MS / 4);
        expect(early.ends).toEqual([]);

        // Late, a few are enough.
        const clock = { at: 0 };
        const late = run(scriptedEngine(room(lateCloses)), () => true, () => false, {
            ...limits,
            now: () => clock.at,
        });
        clock.at = VOICE_START_WINDOW_MS + 1;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(late.ends).toEqual(['window']);

        // A request understood starts both the count and the wait over.
        const asked = { at: 0 };
        const talk = [...room(lateCloses - 1), 'twenty minutes', ...room(lateCloses)];
        const again = run(scriptedEngine(talk), () => true, (text) => text === 'twenty minutes', {
            ...limits,
            now: () => asked.at,
        });
        asked.at = VOICE_START_WINDOW_MS + 1;
        await vi.advanceTimersByTimeAsync(20_000);
        expect(again.ends).toEqual([]);
    });

    it('closes the mic as soon as the setup screen is gone', async () => {
        const engine = scriptedEngine([]);
        let alive = true;
        const { ends } = run(engine, () => alive);
        await vi.advanceTimersByTimeAsync(3_000);
        alive = false;
        await vi.advanceTimersByTimeAsync(600);
        expect(ends).toEqual(['stopped']);
        expect(engine.stops).toBe(1);
    });

    it('gives up quietly on a recognizer error', async () => {
        const engine = scriptedEngine([new Error('not-allowed')]);
        const { ends, order } = run(engine);
        await vi.advanceTimersByTimeAsync(10);
        expect(ends).toEqual(['error']);
        expect(order).not.toContain('begin');
    });

    it('stop() ends it once, and "begin" heard after that does nothing', async () => {
        const engine = scriptedEngine([]);
        const { handle, ends, order } = run(engine);
        await vi.advanceTimersByTimeAsync(100);
        await handle.stop();
        await handle.stop();
        expect(ends).toEqual(['stopped']);
        await vi.advanceTimersByTimeAsync(VOICE_START_WINDOW_MS + 1_000);
        expect(ends).toEqual(['stopped']);
        expect(order).not.toContain('begin');
    });

    it('does not spin on a recognizer that keeps returning nothing', async () => {
        const engine = scriptedEngine(Array.from({ length: 1000 }, () => ''));
        run(engine);
        await vi.advanceTimersByTimeAsync(3_000);
        // One empty turn every ~300 ms, not a thousand in a tick.
        expect(engine.starts).toBeLessThan(15);
    });

    it('hands over what is not "begin", with the recognizer stopped while it is answered', async () => {
        const engine = scriptedEngine(['add playful', 'begin']);
        const heard: string[] = [];
        let startsWhileAnswering = -1;
        const { ends } = run(engine, () => true, async (text) => {
            heard.push(text);
            const before = engine.starts;
            await new Promise((r) => setTimeout(r, 2_000));
            startsWhileAnswering = engine.starts - before;
            return true;
        });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(heard).toEqual(['add playful']);
        expect(engine.starts).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000 + SPEECH_TAIL_MS + 50);
        expect(startsWhileAnswering).toBe(0);
        expect(ends).toEqual(['begin']);
    });

    it('never hands "begin" to the settings path', async () => {
        const engine = scriptedEngine(['begin a noting session']);
        const heard: string[] = [];
        run(engine, () => true, (text) => {
            heard.push(text);
            return true;
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(heard).toEqual([]);
    });

    it('stays open while requests keep coming, and closes on the room alone', async () => {
        const engine = scriptedEngine([]);
        const { handle, ends } = run(engine);
        await vi.advanceTimersByTimeAsync(VOICE_START_WINDOW_MS - 5_000);
        handle.keepOpen();
        await vi.advanceTimersByTimeAsync(VOICE_START_WINDOW_MS - 5_000);
        expect(ends).toEqual([]);
        await vi.advanceTimersByTimeAsync(6_000);
        expect(ends).toEqual(['window']);
    });

    it('closes at the ceiling however many requests it has understood', async () => {
        const engine = scriptedEngine([]);
        const { handle, ends } = run(engine);
        for (let t = 0; t < VOICE_START_MAX_OPEN_MS - 30_000; t += 30_000) {
            await vi.advanceTimersByTimeAsync(30_000);
            handle.keepOpen();
        }
        expect(ends).toEqual([]);
        await vi.advanceTimersByTimeAsync(31_000);
        expect(ends).toEqual(['window']);
    });

    it('hold() stops the recognizer for a line and listens again after its tail', async () => {
        const engine = scriptedEngine([]);
        const { handle, ends } = run(engine);
        await vi.advanceTimersByTimeAsync(100);
        expect(engine.starts).toBe(1);
        let done = false;
        void handle.hold(() => new Promise<void>((r) => setTimeout(r, 3_000))).then(() => (done = true));
        await vi.advanceTimersByTimeAsync(2_900);
        // Stopped, and not started again under the line.
        expect(engine.stops).toBeGreaterThanOrEqual(1);
        expect(engine.starts).toBe(1);
        await vi.advanceTimersByTimeAsync(100 + SPEECH_TAIL_MS + 400);
        expect(done).toBe(true);
        expect(engine.starts).toBe(2);
        expect(ends).toEqual([]);
    });

    it('keeps the mic stream through a line and between turns, and lets it go when listening ends', async () => {
        // On macOS a mic let go as a line starts cuts half a second out of it.
        const engine = scriptedEngine(['add playful']);
        const keeps: Array<Promise<unknown> | undefined> = [];
        const stop = engine.stop.bind(engine);
        engine.stop = (options?: SttStopOptions) => {
            keeps.push(options?.keepMicUntil);
            return stop();
        };
        const { handle } = run(engine, () => true, () => true);
        await vi.advanceTimersByTimeAsync(SPEECH_TAIL_MS + 100);
        const line = handle.hold(() => new Promise<void>((r) => setTimeout(r, 1_000)));
        await vi.advanceTimersByTimeAsync(1_000 + SPEECH_TAIL_MS + 100);
        await line;
        let letGo = false;
        expect(keeps.length).toBeGreaterThanOrEqual(2);
        for (const keep of keeps) {
            expect(keep).toBeInstanceOf(Promise);
            void keep!.then(() => (letGo = true));
        }
        await vi.advanceTimersByTimeAsync(5_000);
        expect(letGo).toBe(false);
        await handle.stop();
        expect(letGo).toBe(true);
        // The last stop, the one that ends it, keeps nothing.
        expect(keeps.at(-1)).toBeUndefined();
    });

    it('stop({ keepMicUntil }) keeps the mic stream until that settles, and plain stop() lets it go first', async () => {
        const keepsOf = (engine: ReturnType<typeof scriptedEngine>) => {
            const keeps: Array<Promise<unknown> | undefined> = [];
            const stop = engine.stop.bind(engine);
            engine.stop = (options?: SttStopOptions) => {
                keeps.push(options?.keepMicUntil);
                return stop();
            };
            return keeps;
        };
        const settledFlag = (promise: Promise<unknown> | undefined) => {
            const state = { settled: false };
            void promise?.then(() => (state.settled = true));
            return state;
        };

        // Handed over: stopped, ended, the stream still held.
        const handed = scriptedEngine([]);
        const handedKeeps = keepsOf(handed);
        const first = run(handed);
        await vi.advanceTimersByTimeAsync(100);
        let nextIsLive = (): void => {};
        await first.handle.stop({ keepMicUntil: new Promise<void>((r) => (nextIsLive = r)) });
        expect(first.ends).toEqual(['stopped']);
        const held = settledFlag(handedKeeps.at(-1));
        expect(handedKeeps.at(-1)).toBeInstanceOf(Promise);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(held.settled).toBe(false);
        nextIsLive();
        await vi.advanceTimersByTimeAsync(0);
        expect(held.settled).toBe(true);

        // Plain: nothing kept, and let go before onEnd runs.
        const plain = scriptedEngine([]);
        const plainKeeps = keepsOf(plain);
        const second = run(plain);
        await vi.advanceTimersByTimeAsync(100);
        await second.handle.stop();
        expect(plainKeeps).toEqual([undefined]);
        expect(second.ends).toEqual(['stopped']);
    });

    it('keeps the mic of a recognizer that failed for one built in its place, where asked', async () => {
        const engine = scriptedEngine([new Error('lost')]);
        const keeps: Array<Promise<unknown> | undefined> = [];
        const stop = engine.stop.bind(engine);
        engine.stop = (options?: SttStopOptions) => {
            keeps.push(options?.keepMicUntil);
            return stop();
        };
        let rebuilt!: () => void;
        const ends: VoiceStartEnd[] = [];
        listenOnSetup({
            engine,
            alive: () => true,
            onBegin: () => undefined,
            onEnd: (why) => void ends.push(why),
            keepMicOnError: () => new Promise<void>((resolve) => (rebuilt = resolve)),
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(ends).toEqual(['error']);
        let letGo = false;
        void keeps.at(-1)!.then(() => (letGo = true));
        await vi.advanceTimersByTimeAsync(5_000);
        expect(letGo).toBe(false);
        rebuilt();
        await vi.advanceTimersByTimeAsync(0);
        expect(letGo).toBe(true);
    });

    it('a hold over a recognizer that errors when stopped is not a failure', async () => {
        // Browser recognition reports its own abort as an error.
        let release: (() => void) | null = null;
        let starts = 0;
        const engine: SttEngine = {
            async *start(): AsyncIterable<SttEvent> {
                starts++;
                await new Promise<void>((r) => (release = r));
                yield { type: 'error', error: new Error('aborted') };
            },
            async stop(): Promise<void> {
                release?.();
            },
        } as SttEngine;
        const { handle, ends } = run(engine);
        await vi.advanceTimersByTimeAsync(100);
        void handle.hold(() => new Promise<void>((r) => setTimeout(r, 500)));
        await vi.advanceTimersByTimeAsync(2_000);
        expect(ends).toEqual([]);
        expect(starts).toBe(2);
    });

    it('asks whether it heard its own line before anything, "begin" included', async () => {
        // A line that ends on the word, caught as the mic reopens.
        const engine = scriptedEngine(['begin.', 'begin']);
        let asked = 0;
        const ends: VoiceStartEnd[] = [];
        listenOnSetup({
            engine,
            alive: () => true,
            onBegin: () => undefined,
            isEcho: () => asked++ === 0,
            onEnd: (why) => ends.push(why),
        });
        await vi.advanceTimersByTimeAsync(200);
        expect(ends).toEqual([]);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ends).toEqual(['begin']);
    });
});

/** Stands in for WhisperPcmSttEngine.whenHearing: each call waits for hear(). */
function hearingSignal(): { asked: number; whenHearing: () => Promise<void>; hear: () => void } {
    const waiting: Array<() => void> = [];
    const signal = {
        asked: 0,
        whenHearing: (): Promise<void> => {
            signal.asked++;
            return new Promise<void>((resolve) => waiting.push(resolve));
        },
        hear: (): void => {
            for (const resolve of waiting.splice(0)) resolve();
        },
    };
    return signal;
}

/** An engine whose turn ends when say() hands it words, or when stopped. */
function liveEngine(): SttEngine & { starts: number; say: (text: string) => void } {
    let deliver: ((text: string | null) => void) | null = null;
    const engine = {
        starts: 0,
        async *start(): AsyncIterable<SttEvent> {
            engine.starts++;
            const text = await new Promise<string | null>((resolve) => (deliver = resolve));
            deliver = null;
            if (text) yield { type: 'final', text } as const;
        },
        async stop(): Promise<void> {
            deliver?.(null);
        },
        say: (text: string): void => deliver?.(text),
    };
    return engine;
}

describe('listenOnSetup: whether the recognizer can hear', () => {
    // What the mic beside Begin pulses on: lit while words said are lost
    // would be a mic that lies.
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function listen(engine: SttEngine, extra: Partial<ListenOnSetupOptions> = {}) {
        const states: SetupHearing[] = [];
        const ends: VoiceStartEnd[] = [];
        const handle = listenOnSetup({
            engine,
            alive: () => true,
            onBegin: () => undefined,
            onEnd: (why) => ends.push(why),
            onHearing: (state) => states.push(state),
            ...extra,
        });
        return { handle, states, ends };
    }

    it('is opening until the turn can hear, not merely until it has started', async () => {
        // A capture opened afresh on macOS sends digital silence first.
        const engine = scriptedEngine([]);
        const signal = hearingSignal();
        const { states } = listen(engine, { whenHearing: signal.whenHearing });
        await vi.advanceTimersByTimeAsync(1_000);
        expect(engine.starts).toBe(1);
        expect(signal.asked).toBe(1);
        expect(states).toEqual([]);
        signal.hear();
        await vi.advanceTimersByTimeAsync(0);
        expect(states).toEqual(['hearing']);
    });

    it('is paused for a line and its tail, and hears again only once the next turn can', async () => {
        const engine = scriptedEngine([]);
        const signal = hearingSignal();
        const { handle, states } = listen(engine, { whenHearing: signal.whenHearing });
        await vi.advanceTimersByTimeAsync(100);
        signal.hear();
        await vi.advanceTimersByTimeAsync(0);
        void handle.hold(() => new Promise<void>((r) => setTimeout(r, 2_000)));
        await vi.advanceTimersByTimeAsync(0);
        expect(states).toEqual(['hearing', 'paused']);
        await vi.advanceTimersByTimeAsync(2_000 + SPEECH_TAIL_MS + 50);
        // Started again, and still paused: a kept stream is quick, not instant.
        expect(engine.starts).toBe(2);
        expect(states).toEqual(['hearing', 'paused']);
        signal.hear();
        await vi.advanceTimersByTimeAsync(0);
        expect(states).toEqual(['hearing', 'paused', 'hearing']);
    });

    it('is paused while a request is answered and through the tail after it', async () => {
        const engine = liveEngine();
        const signal = hearingSignal();
        const { states } = listen(engine, {
            whenHearing: signal.whenHearing,
            onHeard: async () => {
                await new Promise((r) => setTimeout(r, 2_000));
                return true;
            },
        });
        await vi.advanceTimersByTimeAsync(10);
        signal.hear();
        await vi.advanceTimersByTimeAsync(0);
        engine.say('add playful');
        await vi.advanceTimersByTimeAsync(10);
        expect(states).toEqual(['hearing', 'paused']);
        await vi.advanceTimersByTimeAsync(2_000 + SPEECH_TAIL_MS - 100);
        expect(engine.starts).toBe(1);
        await vi.advanceTimersByTimeAsync(200);
        expect(engine.starts).toBe(2);
        expect(states.at(-1)).toBe('paused');
        signal.hear();
        await vi.advanceTimersByTimeAsync(0);
        expect(states).toEqual(['hearing', 'paused', 'hearing']);
    });

    it('stays opening through a line said before it ever heard', async () => {
        // The pause around a line is quick; the mic opening is the slow part,
        // and that is what it still is.
        const engine = scriptedEngine([]);
        const signal = hearingSignal();
        const { handle, states } = listen(engine, { whenHearing: signal.whenHearing });
        await vi.advanceTimersByTimeAsync(100);
        void handle.hold(() => new Promise<void>((r) => setTimeout(r, 1_000)));
        await vi.advanceTimersByTimeAsync(1_000 + SPEECH_TAIL_MS + 50);
        expect(engine.starts).toBe(2);
        expect(states).toEqual([]);
        signal.hear();
        await vi.advanceTimersByTimeAsync(0);
        expect(states).toEqual(['hearing']);
    });

    it('stops waiting HEARING_WAIT_MAX_MS into a turn whose sign never comes, counted from that turn', async () => {
        // A mic that sends only silence must not leave the mic pulsing.
        const engine = scriptedEngine([]);
        const { handle, states } = listen(engine, { whenHearing: () => new Promise<void>(() => undefined) });
        await vi.advanceTimersByTimeAsync(1_000);
        void handle.hold(() => new Promise<void>((r) => setTimeout(r, 3_000)));
        // The first turn's wait runs out under the line: not counted.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(engine.starts).toBe(2);
        expect(states).toEqual([]);
        await vi.advanceTimersByTimeAsync(HEARING_WAIT_MAX_MS);
        expect(states).toEqual(['hearing']);
    });

    it('hears as soon as the turn starts on a recognizer with nothing better to say', async () => {
        const engine = scriptedEngine([]);
        const { handle, states } = listen(engine);
        await vi.advanceTimersByTimeAsync(0);
        expect(states).toEqual(['hearing']);
        void handle.hold(() => new Promise<void>((r) => setTimeout(r, 1_000)));
        await vi.advanceTimersByTimeAsync(10);
        expect(states).toEqual(['hearing', 'paused']);
        await vi.advanceTimersByTimeAsync(1_000 + SPEECH_TAIL_MS + 50);
        expect(states).toEqual(['hearing', 'paused', 'hearing']);
    });

    it('says nothing more once listening has ended, stopped or failed', async () => {
        const engine = scriptedEngine([]);
        const signal = hearingSignal();
        const stopped = listen(engine, { whenHearing: signal.whenHearing });
        await vi.advanceTimersByTimeAsync(100);
        await stopped.handle.stop();
        signal.hear();
        await vi.advanceTimersByTimeAsync(HEARING_WAIT_MAX_MS * 2);
        expect(stopped.ends).toEqual(['stopped']);
        expect(stopped.states).toEqual([]);

        const failed = listen(scriptedEngine([new Error('not-allowed')]), {
            whenHearing: () => new Promise<void>(() => undefined),
        });
        await vi.advanceTimersByTimeAsync(HEARING_WAIT_MAX_MS * 2);
        expect(failed.ends).toEqual(['error']);
        expect(failed.states).toEqual([]);
    });
});

describe('listenOnSetup: a line held for a capture opened cold', () => {
    // A tour line started 137 ms after the mic opened cold began a fraction
    // in and quiet, rising over a couple of seconds (desktop app,
    // 2026-11-18): voice processing starting and a Bluetooth headset going
    // to call audio, under the line.
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    /** Stands in for WhisperPcmSttEngine.coldOpening: coming up until
     *  settle(), null after. */
    function coldOpen(): { coldOpening: () => Promise<void> | null; settle: () => void } {
        let settle!: () => void;
        let opening: Promise<void> | null = new Promise<void>((resolve) => (settle = resolve));
        return {
            coldOpening: () => opening,
            settle: () => {
                opening = null;
                settle();
            },
        };
    }

    function listen(engine: SttEngine, coldOpening?: () => Promise<void> | null) {
        return listenOnSetup({
            engine,
            alive: () => true,
            onBegin: () => undefined,
            onEnd: () => undefined,
            ...(coldOpening ? { coldOpening } : {}),
        });
    }

    it('starts the line only once the capture has settled, the turn listening until then', async () => {
        const engine = scriptedEngine([]);
        const open = coldOpen();
        const handle = listen(engine, open.coldOpening);
        await vi.advanceTimersByTimeAsync(100);
        const order: string[] = [];
        void handle.hold(async () => void order.push(`line, stops ${engine.stops}`));
        await vi.advanceTimersByTimeAsync(2_000);
        // Not stopped: its frames are how the engine sees the first sound,
        // and a stop as the capture opens would close it again.
        expect(order).toEqual([]);
        expect(engine.stops).toBe(0);
        open.settle();
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(['line, stops 1']);
    });

    it('adds nothing where no capture is coming up, or the recognizer has none of ours', async () => {
        for (const coldOpening of [() => null, undefined]) {
            const engine = scriptedEngine([]);
            const handle = listen(engine, coldOpening);
            await vi.advanceTimersByTimeAsync(100);
            let started = false;
            void handle.hold(async () => void (started = true));
            await vi.advanceTimersByTimeAsync(0);
            expect(started).toBe(true);
            await handle.stop();
        }
    });

    it('keeps lines asked for while it waits in the order they were asked', async () => {
        const engine = scriptedEngine([]);
        const open = coldOpen();
        const handle = listen(engine, open.coldOpening);
        await vi.advanceTimersByTimeAsync(100);
        const order: string[] = [];
        void handle.hold(async () => void order.push('first'));
        void handle.hold(async () => void order.push('second'));
        await vi.advanceTimersByTimeAsync(1_000);
        expect(order).toEqual([]);
        open.settle();
        await vi.advanceTimersByTimeAsync(0);
        expect(order).toEqual(['first', 'second']);
        // And listens again after the last of them, not under it.
        await vi.advanceTimersByTimeAsync(SPEECH_TAIL_MS + 50);
        expect(engine.starts).toBe(2);
    });
});

describe('createMicHandover', () => {
    /** A handle that says what its stop kept the mic for. */
    function handle(): VoiceStartHandle & { kept: Array<Promise<unknown> | undefined> } {
        const kept: Array<Promise<unknown> | undefined> = [];
        return {
            kept,
            stop: async (options) => void kept.push(options?.keepMicUntil),
            hold: (during) => during(),
            keepOpen: () => undefined,
        };
    }
    const settledFlag = (promise: Promise<unknown> | undefined) => {
        const state = { settled: false };
        void promise?.then(() => (state.settled = true));
        return state;
    };

    it('holds a replaced mic until whoever took it lets it go', async () => {
        const handover = createMicHandover();
        const old = handle();
        await handover.stop(old);
        const held = settledFlag(old.kept[0]);
        const letGo = handover.take();
        // Taken: a release by anyone else no longer reaches it.
        handover.release();
        await Promise.resolve();
        expect(held.settled).toBe(false);
        letGo?.();
        await Promise.resolve();
        expect(held.settled).toBe(true);
        expect(handover.take()).toBeNull();
    });

    it('holds a second replaced mic along with the first, and lets both go together', async () => {
        // b replaced a before going live, so it was still holding a's mic.
        const handover = createMicHandover();
        const a = handle();
        const b = handle();
        await handover.stop(a);
        const owedByB = handover.take();
        await handover.stop(b, owedByB);
        const heldA = settledFlag(a.kept[0]);
        const heldB = settledFlag(b.kept[0]);
        await Promise.resolve();
        expect([heldA.settled, heldB.settled]).toEqual([false, false]);
        handover.take()?.();
        await Promise.resolve();
        expect([heldA.settled, heldB.settled]).toEqual([true, true]);
    });

    it("holds a mic kept elsewhere (the last session's, past its close) along with a replaced one", async () => {
        const handover = createMicHandover();
        const sessionMic = vi.fn();
        handover.hold(sessionMic);
        const old = handle();
        await handover.stop(old);
        const heldOld = settledFlag(old.kept[0]);
        const letGo = handover.take();
        await Promise.resolve();
        expect([sessionMic.mock.calls.length, heldOld.settled]).toEqual([0, false]);
        letGo?.();
        await Promise.resolve();
        expect([sessionMic.mock.calls.length, heldOld.settled]).toEqual([1, true]);
    });

    it('lets a mic held from elsewhere go when nothing takes it over', () => {
        const handover = createMicHandover();
        const sessionMic = vi.fn();
        handover.hold(sessionMic);
        handover.release();
        expect(sessionMic).toHaveBeenCalledOnce();
        expect(handover.take()).toBeNull();
    });
});

/**
 * Listening for "begin" on the setup screen. The rules that make it safe to
 * have a microphone open before a session exists are the thing under test:
 * never the thing that raises a permission prompt, only for a bounded window,
 * cheap on a recognizer that bills, and the mic released before the session
 * starts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttEngine, SttEvent } from '../src/platform/index.js';
import type { BeginRequest } from '../src/facilitation/index.js';
import { defaultPacingConfig } from '../src/facilitation/pacing.js';
const micCheck = vi.hoisted(() => ({ opened: false }));
vi.mock('../ui/src/mic-check.js', () => ({ micOpenedThisPage: () => micCheck.opened }));

import {
    listenForBegin,
    LOBBY_STT,
    micPermission,
    voiceStartBlocker,
    VOICE_START_WINDOW_MS,
    type VoiceStartEnd,
} from '../ui/src/voice-start.js';

const ready = { enabled: true, mic: 'granted', canBegin: true, touched: true } as const;

describe('voiceStartBlocker', () => {
    it('allows it when everything lines up', () => {
        expect(voiceStartBlocker(ready)).toBeNull();
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

describe('listenForBegin', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    function run(engine: SttEngine, alive: () => boolean = () => true) {
        const ends: VoiceStartEnd[] = [];
        const order: string[] = [];
        const requests: BeginRequest[] = [];
        const handle = listenForBegin({
            engine,
            alive,
            onBegin: (request) => {
                requests.push(request);
                order.push('begin');
            },
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
});

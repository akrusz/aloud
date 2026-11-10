/**
 * Listening for "begin" on the setup screen. The rules that make it safe to
 * have a microphone open before a session exists are the thing under test:
 * only free recognizers, only with permission already granted, only for a
 * bounded window, and the mic released before the session starts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SttEngine, SttEvent } from '../src/platform/index.js';
import {
    listenForBegin,
    voiceStartBlocker,
    VOICE_START_WINDOW_MS,
    type VoiceStartEnd,
} from '../ui/src/voice-start.js';

const ready = { enabled: true, sttChoice: 'web-speech', micGranted: true, canBegin: true, touched: true } as const;

describe('voiceStartBlocker', () => {
    it('allows it when everything lines up, on each free recognizer', () => {
        expect(voiceStartBlocker(ready)).toBeNull();
        expect(voiceStartBlocker({ ...ready, sttChoice: 'capacitor' })).toBeNull();
        expect(voiceStartBlocker({ ...ready, sttChoice: 'whisper' })).toBeNull();
    });
    it('is off unless switched on', () => {
        expect(voiceStartBlocker({ ...ready, enabled: false })).toBe('off');
    });
    it('never listens on metered speech recognition', () => {
        expect(voiceStartBlocker({ ...ready, sttChoice: 'aloud-gpt-transcribe' })).toBe('metered-stt');
    });
    it('never runs where it would have to ask for the microphone', () => {
        expect(voiceStartBlocker({ ...ready, micGranted: false })).toBe('no-permission');
    });
    it('waits for Begin itself to be possible, and for one touch', () => {
        expect(voiceStartBlocker({ ...ready, canBegin: false })).toBe('not-ready');
        expect(voiceStartBlocker({ ...ready, touched: false })).toBe('no-touch-yet');
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
        const handle = listenForBegin({
            engine,
            alive,
            onBegin: () => order.push('begin'),
            onEnd: (why) => {
                ends.push(why);
                order.push(`end:${why}`);
            },
        });
        return { handle, ends, order };
    }

    it('starts the session on "begin", after the mic has been released', async () => {
        const engine = scriptedEngine(["Let's begin."]);
        const { ends, order } = run(engine);
        await vi.advanceTimersByTimeAsync(10);
        expect(ends).toEqual(['begin']);
        // Released first, then begun: the session opens its own mic.
        expect(engine.stops).toBe(1);
        expect(order).toEqual(['end:begin', 'begin']);
    });

    it('ignores everything else and keeps listening', async () => {
        const engine = scriptedEngine(['When does the movie start?', '', 'I should begin cooking', 'okay begin']);
        const { ends, order } = run(engine);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(engine.starts).toBe(4);
        expect(ends).toEqual(['begin']);
        expect(order.filter((o) => o === 'begin')).toHaveLength(1);
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

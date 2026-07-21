/**
 * CapacitorSttEngine restart-stitching (meditation-pal-cddo).
 *
 * Android's SpeechRecognizer endpoints on a short pause; the engine treats each
 * end-of-speech as a segment boundary and relaunches, only submitting the turn
 * after the configured silence window. The native plugin is mocked so we can
 * drive its event contract by hand: partials arrive as 'partialResults', the
 * segment's FINAL transcript arrives as a 'partialResults' event AFTER a
 * 'listeningState: stopped', and start() resolves empty in partial mode.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const H = vi.hoisted(() => ({
    listeners: new Map<string, (d: unknown) => void>(),
    start: vi.fn(async () => undefined as unknown),
    stop: vi.fn(async () => undefined as unknown),
}));

vi.mock('@capacitor-community/speech-recognition', () => ({
    SpeechRecognition: {
        available: async () => ({ available: true }),
        checkPermissions: async () => ({ speechRecognition: 'granted' }),
        requestPermissions: async () => ({ speechRecognition: 'granted' }),
        start: H.start,
        stop: H.stop,
        addListener: async (event: string, cb: (d: unknown) => void) => {
            H.listeners.set(event, cb);
            return { remove: async () => {} };
        },
    },
}));

import { CapacitorSttEngine } from '../ui/src/adapters/capacitor-stt.js';
import type { SttEvent } from '../src/platform/stt.js';

// Consume the engine's async iterator in the background, collecting events.
function collect(engine: CapacitorSttEngine): { events: SttEvent[]; finished: Promise<void> } {
    const events: SttEvent[] = [];
    const finished = (async () => {
        for await (const e of engine.start()) events.push(e);
    })();
    return { events, finished };
}

const partial = (text: string): void =>
    H.listeners.get('partialResults')?.({ matches: [text] });
const stopped = (): void => H.listeners.get('listeningState')?.({ status: 'stopped' });
const finals = (events: SttEvent[]): SttEvent[] => events.filter((e) => e.type === 'final');

beforeEach(() => {
    H.listeners.clear();
    H.start.mockClear();
    H.stop.mockClear();
    // The engine emits greppable [stt-native] diagnostics (for adb logcat);
    // silence them here so the test output stays readable.
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

// submitDelayMs well past the 700ms settle + 50ms relaunch gap, so the restart
// always happens before the end-of-turn timer could fire - the real-world case.
const OPTS = { language: 'en-US', submitDelayMs: 5000, submitMaxDelayMs: 5000 };

describe('CapacitorSttEngine restart-stitching', () => {
    it('a post-stop final does not end the turn - it relaunches to catch a continuation', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60); // permission + 50ms reset, listeners, launch #1
        expect(H.start).toHaveBeenCalledTimes(1);

        partial('I notice'); // live speech
        stopped(); // Android end-of-speech
        partial('I notice'); // FINAL delivered after 'stopped'

        await vi.advanceTimersByTimeAsync(800); // past settle + relaunch gap
        // The regression guard: the post-stop final must NOT have submitted the
        // turn; the recognizer is relaunched instead.
        expect(H.start).toHaveBeenCalledTimes(2);
        expect(finals(events)).toEqual([]);
    });

    it('stitches segments across a pause into one final after the silence window', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        partial('I notice');
        stopped();
        partial('I notice');
        await vi.advanceTimersByTimeAsync(800); // relaunch #2

        partial('a tightness'); // user resumes on the relaunched segment
        stopped();
        partial('a tightness');
        await vi.advanceTimersByTimeAsync(800); // relaunch #3

        // Now stay silent past the end-of-turn window. The window is the 5000ms
        // budget PLUS the deaf-teardown credit from each relaunch (the mic can't
        // hear during a restart, so that time isn't counted as silence), so this
        // must clear the raw budget by a comfortable margin.
        await vi.advanceTimersByTimeAsync(6000);

        expect(finals(events)).toEqual([{ type: 'final', text: 'I notice a tightness' }]);
        await finished;
    });

    it('credits deaf teardown time so a short word + think-pause is not truncated (the "yeah" bug)', async () => {
        // A low pause budget where the ~750ms settle + relaunch would, uncredited,
        // race the end-of-turn timer and ship the first word alone - exactly the
        // "'yeah, I'm feeling a little optimism' sent just 'yeah'" report.
        const engine = new CapacitorSttEngine({
            language: 'en-US',
            submitDelayMs: 1500,
            submitMaxDelayMs: 1500,
        });
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        partial('yeah'); // a short first word...
        stopped(); // ...Android endpoints almost immediately
        partial('yeah'); // post-stop final
        await vi.advanceTimersByTimeAsync(800); // settle + relaunch #2 (deaf gap credited)

        // Past the raw 1500ms budget from the first word (the uncredited deadline
        // was ~1560ms): the turn must still be open - the deaf gap was credited,
        // not spent. Without the fix, 'yeah' would already have submitted alone.
        await vi.advanceTimersByTimeAsync(1100);
        expect(finals(events)).toEqual([]);

        // The continuation lands on the relaunched mic and stitches on.
        partial('I feel some optimism');
        stopped();
        partial('I feel some optimism');
        await vi.advanceTimersByTimeAsync(3000); // silence past the window

        expect(finals(events)).toEqual([
            { type: 'final', text: 'yeah I feel some optimism' },
        ]);
        await finished;
    });

    it('does not cut off before the silence window elapses', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);

        partial('still forming a thought');
        stopped();
        partial('still forming a thought');

        // A pause shorter than the window: no final yet.
        await vi.advanceTimersByTimeAsync(2000);
        expect(finals(events)).toEqual([]);
    });

    it('a silent turn ends with no final (no restart) so the loop starts fresh', async () => {
        const engine = new CapacitorSttEngine(OPTS);
        const { events, finished } = collect(engine);
        await vi.advanceTimersByTimeAsync(60);
        expect(H.start).toHaveBeenCalledTimes(1);

        stopped(); // end-of-speech with nothing heard
        await vi.advanceTimersByTimeAsync(800); // settle fires -> submit no-speech

        expect(finals(events)).toEqual([]);
        expect(H.start).toHaveBeenCalledTimes(1); // never relaunched
        await finished;
    });
});

import { describe, it, expect, vi, afterEach } from 'vitest';

import { BrowserTtsEngine } from '../ui/src/adapters/browser-tts.js';

/** Minimal SpeechSynthesisUtterance stand-in that captures the event handlers
 *  BrowserTtsEngine wires, so a test can fire onend / onerror by hand. */
class FakeUtterance {
    text: string;
    rate = 1;
    pitch = 1;
    voice: unknown = null;
    lang = '';
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((event: { error: string }) => void) | null = null;
    constructor(text: string) {
        this.text = text;
    }
}

function stubSpeechSynthesis(): { spoken: FakeUtterance[]; cancel: ReturnType<typeof vi.fn> } {
    const spoken: FakeUtterance[] = [];
    const cancel = vi.fn();
    vi.stubGlobal('SpeechSynthesisUtterance', FakeUtterance);
    vi.stubGlobal('speechSynthesis', {
        speak: (u: FakeUtterance) => spoken.push(u),
        cancel,
        resume: () => {},
        getVoices: () => [],
    });
    return { spoken, cancel };
}

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('BrowserTtsEngine.speak error handling', () => {
    it('rejects on a genuine synthesis error (the silent-preview bug)', async () => {
        const { spoken } = stubSpeechSynthesis();
        const engine = new BrowserTtsEngine();
        const p = engine.speak('hello');
        spoken.at(-1)!.onerror!({ error: 'synthesis-failed' });
        await expect(p).rejects.toThrow(/synthesis-failed/);
    });

    it('resolves quietly on interrupted/canceled (our own cancel churn)', async () => {
        const { spoken } = stubSpeechSynthesis();
        const engine = new BrowserTtsEngine();
        for (const code of ['interrupted', 'canceled']) {
            const p = engine.speak('hello');
            spoken.at(-1)!.onerror!({ error: code });
            await expect(p).resolves.toBeUndefined();
        }
    });

    it('resolves on normal end', async () => {
        const { spoken } = stubSpeechSynthesis();
        const engine = new BrowserTtsEngine();
        const p = engine.speak('hello');
        spoken.at(-1)!.onend!();
        await expect(p).resolves.toBeUndefined();
    });
});

describe('BrowserTtsEngine start watchdog', () => {
    it('rejects an utterance that never starts, and clears it from the queue', async () => {
        vi.useFakeTimers();
        const { cancel } = stubSpeechSynthesis();
        const outcome = expect(new BrowserTtsEngine().speak('hello')).rejects.toThrow(
            'speechSynthesis start-timeout'
        );
        await vi.advanceTimersByTimeAsync(10_000);
        await outcome;
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('leaves a started utterance alone however long it runs', async () => {
        vi.useFakeTimers();
        const { spoken, cancel } = stubSpeechSynthesis();
        const p = new BrowserTtsEngine().speak('a long passage');
        spoken.at(-1)!.onstart!();
        await vi.advanceTimersByTimeAsync(60_000);
        expect(cancel).not.toHaveBeenCalled();
        spoken.at(-1)!.onend!();
        await expect(p).resolves.toBeUndefined();
    });

    it('fails fast after a timeout until an utterance starts again', async () => {
        vi.useFakeTimers();
        const { spoken } = stubSpeechSynthesis();
        const engine = new BrowserTtsEngine();
        const first = expect(engine.speak('one')).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(10_000);
        await first;

        const second = expect(engine.speak('two')).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(2_000);
        await second;

        const third = engine.speak('three');
        spoken.at(-1)!.onstart!();
        spoken.at(-1)!.onend!();
        await third;

        let settled = false;
        const fourth = engine.speak('four').catch(() => {
            settled = true;
        });
        await vi.advanceTimersByTimeAsync(2_000);
        expect(settled).toBe(false);
        await vi.advanceTimersByTimeAsync(8_000);
        await fourth;
        expect(settled).toBe(true);
    });
});

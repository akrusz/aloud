import { describe, it, expect } from 'vitest';

import { wrapTtsWithBargeIn } from '../ui/src/barge-in.js';
import type { TtsEngine, TtsOptions, TtsVoice } from '../src/platform/index.js';

class RecordingTts implements TtsEngine {
    spoken: Array<{ text: string; options: TtsOptions | undefined }> = [];
    cancelled = 0;
    async speak(text: string, options?: TtsOptions): Promise<void> {
        this.spoken.push({ text, options });
    }
    async cancel(): Promise<void> {
        this.cancelled++;
    }
    async listVoices(): Promise<TtsVoice[]> {
        return [{ id: 'a', name: 'A', language: 'en-US' }];
    }
}

describe('wrapTtsWithBargeIn', () => {
    // The barge-in listener itself needs an AudioContext (which jsdom
    // doesn't provide), so we can't easily test detection here. These
    // tests focus on the wrapper's pass-through behavior — speak() still
    // calls the inner engine, cancel() and listVoices() forward through.
    // Detection logic is exercised manually in the browser preview.

    it('forwards speak() to the inner engine', async () => {
        const inner = new RecordingTts();
        const wrapped = wrapTtsWithBargeIn(inner);
        await wrapped.speak('Hello there', { rate: 160 });
        expect(inner.spoken).toEqual([
            { text: 'Hello there', options: { rate: 160 } },
        ]);
    });

    it('forwards cancel() to the inner engine', async () => {
        const inner = new RecordingTts();
        const wrapped = wrapTtsWithBargeIn(inner);
        await wrapped.cancel();
        expect(inner.cancelled).toBe(1);
    });

    it('forwards listVoices() to the inner engine', async () => {
        const inner = new RecordingTts();
        const wrapped = wrapTtsWithBargeIn(inner);
        const voices = await wrapped.listVoices();
        expect(voices).toEqual([{ id: 'a', name: 'A', language: 'en-US' }]);
    });

    it('silently no-ops when navigator.mediaDevices is unavailable', async () => {
        // In jsdom there's no navigator.mediaDevices. The listener's
        // start() returns early; the wrapper still completes speak().
        const inner = new RecordingTts();
        const wrapped = wrapTtsWithBargeIn(inner);
        await expect(wrapped.speak('hi')).resolves.toBeUndefined();
        expect(inner.spoken).toHaveLength(1);
    });
});

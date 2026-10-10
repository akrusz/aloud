import { describe, it, expect } from 'vitest';

import { wrapTtsWithBargeIn } from '../ui/src/barge-in.js';
import type { TtsEngine, TtsOptions, TtsVoice } from '../src/platform/index.js';

class RecordingTts implements TtsEngine {
    spoken: Array<{ text: string; options: TtsOptions | undefined }> = [];
    async speak(text: string, options?: TtsOptions): Promise<void> {
        this.spoken.push({ text, options });
    }
    async cancel(): Promise<void> {}
    async listVoices(): Promise<TtsVoice[]> {
        return [];
    }
}

describe('wrapTtsWithBargeIn', () => {
    // Node has no navigator.mediaDevices, so the listener's start() returns
    // early and detection is not exercised here: speak() must still reach the
    // inner engine with the mic unavailable.
    it('forwards speak() to the inner engine', async () => {
        const inner = new RecordingTts();
        const wrapped = wrapTtsWithBargeIn(inner);
        await wrapped.speak('Hello there', { rate: 160 });
        expect(inner.spoken).toEqual([
            { text: 'Hello there', options: { rate: 160 } },
        ]);
    });
});

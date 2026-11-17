import { afterEach, describe, it, expect, vi } from 'vitest';

import { bargeInDetectorFits, wrapTtsWithBargeIn } from '../ui/src/barge-in.js';
import { BrowserTtsEngine } from '../ui/src/adapters/browser-tts.js';
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

    it('forwards prefetch() when the inner engine has one, and only then', () => {
        const plain = wrapTtsWithBargeIn(new RecordingTts());
        expect(plain.prefetch).toBeUndefined();

        const inner = new RecordingTts() as RecordingTts & TtsEngine;
        const prefetched: string[] = [];
        inner.prefetch = (text) => void prefetched.push(text);
        wrapTtsWithBargeIn(inner).prefetch?.('Next sentence.');
        expect(prefetched).toEqual(['Next sentence.']);
    });
});

describe('bargeInDetectorFits', () => {
    afterEach(() => vi.unstubAllGlobals());

    const voices = [
        { name: 'Ava (Premium)', voiceURI: 'Ava (Premium)', localService: true },
        { name: 'Google UK English Female', voiceURI: 'Google UK English Female', localService: false },
    ];
    const browserVoice = (name?: string) => new BrowserTtsEngine(name ? { defaultVoice: name } : {});

    it('keeps the detector away from a voice the OS speaks, and only from those', () => {
        vi.stubGlobal('speechSynthesis', { getVoices: () => voices });
        expect(bargeInDetectorFits(browserVoice('Ava (Premium)'))).toBe(false);
        expect(bargeInDetectorFits(browserVoice('Google UK English Female'))).toBe(true);
        expect(bargeInDetectorFits(new RecordingTts())).toBe(true);
        // The OS default speaks for both of these.
        expect(bargeInDetectorFits(browserVoice())).toBe(false);
        expect(bargeInDetectorFits(browserVoice('Not Installed'))).toBe(false);
    });

    it('opens no mic beside an OS voice, and one beside a voice the browser plays', async () => {
        const getUserMedia = vi.fn().mockRejectedValue(new Error('denied'));
        vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
        vi.stubGlobal('speechSynthesis', { getVoices: () => voices });
        const speaking = (name: string) => {
            const engine = browserVoice(name);
            engine.speak = async () => {};
            return wrapTtsWithBargeIn(engine).speak('Hello there');
        };
        await speaking('Ava (Premium)');
        expect(getUserMedia).not.toHaveBeenCalled();
        await speaking('Google UK English Female');
        expect(getUserMedia).toHaveBeenCalledTimes(1);
    });
});

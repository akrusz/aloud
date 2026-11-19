import { afterEach, describe, it, expect, vi } from 'vitest';

import {
    PLAYBACK_TAIL_MS,
    bargesInOnOwnStream,
    voiceEchoCancelled,
    waitOutUncancelledVoice,
    wrapTtsWithBargeIn,
} from '../ui/src/barge-in.js';
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

const voices = [
    { name: 'Ava (Premium)', voiceURI: 'Ava (Premium)', localService: true },
    { name: 'Zoe (Premium)', voiceURI: 'Zoe (Premium)', localService: true },
    { name: 'Google UK English Female', voiceURI: 'Google UK English Female', localService: false },
];
const browserVoice = (name?: string) => new BrowserTtsEngine(name ? { defaultVoice: name } : {});

describe('voiceEchoCancelled', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('is false for a voice the OS speaks, and only for those', () => {
        vi.stubGlobal('speechSynthesis', { getVoices: () => voices });
        expect(voiceEchoCancelled(browserVoice('Ava (Premium)'))).toBe(false);
        expect(voiceEchoCancelled(browserVoice('Google UK English Female'))).toBe(true);
        expect(voiceEchoCancelled(new RecordingTts())).toBe(true);
        // The OS default speaks for both of these.
        expect(voiceEchoCancelled(browserVoice())).toBe(false);
        expect(voiceEchoCancelled(browserVoice('Not Installed'))).toBe(false);
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

describe('bargesInOnOwnStream', () => {
    afterEach(() => vi.unstubAllGlobals());

    const desk = { iosWeb: false, iosHeadphones: false };

    // Zoe on hosted Parakeet in Chrome (2026-11-18): the stream barged in on
    // her a word or two into each line and sent those words as the
    // meditator's turn. Beside such a voice the mic closes while she speaks.
    it('is off beside a voice the OS speaks, on a recognizer with its own stream', () => {
        vi.stubGlobal('speechSynthesis', { getVoices: () => voices });
        const zoe = voiceEchoCancelled(browserVoice('Zoe (Premium)'));
        expect(bargesInOnOwnStream({ backend: 'server-whisper', ...desk, voiceEchoCancelled: zoe })).toBe(false);
    });

    it('stays on beside a voice echo cancellation hears', () => {
        vi.stubGlobal('speechSynthesis', { getVoices: () => voices });
        const google = voiceEchoCancelled(browserVoice('Google UK English Female'));
        const hosted = voiceEchoCancelled(new RecordingTts());
        expect(bargesInOnOwnStream({ backend: 'server-whisper', ...desk, voiceEchoCancelled: google })).toBe(true);
        expect(bargesInOnOwnStream({ backend: 'server-whisper', ...desk, voiceEchoCancelled: hosted })).toBe(true);
    });

    it('keeps the iPhone rule: off on its speaker, on with headphones', () => {
        const iphone = { backend: 'server-whisper' as const, iosWeb: true, voiceEchoCancelled: true };
        expect(bargesInOnOwnStream({ ...iphone, iosHeadphones: false })).toBe(false);
        expect(bargesInOnOwnStream({ ...iphone, iosHeadphones: true })).toBe(true);
    });

    it('is never on for a recognizer with no stream of ours', () => {
        expect(bargesInOnOwnStream({ backend: 'web-speech', ...desk, voiceEchoCancelled: true })).toBe(false);
        expect(bargesInOnOwnStream({ backend: 'capacitor', ...desk, voiceEchoCancelled: true })).toBe(false);
    });
});

describe('waitOutUncancelledVoice', () => {
    afterEach(() => vi.useRealTimers());

    const onsetBuffer = () => {
        const kept: number[] = [];
        return { kept, keepOnsetTail: (ms: number) => void kept.push(ms) };
    };

    // A noting turn opening 100ms after a participant's line in a voice the
    // OS speaks: nothing of the line, or of its tail, may open the note.
    it('opens the turn only past the tail, with no onset from before it', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(10_000);
        const onset = onsetBuffer();
        let open = false;
        const waiting = waitOutUncancelledVoice(Date.now() - 100, onset).then(() => (open = true));
        await vi.advanceTimersByTimeAsync(PLAYBACK_TAIL_MS - 101);
        expect(open).toBe(false);
        expect(onset.kept).toEqual([]);
        await vi.advanceTimersByTimeAsync(1);
        await waiting;
        expect(onset.kept).toEqual([0]);
    });

    it('keeps what was heard after the tail of a line long over, at once', async () => {
        const onset = onsetBuffer();
        const now = () => 20_000;
        await waitOutUncancelledVoice(15_000, onset, now);
        expect(onset.kept).toEqual([5_000 - PLAYBACK_TAIL_MS]);
        await waitOutUncancelledVoice(15_000, null, now);
    });
});

import { describe, it, expect, vi, beforeEach } from 'vitest';

// The model is an app-lifetime download; `broken` puts the engine on its
// energy fallback, which is all a capture-graph test needs.
vi.mock('../ui/src/adapters/silero-vad.js', () => ({
    loadSileroVad: async () => ({ broken: true }),
}));

let opened: Array<{ stopped: boolean }>;

class FakeContext {
    state = 'running';
    sampleRate = 48000;
    destination = {};
    addEventListener(): void {}
    resume(): Promise<void> {
        return Promise.resolve();
    }
    close(): Promise<void> {
        return Promise.resolve();
    }
    createMediaStreamSource() {
        return { connect(): void {}, disconnect(): void {} };
    }
    createScriptProcessor() {
        return { connect(): void {}, disconnect(): void {}, onaudioprocess: null };
    }
}

beforeEach(() => {
    opened = [];
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('navigator', {
        mediaDevices: {
            getUserMedia: async () => {
                // A real device takes a moment, which is the window the
                // concurrent callers used to race in.
                await new Promise((r) => setTimeout(r, 20));
                const state = { stopped: false };
                opened.push(state);
                const track = {
                    muted: false,
                    readyState: 'live',
                    stop: () => (state.stopped = true),
                    getSettings: () => ({}),
                    addEventListener(): void {},
                };
                return { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
            },
        },
    });
});

describe('the capture graph', () => {
    it('opens the mic once when prime() and the first start() arrive together', async () => {
        const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
        const engine = new WhisperPcmSttEngine();
        const listening = engine.start()[Symbol.asyncIterator]();
        const firstEvent = listening.next();
        await Promise.all([engine.prime(), engine.prime()]);
        await new Promise((r) => setTimeout(r, 60));
        expect(opened).toHaveLength(1);

        // And that one stream is the one a stop releases: nothing is left open.
        await engine.stop();
        await firstEvent.catch(() => {});
        expect(opened.every((s) => s.stopped)).toBe(true);
    });

    it('keeps the mic open for a sound the session ends on, and lets go when it is over', async () => {
        const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
        const engine = new WhisperPcmSttEngine();
        await engine.prime();
        let soundOver = (): void => {};
        await engine.stop({ keepMicUntil: new Promise<void>((r) => (soundOver = r)) });
        await new Promise((r) => setTimeout(r, 30));
        expect(opened).toHaveLength(1);
        expect(opened[0]!.stopped).toBe(false);
        soundOver();
        await new Promise((r) => setTimeout(r, 0));
        expect(opened[0]!.stopped).toBe(true);
    });
});

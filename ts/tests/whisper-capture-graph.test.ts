import { describe, it, expect, vi, beforeEach } from 'vitest';

// The model is an app-lifetime download; `broken` puts the engine on its
// energy fallback, which is all a capture-graph test needs.
vi.mock('../ui/src/adapters/silero-vad.js', () => ({
    loadSileroVad: async () => ({ broken: true }),
}));

let opened: Array<{ stopped: boolean }>;
// How long getUserMedia and AudioContext.resume() take. iOS holds both while
// the app is inactive (notification shade down), which is the window a
// foreground rebuild's stop() lands in.
let micDelayMs: number;
let resumeDelayMs: number;
let contextsMade: number;

class FakeContext {
    state = resumeDelayMs > 0 ? 'suspended' : 'running';
    sampleRate = 48000;
    destination = {};
    constructor() {
        contextsMade++;
    }
    addEventListener(): void {}
    async resume(): Promise<void> {
        await new Promise((r) => setTimeout(r, resumeDelayMs));
        this.state = 'running';
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
    micDelayMs = 20;
    resumeDelayMs = 0;
    contextsMade = 0;
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('navigator', {
        mediaDevices: {
            getUserMedia: async () => {
                // A real device takes a moment, which is the window the
                // concurrent callers used to race in.
                await new Promise((r) => setTimeout(r, micDelayMs));
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

    describe('stopped while it is still opening', () => {
        // A foreground rebuild (restartSttAfterForeground) stops the old engine
        // wherever its start() is. The turn is over, not failed: a "Mic error"
        // here is what iOS testers saw after pulling down the notification shade.
        async function stopMidOpen(): Promise<unknown[]> {
            const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
            const engine = new WhisperPcmSttEngine();
            const events: unknown[] = [];
            const done = (async () => {
                for await (const event of engine.start()) events.push(event);
            })();
            await new Promise((r) => setTimeout(r, 10));
            await engine.stop();
            await done;
            return events;
        }

        it('while the mic is being granted: ends quietly and lets go of the late stream', async () => {
            micDelayMs = 40;
            expect(await stopMidOpen()).toEqual([]);
            await new Promise((r) => setTimeout(r, 60));
            expect(opened).toHaveLength(1);
            expect(opened[0]!.stopped).toBe(true);
            expect(contextsMade).toBe(0);
        });

        it('while the audio context resumes: ends quietly', async () => {
            micDelayMs = 0;
            resumeDelayMs = 40;
            expect(await stopMidOpen()).toEqual([]);
            expect(opened.every((s) => s.stopped)).toBe(true);
        });
    });
});

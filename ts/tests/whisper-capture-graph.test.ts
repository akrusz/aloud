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
        const processor = { connect(): void {}, disconnect(): void {}, onaudioprocess: null };
        lastProcessor = processor;
        return processor;
    }
}
let lastProcessor: { onaudioprocess: ((e: unknown) => void) | null } | null = null;
/** One frame through the capture graph, as the audio thread delivers it:
 *  digital silence unless given a level. */
function deliverFrame(level = 0): void {
    lastProcessor?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(level) },
    });
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

    it("vouches for the mic to Begin while open and just after, so Begin's gate opens no probe", async () => {
        vi.resetModules();
        const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
        const { micForBegin } = await import('../ui/src/mic-check.js');
        const engine = new WhisperPcmSttEngine();
        await engine.prime();
        expect(await micForBegin()).toBe('ok');
        // The setup screen's listener, closed by the Begin click.
        await engine.stop();
        expect(await micForBegin()).toBe('ok');
        expect(opened).toHaveLength(1);
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

    describe('a kept mic, started again', () => {
        // The setup screen stops between turns and under each line it speaks,
        // keeping the stream (voice-start.ts). Let go and opened again, the
        // mic made macOS rebuild its output a second or two into the line.
        async function listenThenStop(keep: Promise<unknown>) {
            const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
            const engine = new WhisperPcmSttEngine();
            const turn = (async () => {
                for await (const _ of engine.start()) void _;
            })();
            await new Promise((r) => setTimeout(r, 30));
            await engine.stop({ keepMicUntil: keep });
            await turn;
            return engine;
        }

        it('takes the same stream back instead of opening another', async () => {
            const engine = await listenThenStop(new Promise(() => undefined));
            const turn = (async () => {
                for await (const _ of engine.start()) void _;
            })();
            await new Promise((r) => setTimeout(r, 30));
            expect(opened).toHaveLength(1);
            expect(opened[0]!.stopped).toBe(false);
            await engine.stop();
            await turn;
            expect(opened[0]!.stopped).toBe(true);
        });

        it('is not let go by the promise it was kept for once it is back in use', async () => {
            let over = (): void => {};
            const engine = await listenThenStop(new Promise<void>((r) => (over = r)));
            const turn = (async () => {
                for await (const _ of engine.start()) void _;
            })();
            await new Promise((r) => setTimeout(r, 30));
            over();
            await new Promise((r) => setTimeout(r, 0));
            expect(opened[0]!.stopped).toBe(false);
            await engine.stop();
            await turn;
        });

        it('stays kept through a second stop until both have settled', async () => {
            let first = (): void => {};
            let second = (): void => {};
            const engine = await listenThenStop(new Promise<void>((r) => (first = r)));
            await engine.stop({ keepMicUntil: new Promise<void>((r) => (second = r)) });
            first();
            await new Promise((r) => setTimeout(r, 0));
            expect(opened[0]!.stopped).toBe(false);
            second();
            await new Promise((r) => setTimeout(r, 0));
            expect(opened[0]!.stopped).toBe(true);
        });

        it('says when its capture is live: the first frame it delivers', async () => {
            // The setup screen lets a replaced listener's mic go on this
            // (views/setup.ts runVoiceSync), so the OS never sees the last
            // echo-cancelled capture close.
            const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
            const engine = new WhisperPcmSttEngine();
            let live = false;
            void engine.whenLive().then(() => (live = true));
            const turn = (async () => {
                for await (const _ of engine.start()) void _;
            })();
            await new Promise((r) => setTimeout(r, 30));
            expect(live).toBe(false);
            deliverFrame();
            await Promise.resolve();
            expect(live).toBe(true);
            await engine.stop();
            await turn;
        });

        it('says when it hears: the first frame that is not digital silence', async () => {
            // A capture opened afresh on macOS sends silence while the OS sets
            // its echo canceller up. The session says the mic is opening until
            // this settles, or the first word goes unheard (setMuted).
            const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
            const engine = new WhisperPcmSttEngine();
            let live = false;
            let hearing = false;
            void engine.whenLive().then(() => (live = true));
            void engine.whenHearing().then(() => (hearing = true));
            const turn = (async () => {
                for await (const _ of engine.start()) void _;
            })();
            await new Promise((r) => setTimeout(r, 30));
            deliverFrame();
            await Promise.resolve();
            expect(live).toBe(true);
            expect(hearing).toBe(false);
            // Room tone, about the quietest a MacBook mic measured.
            deliverFrame(1e-4);
            await Promise.resolve();
            expect(hearing).toBe(true);
            await engine.stop();
            await turn;
        });

        it('tells a session whether unmuting takes a kept stream back', async () => {
            let over = (): void => {};
            const engine = await listenThenStop(new Promise<void>((r) => (over = r)));
            expect(engine.micKept).toBe(true);
            const turn = (async () => {
                for await (const _ of engine.start()) void _;
            })();
            await new Promise((r) => setTimeout(r, 30));
            expect(opened).toHaveLength(1);
            expect(engine.micKept).toBe(false);
            await engine.stop();
            await turn;

            // Let go once what it was kept for is over: the next start opens the mic.
            const again = await listenThenStop(new Promise<void>((r) => (over = r)));
            over();
            await new Promise((r) => setTimeout(r, 0));
            expect(again.micKept).toBe(false);
        });

        it('opens a new stream where the kept one has died', async () => {
            const engine = await listenThenStop(new Promise(() => undefined));
            // A device pulled while it was kept: the track has ended.
            const stream = (engine as unknown as { kept: { stream: MediaStream } }).kept.stream;
            (stream.getAudioTracks()[0] as unknown as { readyState: string }).readyState = 'ended';
            const turn = (async () => {
                for await (const _ of engine.start()) void _;
            })();
            await new Promise((r) => setTimeout(r, 60));
            expect(opened).toHaveLength(2);
            expect(opened[0]!.stopped).toBe(true);
            await engine.stop();
            await turn;
        });
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

        it('while the model loads: opens no mic at all', async () => {
            // The setup screen stops a turn that has only just started for a
            // line (voice-start.ts hold). Opened after that stop, the capture
            // came up under the line, read by no turn.
            const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
            const engine = new WhisperPcmSttEngine();
            const events: unknown[] = [];
            const done = (async () => {
                for await (const event of engine.start()) events.push(event);
            })();
            await engine.stop();
            await done;
            await new Promise((r) => setTimeout(r, 60));
            expect(events).toEqual([]);
            expect(opened).toHaveLength(0);
        });
    });

    describe('a capture opened cold', () => {
        // With no other capture of ours open, the open starts macOS voice
        // processing (and a Bluetooth headset's call audio), and a line
        // started under it began late and quiet. The setup screen holds its
        // lines until this settles (voice-start.ts hold).
        async function freshEngine() {
            // Other tests leave kept streams in the registry: start from none.
            vi.resetModules();
            const { WhisperPcmSttEngine } = await import('../ui/src/adapters/whisper-pcm-stt.js');
            return { WhisperPcmSttEngine, engine: new WhisperPcmSttEngine() };
        }
        const listen = (engine: { start(): AsyncIterable<unknown> }) =>
            (async () => {
                for await (const _ of engine.start()) void _;
            })();
        const settledFlag = (promise: Promise<unknown> | null) => {
            const state = { settled: false };
            void promise?.then(() => (state.settled = true));
            return state;
        };

        it('is coming up from the ask until its first frame with sound', async () => {
            micDelayMs = 40;
            const { engine } = await freshEngine();
            expect(engine.coldOpening()).toBeNull();
            const turn = listen(engine);
            await new Promise((r) => setTimeout(r, 10));
            // Asked for, not yet granted: already coming up.
            const opening = engine.coldOpening();
            expect(opening).toBeInstanceOf(Promise);
            const state = settledFlag(opening);
            await new Promise((r) => setTimeout(r, 50));
            deliverFrame();
            await Promise.resolve();
            expect(state.settled).toBe(false);
            deliverFrame(1e-4);
            await Promise.resolve();
            expect(state.settled).toBe(true);
            expect(engine.coldOpening()).toBeNull();
            await engine.stop();
            await turn;
        });

        it('counts as settled a few seconds in on a mic that sends only silence', async () => {
            vi.useFakeTimers();
            try {
                const { engine } = await freshEngine();
                const turn = listen(engine);
                await vi.advanceTimersByTimeAsync(100);
                const state = settledFlag(engine.coldOpening());
                deliverFrame();
                await vi.advanceTimersByTimeAsync(2_000);
                expect(state.settled).toBe(false);
                await vi.advanceTimersByTimeAsync(2_000);
                expect(state.settled).toBe(true);
                // Once: the next line does not wait it out again.
                expect(engine.coldOpening()).toBeNull();
                await engine.stop();
                await vi.advanceTimersByTimeAsync(1_000);
                await turn;
            } finally {
                vi.useRealTimers();
            }
        });

        it('is not cold beside a capture of ours that is still open, a kept one included', async () => {
            const { WhisperPcmSttEngine, engine: old } = await freshEngine();
            const oldTurn = listen(old);
            await new Promise((r) => setTimeout(r, 30));
            deliverFrame(1e-4);
            // A listener replaced for another recognizer keeps its mic until
            // the new one can hear (createMicHandover).
            await old.stop({ keepMicUntil: new Promise(() => undefined) });
            await oldTurn;
            const next = new WhisperPcmSttEngine();
            const turn = listen(next);
            await new Promise((r) => setTimeout(r, 5));
            expect(next.coldOpening()).toBeNull();
            await new Promise((r) => setTimeout(r, 30));
            expect(opened).toHaveLength(2);
            expect(next.coldOpening()).toBeNull();
            await next.stop();
            await turn;
        });

        it('is over when the capture is let go, or never arrives', async () => {
            micDelayMs = 40;
            const { engine } = await freshEngine();
            let turn = listen(engine);
            await new Promise((r) => setTimeout(r, 50));
            let state = settledFlag(engine.coldOpening());
            await engine.stop();
            await turn;
            await Promise.resolve();
            expect(state.settled).toBe(true);
            expect(engine.coldOpening()).toBeNull();

            // Stopped while the mic was still being granted.
            turn = listen(engine);
            await new Promise((r) => setTimeout(r, 10));
            state = settledFlag(engine.coldOpening());
            expect(engine.coldOpening()).toBeInstanceOf(Promise);
            await engine.stop();
            await turn;
            await new Promise((r) => setTimeout(r, 60));
            expect(state.settled).toBe(true);
            expect(engine.coldOpening()).toBeNull();
        });
    });
});

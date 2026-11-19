/**
 * A session's capture is open across everything the session makes audible
 * (dev-docs/audio-output.md): the order of mic opens and closes against the
 * signature sounds at Begin and at the end, with the real capture engine,
 * sound player and Begin hand-over. On Android each open and close of the
 * app's capture switches call mode, which mutes or moves the sound playing;
 * on macOS each rebuilds the audio output.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAudio } from './fake-audio-element.js';

vi.mock('../ui/src/adapters/silero-vad.js', () => ({
    loadSileroVad: async () => ({ broken: true }),
}));

type EngineModule = typeof import('../ui/src/adapters/whisper-pcm-stt.js');
type Engine = InstanceType<EngineModule['WhisperPcmSttEngine']>;

const MIC_DELAY_MS = 50;
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 16; CPH2655) wv';

/** Mic opens and closes, and audible plays, in the order they happened. */
let events: string[];
let processors: Array<{ onaudioprocess: ((e: unknown) => void) | null }>;
/** Object URL -> the file it was made from. */
let blobs: Map<string, string>;
let mic: typeof import('../ui/src/mic-check.js');
let sound: typeof import('../ui/src/signature-sound.js');
let Engine: EngineModule['WhisperPcmSttEngine'];

class FakeContext {
    state = 'running';
    sampleRate = 48000;
    destination = {};
    addEventListener(): void {}
    async resume(): Promise<void> {}
    close(): Promise<void> {
        return Promise.resolve();
    }
    createMediaStreamSource() {
        return { connect(): void {}, disconnect(): void {} };
    }
    createScriptProcessor() {
        const processor = { connect(): void {}, disconnect(): void {}, onaudioprocess: null };
        processors.push(processor);
        return processor;
    }
}

class LoggedAudio extends FakeAudio {
    override play(): Promise<void> {
        const file = blobs.get(this.src);
        if (file && !this.muted) events.push(`play ${file.split('/').pop()}`);
        return super.play();
    }
}

function stubPlatform(userAgent: string): void {
    let opened = 0;
    vi.stubGlobal('navigator', {
        userAgent,
        mediaDevices: {
            getUserMedia: async () => {
                await new Promise((r) => setTimeout(r, MIC_DELAY_MS));
                const n = ++opened;
                events.push(`mic open ${n}`);
                const track = {
                    muted: false,
                    readyState: 'live',
                    stop: () => {
                        if (track.readyState === 'ended') return;
                        track.readyState = 'ended';
                        events.push(`mic close ${n}`);
                    },
                    getSettings: () => ({}),
                    addEventListener(): void {},
                };
                return { active: true, getTracks: () => [track], getAudioTracks: () => [track] };
            },
        },
    });
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeAudio.reset();
    events = [];
    processors = [];
    blobs = new Map();
    stubPlatform(DESKTOP_UA);
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('Audio', LoggedAudio);
    vi.stubGlobal('document', { querySelector: () => ({ classList: { add() {}, remove() {} } }) });
    vi.stubGlobal('fetch', async (url: string) => ({ ok: true, status: 200, arrayBuffer: async () => ({ url }) }));
    vi.stubGlobal(
        'Blob',
        class {
            constructor(readonly parts: Array<{ url: string }>) {}
        }
    );
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
        const id = `blob:${blobs.size + 1}`;
        blobs.set(id, (blob as unknown as { parts: Array<{ url: string }> }).parts[0]!.url);
        return id;
    });
    ({ WhisperPcmSttEngine: Engine } = await import('../ui/src/adapters/whisper-pcm-stt.js'));
    mic = await import('../ui/src/mic-check.js');
    sound = await import('../ui/src/signature-sound.js');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

const advance = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms);

/** One frame through the newest capture graph: digital silence unless given
 *  a level (room tone is about 1e-4). */
function frame(level = 1e-4): void {
    processors.at(-1)?.onaudioprocess?.({
        inputBuffer: { getChannelData: () => new Float32Array(4096).fill(level) },
    });
}

/** The element sounding `file`. */
function sounding(file: string): FakeAudio {
    const el = FakeAudio.made.find((a) => !a.paused && blobs.get(a.src)?.endsWith(file));
    if (!el) throw new Error(`${file} is not playing`);
    return el;
}

/** The setup screen's listener: its capture open, hearing the room. */
async function listeningSetup(): Promise<Engine> {
    const setup = new Engine();
    const primed = setup.prime();
    await advance(MIC_DELAY_MS);
    await primed;
    frame();
    return setup;
}

/** Begin, as views/setup.ts beginFromSetup does it: the listener stops and
 *  its stream is held for the session. */
function begin(setup: Engine | null): void {
    const handover = mic.holdCaptureForSession();
    void setup?.stop({ keepMicUntil: handover });
}

/** The session view's start: the opening, which opens its mic. */
function startSession(): { engine: Engine; opening: Promise<void> } {
    const engine = new Engine();
    return { engine, opening: sound.playOpening('bloom', () => engine.prime()) };
}

describe('at Begin, nothing audible starts until the session capture is open', () => {
    it('from a silent setup screen: mic, a beat, then the opening', async () => {
        begin(null);
        startSession();
        await advance(MIC_DELAY_MS + 599);
        expect(events).toEqual(['mic open 1']);
        await advance(2);
        expect(events).toEqual(['mic open 1', 'play bloom-open.mp3']);
    });

    it("from a listening setup screen: the session's capture opens beside the setup's, which goes once the new one hears", async () => {
        const setup = await listeningSetup();
        begin(setup);
        await advance(1_000);
        // Stopped listening, still open.
        expect(events).toEqual(['mic open 1']);
        startSession();
        await advance(MIC_DELAY_MS);
        expect(events).toEqual(['mic open 1', 'mic open 2']);
        // Its first frames can be the silence of a capture still setting up.
        frame(0);
        await advance(0);
        expect(events).toEqual(['mic open 1', 'mic open 2']);
        frame();
        await advance(0);
        expect(events).toEqual(['mic open 1', 'mic open 2', 'mic close 1']);
        await advance(600);
        expect(events).toEqual(['mic open 1', 'mic open 2', 'mic close 1', 'play bloom-open.mp3']);
    });

    it('on Android from a silent setup screen: the opening waits out the media mute call mode starts with', async () => {
        stubPlatform(ANDROID_UA);
        begin(null);
        startSession();
        await advance(MIC_DELAY_MS + 2_199);
        expect(events).toEqual(['mic open 1']);
        await advance(2);
        expect(events).toEqual(['mic open 1', 'play bloom-open.mp3']);
    });

    it('on Android from a listening setup screen: call mode never switches, so only the short beat', async () => {
        stubPlatform(ANDROID_UA);
        const setup = await listeningSetup();
        begin(setup);
        startSession();
        await advance(MIC_DELAY_MS);
        frame();
        await advance(601);
        expect(events).toEqual(['mic open 1', 'mic open 2', 'mic close 1', 'play bloom-open.mp3']);
    });

    it("lets the setup's capture go at once for a session with no capture of ours (a phone's or the browser's recognizer)", async () => {
        const setup = await listeningSetup();
        begin(setup);
        void sound.playOpening('bloom');
        await advance(0);
        expect(events).toEqual(['mic open 1', 'mic close 1', 'play bloom-open.mp3']);
    });
});

describe('the session capture closes after the last sound, on every way out', () => {
    async function sessionUnderway(): Promise<Engine> {
        begin(null);
        const { engine, opening } = startSession();
        await advance(MIC_DELAY_MS + 600);
        frame();
        sounding('bloom-open.mp3').end();
        await opening;
        return engine;
    }

    it('a normal end: listening stops at once, the capture closes once the close has played out', async () => {
        const engine = await sessionUnderway();
        void sound.playClosing('bloom', engine);
        await advance(0);
        expect(events).toEqual(['mic open 1', 'play bloom-open.mp3', 'play bloom-close.mp3']);
        // Held, not read: no graph is left to feed a transcription or barge-in.
        processors.length = 0;
        await advance(3_000);
        expect(events.at(-1)).toBe('play bloom-close.mp3');
        sounding('bloom-close.mp3').end();
        await advance(0);
        expect(events.at(-1)).toBe('mic close 1');
    });

    it('an end inside the opening: the capture closes once the cut opening has faded', async () => {
        begin(null);
        const { engine } = startSession();
        await advance(MIC_DELAY_MS + 601);
        const opening = sounding('bloom-open.mp3');
        void sound.playClosing('bloom', engine);
        await advance(100);
        expect(opening.volume).toBeLessThan(1);
        expect(events).toEqual(['mic open 1', 'play bloom-open.mp3']);
        await advance(200);
        expect(opening.paused).toBe(true);
        expect(events).toEqual(['mic open 1', 'play bloom-open.mp3', 'mic close 1']);
    });

    it('an end while the opening waits for the mic: the capture closes at once and nothing plays', async () => {
        begin(null);
        const { engine } = startSession();
        await advance(MIC_DELAY_MS + 300);
        void sound.playClosing('bloom', engine);
        await advance(0);
        expect(events).toEqual(['mic open 1', 'mic close 1']);
        await advance(10_000);
        expect(events).toEqual(['mic open 1', 'mic close 1']);
    });

    it('an end before the mic has opened: the late stream is closed on arrival', async () => {
        begin(null);
        const { engine } = startSession();
        await advance(10);
        void sound.playClosing('bloom', engine);
        await advance(10_000);
        expect(events).toEqual(['mic open 1', 'mic close 1']);
    });

    it('a close that never reports its end: the capture closes by the sound clock', async () => {
        const engine = await sessionUnderway();
        void sound.playClosing('bloom', engine);
        await advance(0);
        // The fake file is 4 s long; the clock gives it 300 ms more.
        await advance(4_000);
        expect(events.at(-1)).toBe('play bloom-close.mp3');
        await advance(400);
        expect(events.at(-1)).toBe('mic close 1');
    });

    it('a close that cannot play: the capture closes at once', async () => {
        const engine = await sessionUnderway();
        vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, arrayBuffer: async () => ({}) }));
        void sound.playClosing('drone', engine);
        await advance(0);
        expect(events).toEqual(['mic open 1', 'play bloom-open.mp3', 'mic close 1']);
    });

    it('a hold whose promise never settles is still let go, by the engine cap', async () => {
        const engine = await sessionUnderway();
        await engine.stop({ keepMicUntil: new Promise(() => undefined) });
        await advance(59_000);
        expect(events.at(-1)).toBe('play bloom-open.mp3');
        await advance(1_001);
        expect(events.at(-1)).toBe('mic close 1');
    });
});

describe("the setup screen's capture held at Begin is let go on every way out", () => {
    it('when the start is turned back (no mic, a sign-in dismissed)', async () => {
        begin(await listeningSetup());
        await advance(1_000);
        mic.endCaptureHandover();
        await advance(0);
        expect(events).toEqual(['mic open 1', 'mic close 1']);
    });

    it("when the session's capture never hears, at the hand-over cap", async () => {
        begin(await listeningSetup());
        startSession();
        await advance(MIC_DELAY_MS);
        frame(0);
        await advance(mic.CAPTURE_HANDOVER_CAP_MS - MIC_DELAY_MS - 1);
        expect(events).not.toContain('mic close 1');
        await advance(2);
        expect(events).toContain('mic close 1');
        expect(events).not.toContain('mic close 2');
    });

    it('when the session ends before its capture hears', async () => {
        begin(await listeningSetup());
        const { engine } = startSession();
        await advance(MIC_DELAY_MS);
        void sound.playClosing('bloom', engine);
        await advance(0);
        expect(events).toEqual(['mic open 1', 'mic open 2', 'mic close 1', 'mic close 2']);
    });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeAudio, audiblePlays } from './fake-audio-element.js';

type Sound = typeof import('../ui/src/signature-sound.js');
let sound: Sound;
/** Selectors of the nav orbs given the ripple class, in order. */
let rippled: string[];
let fetched: string[];
/** Set to hold every fetch open until released. */
let gate: Promise<void> | null;
let failing: boolean;
/** Object URL -> the asset it was made from. */
let blobs: Map<string, string>;

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeAudio.reset();
    fetched = [];
    gate = null;
    failing = false;
    rippled = [];
    blobs = new Map();
    vi.stubGlobal('Audio', FakeAudio);
    // Both nav orbs at once, which the app never has: enough to see which one
    // a pulse went to.
    vi.stubGlobal('document', {
        querySelector: (selector: string) => ({
            classList: { add: () => rippled.push(selector), remove: () => {} },
        }),
    });
    // The bytes carry their URL, so an object URL can say which file it is.
    vi.stubGlobal('fetch', async (url: string) => {
        fetched.push(url);
        if (gate) await gate;
        return { ok: !failing, status: failing ? 404 : 200, arrayBuffer: async () => ({ url }) };
    });
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
    sound = await import('../ui/src/signature-sound.js');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/** Run a play() far enough to have started its element (or decided not to). */
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);
/** The files that have started playing, in order. */
const played = (): string[] => audiblePlays().map((p) => blobs.get(p.src) ?? p.src);
const lastEl = (): FakeAudio => audiblePlays().at(-1)!.el;

function track(p: Promise<void>): { over: boolean } {
    const state = { over: false };
    void p.then(() => {
        state.over = true;
    });
    return state;
}

describe('signature sound presets', () => {
    it('keeps a pick that is on the menu and defaults anything else', () => {
        expect(sound.resolveSignatureSound('ripples')).toBe('ripples');
        expect(sound.resolveSignatureSound('none')).toBe('none');
        expect(sound.resolveSignatureSound('retired-preset')).toBe(sound.DEFAULT_SIGNATURE_SOUND);
        expect(sound.resolveSignatureSound(undefined)).toBe(sound.DEFAULT_SIGNATURE_SOUND);
    });

    it('ships both files of every preset', () => {
        const dir = join(dirname(fileURLToPath(import.meta.url)), '../ui/public/audio/signature');
        for (const [id] of sound.SIGNATURE_SOUNDS) {
            if (id === 'none') continue;
            for (const half of ['open', 'close']) {
                expect(existsSync(join(dir, `${id}-${half}.mp3`)), `${id}-${half}.mp3`).toBe(true);
            }
        }
    });
});

describe('the opening', () => {
    it('is over only when the sound has played out', async () => {
        const opening = track(sound.playOpening('handpan'));
        await settle();
        expect(fetched).toContain('/audio/signature/handpan-open.mp3');
        expect(played()).toEqual(['/audio/signature/handpan-open.mp3']);
        expect(opening.over).toBe(false);
        lastEl().end();
        await settle();
        expect(opening.over).toBe(true);
    });

    it('plays the fetched bytes from an object URL, kept for the next session', async () => {
        void sound.playOpening('handpan');
        await settle();
        const el = lastEl();
        expect(el.src).toMatch(/^blob:/);
        el.end();
        await settle();
        void sound.playClosing('handpan');
        await settle();
        lastEl().end();
        await settle();
        void sound.playOpening('handpan');
        await settle();
        expect(lastEl()).toBe(el);
        expect(el.srcSets).toBe(1);
        expect(fetched.filter((u) => u.endsWith('handpan-open.mp3'))).toHaveLength(1);
    });

    it('is over at once with no sound picked, and fetches nothing', async () => {
        const opening = track(sound.playOpening('none'));
        await settle();
        expect(opening.over).toBe(true);
        expect(fetched).toEqual([]);
    });

    it('is skipped when it has not loaded in time, and does not play late', async () => {
        let release = (): void => {};
        gate = new Promise((r) => (release = r));
        const opening = track(sound.playOpening('bloom'));
        await vi.advanceTimersByTimeAsync(1499);
        expect(opening.over).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(opening.over).toBe(true);
        release();
        await settle();
        expect(played()).toEqual([]);
    });

    it('does not hold the first words for an element that will not start', async () => {
        FakeAudio.playResult = () => new Promise(() => {});
        const opening = track(sound.playOpening('bloom'));
        await vi.advanceTimersByTimeAsync(1501);
        expect(opening.over).toBe(true);
        expect(lastEl().paused).toBe(true);
    });

    it('does not hold the first words when playback is refused', async () => {
        FakeAudio.playResult = () => Promise.reject(Object.assign(new Error('no gesture'), { name: 'NotAllowedError' }));
        const opening = track(sound.playOpening('bloom'));
        await settle();
        expect(opening.over).toBe(true);
    });

    it('ends by the clock when the element never reports its end', async () => {
        const opening = track(sound.playOpening('bloom'));
        await settle();
        expect(played()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(4000 + 400);
        expect(opening.over).toBe(true);
        await vi.advanceTimersByTimeAsync(300);
        expect(lastEl().paused).toBe(true);
    });

    it('plays a file the iOS app serves with no HTTP status', async () => {
        vi.stubGlobal('fetch', async (url: string) => ({ ok: false, status: 0, arrayBuffer: async () => ({ url }) }));
        void sound.playOpening('bloom');
        await settle();
        expect(played()).toHaveLength(1);
    });

    it('ends when the file cannot be fetched, and tries again next time', async () => {
        failing = true;
        const opening = track(sound.playOpening('drone'));
        await settle();
        expect(opening.over).toBe(true);
        failing = false;
        fetched = [];
        void sound.playOpening('drone');
        await settle();
        expect(fetched).toContain('/audio/signature/drone-open.mp3');
        expect(played()).toEqual(['/audio/signature/drone-open.mp3']);
    });

    it('is loaded into its element ahead of the session', async () => {
        sound.preloadOpening('ripples');
        await settle();
        const el = FakeAudio.made.find((a) => a.src.startsWith('blob:'))!;
        expect(blobs.get(el.src)).toBe('/audio/signature/ripples-open.mp3');
        expect(el.paused).toBe(true);
        void sound.playOpening('ripples');
        await settle();
        expect(lastEl()).toBe(el);
        expect(el.srcSets).toBe(1);
    });
});

describe('the opening, with a mic being opened', () => {
    it('waits for the mic and a beat more, so the output has settled', async () => {
        let micUp = (): void => {};
        const opening = track(sound.playOpening('bloom', () => new Promise<void>((r) => (micUp = r))));
        await vi.advanceTimersByTimeAsync(400);
        expect(played()).toEqual([]);
        micUp();
        await vi.advanceTimersByTimeAsync(590);
        expect(played()).toEqual([]);
        await vi.advanceTimersByTimeAsync(20);
        expect(played()).toHaveLength(1);
        expect(rippled).toEqual(['#navCenter #orb']);
        expect(opening.over).toBe(false);
    });

    it('stops waiting for a mic that does not open', async () => {
        void sound.playOpening('bloom', () => new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(1500 + 600 + 20);
        expect(played()).toHaveLength(1);
    });

    it('plays neither sound for a session that ends while it waits', async () => {
        const opening = track(sound.playOpening('bloom', () => new Promise(() => {})));
        await vi.advanceTimersByTimeAsync(300);
        sound.playClosing('bloom');
        await vi.advanceTimersByTimeAsync(5000);
        expect(opening.over).toBe(true);
        expect(played()).toEqual([]);
        expect(rippled).toEqual([]);
    });

    it('with no sound picked, is over once the mic is up', async () => {
        let micUp = (): void => {};
        const opening = track(sound.playOpening('none', () => new Promise<void>((r) => (micUp = r))));
        await settle();
        expect(opening.over).toBe(false);
        micUp();
        await settle();
        expect(opening.over).toBe(true);
        expect(fetched).toEqual([]);
    });
});

describe('the opening on Android', () => {
    // The mic opens first there too. An echo-cancelled mic starts call mode,
    // and Android mutes media playback for 2 s as it starts.
    beforeEach(() => {
        vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 (Linux; Android 16; CPH2655) wv' });
    });

    it('opens the mic first, and starts the sound once call mode has stopped muting media', async () => {
        let micUp = (): void => {};
        const openMic = vi.fn(() => new Promise<void>((r) => (micUp = r)));
        const opening = track(sound.playOpening('bloom', openMic));
        await settle();
        expect(openMic).toHaveBeenCalledOnce();
        expect(played()).toEqual([]);
        micUp();
        await vi.advanceTimersByTimeAsync(2190);
        expect(played()).toEqual([]);
        await vi.advanceTimersByTimeAsync(20);
        expect(played()).toHaveLength(1);
        expect(opening.over).toBe(false);
    });

    it('waits only the short beat for a mic opened beside one of ours, which switches nothing', async () => {
        const mic = await import('../ui/src/mic-check.js');
        mic.noteCaptureOpened({} as MediaStream, () => true);
        let micUp = (): void => {};
        void sound.playOpening('bloom', () => new Promise<void>((r) => (micUp = r)));
        await settle();
        micUp();
        await vi.advanceTimersByTimeAsync(590);
        expect(played()).toEqual([]);
        await vi.advanceTimersByTimeAsync(20);
        expect(played()).toHaveLength(1);
    });

    it("opens the mic first while the last session's close still holds one", async () => {
        const mic = await import('../ui/src/mic-check.js');
        void sound.playOpening('bloom');
        await settle();
        lastEl().end();
        await settle();
        // The last session's capture, kept until its close is over.
        mic.noteCaptureOpened({} as MediaStream, () => true);
        void sound.playClosing('bloom');
        await settle();
        let micUp = (): void => {};
        const openMic = vi.fn(() => new Promise<void>((r) => (micUp = r)));
        void sound.playOpening('bloom', openMic);
        await settle();
        expect(openMic).toHaveBeenCalledOnce();
        expect(played()).toHaveLength(2);
        micUp();
        // The settle, then the close's fade.
        await vi.advanceTimersByTimeAsync(600 + 250 + 20);
        expect(played()).toHaveLength(3);
    });

    it('with no sound picked, opens the mic at once and waits for it', async () => {
        let micUp = (): void => {};
        const openMic = vi.fn(() => new Promise<void>((r) => (micUp = r)));
        const opening = track(sound.playOpening('none', openMic));
        await settle();
        expect(openMic).toHaveBeenCalledOnce();
        expect(opening.over).toBe(false);
        micUp();
        await settle();
        expect(opening.over).toBe(true);
    });

    it('stops waiting for a mic that does not open', async () => {
        const opening = track(sound.playOpening('none', () => new Promise(() => {})));
        await vi.advanceTimersByTimeAsync(1499);
        expect(opening.over).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(opening.over).toBe(true);
    });
});

describe('the close', () => {
    it('plays once the opening is over, on its own element', async () => {
        void sound.playOpening('marimba');
        await settle();
        const openEl = lastEl();
        openEl.end();
        await settle();
        // Its promise is what the mic is held open for: over when the sound is.
        const close = track(sound.playClosing('marimba'));
        await settle();
        expect(played()).toEqual(['/audio/signature/marimba-open.mp3', '/audio/signature/marimba-close.mp3']);
        expect(lastEl()).not.toBe(openEl);
        expect(close.over).toBe(false);
        lastEl().end();
        await settle();
        expect(close.over).toBe(true);
        // The session's orb for the opening, the home screen's for the close.
        expect(rippled).toEqual(['#navCenter #orb', '#navCenter #home-orb']);
    });

    it('is dropped, with the opening faded, when the session ends inside its opening', async () => {
        const opening = track(sound.playOpening('marimba'));
        await settle();
        const el = lastEl();
        const close = track(sound.playClosing('marimba'));
        await settle();
        expect(opening.over).toBe(true);
        expect(played()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(100);
        expect(el.volume).toBeLessThan(1);
        expect(el.paused).toBe(false);
        // Over once the faded opening is quiet: the mic is held until then.
        expect(close.over).toBe(false);
        await vi.advanceTimersByTimeAsync(200);
        expect(el.paused).toBe(true);
        expect(close.over).toBe(true);
    });
});

describe("the close, and the recognizer's mic", () => {
    function engine() {
        const keeps: Array<{ settled: boolean }> = [];
        return {
            keeps,
            stop: vi.fn(async (options?: { keepMicUntil?: Promise<unknown> }) => {
                const state = { settled: false };
                keeps.push(state);
                void options?.keepMicUntil?.then(() => (state.settled = true));
            }),
            start: () => ({ async *[Symbol.asyncIterator]() {} }),
        };
    }

    it('stops listening at once and keeps the mic until the close has played out', async () => {
        void sound.playOpening('handpan');
        await settle();
        lastEl().end();
        await settle();
        const stt = engine();
        void sound.playClosing('handpan', stt);
        expect(stt.stop).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(2000);
        expect(stt.keeps[0]!.settled).toBe(false);
        lastEl().end();
        await settle();
        expect(stt.keeps[0]!.settled).toBe(true);
    });

    it('lets it go at once with no sound picked, or for a session ended before its opening', async () => {
        const quiet = engine();
        void sound.playClosing('none', quiet);
        await settle();
        expect(quiet.keeps[0]!.settled).toBe(true);

        void sound.playOpening('bloom', () => new Promise(() => {}));
        await settle();
        const early = engine();
        void sound.playClosing('bloom', early);
        await settle();
        expect(early.keeps[0]!.settled).toBe(true);
        expect(played()).toEqual([]);
    });

    it('lets it go when the close cannot play', async () => {
        failing = true;
        const stt = engine();
        void sound.playClosing('ripples', stt);
        await settle();
        expect(stt.keeps[0]!.settled).toBe(true);
    });
});

describe('the capture held at Begin (mic-check.ts holdCaptureForSession)', () => {
    async function held() {
        const mic = await import('../ui/src/mic-check.js');
        const state = { settled: false };
        void mic.holdCaptureForSession().then(() => (state.settled = true));
        return { mic, state };
    }

    it('is let go at once for a session with no mic of ours to open', async () => {
        const { state } = await held();
        void sound.playOpening('bloom');
        await settle();
        expect(state.settled).toBe(true);
    });

    it("is kept while the session's mic opens, and let go once it hears", async () => {
        const { mic, state } = await held();
        void sound.playOpening('bloom', () => Promise.resolve());
        await vi.advanceTimersByTimeAsync(1000);
        expect(state.settled).toBe(false);
        mic.noteCaptureHearing();
        await settle();
        expect(state.settled).toBe(true);
    });

    it("is let go when the session's mic fails to open", async () => {
        const { state } = await held();
        void sound.playOpening('bloom', () => Promise.reject(new Error('NotReadableError')));
        await settle();
        expect(state.settled).toBe(true);
    });

    it('is let go when the session ends', async () => {
        const { state } = await held();
        void sound.playOpening('bloom', () => new Promise(() => {}));
        await settle();
        void sound.playClosing('bloom');
        await settle();
        expect(state.settled).toBe(true);
    });
});

describe('a preview', () => {
    it('primes the elements from the click', () => {
        sound.previewSignatureSound('ripples', 'open');
        expect(FakeAudio.log.filter((p) => p.src.startsWith('data:'))).toHaveLength(4);
    });

    it('cuts an opening still sounding and starts once it has faded, not over it', async () => {
        sound.previewSignatureSound('ripples', 'open');
        await settle();
        const openEl = lastEl();
        sound.previewSignatureSound('ripples', 'close');
        await vi.advanceTimersByTimeAsync(100);
        expect(played()).toHaveLength(1);
        expect(openEl.volume).toBeLessThan(1);
        await vi.advanceTimersByTimeAsync(200);
        expect(openEl.paused).toBe(true);
        expect(played()).toEqual(['/audio/signature/ripples-open.mp3', '/audio/signature/ripples-close.mp3']);
    });

    it('of the same half restarts it from the top once faded', async () => {
        sound.previewSignatureSound('drone', 'open');
        await settle();
        const el = lastEl();
        el.currentTime = 1.2;
        sound.previewSignatureSound('drone', 'open');
        await vi.advanceTimersByTimeAsync(300);
        expect(played()).toHaveLength(2);
        expect(audiblePlays()[1]!.el).toBe(el);
        expect(audiblePlays()[1]!.currentTime).toBe(0);
    });
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAudio, audiblePlays } from './fake-audio-element.js';

type Player = typeof import('../ui/src/sound-player.js');
let player: Player;

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    FakeAudio.reset();
    vi.stubGlobal('Audio', FakeAudio);
    player = await import('../ui/src/sound-player.js');
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);

function track(p: Promise<void>): { over: boolean } {
    const state = { over: false };
    void p.then(() => {
        state.over = true;
    });
    return state;
}

/** The element a play() went to: the last one, unless told otherwise. */
const lastEl = (): FakeAudio => audiblePlays().at(-1)!.el;

describe('priming', () => {
    it('plays silence once on each sound element, inside the gesture', () => {
        player.primeSounds();
        const primed = FakeAudio.log.filter((p) => p.src === player.SILENT_WAV);
        expect(primed).toHaveLength(4);
        expect(new Set(primed.map((p) => p.el)).size).toBe(4);
    });

    it('leaves an element that is sounding alone', async () => {
        const cue = player.playCue('bowl');
        await settle();
        const el = lastEl();
        player.primeSounds();
        expect(el.src).toBe('/audio/bowl.mp3');
        expect(FakeAudio.log.filter((p) => p.el === el)).toHaveLength(1);
        expect(track(cue.done).over).toBe(false);
    });

    it('keeps the src of an element that has its sound: played muted, then paused', async () => {
        player.playChime();
        await settle();
        const el = lastEl();
        el.end();
        await settle();
        const sets = el.srcSets;
        player.primeSounds();
        const prime = FakeAudio.log.filter((p) => p.el === el).at(-1)!;
        expect(FakeAudio.log.filter((p) => p.el === el)).toHaveLength(2);
        expect(prime.muted).toBe(true);
        expect(el.srcSets).toBe(sets);
        expect(el.paused).toBe(true);
        expect(el.muted).toBe(false);
    });

    it('a pause the prime left queued does not end the next sound', async () => {
        player.playChime();
        await settle();
        lastEl().end();
        await settle();
        player.primeSounds();
        const chime = track(player.playChime().done);
        await vi.advanceTimersByTimeAsync(50);
        expect(audiblePlays()).toHaveLength(2);
        expect(chime.over).toBe(false);
    });
});

describe('a sound', () => {
    it('is over when it has played out', async () => {
        const sound = track(player.playSound('open', 'blob:a').done);
        await settle();
        expect(sound.over).toBe(false);
        lastEl().end();
        await settle();
        expect(sound.over).toBe(true);
        expect(lastEl().listening('ended')).toBe(0);
    });

    it('is over when the system pauses it', async () => {
        const sound = track(player.playSound('open', 'blob:a').done);
        await settle();
        lastEl().pause();
        await settle();
        expect(sound.over).toBe(true);
    });

    it('is over by the clock when ended never comes', async () => {
        const sound = track(player.playSound('open', 'blob:a').done);
        await settle();
        await vi.advanceTimersByTimeAsync(4000 + 299);
        expect(sound.over).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(sound.over).toBe(true);
        await vi.advanceTimersByTimeAsync(300);
        expect(lastEl().paused).toBe(true);
    });

    it('resolves when play() is refused', async () => {
        FakeAudio.playResult = () => Promise.reject(Object.assign(new Error('no gesture'), { name: 'NotAllowedError' }));
        const sound = track(player.playChime().done);
        await settle();
        expect(sound.over).toBe(true);
    });

    it('is skipped, and never plays late, when not started by its deadline', async () => {
        let release = (_: string): void => {};
        const src = new Promise<string>((r) => (release = r));
        const sound = track(player.playSound('open', src, { startDeadlineMs: 1500 }).done);
        await vi.advanceTimersByTimeAsync(1499);
        expect(sound.over).toBe(false);
        await vi.advanceTimersByTimeAsync(2);
        expect(sound.over).toBe(true);
        release('blob:late');
        await settle();
        expect(audiblePlays()).toHaveLength(0);
    });

    it('is paused when it loads but does not start by its deadline', async () => {
        FakeAudio.playResult = () => new Promise(() => {});
        const sound = track(player.playSound('open', 'blob:a', { startDeadlineMs: 1500 }).done);
        await vi.advanceTimersByTimeAsync(1501);
        expect(sound.over).toBe(true);
        expect(lastEl().paused).toBe(true);
    });
});

describe('a cue', () => {
    it('restarts from the top on its element, without loading the file again', async () => {
        const first = track(player.playCue('bowl').done);
        await settle();
        const el = lastEl();
        el.currentTime = 0.5;
        player.playCue('bowl');
        await settle();
        expect(first.over).toBe(true);
        expect(audiblePlays()).toHaveLength(2);
        expect(lastEl()).toBe(el);
        expect(audiblePlays()[1]!.currentTime).toBe(0);
        expect(el.srcSets).toBe(1);
    });

    it('changes the src only when the cue changes', async () => {
        player.playCue('bowl');
        await settle();
        player.playCue('rin');
        await settle();
        expect(lastEl().src).toBe('/audio/rin.mp3');
        expect(lastEl().srcSets).toBe(2);
    });

    it('plays on its own element, so a chime and a cue do not cut each other', async () => {
        const chime = track(player.playChime().done);
        await settle();
        player.playCue('bowl');
        await settle();
        const [a, b] = audiblePlays();
        expect(a!.el).not.toBe(b!.el);
        expect(a!.src).toBe('/audio/chime.wav');
        expect(chime.over).toBe(false);
    });
});

describe('cut short', () => {
    it('fades out, then pauses, and the next sound on the element waits for it', async () => {
        const first = player.playSound('open', 'blob:a');
        await settle();
        const el = lastEl();
        const done = track(first.done);
        const quiet = track(first.stop());
        await settle();
        expect(done.over).toBe(true);
        player.playSound('open', 'blob:b');
        await vi.advanceTimersByTimeAsync(100);
        expect(el.volume).toBeGreaterThan(0);
        expect(el.volume).toBeLessThan(1);
        expect(el.paused).toBe(false);
        expect(audiblePlays()).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(200);
        expect(quiet.over).toBe(true);
        expect(audiblePlays()).toHaveLength(2);
        expect(el.src).toBe('blob:b');
        expect(el.volume).toBe(1);
    });

    it('pauses at once where the volume cannot be set', async () => {
        FakeAudio.volumeFixed = true;
        player.primeSounds();
        await vi.advanceTimersByTimeAsync(200);
        const sound = player.playSound('open', 'blob:a');
        await settle();
        const el = lastEl();
        void sound.stop();
        expect(el.paused).toBe(true);
    });

    it('pauses within a tick or two where the volume is put back before the check has answered', async () => {
        FakeAudio.volumeFixed = true;
        const sound = player.playSound('open', 'blob:a');
        await settle();
        const el = lastEl();
        void sound.stop();
        await vi.advanceTimersByTimeAsync(60);
        expect(el.paused).toBe(true);
    });
});

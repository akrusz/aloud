import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

class FakeSource {
    buffer: unknown = null;
    onended: (() => void) | null = null;
    stopAt: number | null = null;
    startAt: number | null = null;
    connect(): void {}
    disconnect(): void {}
    start(when = 0): void {
        this.startAt = when;
    }
    stop(when = 0): void {
        this.stopAt = when;
    }
}

class FakeContext {
    static last: FakeContext | null = null;
    state = 'running';
    currentTime = 0;
    destination = {};
    sources: FakeSource[] = [];
    gains: number[] = [];
    resumes = 0;
    constructor() {
        FakeContext.last = this;
    }
    resume(): Promise<void> {
        this.resumes++;
        return Promise.resolve();
    }
    createBufferSource(): FakeSource {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
    }
    createGain() {
        const gains = this.gains;
        return {
            gain: {
                set value(v: number) {
                    gains.push(v);
                },
                get value() {
                    return gains[gains.length - 1] ?? 1;
                },
                cancelScheduledValues(): void {},
                setValueAtTime(): void {},
                linearRampToValueAtTime(): void {},
            },
            connect(): void {},
            disconnect(): void {},
        };
    }
    decodeAudioData(_data: ArrayBuffer, ok: (b: unknown) => void): void {
        ok({ duration: 4 });
    }
}

type Sound = typeof import('../ui/src/signature-sound.js');
let sound: Sound;
/** Selectors of the nav orbs given the ripple class, in order. */
let rippled: string[];
let fetched: string[];
/** Set to hold every fetch open until released. */
let gate: Promise<void> | null;
let failing: boolean;

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    fetched = [];
    gate = null;
    failing = false;
    FakeContext.last = null;
    rippled = [];
    const g = globalThis as unknown as { AudioContext: unknown; fetch: unknown; document: unknown };
    g.AudioContext = FakeContext;
    // Both nav orbs at once, which the app never has: enough to see which one
    // a pulse went to.
    g.document = {
        querySelector: (selector: string) => ({
            classList: { add: () => rippled.push(selector), remove: () => {} },
        }),
    };
    g.fetch = async (url: string) => {
        fetched.push(url);
        if (gate) await gate;
        return { ok: !failing, status: failing ? 404 : 200, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    sound = await import('../ui/src/signature-sound.js');
});

afterEach(() => vi.useRealTimers());

/** Run a play() far enough to have started its source (or decided not to). */
const settle = (): Promise<unknown> => vi.advanceTimersByTimeAsync(0);
const ctx = (): FakeContext => FakeContext.last!;

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
        expect(ctx().sources).toHaveLength(1);
        expect(ctx().gains[0]).toBeLessThan(1);
        expect(opening.over).toBe(false);
        ctx().sources[0]!.onended!();
        await settle();
        expect(opening.over).toBe(true);
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
        expect(ctx().sources).toHaveLength(0);
    });

    it('does not hold the first words for a context that will not run', async () => {
        const opening = track(sound.playOpening('bloom'));
        ctx().state = 'suspended';
        ctx().resume = () => new Promise(() => {});
        await vi.advanceTimersByTimeAsync(500);
        expect(opening.over).toBe(true);
        expect(ctx().sources).toHaveLength(0);
    });

    it('ends by the clock when the context stalls mid-sound', async () => {
        const opening = track(sound.playOpening('bloom'));
        await settle();
        expect(ctx().sources).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(4000 + 400);
        expect(opening.over).toBe(true);
        expect(ctx().sources[0]!.stopAt).not.toBeNull();
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
        expect(ctx().sources).toHaveLength(1);
    });
});

describe('the opening, with a mic being opened', () => {
    it('waits for the mic and a beat more, so the output has settled', async () => {
        let micUp = (): void => {};
        const opening = track(sound.playOpening('bloom', new Promise<void>((r) => (micUp = r))));
        await vi.advanceTimersByTimeAsync(400);
        expect(ctx()).toBeNull();
        micUp();
        await vi.advanceTimersByTimeAsync(590);
        expect(ctx()).toBeNull();
        await vi.advanceTimersByTimeAsync(20);
        expect(ctx().sources).toHaveLength(1);
        expect(rippled).toEqual(['#navCenter #orb']);
        expect(opening.over).toBe(false);
    });

    it('stops waiting for a mic that does not open', async () => {
        void sound.playOpening('bloom', new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(1500 + 600 + 20);
        expect(ctx().sources).toHaveLength(1);
    });

    it('plays neither sound for a session that ends while it waits', async () => {
        const opening = track(sound.playOpening('bloom', new Promise(() => {})));
        await vi.advanceTimersByTimeAsync(300);
        sound.playClosing('bloom');
        await vi.advanceTimersByTimeAsync(5000);
        expect(opening.over).toBe(true);
        expect(ctx()).toBeNull();
        expect(rippled).toEqual([]);
    });
});

describe('the close', () => {
    it('plays once the opening is over', async () => {
        void sound.playOpening('marimba');
        await settle();
        ctx().sources[0]!.onended!();
        await settle();
        // Its promise is what the mic is held open for: over when the sound is.
        const close = track(sound.playClosing('marimba'));
        await settle();
        expect(ctx().sources).toHaveLength(2);
        expect(fetched).toContain('/audio/signature/marimba-close.mp3');
        expect(close.over).toBe(false);
        ctx().sources[1]!.onended!();
        await settle();
        expect(close.over).toBe(true);
        // The session's orb for the opening, the home screen's for the close.
        expect(rippled).toEqual(['#navCenter #orb', '#navCenter #home-orb']);
    });

    it('is dropped, with the opening faded, when the session ends inside its opening', async () => {
        const opening = track(sound.playOpening('marimba'));
        await settle();
        const close = track(sound.playClosing('marimba'));
        await settle();
        expect(opening.over).toBe(true);
        expect(close.over).toBe(true);
        expect(ctx().sources).toHaveLength(1);
        expect(ctx().sources[0]!.stopAt).not.toBeNull();
    });
});

describe('a preview', () => {
    it('cuts an opening still sounding and starts once it has faded, not over it', async () => {
        sound.previewSignatureSound('ripples', 'open');
        await settle();
        expect(ctx().sources[0]!.startAt).toBe(0);
        sound.previewSignatureSound('ripples', 'close');
        await settle();
        expect(ctx().sources).toHaveLength(2);
        const fadedAt = ctx().sources[0]!.stopAt!;
        expect(fadedAt).toBeGreaterThan(0);
        expect(ctx().sources[1]!.startAt).toBe(fadedAt);
    });
});

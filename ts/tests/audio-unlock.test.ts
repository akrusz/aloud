import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { FakeAudio } from './fake-audio-element.js';

type Unlock = typeof import('../ui/src/audio-unlock.js');
let unlock: Unlock;

beforeEach(async () => {
    vi.resetModules();
    FakeAudio.reset();
    vi.stubGlobal('Audio', FakeAudio);
    unlock = await import('../ui/src/audio-unlock.js');
});

afterEach(() => vi.unstubAllGlobals());

const playsOn = (el: FakeAudio): string[] => FakeAudio.log.filter((p) => p.el === el).map((p) => p.src);

describe('audio playback unlock', () => {
    it('hands out one element, so Safari’s per-element permission carries', () => {
        const a = unlock.playbackAudio();
        const b = unlock.playbackAudio();
        expect(a).toBe(b);
        expect(FakeAudio.made).toHaveLength(1);
    });

    it('primes by playing silence on that same element', () => {
        const el = unlock.playbackAudio() as unknown as FakeAudio;
        unlock.primeAudioPlayback();
        expect(playsOn(el)).toHaveLength(1);
        expect(playsOn(el)[0]).toMatch(/^data:audio\/wav;base64,/);
    });

    it('primes the sound elements on the same click', () => {
        const voice = unlock.playbackAudio() as unknown as FakeAudio;
        unlock.primeAudioPlayback();
        const others = new Set(FakeAudio.log.filter((p) => p.el !== voice).map((p) => p.el));
        expect(others.size).toBe(4);
    });

    it('does not interrupt an utterance already playing', () => {
        const el = unlock.playbackAudio() as unknown as FakeAudio;
        el.src = 'blob:sentence';
        el.paused = false;
        unlock.primeAudioPlayback();
        expect(playsOn(el)).toHaveLength(0);
        expect(el.src).toBe('blob:sentence');
    });
});

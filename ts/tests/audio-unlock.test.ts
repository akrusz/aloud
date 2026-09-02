import { describe, it, expect, beforeEach } from 'vitest';
import { playbackAudio, primeAudioPlayback } from '../ui/src/audio-unlock.js';

class FakeAudio {
    static made = 0;
    src = '';
    preload = '';
    paused = true;
    plays: string[] = [];
    constructor() {
        FakeAudio.made++;
    }
    play() {
        this.paused = false;
        this.plays.push(this.src);
        return Promise.resolve();
    }
    pause() {
        this.paused = true;
    }
}

beforeEach(() => {
    (globalThis as unknown as { Audio: unknown }).Audio = FakeAudio;
    FakeAudio.made = 0;
});

describe('audio playback unlock', () => {
    it('hands out one element, so Safari’s per-element permission carries', () => {
        const a = playbackAudio() as unknown as FakeAudio;
        const b = playbackAudio() as unknown as FakeAudio;
        expect(a).toBe(b);
        // Constructed once, at first use - later calls reuse it.
        expect(FakeAudio.made).toBeLessThanOrEqual(1);
    });

    it('primes by playing silence on that same element', () => {
        const el = playbackAudio() as unknown as FakeAudio;
        el.plays = [];
        primeAudioPlayback();
        expect(el.plays).toHaveLength(1);
        expect(el.plays[0]).toMatch(/^data:audio\/wav;base64,/);
    });

    it('does not interrupt an utterance already playing', () => {
        const el = playbackAudio() as unknown as FakeAudio;
        el.src = 'blob:sentence';
        el.paused = false;
        el.plays = [];
        primeAudioPlayback();
        expect(el.plays).toHaveLength(0);
        expect(el.src).toBe('blob:sentence');
    });
});

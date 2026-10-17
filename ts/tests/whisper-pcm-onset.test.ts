import { describe, it, expect } from 'vitest';
import { framesWithin } from '../ui/src/adapters/whisper-pcm-stt.js';

// 4096-sample frames: ~85ms at 48kHz, ~93ms at 44.1kHz.
describe('the onset audio a turn keeps', () => {
    it('counts only whole frames inside the window', () => {
        expect(framesWithin(450, 48_000)).toBe(5);
        expect(framesWithin(85, 48_000)).toBe(0);
        expect(framesWithin(86, 48_000)).toBe(1);
        expect(framesWithin(450, 44_100)).toBe(4);
    });

    it('keeps nothing when the window closed before the turn opened', () => {
        expect(framesWithin(0, 48_000)).toBe(0);
        expect(framesWithin(-300, 48_000)).toBe(0);
    });
});

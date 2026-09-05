import { describe, expect, it } from 'vitest';
import { compactQuietRuns } from '../ui/src/adapters/whisper-pcm-stt.js';

/**
 * Interior-silence compaction for the billed STT payload (meditation-pal-12q9):
 * a held mid-thought pause is uploaded as a short gap instead of its full
 * length, with the cut always inside the quiet.
 */
const q = (pattern: string): boolean[] => [...pattern].map((c) => c === '.');

describe('compactQuietRuns', () => {
    it('leaves a sequence with no long quiet run alone', () => {
        expect(compactQuietRuns(q('xxx..xxx'), 4, 2)).toEqual([[0, 8]]);
    });

    it('collapses a long quiet run to `keep` chunks split across both edges', () => {
        // 3 speech, 10 quiet, 3 speech; gap 4, keep 4 -> keep 2 head + 2 tail
        const ranges = compactQuietRuns(q('xxx..........xxx'), 4, 4);
        expect(ranges).toEqual([
            [0, 5],
            [11, 16],
        ]);
    });

    it('handles several runs and a run touching either end', () => {
        const ranges = compactQuietRuns(q('......xx......xx......'), 3, 2);
        expect(ranges).toEqual([
            [0, 1],
            [5, 9],
            [13, 17],
            [21, 22],
        ]);
    });

    it('never cuts when the run is not longer than keep', () => {
        expect(compactQuietRuns(q('xx....xx'), 2, 4)).toEqual([[0, 8]]);
    });
});

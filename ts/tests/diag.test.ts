import { describe, it, expect, vi } from 'vitest';
import { diag, recentAudioDiag } from '../ui/src/diag.js';

describe('audio diagnostics kept for bug reports', () => {
    it('keeps the audio lines only', () => {
        vi.spyOn(console, 'info').mockImplementation(() => {});
        diag('[vad] tts window: frames=40 peak=0.0812');
        diag('[judge]', JSON.stringify({ verdict: 'resume', ms: 412 }));
        diag(`[stt-cost] final billed=2.10s`);
        expect(recentAudioDiag()).toEqual([
            '[vad] tts window: frames=40 peak=0.0812',
            '[stt-cost] final billed=2.10s',
        ]);
    });

    it('holds the last 40, each clipped', () => {
        vi.spyOn(console, 'info').mockImplementation(() => {});
        for (let i = 0; i < 50; i++) diag(`[vad] line ${i} ${'x'.repeat(300)}`);
        const lines = recentAudioDiag();
        expect(lines).toHaveLength(40);
        expect(lines[0]!.startsWith('[vad] line 10 ')).toBe(true);
        expect(lines.every((l) => l.length <= 221)).toBe(true);
    });
});

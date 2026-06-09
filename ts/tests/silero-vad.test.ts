/**
 * SileroFrameVad — the streaming resampler/chunker and the speech-probability
 * hysteresis around an injected fake model. The real ONNX path (create()) is
 * exercised manually in the app; here we verify the audio plumbing that wraps
 * it: phase-continuous downsampling to 16 kHz, exact 512-sample chunking,
 * serialized inference, the ON/OFF probability band, and backpressure.
 */

import { describe, expect, it } from 'vitest';
import { SileroFrameVad, type SileroModel } from '../ui/src/adapters/silero-vad.js';

function fakeModel(probFor: (chunkIndex: number) => number): SileroModel & {
    chunks: Float32Array[];
    resets: number;
} {
    const chunks: Float32Array[] = [];
    return {
        chunks,
        resets: 0,
        async process(frame: Float32Array) {
            chunks.push(frame.slice());
            const isSpeech = probFor(chunks.length - 1);
            return { isSpeech, notSpeech: 1 - isSpeech };
        },
        reset_state() {
            this.resets++;
        },
        async release() {},
    };
}

describe('SileroFrameVad', () => {
    it('slices 48 kHz frames into 512-sample chunks at 16 kHz', async () => {
        const model = fakeModel(() => 0.1);
        const vad = new SileroFrameVad(model);
        // 12 frames x 4096 samples @48k = 49152 native ≈ 16384 @16k = 32 chunks.
        for (let i = 0; i < 12; i++) {
            vad.feed(new Float32Array(4096).fill(0.5), 48_000);
        }
        await vad.release();
        expect(model.chunks.length).toBe(32);
        for (const chunk of model.chunks) {
            expect(chunk.length).toBe(512);
            // DC input must survive resampling untouched (interpolation between
            // equal samples) — catches phase/indexing bugs at frame seams.
            for (const sample of chunk) expect(sample).toBeCloseTo(0.5, 6);
        }
        expect(vad.droppedChunks).toBe(0);
    });

    it('passes 16 kHz input through losslessly', async () => {
        const model = fakeModel(() => 0.1);
        const vad = new SileroFrameVad(model);
        // Ramp signal; ratio 1 keeps interpolation exact (frac always 0).
        const input = Float32Array.from({ length: 1025 }, (_, i) => i / 1025);
        vad.feed(input, 16_000);
        await vad.release();
        expect(model.chunks.length).toBe(2);
        expect(model.chunks[0]![0]).toBeCloseTo(input[0]!, 6);
        expect(model.chunks[1]![511]).toBeCloseTo(input[1023]!, 6);
    });

    it('applies ON/OFF hysteresis to the speech probability', async () => {
        // Chunk probs: 0.6 (on), 0.45 (in band — hold), 0.3 (off).
        const probs = [0.6, 0.45, 0.3];
        const model = fakeModel((i) => probs[i] ?? 0);
        const vad = new SileroFrameVad(model);
        expect(vad.speaking).toBe(false);

        vad.feed(new Float32Array(513), 16_000);
        await vad.release();
        expect(vad.speaking).toBe(true);

        vad.feed(new Float32Array(512), 16_000);
        await vad.release();
        expect(vad.speaking).toBe(true); // 0.45 is inside the band: state holds

        vad.feed(new Float32Array(512), 16_000);
        await vad.release();
        expect(vad.speaking).toBe(false);
        expect(vad.lastProb).toBeCloseTo(0.3, 6);
    });

    it('reset clears stream state and resets the model behind in-flight chunks', async () => {
        const model = fakeModel(() => 0.9);
        const vad = new SileroFrameVad(model);
        vad.feed(new Float32Array(700), 16_000); // one chunk + partial fill
        await vad.release();
        expect(vad.speaking).toBe(true);

        vad.reset();
        await vad.release();
        expect(vad.speaking).toBe(false);
        expect(vad.lastProb).toBe(0);
        expect(model.resets).toBe(1);

        // Stream state cleared: the leftover partial fill is gone, so a fresh
        // 512-sample feed produces exactly one whole new chunk.
        vad.feed(new Float32Array(513), 16_000);
        await vad.release();
        expect(model.chunks.length).toBe(2);
    });

    it('drops chunks instead of queueing unboundedly when inference stalls', () => {
        const stalled: SileroModel = {
            process: () => new Promise(() => {}), // never resolves
            reset_state() {},
            release: async () => {},
        };
        const vad = new SileroFrameVad(stalled);
        // 64 chunks' worth at 16 kHz; the queue caps at 32 in flight.
        vad.feed(new Float32Array(64 * 512 + 1), 16_000);
        expect(vad.droppedChunks).toBe(32);
    });
});

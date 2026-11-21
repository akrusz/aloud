import { describe, it, expect, vi } from 'vitest';

import { advance, engineWithMic, listen, rig, useWhisperHarness, type Engine } from './whisper-pcm-harness.js';
import type { WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';
import { LOBBY_STT } from '../ui/src/voice-start.js';

/**
 * A quiet word over a tour line, with Silero deciding (LOBBY_STT
 * overLineLatchMs). Silero's verdict trails the word's loudest part, so the
 * frame over the bar and the frames Silero calls speech are not the same ones.
 */

const silero = vi.hoisted(() => ({
    broken: false,
    speaking: false,
    lastProb: 0,
    droppedChunks: 0,
    feed(): void {},
    reset(): void {},
}));
vi.mock('../ui/src/adapters/silero-vad.js', () => ({ loadSileroVad: async () => silero }));

useWhisperHarness();

const ECHO = 0.01;
/** The frames still to come: the mic's level and Silero's verdict on each. */
let frames: Array<{ level: number; speaking: boolean }> = [];
let rest = 0;
const mic = (): number => {
    const next = frames.shift();
    silero.speaking = next?.speaking ?? false;
    return next?.level ?? rest;
};

async function line(e: WhisperPcmSttEngine, during: () => Promise<void>): Promise<void> {
    e.noteVoicePlayback();
    e.setTtsActive(true);
    rest = ECHO;
    await during();
    rest = 0;
    e.notePlaybackEnded();
    e.setTtsActive(false);
}

/** One frame at 0.055, then three at the bar that Silero calls speech; true
 *  when the word was sent. */
async function quietWordOverLine(opts: Record<string, unknown>): Promise<boolean> {
    frames = [];
    rest = 0;
    silero.speaking = false;
    rig.amplitude = mic;
    const e = (await engineWithMic(opts)) as unknown as WhisperPcmSttEngine;
    // The first line after a capture opens is the voice warm-up's.
    await line(e, () => advance(1000));
    const turn = await listen(e as unknown as Engine);
    await line(e, async () => {
        await advance(500);
        frames = [
            { level: 0.055, speaking: false },
            { level: 0.02, speaking: true },
            { level: 0.02, speaking: true },
            { level: 0.015, speaking: true },
        ];
        await advance(2500);
    });
    await advance(3000, turn.done);
    return rig.posts.length > 0;
}

describe('a quiet word over a tour line, heard by Silero a frame late', () => {
    it('is sent on the setup screen', async () => {
        expect(await quietWordOverLine(LOBBY_STT)).toBe(true);
    });

    it('opens no turn without the latch', async () => {
        expect(await quietWordOverLine({ ...LOBBY_STT, overLineLatchMs: 0 })).toBe(false);
    });
});

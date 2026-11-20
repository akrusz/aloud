import { describe, it, expect, vi } from 'vitest';

import { advance, engineWithMic, listen, rig, useWhisperHarness, type Engine } from './whisper-pcm-harness.js';
import type { WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';
import { LOBBY_STT } from '../ui/src/voice-start.js';

/**
 * Words said over a tour line on the setup screen's hosted capture, which
 * hears through it (LOBBY_STT overLineBar / overLineMinSpeechMs). A one-syllable
 * command clears the bar for a frame or two; in a session's tuning it is
 * dropped as a cough, on the setup screen it is sent. The engine runs on its
 * energy speech decision here, so a frame's level alone says whether it is
 * speech.
 */

vi.mock('../ui/src/adapters/silero-vad.js', () => ({
    loadSileroVad: async () => ({ broken: true }),
}));

useWhisperHarness();

const engineOf = (engine: Engine): WhisperPcmSttEngine => engine as unknown as WhisperPcmSttEngine;

/** The echo every line leaves at the mic: the desktop's planning figure. */
const ECHO = 0.01;
/** The mic's level for the next `frames` frames, then `rest`. */
let burst = { frames: 0, level: 0 };
let rest = 0;
function word(level: number, frames: number): void {
    burst = { frames, level };
}

async function line(e: WhisperPcmSttEngine, during: () => Promise<void>): Promise<void> {
    e.noteVoicePlayback();
    e.setTtsActive(true);
    rest = ECHO;
    await during();
    rest = 0;
    e.notePlaybackEnded();
    e.setTtsActive(false);
}

async function setupEngine(opts: Record<string, unknown>): Promise<WhisperPcmSttEngine> {
    burst = { frames: 0, level: 0 };
    rest = 0;
    rig.amplitude = () => (burst.frames > 0 ? (burst.frames--, burst.level) : rest);
    const engine = engineOf(await engineWithMic(opts));
    // The first line after a capture opens is the voice warm-up's.
    await line(engine, () => advance(1000));
    return engine;
}

/** A command over a line, one frame long at `level`; true when it was sent. */
async function overLine(e: WhisperPcmSttEngine, level: number, frames = 1): Promise<boolean> {
    const turn = await listen(e as unknown as Engine);
    await line(e, async () => {
        await advance(500);
        word(level, frames);
        await advance(2500);
    });
    await advance(3000, turn.done);
    return rig.posts.length > 0;
}

describe('a word over a tour line', () => {
    it('is sent on the setup screen however short, once it clears the bar', async () => {
        expect(await overLine(await setupEngine(LOBBY_STT), 0.025)).toBe(true);
    });

    const { overLineBar: _bar, overLineMinSpeechMs: _min, ...session } = LOBBY_STT;
    it('is not sent in a session under the barge-in bar', async () => {
        expect(await overLine(await setupEngine(session), 0.025)).toBe(false);
    });

    it('is not sent in a session over it either, being shorter than the minimum', async () => {
        expect(await overLine(await setupEngine(session), 0.05)).toBe(false);
    });

    it('opens no turn on the line alone', async () => {
        const e = await setupEngine(LOBBY_STT);
        const turn = await listen(e as unknown as Engine);
        await line(e, () => advance(4000));
        await advance(3000);
        expect(rig.posts).toHaveLength(0);
        expect(turn.done()).toBe(false);
    });

    it('waits for the voice warm-up over the first line after a capture opens', async () => {
        burst = { frames: 0, level: 0 };
        rest = 0;
        rig.amplitude = () => (burst.frames > 0 ? (burst.frames--, burst.level) : rest);
        const e = engineOf(await engineWithMic(LOBBY_STT));
        expect(await overLine(e, 0.05, 3)).toBe(false);
    });
});

describe('a short sound not over a line', () => {
    it('is still dropped as a cough', async () => {
        const e = await setupEngine(LOBBY_STT);
        const turn = await listen(e as unknown as Engine);
        word(0.05, 1);
        await advance(3000, turn.done);
        expect(rig.posts).toHaveLength(0);
    });
});

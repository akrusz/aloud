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

/** LOBBY_STT as a session would have it: nothing of its own over a line. */
const {
    overLineBar: _bar,
    overLineMinSpeechMs: _min,
    overLineSilenceMs: _pause,
    overLineLatchMs: _latch,
    ...session
} = LOBBY_STT;

const engineOf = (engine: Engine): WhisperPcmSttEngine => engine as unknown as WhisperPcmSttEngine;

/** The echo every line leaves at the mic: the desktop's planning figure. */
const ECHO = 0.01;
/** The mic's level for the next `frames` frames, then `rest`. */
let burst = { frames: 0, level: 0 };
let rest = 0;
/** When the last frame of the word was heard. */
let wordEndedAt = 0;
function word(level: number, frames: number): void {
    burst = { frames, level };
}
const mic = (): number => {
    if (burst.frames === 0) return rest;
    burst.frames--;
    wordEndedAt = Date.now();
    return burst.level;
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

async function setupEngine(opts: Record<string, unknown>): Promise<WhisperPcmSttEngine> {
    burst = { frames: 0, level: 0 };
    rest = 0;
    rig.amplitude = mic;
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
        rig.amplitude = mic;
        const e = engineOf(await engineWithMic(LOBBY_STT));
        expect(await overLine(e, 0.05, 3)).toBe(false);
    });
});

describe('a turn too loud to be the line come back', () => {
    // setupEngine's first line measured this mic's echo at ECHO (0.01).
    it('is one five times over the loudest a line has been with nobody speaking', async () => {
        const e = await setupEngine(LOBBY_STT);
        expect(await overLine(e, 0.06)).toBe(true);
        expect(e.lastTurnClearOfEcho()).toBe(true);
    });

    it('is not one nearer the echo than that', async () => {
        const e = await setupEngine(LOBBY_STT);
        expect(await overLine(e, 0.03)).toBe(true);
        expect(e.lastTurnClearOfEcho()).toBe(false);
    });

    it('is none before any line has been measured', async () => {
        burst = { frames: 0, level: 0 };
        rest = 0;
        rig.amplitude = mic;
        const e = engineOf(await engineWithMic(LOBBY_STT));
        expect(e.lastTurnClearOfEcho()).toBe(false);
    });
});

describe('the pause that ends the turn', () => {
    /** How long after the word's last frame the turn was sent. */
    async function sentAfter(e: WhisperPcmSttEngine, over: boolean): Promise<number> {
        const turn = await listen(e as unknown as Engine);
        let sentAt = 0;
        const sent = (): boolean => {
            if (!sentAt && rig.posts.length > 0) sentAt = Date.now();
            return sentAt > 0;
        };
        const speak = async (): Promise<void> => {
            await advance(500);
            word(0.05, 3);
            await advance(2500, sent);
        };
        if (over) await line(e, speak);
        else await speak();
        await advance(3000, turn.done);
        expect(sentAt).toBeGreaterThan(0);
        return sentAt - wordEndedAt;
    }

    it('is shorter for a turn begun over a line', async () => {
        expect(await sentAfter(await setupEngine(LOBBY_STT), true)).toBeLessThan(650);
    });

    it('is the setup screen\'s own between lines', async () => {
        expect(await sentAfter(await setupEngine(LOBBY_STT), false)).toBeGreaterThanOrEqual(LOBBY_STT.silenceBaseMs);
    });

    it('is unchanged over a line without the setup screen\'s numbers', async () => {
        expect(await sentAfter(await setupEngine(session), true)).toBeGreaterThanOrEqual(LOBBY_STT.silenceBaseMs);
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

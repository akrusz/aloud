import { describe, it, expect, vi } from 'vitest';

import { advance, engineWithMic, heard, listen, rig, useWhisperHarness, type Engine } from './whisper-pcm-harness.js';
import type { WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';

/**
 * The answer to a question the facilitator just asked (expectAnswer): a soft
 * "yes" said over the question's tail opens the turn, and a whole answer ends
 * it at its first speculative pass instead of after the session's pause
 * (meditation-pal-cs6y). The engine runs on its energy speech decision here,
 * so a frame's level alone says whether it is speech (floor 0.015).
 */

vi.mock('../ui/src/adapters/silero-vad.js', () => ({
    loadSileroVad: async () => ({ broken: true }),
}));

useWhisperHarness();

/** A session's own pause: 3s and up. */
const sessionWindow = { silenceBaseMs: 3000, silenceMaxMs: 6000, silenceRampRate: 0.16 };
const isYes = (text: string): boolean => /^yes\.?$/i.test(text.trim());
/** Over the floor, under the barge-in bar (0.03). */
const SOFT_WORD = 0.02;

const engineOf = (engine: Engine): WhisperPcmSttEngine => engine as unknown as WhisperPcmSttEngine;

/** The mic's level frame by frame, set as the scene goes. */
let level = 0;

/** The facilitator says a line whose echo reaches the mic at `echo`; the
 *  caller's hangover then holds the gate up for another second (session.ts
 *  TTS_ACTIVE_HANGOVER_MS), across `meanwhile`. */
async function question(
    engine: WhisperPcmSttEngine,
    echo: number,
    meanwhile: () => Promise<void>,
    afterLine: () => void | Promise<void> = () => {}
): Promise<void> {
    engine.setTtsActive(true);
    engine.noteVoicePlayback();
    level = echo;
    await advance(2000);
    level = 0;
    engine.notePlaybackEnded();
    await afterLine();
    const hangoverEnds = Date.now() + 1000;
    await meanwhile();
    await advance(Math.max(0, hangoverEnds - Date.now()));
    engine.setTtsActive(false);
}

/** A soft word, 300ms after it is called, inside the hangover. */
async function softYes(): Promise<void> {
    await advance(300);
    level = SOFT_WORD;
    await advance(400);
    level = 0;
}

/** Speak for `ms`, then report how long the turn took to end after it. */
async function sayAndTime(turn: { done: () => boolean }, ms = 400): Promise<number> {
    rig.talking = true;
    await advance(ms);
    rig.talking = false;
    const quietFrom = Date.now();
    await advance(10_000, turn.done);
    expect(turn.done()).toBe(true);
    return Date.now() - quietFrom;
}

describe('a soft word right after a question', () => {
    it('is lost under the barge-in bar when no answer is expected', async () => {
        level = 0;
        rig.amplitude = () => level;
        const engine = await engineWithMic(sessionWindow);
        let turn!: { done: () => boolean };
        await question(engineOf(engine), 0.001, softYes, async () => {
            turn = await listen(engine);
        });
        await advance(6000);
        expect(rig.posts).toHaveLength(0);
        expect(turn.done()).toBe(false);
    });

    it('opens the turn when an answer is expected, and the turn ends as one', async () => {
        level = 0;
        rig.amplitude = () => level;
        rig.reply = () => heard('Yes.');
        const engine = await engineWithMic(sessionWindow);
        let turn!: Awaited<ReturnType<typeof listen>>;
        await question(engineOf(engine), 0.001, softYes, async () => {
            engineOf(engine).expectAnswer(isYes, 45_000);
            turn = await listen(engine);
        });
        await advance(6000, turn.done);
        expect(turn.done()).toBe(true);
        expect(rig.posts).toHaveLength(1);
        expect(turn.events.at(-1)).toMatchObject({ type: 'final', text: 'Yes.' });
    });

    it('stays shut when it is no louder than the question was at the mic, by the margin', async () => {
        level = 0;
        rig.amplitude = () => level;
        const engine = await engineWithMic(sessionWindow);
        let turn!: { done: () => boolean };
        // An echo of 0.008 puts the bar at 0.024: a word at 0.02 could be the
        // question's own tail.
        await question(engineOf(engine), 0.008, softYes, async () => {
            engineOf(engine).expectAnswer(isYes, 45_000);
            turn = await listen(engine);
        });
        await advance(6000);
        expect(rig.posts).toHaveLength(0);
        expect(turn.done()).toBe(false);
    });

    it('stays shut while a line is still playing, answer or not', async () => {
        level = 0;
        rig.amplitude = () => level;
        const engine = await engineWithMic(sessionWindow);
        const e = engineOf(engine);
        // Listening through the line, as the continuous path does under a
        // reply that ends in a question.
        e.setTtsActive(true);
        e.noteVoicePlayback();
        const turn = await listen(engine);
        e.expectAnswer(isYes, 45_000);
        level = 0.001;
        await advance(1000);
        level = SOFT_WORD;
        await advance(400);
        level = 0.001;
        await advance(600);
        level = 0;
        e.notePlaybackEnded();
        await advance(1000);
        e.setTtsActive(false);
        await advance(6000);
        expect(rig.posts).toHaveLength(0);
        expect(turn.done()).toBe(false);
    });
});

describe('a whole answer', () => {
    it('ends the turn when its first speculative pass comes back', async () => {
        rig.reply = () => heard('Yes.');
        const engine = await engineWithMic(sessionWindow);
        engineOf(engine).expectAnswer(isYes, 45_000);
        const turn = await listen(engine);
        expect(await sayAndTime(turn)).toBeLessThan(2500);
        expect(rig.posts).toHaveLength(1);
        expect(turn.events.at(-1)).toMatchObject({ type: 'final', text: 'Yes.' });
    });

    it("waits out the session's pause when the pass reads as anything else", async () => {
        rig.reply = () => heard('Hmm.');
        const engine = await engineWithMic(sessionWindow);
        engineOf(engine).expectAnswer(isYes, 45_000);
        const turn = await listen(engine);
        expect(await sayAndTime(turn)).toBeGreaterThanOrEqual(3000);
        expect(turn.events.at(-1)).toMatchObject({ type: 'final', text: 'Hmm.' });
    });

    it('gets its pass with speculation off, and one transcription in all', async () => {
        rig.reply = () => heard('Yes.');
        const engine = await engineWithMic({ ...sessionWindow, speculation: false });
        engineOf(engine).expectAnswer(isYes, 45_000);
        const turn = await listen(engine);
        expect(await sayAndTime(turn)).toBeLessThan(2500);
        expect(rig.posts).toHaveLength(1);
    });

    it('does not end the turn when speech came while its pass was out', async () => {
        rig.reply = (n) => heard(n === 1 ? 'Yes.' : 'Yes, but not yet.');
        const engine = await engineWithMic(sessionWindow);
        engineOf(engine).expectAnswer(isYes, 45_000);
        const turn = await listen(engine);
        rig.talking = true;
        await advance(400);
        rig.talking = false;
        // The first pass goes out at the 750ms pause and is in flight for 1s.
        await advance(1000);
        expect(rig.posts).toHaveLength(1);
        rig.talking = true;
        await advance(500);
        rig.talking = false;
        await advance(12_000, turn.done);
        expect(rig.posts).toHaveLength(2);
        expect(turn.events.at(-1)).toMatchObject({ type: 'final', text: 'Yes, but not yet.' });
    });

    it('is expected once: the turn after it, or after the window, is a turn', async () => {
        rig.reply = () => heard('Yes.');
        const engine = await engineWithMic(sessionWindow);
        const e = engineOf(engine);
        e.expectAnswer(isYes, 45_000);
        expect(await sayAndTime(await listen(engine))).toBeLessThan(2500);
        expect(await sayAndTime(await listen(engine))).toBeGreaterThanOrEqual(3000);

        e.expectAnswer(isYes, 1000);
        await advance(2000);
        expect(await sayAndTime(await listen(engine))).toBeGreaterThanOrEqual(3000);
    });
});

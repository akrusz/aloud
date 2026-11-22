import { describe, it, expect, vi } from 'vitest';

import { advance, engineWithMic, useWhisperHarness, rig } from './whisper-pcm-harness.js';
import type { WhisperPcmSttEngine } from '../ui/src/adapters/whisper-pcm-stt.js';

/**
 * The voice warm-up (ECHO_WARMUP_GATE, ECHO_WARMUP_MS): over the first 3s of
 * audible voice a new capture stream plays under, barge-in needs 0.1, and
 * after that the normal bar (0.03) holds, however long the playback window
 * stays open. The engine runs on its energy speech decision here, so a
 * frame's level alone says whether it is speech.
 */

vi.mock('../ui/src/adapters/silero-vad.js', () => ({
    loadSileroVad: async () => ({ broken: true }),
}));

useWhisperHarness();

/** What the canceller leaves of the voice at the mic. */
const ECHO = 0.01;
/** Speech over a line: over the normal bar, under the warm-up's. */
const OVER_LINE = 0.08;

let level = 0;
let bargedIn = false;

async function freshEngine(): Promise<WhisperPcmSttEngine> {
    level = 0;
    bargedIn = false;
    rig.amplitude = () => level;
    const e = (await engineWithMic({})) as unknown as WhisperPcmSttEngine;
    e.setBargeInHandler(() => {
        bargedIn = true;
    });
    return e;
}

/** A line's speak() begins and its audio is on the way for `waitMs` (a
 *  clip's synthesis), then sounds for `ms`, inside a playback window already
 *  open. */
async function sounding(e: WhisperPcmSttEngine, ms: number, waitMs = 0): Promise<void> {
    e.noteVoicePlayback();
    level = 0;
    await advance(waitMs);
    e.noteVoiceAudible();
    level = ECHO;
    await advance(ms);
}

/** The line stops (played out, hushed, or cut by a newer turn). */
function ended(e: WhisperPcmSttEngine): void {
    e.notePlaybackEnded();
    level = 0;
}

/** Speech at `at` for 500ms (about 4 frames, the barge-in needs 3). */
async function speak(at: number): Promise<void> {
    level = at;
    await advance(500);
    level = ECHO;
}

describe('the voice warm-up on a new capture stream', () => {
    it('holds speech under its bar in the first 3s of voice', async () => {
        const e = await freshEngine();
        e.setTtsActive(true);
        await sounding(e, 1000);
        await speak(OVER_LINE);
        expect(bargedIn).toBe(false);
    });

    it('ends after 3s of voice, with the same playback still going', async () => {
        const e = await freshEngine();
        e.setTtsActive(true);
        await sounding(e, 3200);
        await speak(OVER_LINE);
        expect(bargedIn).toBe(true);
        const lines = vi.mocked(console.info).mock.calls.map((c) => c.join(' '));
        expect(lines.some((l) => l.startsWith('[vad] voice warm-up over on time'))).toBe(true);
    });

    it('is at the normal bar for a second playback in the same window', async () => {
        // A turn superseded the greeting and the next reply began inside the
        // echo hangover, so the playback window never closed (meditation-pal-u21t).
        const e = await freshEngine();
        e.setTtsActive(true);
        await sounding(e, 4000);
        ended(e);
        await advance(600);
        await sounding(e, 500);
        await speak(OVER_LINE);
        expect(bargedIn).toBe(true);
    });

    it('counts only time a line is sounding, not the gaps between sentences', async () => {
        const e = await freshEngine();
        e.setTtsActive(true);
        await sounding(e, 1000);
        ended(e);
        await advance(2500);
        await sounding(e, 500);
        await speak(OVER_LINE);
        expect(bargedIn).toBe(false);
    });

    it('does not count the wait for a line to become audible', async () => {
        const e = await freshEngine();
        e.setTtsActive(true);
        await sounding(e, 1000, 2500);
        await speak(OVER_LINE);
        expect(bargedIn).toBe(false);
    });

    it('stops counting when a line is cut, until the next one is audible', async () => {
        const e = await freshEngine();
        e.setTtsActive(true);
        await sounding(e, 1000);
        ended(e);
        // A start reported late, after the cut, is not the next line's.
        e.noteVoiceAudible();
        await advance(2000);
        await sounding(e, 500, 1500);
        await speak(OVER_LINE);
        expect(bargedIn).toBe(false);
    });

    it('counts a line begun over another from its own audible start', async () => {
        // A notice's speak() beginning while a reply plays: the reply is cut
        // and the playback never ends between the two.
        const e = await freshEngine();
        e.setTtsActive(true);
        await sounding(e, 1000);
        await sounding(e, 500, 2500);
        await speak(OVER_LINE);
        expect(bargedIn).toBe(false);
    });
});

import { describe, it, expect, vi } from 'vitest';

import { advance, engineWithMic, FRAME_MS, heard, listen, rig, useWhisperHarness, type Post } from './whisper-pcm-harness.js';

// `broken` puts the engine on its energy speech decision, so a loud frame is
// speech and a near-zero frame is quiet.
vi.mock('../ui/src/adapters/silero-vad.js', () => ({
    loadSileroVad: async () => ({ broken: true }),
}));

useWhisperHarness();

const CAP_MS = 3000;

// The cap is a runaway valve (background speech, a TV, speaker echo holding
// the VAD open): the turn it ends is final. Speech still going during that
// final pass starts the NEXT turn from the onset pre-buffer; it must not
// reopen this one, or each pass re-sends (and hosted STT bills) the whole
// buffer again. meditation-pal-uuh4.
describe('the max utterance cap', () => {
    // Where the cut lands against the engine's 200 ms poll decides whether a
    // frame arrives between the cut and the final pass's snapshot, so sweep
    // the speech onset across one poll period.
    it.each([0, 25, 50, 75, 100, 125, 150, 175])(
        'ends the turn with one final pass; continuing speech starts the next turn (phase %ims)',
        async (phaseMs) => {
            const engine = await engineWithMic({ maxUtteranceMs: CAP_MS });
            const first = await listen(engine);
            await vi.advanceTimersByTimeAsync(phaseMs);
            rig.talking = true;
            await advance(CAP_MS + 4000, first.done);
            expect(first.done()).toBe(true);

            expect(rig.posts).toHaveLength(1);
            const [cut] = rig.posts as [Post];
            // The cap plus the onset margin (LEAD_KEEP_MS), each rounded up to
            // whole frames.
            expect(cut.seconds).toBeGreaterThanOrEqual(CAP_MS / 1000);
            expect(cut.seconds).toBeLessThanOrEqual((CAP_MS + 500 + 2 * FRAME_MS) / 1000);
            expect(first.events).toEqual([
                { type: 'final', text: 'pass 1', seconds: cut.seconds, startedDuringTts: false },
            ]);

            // Still talking: the next turn opens on the pre-buffer, which picks
            // up right after the cut frame, with no frame sent twice.
            const second = await listen(engine);
            await advance(1000);
            rig.talking = false;
            await advance(15_000, second.done);
            expect(second.done()).toBe(true);

            const later = rig.posts.slice(1);
            expect(later.length).toBeGreaterThan(0);
            const firstTags = new Set(cut.tags);
            for (const p of later) expect(p.tags.some((t) => firstTags.has(t))).toBe(false);
            expect(later[0]!.tags[0]).toBe(cut.tags.at(-1)! + 1);
            expect(second.events.at(-1)).toMatchObject({ type: 'final' });
        }
    );
});

describe('speech that continues past a silence-window submit', () => {
    it('reopens the turn, and the final pass carries all of it', async () => {
        const engine = await engineWithMic({
            speculation: false,
            silenceBaseMs: 1000,
            silenceMaxMs: 1000,
            silenceRampRate: 0,
        });
        const turn = await listen(engine);
        rig.talking = true;
        await advance(1500);
        rig.talking = false;
        // The window closes about 1s into the pause and the pass goes out.
        await advance(1300);
        expect(rig.posts).toHaveLength(1);
        // The meditator picks up again while that pass is in flight.
        rig.talking = true;
        await advance(1500);
        rig.talking = false;
        await advance(8000, turn.done);
        expect(turn.done()).toBe(true);

        expect(rig.posts).toHaveLength(2);
        const [before, after] = rig.posts as [Post, Post];
        expect(after.tags[0]).toBe(before.tags[0]);
        expect(after.tags.at(-1)!).toBeGreaterThan(before.tags.at(-1)! + 5);
        expect(turn.events).toEqual([
            { type: 'partial', text: 'pass 1', startedDuringTts: false },
            {
                type: 'final',
                text: 'pass 2',
                seconds: before.seconds + after.seconds,
                startedDuringTts: false,
            },
        ]);
    });
});

// The final reuses a speculative transcript only when no speech came after
// it. A later speculative pass that failed, came back empty, or was dropped
// leaves an older transcript behind that is missing the newer words.
describe('a final after speculative passes', () => {
    const windowed = { silenceBaseMs: 4000, silenceMaxMs: 4000, silenceRampRate: 0 };

    /** Speech, a pause the first speculative pass answers, more speech, then
     *  quiet: the second pass goes out on that last pause. */
    async function twoPhrases(turn: { done: () => boolean }): Promise<void> {
        rig.talking = true;
        await advance(1500);
        rig.talking = false;
        await advance(2500);
        expect(rig.posts).toHaveLength(1);
        rig.talking = true;
        await advance(1500);
        rig.talking = false;
        await advance(12_000, turn.done);
        expect(turn.done()).toBe(true);
    }

    it('reuses the transcript of a single pause instead of sending again', async () => {
        rig.reply = () => heard('One.');
        const engine = await engineWithMic(windowed);
        const turn = await listen(engine);
        rig.talking = true;
        await advance(1500);
        rig.talking = false;
        await advance(8000, turn.done);
        expect(turn.done()).toBe(true);

        expect(rig.posts).toHaveLength(1);
        expect(turn.events.at(-1)).toEqual({
            type: 'final',
            text: 'One.',
            seconds: rig.posts[0]!.seconds,
            startedDuringTts: false,
        });
    });

    it.each([
        ['fails on a dropped connection', (): Response => {
            throw new TypeError('Failed to fetch');
        }],
        ['fails with a 500', (): Response => new Response('upstream', { status: 500 })],
        ['comes back empty', (): Response => heard('')],
    ])('sends the whole turn again when the last pause\'s pass %s', async (_, second) => {
        rig.reply = (n) => (n === 1 ? heard('One.') : n === 2 ? second() : heard('One. Two.'));
        const engine = await engineWithMic(windowed);
        const turn = await listen(engine);
        await twoPhrases(turn);

        expect(rig.posts).toHaveLength(3);
        const [spec, , final] = rig.posts as [Post, Post, Post];
        expect(final.tags[0]).toBe(spec.tags[0]);
        expect(final.tags.at(-1)).toBeGreaterThanOrEqual(rig.posts[1]!.tags.at(-1)!);
        expect(turn.events.at(-1)).toMatchObject({ type: 'final', text: 'One. Two.' });
    });

    it('sends the whole turn again when the cap drops the last pause\'s pass', async () => {
        rig.reply = (n) => heard(n === 1 ? 'One.' : n === 2 ? 'One. Tw' : 'One. Two.');
        // The cap lands while the second pass is in flight.
        const engine = await engineWithMic({ ...windowed, maxUtteranceMs: 6900 });
        const turn = await listen(engine);
        await twoPhrases(turn);

        expect(rig.posts).toHaveLength(3);
        expect(turn.events.map((e) => e.type)).toEqual(['partial', 'final']);
        expect(turn.events.at(-1)).toMatchObject({ type: 'final', text: 'One. Two.' });
    });
});

import { describe, expect, it } from 'vitest';
import { streamNeedsRefresh } from '../ui/src/adapters/whisper-pcm-stt.js';

/**
 * The capture graph is reused across turns on purpose - re-acquiring the mic is
 * what used to clip the first second of a barge-in. These pin the cases where
 * reuse is wrong, the important one being a muted-but-live track
 * (meditation-pal-wudm).
 */

function fakeStream(opts: {
    active?: boolean;
    tracks?: Array<{ muted?: boolean; readyState?: MediaStreamTrackState }>;
}): MediaStream {
    const tracks = (opts.tracks ?? [{}]).map((t) => ({
        muted: t.muted ?? false,
        readyState: t.readyState ?? ('live' as MediaStreamTrackState),
    }));
    return {
        active: opts.active ?? true,
        getAudioTracks: () => tracks,
    } as unknown as MediaStream;
}

describe('streamNeedsRefresh', () => {
    it('reuses a healthy live stream', () => {
        expect(streamNeedsRefresh(fakeStream({}))).toBe(false);
    });

    it('refreshes when there is no stream yet', () => {
        expect(streamNeedsRefresh(null)).toBe(true);
    });

    it('refreshes an inactive stream', () => {
        expect(streamNeedsRefresh(fakeStream({ active: false }))).toBe(true);
    });

    it('refreshes a stream with no audio track', () => {
        expect(streamNeedsRefresh(fakeStream({ tracks: [] }))).toBe(true);
    });

    it('refreshes an ended track', () => {
        expect(streamNeedsRefresh(fakeStream({ tracks: [{ readyState: 'ended' }] }))).toBe(true);
    });

    // The regression: Android leaves the track muted-but-live after the app is
    // backgrounded and returns. `active` stays true, so the old guard reused it
    // and every later turn captured silence.
    it('refreshes a muted track even though the stream still reports active', () => {
        const stream = fakeStream({ active: true, tracks: [{ muted: true }] });
        expect(stream.active).toBe(true);
        expect(streamNeedsRefresh(stream)).toBe(true);
    });
});

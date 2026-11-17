import { describe, expect, it } from 'vitest';
import { describeWhisperWait, parseWarmBody, settleLoading, whisperNotice } from '../ui/src/whisper-ready.js';

describe('parseWarmBody', () => {
    it('reads a loaded model as ready', () => {
        expect(parseWarmBody({ ready: true, error: null, progress: null })).toEqual({ state: 'ready' });
    });

    it('stays optimistic when the body says nothing', () => {
        expect(parseWarmBody({})).toEqual({ state: 'ready' });
    });

    it('reports download percent, never 100 before ready', () => {
        expect(parseWarmBody({ ready: false, progress: { done: 50, total: 200 } })).toEqual({
            state: 'downloading',
            percent: 25,
        });
        expect(parseWarmBody({ ready: false, progress: { done: 200, total: 200 } })).toEqual({
            state: 'downloading',
            percent: 99,
        });
    });

    it('has no percent without a content-length', () => {
        expect(parseWarmBody({ ready: false, progress: { done: 50, total: null } })).toEqual({
            state: 'downloading',
            percent: null,
        });
    });

    it('prefers an in-flight download over a stale error', () => {
        expect(
            parseWarmBody({ ready: false, error: 'timed out', progress: { done: 1, total: 2 } }).state
        ).toBe('downloading');
    });

    it('separates failed from plain loading', () => {
        expect(parseWarmBody({ ready: false, error: 'offline' })).toEqual({ state: 'failed' });
        expect(parseWarmBody({ ready: false, error: null })).toEqual({ state: 'loading' });
    });
});

describe('a model being loaded', () => {
    it('is brief, and unannounced, for its first second', () => {
        const first = settleLoading({ state: 'loading' }, null, 5_000);
        expect(first).toEqual({ state: 'loading', brief: true });
        expect(whisperNotice(first)).toBeNull();
        // Begin and the listener still wait on it.
        expect(describeWhisperWait(first)).not.toBeNull();
        expect(settleLoading({ state: 'loading' }, 5_000, 5_900)).toEqual({ state: 'loading', brief: true });
    });

    it('is announced once it has gone on', () => {
        const late = settleLoading({ state: 'loading' }, 5_000, 6_100);
        expect(late).toEqual({ state: 'loading' });
        expect(whisperNotice(late)).not.toBeNull();
    });

    it('leaves a download and a ready model as they are', () => {
        expect(settleLoading({ state: 'ready' }, 5_000, 9_000)).toEqual({ state: 'ready' });
        const down = { state: 'downloading', percent: 4 } as const;
        expect(settleLoading(down, null, 9_000)).toBe(down);
        expect(whisperNotice(down)).not.toBeNull();
    });
});

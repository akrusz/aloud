import { describe, expect, it } from 'vitest';
import { parseWarmBody } from '../ui/src/whisper-ready.js';

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

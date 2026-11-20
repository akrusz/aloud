/**
 * output-volume.ts: a session on a phone says when its volume is off, or very
 * low as it loads, and nothing where the volume can't be read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
    LOW_VOLUME,
    LOW_JUDGED_AFTER_MS,
    LOW_SHOWN_MS,
    WATCH_MS,
    mountVolumeNotice,
    volumeProblem,
    type VolumeReading,
} from '../ui/src/output-volume.js';

const reading = (over: Partial<VolumeReading> = {}): VolumeReading => ({
    level: 0.6,
    muted: false,
    headphones: false,
    ...over,
});

function banner() {
    const el = {
        textContent: '' as string | null,
        hidden: true,
        classList: {
            toggle(_cls: string, force: boolean) {
                el.hidden = force;
            },
        },
    };
    return el;
}

describe('volumeProblem', () => {
    it('is nothing at an ordinary level, or where there is no reading', () => {
        expect(volumeProblem(reading())).toBeNull();
        expect(volumeProblem(null)).toBeNull();
    });

    it('is "off" when muted, headphones or not', () => {
        expect(volumeProblem(reading({ level: 0, muted: true }))).toBe('off');
        expect(volumeProblem(reading({ level: 0, muted: true, headphones: true }))).toBe('off');
    });

    it('is "low" at the bottom steps of the speaker, and not just above them', () => {
        expect(volumeProblem(reading({ level: LOW_VOLUME }))).toBe('low');
        expect(volumeProblem(reading({ level: 1 / 15 }))).toBe('low');
        expect(volumeProblem(reading({ level: 2 / 16 }))).toBeNull();
        // Android's call stream, one step above its lowest of nine.
        expect(volumeProblem(reading({ level: 1 / 8 }))).toBeNull();
    });

    it('leaves a low setting alone in headphones', () => {
        expect(volumeProblem(reading({ level: 0.05, headphones: true }))).toBeNull();
        // Android's call stream at its lowest step: quiet, not muted.
        expect(volumeProblem(reading({ level: 0, headphones: true }))).toBeNull();
    });
});

describe('mountVolumeNotice', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('shows "off" and takes it down once the volume comes up', async () => {
        const el = banner();
        let now = reading({ level: 0, muted: true });
        const stop = mountVolumeNotice(el, { read: async () => now });
        await vi.advanceTimersByTimeAsync(0);
        expect(el.hidden).toBe(false);
        expect(el.textContent).toBe('The volume is off.');

        now = reading();
        await vi.advanceTimersByTimeAsync(2000);
        expect(el.hidden).toBe(true);
        expect(el.textContent).toBe('');
        stop();
    });

    it('judges "very low" once the mic has opened, on the stream it settles', async () => {
        const el = banner();
        let opened!: () => void;
        const micOpen = new Promise<void>((resolve) => (opened = resolve));
        // Low before the mic opens: not yet the stream the session plays on.
        let now = reading({ level: 0.05 });
        const stop = mountVolumeNotice(el, { read: async () => now, micOpen });
        await vi.advanceTimersByTimeAsync(5000);
        expect(el.hidden).toBe(true);

        // Android's call stream at its lowest step.
        now = reading({ level: 0 });
        opened();
        await vi.advanceTimersByTimeAsync(LOW_JUDGED_AFTER_MS - 1);
        expect(el.hidden).toBe(true);
        await vi.advanceTimersByTimeAsync(1);
        expect(el.textContent).toBe('The volume is very low.');
        stop();
    });

    it('says nothing of a volume turned down once the session has loaded', async () => {
        const el = banner();
        let now = reading();
        const stop = mountVolumeNotice(el, { read: async () => now });
        await vi.advanceTimersByTimeAsync(LOW_JUDGED_AFTER_MS);
        now = reading({ level: 0 });
        await vi.advanceTimersByTimeAsync(WATCH_MS);
        expect(el.hidden).toBe(true);
        stop();
    });

    it('shows "low" for ten seconds and not again, while "off" can still follow', async () => {
        const el = banner();
        let now = reading({ level: 0.05 });
        const stop = mountVolumeNotice(el, { read: async () => now });
        await vi.advanceTimersByTimeAsync(LOW_JUDGED_AFTER_MS + LOW_SHOWN_MS - 500);
        expect(el.textContent).toBe('The volume is very low.');
        await vi.advanceTimersByTimeAsync(600);
        expect(el.hidden).toBe(true);
        await vi.advanceTimersByTimeAsync(6000);
        expect(el.hidden).toBe(true);

        now = reading({ level: 0, muted: true });
        await vi.advanceTimersByTimeAsync(2000);
        expect(el.textContent).toBe('The volume is off.');
        stop();
    });

    it('takes "low" down once the volume comes up', async () => {
        const el = banner();
        let now = reading({ level: 0.05 });
        const stop = mountVolumeNotice(el, { read: async () => now });
        await vi.advanceTimersByTimeAsync(LOW_JUDGED_AFTER_MS);
        expect(el.textContent).toBe('The volume is very low.');
        now = reading();
        await vi.advanceTimersByTimeAsync(2000);
        expect(el.hidden).toBe(true);
        stop();
    });

    it('keeps "off" up past the watch, drops "low" well before its end, and then stops looking', async () => {
        const off = banner();
        const stopOff = mountVolumeNotice(off, { read: async () => reading({ level: 0, muted: true }) });
        const low = banner();
        const readLow = vi.fn(async () => reading({ level: 0.1 }));
        mountVolumeNotice(low, { read: readLow });
        await vi.advanceTimersByTimeAsync(WATCH_MS + 4000);
        expect(off.hidden).toBe(false);
        expect(low.hidden).toBe(true);

        const looks = readLow.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(readLow.mock.calls.length).toBe(looks);
        stopOff();
    });

    it('says nothing while the session is not speaking', async () => {
        const el = banner();
        const stop = mountVolumeNotice(el, {
            read: async () => reading({ level: 0, muted: true }),
            wanted: () => false,
        });
        await vi.advanceTimersByTimeAsync(4000);
        expect(el.hidden).toBe(true);
        stop();
    });

    it('looks once and gives up where the volume cannot be read', async () => {
        const el = banner();
        const read = vi.fn(async () => null);
        mountVolumeNotice(el, { read });
        await vi.advanceTimersByTimeAsync(WATCH_MS);
        expect(read).toHaveBeenCalledTimes(1);
        expect(el.hidden).toBe(true);
    });

    it('stops when the session ends', async () => {
        const el = banner();
        const read = vi.fn(async () => reading({ level: 0, muted: true }));
        const stop = mountVolumeNotice(el, { read });
        await vi.advanceTimersByTimeAsync(0);
        stop();
        const looks = read.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(read.mock.calls.length).toBe(looks);
    });
});

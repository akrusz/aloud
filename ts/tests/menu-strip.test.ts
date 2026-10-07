import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    HIDE_DELAY_MS,
    MenuStripReveal,
    OFF_PAGE_POLL_MS,
    OffPagePointer,
    REVEAL_BAND_PX,
    REVEAL_DWELL_MS,
} from '../ui/src/menu-strip.js';

const STRIP_H = 30;

function setup() {
    const changes: boolean[] = [];
    const reveal = new MenuStripReveal(
        (open) => changes.push(open),
        () => STRIP_H
    );
    /** Rest in the band until the strip opens. */
    const open = () => {
        reveal.pointerAt(REVEAL_BAND_PX);
        vi.advanceTimersByTime(REVEAL_DWELL_MS);
    };
    return { changes, reveal, open };
}

beforeEach(() => {
    vi.useFakeTimers();
});
afterEach(() => {
    vi.useRealTimers();
});

describe('menu strip reveal', () => {
    it('opens once the pointer has rested in the top band', () => {
        const { changes, reveal } = setup();
        reveal.pointerAt(REVEAL_BAND_PX);
        vi.advanceTimersByTime(REVEAL_DWELL_MS - 1);
        expect(changes).toEqual([]);
        vi.advanceTimersByTime(1);
        expect(changes).toEqual([true]);
    });

    it('counts the title bar, above the page, as near', () => {
        const { changes, reveal } = setup();
        reveal.pointerAt(-20);
        vi.advanceTimersByTime(REVEAL_DWELL_MS);
        expect(changes).toEqual([true]);
    });

    it('stays shut when the pointer only passes through', () => {
        const { changes, reveal } = setup();
        reveal.pointerAt(REVEAL_BAND_PX);
        vi.advanceTimersByTime(REVEAL_DWELL_MS - 1);
        reveal.pointerLeft();
        vi.advanceTimersByTime(REVEAL_DWELL_MS * 10);
        expect(changes).toEqual([]);
    });

    it('ignores the pointer anywhere below the band while shut', () => {
        const { changes, reveal } = setup();
        reveal.pointerAt(REVEAL_BAND_PX + 1);
        vi.advanceTimersByTime(REVEAL_DWELL_MS * 10);
        expect(changes).toEqual([]);
    });

    it('holds open across the whole strip, then closes after the pointer leaves', () => {
        const { changes, reveal, open } = setup();
        open();
        reveal.pointerAt(STRIP_H); // on a label, well below the reveal band
        vi.advanceTimersByTime(HIDE_DELAY_MS * 10);
        expect(changes).toEqual([true]);

        reveal.pointerAt(STRIP_H + 100);
        vi.advanceTimersByTime(HIDE_DELAY_MS - 1);
        expect(changes).toEqual([true]);
        vi.advanceTimersByTime(1);
        expect(changes).toEqual([true, false]);
    });

    it('forgives a wobble off the strip and back', () => {
        const { changes, reveal, open } = setup();
        open();
        reveal.pointerAt(STRIP_H + 100);
        vi.advanceTimersByTime(HIDE_DELAY_MS - 1);
        reveal.pointerAt(STRIP_H);
        vi.advanceTimersByTime(HIDE_DELAY_MS * 10);
        expect(changes).toEqual([true]);
    });

    it('closes when the pointer leaves the page', () => {
        const { changes, reveal, open } = setup();
        open();
        reveal.pointerLeft();
        vi.advanceTimersByTime(HIDE_DELAY_MS);
        expect(changes).toEqual([true, false]);
    });

    it('needs the band again to reopen, not just the strip area', () => {
        const { changes, reveal, open } = setup();
        open();
        reveal.pointerLeft();
        vi.advanceTimersByTime(HIDE_DELAY_MS);
        reveal.pointerAt(STRIP_H); // where the strip was
        vi.advanceTimersByTime(REVEAL_DWELL_MS * 10);
        expect(changes).toEqual([true, false]);
    });

    it('stays open under a dropdown, wherever the pointer goes', () => {
        const { changes, reveal, open } = setup();
        open();
        reveal.hold();
        reveal.pointerLeft(); // the native popup takes the mouse
        vi.advanceTimersByTime(HIDE_DELAY_MS * 10);
        expect(changes).toEqual([true]);

        reveal.release();
        vi.advanceTimersByTime(HIDE_DELAY_MS);
        expect(changes).toEqual([true, false]);
    });

    it('stays open after a dropdown closes with the pointer still on the strip', () => {
        const { changes, reveal, open } = setup();
        open();
        reveal.pointerAt(STRIP_H);
        reveal.hold();
        reveal.release();
        vi.advanceTimersByTime(HIDE_DELAY_MS * 10);
        expect(changes).toEqual([true]);
    });

    it('drops a pending close when a dropdown opens', () => {
        const { changes, reveal, open } = setup();
        open();
        reveal.pointerAt(STRIP_H + 100);
        vi.advanceTimersByTime(HIDE_DELAY_MS - 1);
        reveal.hold();
        vi.advanceTimersByTime(HIDE_DELAY_MS * 10);
        expect(changes).toEqual([true]);
    });
});

describe('pointer off the page', () => {
    /** A probe answered by hand, and a record of what reached the reveal. */
    function setupOffPage() {
        const calls: (number | 'left')[] = [];
        const pending: {
            resolve: (y: number | null) => void;
            reject: (e: unknown) => void;
        }[] = [];
        const offPage = new OffPagePointer(
            () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
            { pointerAt: (y) => calls.push(y), pointerLeft: () => calls.push('left') }
        );
        const answer = async (y: number | null) => {
            pending.shift()!.resolve(y);
            await vi.advanceTimersByTimeAsync(0);
        };
        return { calls, pending, offPage, answer };
    }

    it('keeps asking while the pointer is on the title bar', async () => {
        const { calls, pending, offPage, answer } = setupOffPage();
        offPage.locate();
        await answer(-20);
        expect(calls).toEqual([-20]);
        expect(pending).toHaveLength(0);

        await vi.advanceTimersByTimeAsync(OFF_PAGE_POLL_MS);
        await answer(-5);
        expect(calls).toEqual([-20, -5]);

        await vi.advanceTimersByTimeAsync(OFF_PAGE_POLL_MS);
        await answer(null); // off the window
        expect(calls).toEqual([-20, -5, 'left']);
        await vi.advanceTimersByTimeAsync(OFF_PAGE_POLL_MS * 10);
        expect(pending).toHaveLength(0);
    });

    it('reports a pointer over the page once, then leaves it to mouse events', async () => {
        const { calls, pending, offPage, answer } = setupOffPage();
        offPage.locate();
        await answer(240);
        await vi.advanceTimersByTimeAsync(OFF_PAGE_POLL_MS * 10);
        expect(calls).toEqual([240]);
        expect(pending).toHaveLength(0);
    });

    it('drops an answer that lands after the page has the pointer back', async () => {
        const { calls, pending, offPage, answer } = setupOffPage();
        offPage.locate();
        offPage.heard();
        await answer(-20);
        await vi.advanceTimersByTimeAsync(OFF_PAGE_POLL_MS * 10);
        expect(calls).toEqual([]);
        expect(pending).toHaveLength(0);
    });

    it('stops asking once the page has the pointer back', async () => {
        const { calls, pending, offPage, answer } = setupOffPage();
        offPage.locate();
        await answer(-20);
        offPage.heard();
        await vi.advanceTimersByTimeAsync(OFF_PAGE_POLL_MS * 10);
        expect(calls).toEqual([-20]);
        expect(pending).toHaveLength(0);
    });

    it('treats a failed probe as gone', async () => {
        const { calls, pending, offPage } = setupOffPage();
        offPage.locate();
        pending.shift()!.reject(new Error('ipc'));
        await vi.advanceTimersByTimeAsync(0);
        expect(calls).toEqual(['left']);
    });

    it('runs one probe at a time however often it is asked', async () => {
        const { pending, offPage, answer } = setupOffPage();
        offPage.locate();
        offPage.locate();
        offPage.locate();
        expect(pending).toHaveLength(1);
        await answer(-20);
        offPage.locate();
        await vi.advanceTimersByTimeAsync(OFF_PAGE_POLL_MS);
        expect(pending).toHaveLength(1);
    });
});

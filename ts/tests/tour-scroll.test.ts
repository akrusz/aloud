/**
 * The setup guide's `?` panels on a phone (ui/src/tour/tour-scroll.ts): shut
 * for a tour read aloud, open for one that is not, and a panel that runs the
 * section past the docked card shown by a slow scroll that gives way to the
 * person at once.
 */

import { describe, expect, it } from 'vitest';
import {
    opensPanel,
    readAlong,
    readAlongOffset,
    readAlongOverflow,
    readAlongPxPerSecond,
    READ_ALONG_BEAT_MS,
    READ_ALONG_WPM,
    wordCount,
    type ReadAlongPage,
    type ReadAlongPlan,
} from '../ui/src/tour/tour-scroll.js';

describe('opensPanel', () => {
    it('opens every panel at a desk, read aloud or not', () => {
        expect(opensPanel({ phone: false, readAloud: true })).toBe(true);
        expect(opensPanel({ phone: false, readAloud: false })).toBe(true);
    });
    it('on a phone, opens one only for a tour not read aloud, whose cards have no other words', () => {
        expect(opensPanel({ phone: true, readAloud: true })).toBe(false);
        expect(opensPanel({ phone: true, readAloud: false })).toBe(true);
    });
});

describe('the pace', () => {
    it('reads the panel at READ_ALONG_WPM, whatever its font and width', () => {
        // 90 words laid out 300px tall: 0.3 words a px.
        expect(readAlongPxPerSecond(90, 300)).toBeCloseTo(READ_ALONG_WPM / 60 / 0.3);
        // The same text twice as tall (bigger type) moves twice as fast.
        expect(readAlongPxPerSecond(90, 600)).toBeCloseTo(2 * readAlongPxPerSecond(90, 300));
    });
    it('stays within bounds for text that measures oddly', () => {
        expect(readAlongPxPerSecond(0, 300)).toBeGreaterThan(0);
        expect(readAlongPxPerSecond(1, 5_000)).toBeLessThanOrEqual(40);
    });
    it('counts two Chinese characters as a word', () => {
        expect(wordCount('Felt sense follows a six step process.')).toBe(7);
        expect(wordCount('体会分六步')).toBe(2.5);
    });
});

const plan: ReadAlongPlan = {
    readFrom: 200,
    visibleTop: 100,
    visibleBottom: 500,
    contentBottom: 800,
    pxPerSecond: 10,
};

describe('readAlongOffset', () => {
    it('holds still until the reading line is half way down the room, then moves with it', () => {
        // Reading starts at 200, the middle is 300: 10 s at 10 px/s.
        expect(readAlongOffset(plan, 0)).toBe(0);
        expect(readAlongOffset(plan, 9_000)).toBe(0);
        expect(readAlongOffset(plan, 15_000)).toBeCloseTo(50);
    });
    it('stops once the section\'s foot clears the card', () => {
        expect(readAlongOverflow(plan)).toBe(300);
        expect(readAlongOffset(plan, 600_000)).toBe(300);
    });
});

/** A page whose frames run only when the test moves time on. */
function fakePage(opts: { reducedMotion?: boolean; maxScroll?: number } = {}) {
    let now = 0;
    let y = 0;
    let frames: Array<(now: number) => void> = [];
    let person: (() => void) | null = null;
    const scrolls: number[] = [];
    const page: ReadAlongPage = {
        scrollY: () => y,
        scrollTo: (to) => {
            y = Math.min(to, opts.maxScroll ?? Infinity);
            scrolls.push(y);
        },
        frame: (step) => {
            frames.push(step);
            return () => (frames = frames.filter((f) => f !== step));
        },
        now: () => now,
        onPerson: (stop) => {
            person = stop;
            return () => (person = null);
        },
        reducedMotion: () => opts.reducedMotion ?? false,
    };
    return {
        page,
        scrolls,
        y: () => y,
        listening: () => person !== null,
        /** Move time on by `ms`, a frame every 16 ms. */
        run(ms: number): void {
            for (const end = now + ms; now < end; ) {
                now += 16;
                const due = frames;
                frames = [];
                for (const step of due) step(now);
            }
        },
        touch: () => person?.(),
        fling: (to: number) => (y = to),
    };
}

describe('readAlong', () => {
    it('waits out the beat, then scrolls the section into view and stops', () => {
        const fake = fakePage();
        readAlong(fake.page, () => plan);
        fake.run(READ_ALONG_BEAT_MS - 100);
        expect(fake.scrolls).toEqual([]);
        fake.run(10_000);
        expect(fake.scrolls).toEqual([]);
        fake.run(60_000);
        expect(fake.y()).toBe(300);
        expect(fake.listening()).toBe(false);
    });

    it('stops for good at a touch, and says it was the person', () => {
        const fake = fakePage();
        let byPerson = false;
        readAlong(fake.page, () => plan, () => (byPerson = true));
        fake.run(READ_ALONG_BEAT_MS + 15_000);
        const reached = fake.y();
        expect(reached).toBeGreaterThan(0);
        fake.touch();
        fake.run(60_000);
        expect(fake.y()).toBe(reached);
        expect(byPerson).toBe(true);
        expect(fake.listening()).toBe(false);
    });

    it('stops when the page is scrolled by anything else', () => {
        const fake = fakePage();
        let byPerson = false;
        readAlong(fake.page, () => plan, () => (byPerson = true));
        fake.run(READ_ALONG_BEAT_MS + 15_000);
        fake.fling(1_000);
        fake.run(60_000);
        expect(fake.y()).toBe(1_000);
        expect(byPerson).toBe(true);
    });

    it('takes a touch during the beat too', () => {
        const fake = fakePage();
        readAlong(fake.page, () => plan);
        fake.run(500);
        fake.touch();
        fake.run(60_000);
        expect(fake.scrolls).toEqual([]);
    });

    it('never moves under reduced motion', () => {
        const fake = fakePage({ reducedMotion: true });
        readAlong(fake.page, () => plan);
        fake.run(120_000);
        expect(fake.scrolls).toEqual([]);
        expect(fake.listening()).toBe(false);
    });

    it('does nothing where the section already clears the card, or the card is gone', () => {
        for (const measure of [() => ({ ...plan, contentBottom: 480 }), () => null]) {
            const fake = fakePage();
            readAlong(fake.page, measure);
            fake.run(120_000);
            expect(fake.scrolls).toEqual([]);
            expect(fake.listening()).toBe(false);
        }
    });

    it('stops where the page can go no further', () => {
        const fake = fakePage({ maxScroll: 120 });
        readAlong(fake.page, () => plan);
        fake.run(120_000);
        expect(fake.y()).toBe(120);
        expect(fake.listening()).toBe(false);
    });

    it('stops when the card changes', () => {
        const fake = fakePage();
        const run = readAlong(fake.page, () => plan);
        fake.run(READ_ALONG_BEAT_MS + 15_000);
        const reached = fake.y();
        run.stop();
        fake.run(60_000);
        expect(fake.y()).toBe(reached);
    });
});

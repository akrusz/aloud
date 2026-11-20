/**
 * The setup guide's `?` panels on a phone (tour/index-guide.ts showSection).
 *
 * Read aloud, a section's card says what its panel says, and the open panel
 * only pushed the section's controls off the screen, so it stays shut. Not
 * read aloud (voice mode off, or the card's speaker switched off), the panel
 * is the only text the card has: it opens, and where the section then runs
 * past the card docked at the foot of the screen, the page scrolls down by
 * itself at reading pace until all of it has been shown (`readAlong`).
 */

/** Whether a section step opens its `?` panel. Settled as each card goes up:
 *  a card muted or unmuted after that keeps the layout it was shown with. */
export function opensPanel(o: { phone: boolean; readAloud: boolean }): boolean {
    return !o.phone || !o.readAloud;
}

/** The pace the page scrolls at, in words a minute of the panel's own text:
 *  under the 200 to 250 of most adults reading silently, since this is small
 *  text on a phone, often in a second language, and a reader who is ahead
 *  can scroll on themselves. */
export const READ_ALONG_WPM = 180;
/** Before anything moves: time to see the card and find the panel's start. */
export const READ_ALONG_BEAT_MS = 1500;
/** Bounds on the pace in px/s, for a panel whose text measures oddly. */
const MIN_PX_PER_S = 5;
const MAX_PX_PER_S = 40;
/** A scroll of the page this far from where the read-along last put it was
 *  the person's, not ours. */
const THEIRS_PX = 2;

/** Words in a panel's text, two Chinese characters counting as one (zh has
 *  no spaces to count), so a zh panel reads at about 360 characters a
 *  minute. */
export function wordCount(text: string): number {
    const cjk = (text.match(/[㐀-鿿]/gu) ?? []).length;
    const latin = text.replace(/[㐀-鿿]/gu, ' ').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
    return latin + cjk / 2;
}

/** The pace in px/s for a panel of `words` words laid out `heightPx` tall. */
export function readAlongPxPerSecond(words: number, heightPx: number): number {
    if (!(words > 0) || !(heightPx > 0)) return MIN_PX_PER_S;
    const wordsPerPx = words / heightPx;
    return Math.min(MAX_PX_PER_S, Math.max(MIN_PX_PER_S, READ_ALONG_WPM / 60 / wordsPerPx));
}

/**
 * The geometry of one card, in viewport px as it went up. `readFrom` is where
 * the panel's text starts, `visibleTop` and `visibleBottom` the room between
 * the nav and the docked card, `contentBottom` the section's foot.
 */
export interface ReadAlongPlan {
    readFrom: number;
    visibleTop: number;
    visibleBottom: number;
    contentBottom: number;
    pxPerSecond: number;
}

/** How far the page needs to go for the section's foot to clear the card:
 *  0 when it already does. */
export function readAlongOverflow(plan: ReadAlongPlan): number {
    return Math.max(0, plan.contentBottom - plan.visibleBottom);
}

/**
 * How far the page has scrolled `readingMs` after the beat. The reader is
 * taken to start at `readFrom` then and read on at the pace; the page holds
 * still until that reading line is half way down the room, then moves with
 * it, so it stays mid-screen with room either side for a reader a little
 * faster or slower, and stops once the foot is in view.
 */
export function readAlongOffset(plan: ReadAlongPlan, readingMs: number): number {
    const overflow = readAlongOverflow(plan);
    const reading = plan.readFrom + (plan.pxPerSecond * Math.max(0, readingMs)) / 1000;
    const middle = plan.visibleTop + (plan.visibleBottom - plan.visibleTop) / 2;
    return Math.min(overflow, Math.max(0, reading - middle));
}

/** What the read-along needs of the page: the window, behind seams the
 *  tests stand in for. */
export interface ReadAlongPage {
    scrollY(): number;
    scrollTo(y: number): void;
    /** Request the next frame; returns a cancel. */
    frame(step: (now: number) => void): () => void;
    now(): number;
    /** Call `stop` on anything the person does to the page; returns a
     *  detach. */
    onPerson(stop: () => void): () => void;
    reducedMotion(): boolean;
}

/**
 * After the beat, measure the card (`measure`, null for nothing to do) and
 * scroll the page by that plan until the section's foot is in view, the
 * person touches or scrolls the page, or `stop()` is called (the card
 * changed). Measured after the beat, not before: the tour's own smooth
 * scroll to the section may still be running when the card goes up, and
 * would read as the person's. Nothing at all under reduced motion, or where
 * nothing runs past the card. `onPersonStopped` hears that it was the person.
 */
export function readAlong(
    page: ReadAlongPage,
    measure: () => ReadAlongPlan | null,
    onPersonStopped: () => void = () => undefined
): { stop(): void } {
    if (page.reducedMotion()) return { stop: () => undefined };
    const shownAt = page.now();
    let plan: ReadAlongPlan | null = null;
    let startY = 0;
    let readingFrom = 0;
    let lastSet = 0;
    let cancelFrame: (() => void) | null = null;
    let over = false;
    const stop = (): void => {
        if (over) return;
        over = true;
        cancelFrame?.();
        detach();
    };
    const byPerson = (): void => {
        if (over) return;
        stop();
        onPersonStopped();
    };
    const detach = page.onPerson(byPerson);
    const step = (now: number): void => {
        if (over) return;
        if (!plan) {
            if (now - shownAt < READ_ALONG_BEAT_MS) {
                cancelFrame = page.frame(step);
                return;
            }
            plan = measure();
            if (!plan || readAlongOverflow(plan) <= 0) return stop();
            startY = lastSet = page.scrollY();
            readingFrom = now;
        }
        // Moved by something other than this: a fling, a scrollbar drag.
        if (Math.abs(page.scrollY() - lastSet) > THEIRS_PX) return byPerson();
        const offset = readAlongOffset(plan, now - readingFrom);
        const y = Math.round(startY + offset);
        if (y !== lastSet) {
            page.scrollTo(y);
            // A page that can't scroll that far stops where it can.
            lastSet = page.scrollY();
            if (Math.abs(lastSet - y) > 1) return stop();
        }
        if (offset >= readAlongOverflow(plan)) return stop();
        cancelFrame = page.frame(step);
    };
    cancelFrame = page.frame(step);
    return { stop };
}

/** The real page. */
export function windowPage(): ReadAlongPage {
    return {
        scrollY: () => window.scrollY,
        scrollTo: (y) => window.scrollTo({ top: y, behavior: 'instant' }),
        frame: (step) => {
            const id = requestAnimationFrame(step);
            return () => cancelAnimationFrame(id);
        },
        now: () => performance.now(),
        onPerson: (stop) => {
            const types = ['touchstart', 'pointerdown', 'wheel', 'keydown'] as const;
            for (const type of types) window.addEventListener(type, stop, { capture: true, passive: true });
            return () => {
                for (const type of types) window.removeEventListener(type, stop, { capture: true });
            };
        },
        reducedMotion: () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
    };
}

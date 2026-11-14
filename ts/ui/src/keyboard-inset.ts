/**
 * Keep the Begin and Save bars reachable while the on-screen keyboard is up.
 *
 * A phone browser, and iOS's web view, lay the keyboard over the foot of the
 * page without resizing it, so the fixed .setup-footer / .settings-footer sat
 * under the keys: with an intention typed there was no Begin on screen, and
 * nothing to say the keyboard had to go first. While a text field has focus and
 * a keyboard is up, <body> carries `keyboard-up` and <html> `--keyboard-inset`
 * (the px the keys cover); app-base.css lifts the bars by it and drops the
 * bottom nav, which the keys cover anyway. The field is then scrolled clear of
 * the lifted bar, and of the top bar.
 *
 * Real keyboards only show on a device: nothing in CI or a desktop browser
 * exercises this past keyboardInset()'s arithmetic (dev-docs/manual-smoke.md).
 */

/** Shorter than any keyboard, taller than a browser toolbar sliding away. */
const MIN_KEYBOARD_PX = 80;

/** Breathing room between the field being typed in and the lifted bar. */
const FIELD_GAP_PX = 8;

/** As the keys come up, the web view runs its own animated scroll to the field
 *  (some 200ms on Android), knowing nothing of the bars: it left a field under
 *  the top bar. So the field is placed again once the page has been still for
 *  SETTLE_QUIET_MS, for SETTLE_WINDOW_MS after the keyboard; scrolling after
 *  that is the user's and is left alone. */
const SETTLE_QUIET_MS = 150;
const SETTLE_WINDOW_MS = 1000;

export interface ViewportReading {
    /** window.innerHeight: the layout viewport, which fixed bars hang from. */
    innerHeight: number;
    /** innerHeight as it was before this field took focus. */
    restingHeight: number;
    /** visualViewport: the part of the layout viewport that actually shows. */
    visualHeight: number;
    visualTop: number;
    scale: number;
}

/**
 * How many px of the layout viewport's foot the keyboard covers, or null when
 * no keyboard is up.
 *
 * Two shapes. Laid over the page (iOS, Chrome on Android), the visual viewport
 * ends short of the layout viewport and the difference is the keyboard. Where
 * the window itself is resized instead (an Android web view), nothing is
 * covered - 0 - but the window is shorter than it was at rest, and the nav
 * still has no business taking a row above the keys.
 *
 * The resized window is read first. As its keyboard opens, the Android web
 * view reports one frame with the window already short AND the visual viewport
 * short of it by the keyboard again (488 and 184 of a resting 792, OnePlus 13):
 * read as covered, that frame threw the bar a keyboard's height up the page
 * and the field was scrolled above it, under the top bar.
 */
export function keyboardInset(v: ViewportReading): number | null {
    // Pinch zoom shrinks the visual viewport just the same.
    if (Math.abs(v.scale - 1) > 0.01) return null;
    if (v.restingHeight - v.innerHeight >= MIN_KEYBOARD_PX) return 0;
    const covered = Math.round(v.innerHeight - v.visualHeight - v.visualTop);
    if (covered >= MIN_KEYBOARD_PX) return covered;
    return null;
}

const NOT_TYPED_IN = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image']);

function typedIn(el: Element | null): el is HTMLElement {
    return (
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement && !NOT_TYPED_IN.has(el.type)) ||
        (el instanceof HTMLElement && el.isContentEditable)
    );
}

export function initKeyboardInset(win: Window = window): void {
    const vv = win.visualViewport;
    if (!vv) return;
    const doc = win.document;
    // A resized window only means a keyboard where there is no other way to
    // resize one: on a desktop it is the user dragging it, or devtools.
    const touch = win.matchMedia('(pointer: coarse)').matches;
    let restingHeight = win.innerHeight;
    let restingWidth = win.innerWidth;
    /** The field already scrolled clear, so a later viewport scroll (the user
     *  looking around with the keys up) isn't fought back to it. */
    let settled: Element | null = null;
    let settleUntil = 0;
    let settleTimer: number | undefined;

    const shown = (selector: string): HTMLElement | undefined =>
        Array.from(doc.querySelectorAll<HTMLElement>(selector)).find((el) => el.getClientRects().length > 0);

    /** Scroll the field into the gap between the top bar (the wordmark and
     *  orb float over the page on a phone) and the lifted bar. Where it can't
     *  have both, the foot wins: that is the line being typed. */
    const clearBar = (field: HTMLElement): void => {
        const bar = shown('.setup-footer, .settings-footer');
        if (!bar) return;
        const rect = field.getBoundingClientRect();
        const under = rect.bottom + FIELD_GAP_PX - bar.getBoundingClientRect().top;
        if (under > 0) return void win.scrollBy(0, under);
        const top = shown('.nav')?.getBoundingClientRect();
        // A bar across the top, not the column the nav becomes on a phone on
        // its side.
        if (!top || top.top > 0 || top.bottom > win.innerHeight / 2) return;
        const over = top.bottom + FIELD_GAP_PX - rect.top;
        if (over > 0) win.scrollBy(0, -Math.min(over, -under));
    };

    const settleWhenStill = (): void => {
        if (!settled || Date.now() > settleUntil) return;
        win.clearTimeout(settleTimer);
        settleTimer = win.setTimeout(() => {
            if (settled && settled === doc.activeElement && typedIn(settled)) clearBar(settled);
        }, SETTLE_QUIET_MS);
    };

    const update = (): void => {
        const field = doc.activeElement;
        const typing = typedIn(field);
        // The resting height is whatever the window was with no field in use;
        // a turned phone starts over.
        if (!typing || win.innerWidth !== restingWidth || win.innerHeight > restingHeight) {
            restingHeight = win.innerHeight;
            restingWidth = win.innerWidth;
        }
        const inset = typing
            ? keyboardInset({
                  innerHeight: win.innerHeight,
                  restingHeight: touch ? restingHeight : win.innerHeight,
                  visualHeight: vv.height,
                  visualTop: vv.offsetTop,
                  scale: vv.scale,
              })
            : null;
        doc.body.classList.toggle('keyboard-up', inset !== null);
        doc.documentElement.style.setProperty('--keyboard-inset', `${inset ?? 0}px`);
        if (inset === null || !typing) {
            settled = null;
        } else if (settled !== field) {
            settled = field;
            clearBar(field);
            settleUntil = Date.now() + SETTLE_WINDOW_MS;
        }
        settleWhenStill();
    };

    vv.addEventListener('resize', update);
    // iOS scrolls the visual viewport, not the page, while the keys are up.
    vv.addEventListener('scroll', update);
    win.addEventListener('resize', update);
    win.addEventListener('scroll', settleWhenStill, { passive: true });
    doc.addEventListener('focusin', update);
    // Focus moving between two fields passes through <body>: read where it lands.
    doc.addEventListener('focusout', () => win.setTimeout(update, 0));
    // A box that grows as it fills (the intention) can grow under the bar.
    doc.addEventListener('input', (e) => {
        if (settled && e.target === settled && typedIn(settled)) clearBar(settled);
    });
}

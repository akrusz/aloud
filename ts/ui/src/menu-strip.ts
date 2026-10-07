/**
 * Windows desktop: the app menu (File / Edit / Window / Help) as a strip that
 * slides over the top of the page while the pointer is near the top of the
 * window: over the native title bar, or just under it.
 *
 * It's drawn in the page, not attached as the window's own menu bar. Showing
 * and hiding the native bar resizes the client area: the page would jump by
 * the bar's height on every reveal, and tauri-plugin-window-state (which
 * persists the INNER size) would save a shorter window whenever the app closed
 * with the bar up. The dropdowns are still the stock native menus, opened as
 * popups under their label.
 *
 * Windows only. macOS has the system menu bar (src-tauri lib.rs). On Linux the
 * popup call returns before the menu closes, and holding the strip open under
 * a dropdown relies on it resolving at dismissal.
 */

import { isTauri, isWindows } from './is-desktop.js';
import { openBugReport } from './bug-report.js';

/** Pointer this far down the page still asks for the strip (anywhere above the
 *  page, on the title bar, does too). Kept inside the nav's own top padding, so
 *  the band never sits on a nav control. */
export const REVEAL_BAND_PX = 12;
/** ...and has to rest there this long, so a pass through on the way somewhere
 *  else doesn't flash the strip. */
export const REVEAL_DWELL_MS = 250;
export const HIDE_DELAY_MS = 300;
/** Slack under the open strip before leaving it counts as leaving. */
const KEEP_SLACK_PX = 12;
/** How often to ask where the pointer is while it's over the title bar. */
export const OFF_PAGE_POLL_MS = 100;

/** Matches tauri's HELP_SUBMENU_ID (menu/menu.rs). */
const HELP_SUBMENU_ID = '__tauri_help_menu__';

/**
 * When the strip is open, from where the pointer is and whether a dropdown is
 * up. No DOM: the caller feeds pointer positions (y in page px, negative above
 * the page) and gets `onChange(open)`.
 */
export class MenuStripReveal {
    private open = false;
    private near = false;
    private held = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly onChange: (open: boolean) => void,
        private readonly stripHeight: () => number
    ) {}

    pointerAt(y: number): void {
        const reach = this.open ? this.stripHeight() + KEEP_SLACK_PX : REVEAL_BAND_PX;
        const near = y <= reach;
        if (near === this.near) return;
        this.near = near;
        this.settle();
    }

    pointerLeft(): void {
        this.pointerAt(Infinity);
    }

    /** A dropdown is opening: stay put until `release`, wherever the pointer
     *  goes (it's over the dropdown, and the page hears nothing meanwhile). */
    hold(): void {
        this.held = true;
        this.settle();
    }

    release(): void {
        this.held = false;
        this.settle();
    }

    private settle(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        if (this.held || this.near === this.open) return;
        const open = this.near;
        this.timer = setTimeout(
            () => {
                this.timer = null;
                this.open = open;
                this.onChange(open);
            },
            open ? REVEAL_DWELL_MS : HIDE_DELAY_MS
        );
    }
}

/**
 * The pointer, while the page can't hear it. The title bar is above the page,
 * where no mouse event reaches, and a native dropdown swallows them too. So
 * when the page loses the pointer, ask the OS where it is, and keep asking for
 * as long as it's on the title bar.
 *
 * `probe` resolves the pointer's y in page px (negative on the title bar), or
 * null once it's off the window.
 */
export class OffPagePointer {
    private lost = false;
    private following = false;

    constructor(
        private readonly probe: () => Promise<number | null>,
        private readonly reveal: Pick<MenuStripReveal, 'pointerAt' | 'pointerLeft'>
    ) {}

    /** A mouse event arrived: the page has the pointer again. */
    heard(): void {
        this.lost = false;
    }

    locate(): void {
        this.lost = true;
        if (!this.following) void this.follow();
    }

    private async follow(): Promise<void> {
        this.following = true;
        while (this.lost) {
            const y = await this.probe().catch(() => null);
            // Back on the page mid-probe: its events are newer than this answer.
            if (!this.lost) break;
            if (y === null) {
                this.reveal.pointerLeft();
                break;
            }
            this.reveal.pointerAt(y);
            // Over the page, the next move is an event; only the title bar
            // needs watching.
            if (y >= 0) break;
            await new Promise((resolve) => setTimeout(resolve, OFF_PAGE_POLL_MS));
        }
        this.following = false;
    }
}

export function initMenuStrip(): void {
    if (!isTauri() || !isWindows()) return;
    void mount().catch(() => {
        /* the menu is a nicety; everything in it is reachable elsewhere */
    });
}

async function mount(): Promise<void> {
    const [{ Menu, MenuItem, Submenu }, { LogicalPosition }, { cursorPosition, getCurrentWindow }] =
        await Promise.all([
            import('@tauri-apps/api/menu'),
            import('@tauri-apps/api/dpi'),
            import('@tauri-apps/api/window'),
        ]);
    const menu = await Menu.default();
    const help = await menu.get(HELP_SUBMENU_ID);
    if (help instanceof Submenu) {
        // Same entry the macOS menu carries (src-tauri lib.rs). Built with
        // MenuItem.new: append() given bare options drops the action.
        const report = await MenuItem.new({
            text: 'Report a Bug…',
            action: () => void openBugReport(),
        });
        await help.append(report);
    }

    const strip = document.createElement('div');
    strip.className = 'menu-strip';
    strip.setAttribute('role', 'menubar');
    const reveal = new MenuStripReveal(
        (open) => strip.classList.toggle('is-open', open),
        () => strip.offsetHeight
    );
    const win = getCurrentWindow();
    const offPage = new OffPagePointer(async () => {
        // All in screen px: the window's frame, where its page starts, the pointer.
        const [pointer, frame, frameSize, page, scale] = await Promise.all([
            cursorPosition(),
            win.outerPosition(),
            win.outerSize(),
            win.innerPosition(),
            win.scaleFactor(),
        ]);
        const onWindow =
            pointer.x >= frame.x &&
            pointer.x < frame.x + frameSize.width &&
            pointer.y >= frame.y &&
            pointer.y < frame.y + frameSize.height;
        return onWindow ? (pointer.y - page.y) / scale : null;
    }, reveal);

    for (const item of await menu.items()) {
        if (!(item instanceof Submenu)) continue;
        const button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'menuitem');
        button.setAttribute('aria-haspopup', 'menu');
        button.textContent = await item.text();
        button.addEventListener('click', () => {
            const rect = button.getBoundingClientRect();
            reveal.hold();
            button.classList.add('is-active');
            void item
                .popup(new LogicalPosition(rect.left, rect.bottom))
                .catch(() => {
                    /* nothing to show; fall through to release */
                })
                .finally(() => {
                    button.classList.remove('is-active');
                    reveal.release();
                    // Wherever the pointer ended up, the page may not have heard.
                    offPage.locate();
                });
        });
        strip.append(button);
    }
    document.body.append(strip);

    document.addEventListener(
        'mousemove',
        (e) => {
            offPage.heard();
            // A press in progress is a text selection or a window drag passing
            // through the band, not a reach for the menu.
            if (e.buttons === 0) reveal.pointerAt(e.clientY);
        },
        { passive: true }
    );
    document.documentElement.addEventListener('mouseleave', () => offPage.locate());
}

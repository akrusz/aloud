/**
 * Tauri desktop window chrome: make the whole top bar drag the window while
 * keeping its links/buttons clickable.
 *
 * `data-tauri-drag-region` can't do this — an element with the attribute
 * starts dragging on mousedown, which swallows clicks. Instead we watch for a
 * mousedown on the nav and only start dragging once the pointer actually moves
 * past a small threshold. A plain click (no movement) falls through to the
 * link/button underneath, so navigation, the About logo, the theme toggle, and
 * the in-session orb/hamburger all still work — and you can grab the bar
 * anywhere (including over those controls) to move the window.
 *
 * No-op outside Tauri.
 */

import { isTauri } from './is-desktop.js';

const DRAG_THRESHOLD_PX = 4;

export function initTauriWindowDrag(): void {
    if (!isTauri()) return;
    const nav = document.querySelector<HTMLElement>('nav.nav');
    if (!nav) return;

    // Load the window handle once; calls are guarded by isTauri() above.
    let appWindow: { startDragging: () => Promise<unknown> } | null = null;
    void import('@tauri-apps/api/window')
        .then((m) => {
            appWindow = m.getCurrentWindow();
        })
        .catch(() => {
            /* drag is a nicety; ignore load failures */
        });

    // When a drag happens, the native drag consumes the gesture but WebKit
    // still synthesizes a `click` on release — which would e.g. open the About
    // modal when you drag the window by the logo. Swallow that one click.
    let dragged = false;
    document.addEventListener(
        'click',
        (e) => {
            if (dragged) {
                e.stopImmediatePropagation();
                e.preventDefault();
                dragged = false;
            }
        },
        true // capture, so we run before the link/button's own handler
    );

    nav.addEventListener('mousedown', (e: MouseEvent) => {
        // Fresh interaction — clear any stale suppression so a real click works.
        dragged = false;
        if (e.button !== 0 || !appWindow) return; // primary button only
        const startX = e.clientX;
        const startY = e.clientY;

        const onMove = (m: MouseEvent): void => {
            if (
                Math.abs(m.clientX - startX) + Math.abs(m.clientY - startY) <=
                DRAG_THRESHOLD_PX
            ) {
                return; // still a click, not a drag
            }
            cleanup();
            dragged = true; // suppress the click that fires on release
            // OS takes over the drag loop here; our move/up listeners won't
            // fire again, so remove them first.
            void appWindow?.startDragging();
        };
        const cleanup = (): void => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', cleanup);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', cleanup);
    });
}

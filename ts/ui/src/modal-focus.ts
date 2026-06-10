/**
 * Shared modal focus management for the overlay dialogs (sign-in, buy-credits,
 * gift). On open: move focus into the dialog (the first meaningful control,
 * preferring something other than the close button). While open: trap Tab so
 * keyboard focus cycles inside the dialog instead of escaping into the dimmed
 * page behind it. On close (the returned release fn): restore focus to
 * whatever had it before the modal opened, so a keyboard user lands back where
 * they were. Escape handling stays with each modal (they already wire it).
 */

const FOCUSABLE =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function focusables(overlay: HTMLElement): HTMLElement[] {
    return Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) =>
            !el.hasAttribute('disabled') &&
            // Skip hidden controls (e.g. the gift-email field before "Gift to
            // someone" is picked) — getClientRects is empty under display:none.
            el.getClientRects().length > 0
    );
}

/**
 * Activate focus management for a modal overlay. Call after the overlay is in
 * the DOM; call the returned function when the modal closes.
 */
export function manageModalFocus(overlay: HTMLElement): () => void {
    const previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Initial focus: the first control that isn't the close button, so a
    // keyboard user starts on the dialog's actual content (close still
    // reachable by Shift+Tab). Fall back to whatever is first.
    const initial = focusables(overlay);
    (initial.find((el) => !el.classList.contains('voice-modal-close')) ?? initial[0])?.focus();

    const onKeydown = (e: KeyboardEvent): void => {
        if (e.key !== 'Tab') return;
        const els = focusables(overlay);
        if (els.length === 0) return;
        const first = els[0]!;
        const last = els[els.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey) {
            if (active === first || !(active instanceof Node) || !overlay.contains(active)) {
                e.preventDefault();
                last.focus();
            }
        } else if (active === last || !(active instanceof Node) || !overlay.contains(active)) {
            e.preventDefault();
            first.focus();
        }
    };
    overlay.addEventListener('keydown', onKeydown);

    return () => {
        overlay.removeEventListener('keydown', onKeydown);
        previouslyFocused?.focus();
    };
}

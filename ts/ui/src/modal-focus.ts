/**
 * Focus management for the overlay dialogs (sign-in, buy-credits, gift): focus
 * the first meaningful control on open, trap Tab inside the dialog, and restore
 * the previously focused element via the returned release fn. Escape handling
 * stays with each modal.
 */

const FOCUSABLE =
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function focusables(overlay: HTMLElement): HTMLElement[] {
    return Array.from(overlay.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) =>
            !el.hasAttribute('disabled') &&
            // Skip hidden controls (e.g. the gift-email field before "Gift to
            // someone" is picked): getClientRects is empty under display:none.
            el.getClientRects().length > 0
    );
}

/** Call after the overlay is in the DOM; call the returned fn on close. */
export function manageModalFocus(overlay: HTMLElement): () => void {
    const previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Prefer the first control that isn't the close button, so a keyboard user
    // starts on the dialog's content; close stays reachable by Shift+Tab.
    // Text fields are last resort: auto-focusing one pops the keyboard on
    // touch screens, burying the controls most users actually want (e.g. the
    // sign-in modal's Google/Apple buttons above the email field).
    const isTextEntry = (el: HTMLElement): boolean =>
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLInputElement &&
            !['button', 'submit', 'reset', 'checkbox', 'radio', 'range'].includes(el.type));
    const initial = focusables(overlay);
    const nonClose = initial.filter((el) => !el.classList.contains('voice-modal-close'));
    (nonClose.find((el) => !isTextEntry(el)) ?? nonClose[0] ?? initial[0])?.focus();

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

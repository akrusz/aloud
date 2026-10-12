/**
 * Dismiss-on-backdrop for the app's modals: `onDismiss` runs for a click on the
 * backdrop itself, not on the dialog inside it.
 *
 * The press has to start on the backdrop too. A drag that begins inside the
 * dialog (selecting the text in a field) and lets go outside it fires `click`
 * on the two elements' common ancestor, which is the backdrop, and used to
 * close the dialog under the user's hand.
 *
 * Returns a remover, for modals that stay in the DOM between openings.
 */
export function onBackdropClick(backdrop: EventTarget, onDismiss: () => void): () => void {
    let pressedInside = false;
    const onDown = (e: Event): void => {
        pressedInside = e.target !== backdrop;
    };
    const onClick = (e: Event): void => {
        const inside = pressedInside;
        pressedInside = false;
        if (e.target === backdrop && !inside) onDismiss();
    };
    backdrop.addEventListener('pointerdown', onDown);
    backdrop.addEventListener('click', onClick);
    return () => {
        backdrop.removeEventListener('pointerdown', onDown);
        backdrop.removeEventListener('click', onClick);
    };
}

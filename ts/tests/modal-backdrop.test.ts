/**
 * A modal's backdrop dismisses on a click that both starts and ends on it. The
 * app's modals all used a bare `click` check, so selecting the text in a field
 * and letting go outside the dialog closed it.
 */
import { describe, it, expect, vi } from 'vitest';
import { onBackdropClick } from '../ui/src/modal-backdrop.js';

/** An event as the backdrop's listeners see it: bubbled up from `target`. */
function fire(backdrop: EventTarget, type: string, target: object): void {
    const event = new Event(type);
    Object.defineProperty(event, 'target', { value: target });
    backdrop.dispatchEvent(event);
}

describe('onBackdropClick', () => {
    const field = {};

    it('dismisses on a press and release on the backdrop', () => {
        const backdrop = new EventTarget();
        const dismiss = vi.fn();
        onBackdropClick(backdrop, dismiss);
        fire(backdrop, 'pointerdown', backdrop);
        fire(backdrop, 'click', backdrop);
        expect(dismiss).toHaveBeenCalledTimes(1);
    });

    it('ignores a drag that starts inside the dialog and ends on the backdrop', () => {
        const backdrop = new EventTarget();
        const dismiss = vi.fn();
        onBackdropClick(backdrop, dismiss);
        fire(backdrop, 'pointerdown', field);
        fire(backdrop, 'click', backdrop); // the browser's common-ancestor click
        expect(dismiss).not.toHaveBeenCalled();
        // ...and the next real backdrop click still works.
        fire(backdrop, 'pointerdown', backdrop);
        fire(backdrop, 'click', backdrop);
        expect(dismiss).toHaveBeenCalledTimes(1);
    });

    it('ignores clicks inside the dialog', () => {
        const backdrop = new EventTarget();
        const dismiss = vi.fn();
        onBackdropClick(backdrop, dismiss);
        fire(backdrop, 'pointerdown', field);
        fire(backdrop, 'click', field);
        expect(dismiss).not.toHaveBeenCalled();
    });

    it('still dismisses on a click with no press before it (a scripted .click())', () => {
        const backdrop = new EventTarget();
        const dismiss = vi.fn();
        onBackdropClick(backdrop, dismiss);
        fire(backdrop, 'click', backdrop);
        expect(dismiss).toHaveBeenCalledTimes(1);
    });

    it('stops listening once removed', () => {
        const backdrop = new EventTarget();
        const dismiss = vi.fn();
        onBackdropClick(backdrop, dismiss)();
        fire(backdrop, 'click', backdrop);
        expect(dismiss).not.toHaveBeenCalled();
    });
});

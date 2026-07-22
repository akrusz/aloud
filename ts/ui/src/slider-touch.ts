/**
 * Keep page scrolling from changing sliders (mobile).
 *
 * A touch landing on an <input type="range"> jumps the value to the touch
 * point immediately, so starting a vertical page scroll on a slider edits the
 * setting as a side effect. With `touch-action: pan-y` on range inputs (see
 * app-base.css) the browser claims vertical swipes for scrolling and fires
 * `pointercancel` on the input - this module remembers each slider's value at
 * touch-down and restores it on that cancel, undoing the jump. Taps and
 * horizontal drags never cancel, so they keep working natively.
 *
 * One delegated listener pair covers every range input in the app (setup
 * sliders, settings, voice picker) with no per-site wiring.
 */

let touched: HTMLInputElement | null = null;
let valueAtTouch = '';

const asRange = (target: EventTarget | null): HTMLInputElement | null => {
    const el = target as HTMLElement | null;
    return el instanceof HTMLInputElement && el.type === 'range' ? el : null;
};

export function initSliderTouchGuard(doc: Document = document): void {
    // Capture phase: record before the input's own handlers see the event.
    doc.addEventListener(
        'pointerdown',
        (e) => {
            if (e.pointerType !== 'touch') return;
            const input = asRange(e.target);
            if (!input) return;
            touched = input;
            // Read before the browser's default action moves the thumb.
            valueAtTouch = input.value;
        },
        true
    );
    doc.addEventListener(
        'pointercancel',
        (e) => {
            const input = asRange(e.target);
            if (!input || input !== touched) return;
            touched = null;
            if (input.value !== valueAtTouch) {
                input.value = valueAtTouch;
                // Re-fire the events the jump fired so bound labels/state revert.
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
        },
        true
    );
    doc.addEventListener('pointerup', () => (touched = null), true);
}

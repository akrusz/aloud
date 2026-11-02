/**
 * Keep the Begin and Save bars above the on-screen keyboard (mobile).
 *
 * A phone's browser (and iOS's web view) puts the keyboard over the bottom of
 * the layout viewport without resizing it, so the fixed .setup-footer and
 * .settings-footer sat under the keys while you typed: you couldn't start a sit
 * from the intention box without first putting the keyboard away. The visual
 * viewport does shrink to what shows; the gap below it is the keyboard. While a
 * text field has focus this sets `keyboard-up` on <body> and the gap as
 * --keyboard-inset, which app-base.css lifts the bars by (and hides the bottom
 * nav for), then scrolls the field above the lifted bar.
 *
 * Where the window itself resizes for the keyboard (Android's web view), the
 * gap is 0 and nothing changes. Pinch zoom also shrinks the visual viewport, so
 * only at scale 1; under 80px is a browser toolbar sliding, not a keyboard.
 */

const NOT_TEXT = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden']);

const isTextField = (el: Element | null): el is HTMLElement =>
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLInputElement && !NOT_TEXT.has(el.type)) ||
    (el instanceof HTMLElement && el.isContentEditable);

export function initKeyboardInset(win: Window = window): void {
    const vv = win.visualViewport;
    if (!vv) return;
    const doc = win.document;
    const update = (): void => {
        const field = doc.activeElement;
        const gap = isTextField(field) && Math.abs(vv.scale - 1) < 0.01
            ? Math.round(win.innerHeight - vv.height - vv.offsetTop) : 0;
        const up = gap >= 80;
        doc.body.classList.toggle('keyboard-up', up);
        doc.documentElement.style.setProperty('--keyboard-inset', up ? `${gap}px` : '0px');
        if (!up || !isTextField(field)) return;
        // The field the browser scrolled above the keys may now be under the bar.
        const bar = doc.querySelector<HTMLElement>('.setup-footer, .settings-footer');
        const limit = vv.offsetTop + vv.height - (bar?.offsetHeight ?? 0) - 8;
        const bottom = field.getBoundingClientRect().bottom;
        if (bottom > limit) win.scrollBy(0, bottom - limit);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);   // (iOS moves the visual viewport, not the page, as you scroll with the keys up)
    doc.addEventListener('focusin', update);
    // (focus moving between two fields passes through body: wait for where it lands)
    doc.addEventListener('focusout', () => win.setTimeout(update, 0));
}

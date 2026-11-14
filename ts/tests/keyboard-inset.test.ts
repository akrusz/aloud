/**
 * The Begin and Save bars above the on-screen keyboard. A real keyboard only
 * exists on a device, so what is pinned here is the reading of the viewport
 * (what counts as a keyboard, and how much it covers) and the two things that
 * are easy to get wrong around it: the bar must not move for a pinch zoom or a
 * desktop window being dragged, and the field is scrolled clear of the bar
 * once, not every time the user scrolls with the keys up.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initKeyboardInset, keyboardInset } from '../ui/src/keyboard-inset.js';

const reading = { innerHeight: 800, restingHeight: 800, visualHeight: 800, visualTop: 0, scale: 1 };

describe('keyboardInset', () => {
    it('is null with nothing over the page', () => {
        expect(keyboardInset(reading)).toBeNull();
    });

    it('is the px a keyboard laid over the page covers', () => {
        expect(keyboardInset({ ...reading, visualHeight: 460 })).toBe(340);
    });

    it('counts from where the visual viewport has scrolled to', () => {
        // iOS slides the visual viewport down the page to show the field.
        expect(keyboardInset({ ...reading, visualHeight: 460, visualTop: 340 })).toBeNull();
        expect(keyboardInset({ ...reading, visualHeight: 460, visualTop: 100 })).toBe(240);
    });

    it('ignores a browser toolbar sliding away', () => {
        expect(keyboardInset({ ...reading, visualHeight: 744 })).toBeNull();
    });

    it('ignores pinch zoom, which shrinks the visual viewport too', () => {
        expect(keyboardInset({ ...reading, visualHeight: 400, scale: 2 })).toBeNull();
    });

    it('is 0 where the window itself was resized for the keyboard', () => {
        expect(keyboardInset({ ...reading, innerHeight: 460, visualHeight: 460 })).toBe(0);
    });

    it('is 0 for a resized window whose visual viewport reads short for a frame', () => {
        // The Android web view, as the keyboard opens (measured on a OnePlus 13).
        expect(keyboardInset({ ...reading, restingHeight: 792, innerHeight: 488, visualHeight: 184 })).toBe(0);
    });
});

describe('initKeyboardInset', () => {
    class FakeElement {
        isContentEditable = false;
        rect = { top: 0, bottom: 0 };
        getBoundingClientRect(): { top: number; bottom: number } {
            return this.rect;
        }
        getClientRects(): unknown[] {
            return [this.rect];
        }
    }
    class FakeTextArea extends FakeElement {}
    class FakeInput extends FakeElement {
        type = 'text';
    }

    function harness(touch: boolean) {
        const listeners = new Map<string, Array<(e: unknown) => void>>();
        const on = (prefix: string) => (name: string, fn: (e: unknown) => void) => {
            const key = `${prefix}:${name}`;
            listeners.set(key, [...(listeners.get(key) ?? []), fn]);
        };
        const fire = (key: string, e: unknown = {}): void => {
            for (const fn of listeners.get(key) ?? []) fn(e);
        };
        const classes = new Set<string>();
        const props = new Map<string, string>();
        let pending: (() => void) | null = null;
        const bar = new FakeElement();
        const nav = new FakeElement();
        const doc = {
            activeElement: null as FakeElement | null,
            body: {
                classList: {
                    toggle: (name: string, onOff: boolean) => (onOff ? classes.add(name) : classes.delete(name)),
                },
            },
            documentElement: { style: { setProperty: (k: string, v: string) => props.set(k, v) } },
            querySelectorAll: (selector: string) => (selector === '.nav' ? [nav] : [bar]),
            addEventListener: on('doc'),
        };
        const vv = { height: 800, offsetTop: 0, scale: 1, addEventListener: on('vv') };
        const win = {
            innerHeight: 800,
            innerWidth: 390,
            visualViewport: vv,
            document: doc,
            matchMedia: () => ({ matches: touch }),
            scrollBy: vi.fn(),
            // A 0ms timeout runs at once; a real wait is held until still().
            setTimeout: (fn: () => void, ms = 0) => {
                if (ms === 0) return void fn();
                pending = fn;
                return 1;
            },
            clearTimeout: () => {
                pending = null;
            },
            addEventListener: on('win'),
        };
        /** The page has been still long enough for the second placing. */
        const still = (): void => {
            const fn = pending;
            pending = null;
            fn?.();
        };
        initKeyboardInset(win as unknown as Window);
        return { win, vv, doc, bar, nav, fire, still, classes, props };
    }

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.stubGlobal('HTMLElement', FakeElement);
        vi.stubGlobal('HTMLTextAreaElement', FakeTextArea);
        vi.stubGlobal('HTMLInputElement', FakeInput);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('lifts the bar by the keyboard while a text field has focus, and lets go on blur', () => {
        const h = harness(true);
        h.doc.activeElement = new FakeTextArea();
        h.fire('doc:focusin');
        expect(h.classes.has('keyboard-up')).toBe(false);

        h.vv.height = 460;
        h.fire('vv:resize');
        expect(h.classes.has('keyboard-up')).toBe(true);
        expect(h.props.get('--keyboard-inset')).toBe('340px');

        h.doc.activeElement = null;
        h.fire('doc:focusout');
        expect(h.classes.has('keyboard-up')).toBe(false);
        expect(h.props.get('--keyboard-inset')).toBe('0px');
    });

    it('does nothing for a control that brings up no keyboard', () => {
        const h = harness(true);
        const slider = new FakeInput();
        slider.type = 'range';
        h.doc.activeElement = slider;
        h.vv.height = 460;
        h.fire('vv:resize');
        expect(h.classes.has('keyboard-up')).toBe(false);
    });

    it('reads a shrunken window as a keyboard on a touchscreen only', () => {
        for (const touch of [true, false]) {
            const h = harness(touch);
            h.doc.activeElement = new FakeTextArea();
            h.fire('doc:focusin');
            h.win.innerHeight = 460;
            h.vv.height = 460;
            h.fire('win:resize');
            expect(h.classes.has('keyboard-up')).toBe(touch);
            expect(h.props.get('--keyboard-inset')).toBe('0px');
        }
    });

    it('scrolls the field clear of the lifted bar once, not on every scroll', () => {
        const h = harness(true);
        const field = new FakeTextArea();
        field.rect = { top: 380, bottom: 440 };
        h.bar.rect = { top: 410, bottom: 460 };
        h.doc.activeElement = field;
        h.fire('doc:focusin');
        h.vv.height = 460;
        h.fire('vv:resize');
        expect(h.win.scrollBy).toHaveBeenCalledTimes(1);
        expect(h.win.scrollBy).toHaveBeenCalledWith(0, 38);

        // The user scrolls to read something else with the keys still up.
        h.fire('vv:scroll');
        h.fire('vv:scroll');
        expect(h.win.scrollBy).toHaveBeenCalledTimes(1);

        // The box grew under the bar as it filled.
        field.rect = { top: 380, bottom: 420 };
        h.fire('doc:input', { target: field });
        expect(h.win.scrollBy).toHaveBeenCalledTimes(2);
    });

    it('brings a field out from under the top bar, as far as the lifted bar allows', () => {
        const h = harness(true);
        h.nav.rect = { top: 0, bottom: 94 };
        h.bar.rect = { top: 410, bottom: 460 };
        const field = new FakeTextArea();
        field.rect = { top: 33, bottom: 120 };
        h.doc.activeElement = field;
        h.fire('doc:focusin');
        h.vv.height = 460;
        h.fire('vv:resize');
        expect(h.win.scrollBy).toHaveBeenLastCalledWith(0, -69);

        // Taller than the gap: only as far as its foot stays above the bar.
        const tall = new FakeTextArea();
        tall.rect = { top: 33, bottom: 390 };
        h.doc.activeElement = tall;
        h.fire('doc:focusin');
        expect(h.win.scrollBy).toHaveBeenLastCalledWith(0, -12);
    });

    it("places the field again once the web view's own scroll has finished", () => {
        const h = harness(true);
        h.nav.rect = { top: 0, bottom: 94 };
        h.bar.rect = { top: 432, bottom: 488 };
        const field = new FakeTextArea();
        field.rect = { top: 400, bottom: 485 };
        h.doc.activeElement = field;
        h.fire('doc:focusin');
        h.win.innerHeight = 488;
        h.vv.height = 488;
        h.fire('win:resize');
        expect(h.win.scrollBy).toHaveBeenLastCalledWith(0, 61);

        // The web view then animates the field to where it likes: under the top bar.
        field.rect = { top: 49, bottom: 135 };
        h.fire('win:scroll');
        expect(h.win.scrollBy).toHaveBeenCalledTimes(1);
        h.still();
        expect(h.win.scrollBy).toHaveBeenCalledTimes(2);
        expect(h.win.scrollBy).toHaveBeenLastCalledWith(0, -53);

        // Past the window, a scroll is the user's.
        vi.setSystemTime(Date.now() + 5000);
        h.fire('win:scroll');
        h.still();
        expect(h.win.scrollBy).toHaveBeenCalledTimes(2);
    });

    it('does not let one odd frame of a resized window throw the bar up the page', () => {
        const h = harness(true);
        h.win.innerHeight = 792;
        h.vv.height = 792;
        const field = new FakeTextArea();
        field.rect = { top: 195, bottom: 282 };
        h.bar.rect = { top: 432, bottom: 488 };
        h.doc.activeElement = field;
        h.fire('doc:focusin');
        h.win.innerHeight = 488;
        h.vv.height = 184;
        h.fire('vv:resize');
        expect(h.props.get('--keyboard-inset')).toBe('0px');
        expect(h.win.scrollBy).not.toHaveBeenCalled();
    });
});

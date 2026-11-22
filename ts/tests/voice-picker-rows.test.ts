/**
 * The voice and sound pickers' rows by keyboard and screen reader
 * (meditation-pal-dvy4): each row's label is a real button, so Tab reaches it
 * and Enter or Space presses it, with aria-pressed on the current choice;
 * Preview is its own button beside the label, never inside it.
 *
 * Node has no DOM, so a small stand-in below carries what the row code
 * touches. What a browser itself does (Enter and Space press a focused
 * button, Tab skips a disabled one) is taken as given here; it was driven for
 * real in Chrome when this landed.
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
    createPickerRow,
    renderVoiceList,
    setPickerRowSelected,
    updateVoiceSelection,
    type ScoredVoice,
} from '../ui/src/voice-picker.js';
import { setUiLang } from '../ui/src/i18n.js';

// ---- A DOM stand-in: elements, simple selectors, bubbling clicks, focus ----

type Listener = (e: FakeEvent) => void;
interface FakeEvent {
    type: string;
    target: FakeEl;
    defaultPrevented: boolean;
    preventDefault(): void;
}

/** `tag.a.b`, `:not(:disabled)`, `:not(.x)`, `:focus-visible`, one per compound. */
function matchesCompound(el: FakeEl, compound: string): boolean {
    let rest = compound;
    const nots: string[] = [];
    rest = rest.replace(/:not\(([^)]*)\)/g, (_, inner: string) => {
        nots.push(inner);
        return '';
    });
    if (rest.includes(':focus-visible')) {
        if (!el.focusVisible || doc.activeElement !== el) return false;
        rest = rest.replace(':focus-visible', '');
    }
    if (rest.includes(':disabled')) {
        if (!el.disabled) return false;
        rest = rest.replace(':disabled', '');
    }
    const [tag, ...classes] = rest.split('.');
    if (tag && tag.toLowerCase() !== el.tagName.toLowerCase()) return false;
    if (!classes.every((c) => el.classList.contains(c))) return false;
    return nots.every((n) => !matchesCompound(el, n));
}

function matchesSelector(el: FakeEl, selector: string): boolean {
    const parts = selector.trim().split(/\s+/);
    if (!matchesCompound(el, parts[parts.length - 1]!)) return false;
    let at: FakeEl | null = el.parentNode;
    for (let i = parts.length - 2; i >= 0; i--) {
        while (at && !matchesCompound(at, parts[i]!)) at = at.parentNode;
        if (!at) return false;
        at = at.parentNode;
    }
    return true;
}

class FakeEl {
    parentNode: FakeEl | null = null;
    children: FakeEl[] = [];
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    listeners = new Map<string, Listener[]>();
    onclick: Listener | null = null;
    type = '';
    title = '';
    disabled = false;
    /** Whether focus here was reached from the keyboard (:focus-visible). */
    focusVisible = false;
    private text = '';
    private classes = new Set<string>();
    readonly classList = {
        add: (...c: string[]) => c.forEach((x) => this.classes.add(x)),
        remove: (...c: string[]) => c.forEach((x) => this.classes.delete(x)),
        contains: (c: string) => this.classes.has(c),
        toggle: (c: string, force?: boolean) => {
            const on = force ?? !this.classes.has(c);
            if (on) this.classes.add(c);
            else this.classes.delete(c);
            return on;
        },
    };

    constructor(readonly tagName: string) {}

    get className(): string {
        return [...this.classes].join(' ');
    }
    set className(v: string) {
        this.classes = new Set(v.split(/\s+/).filter(Boolean));
    }
    get textContent(): string {
        return this.text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v: string) {
        this.replaceChildren();
        this.text = v;
    }
    set innerHTML(v: string) {
        this.textContent = v.replace(/<[^>]*>/g, '');
    }
    get nextSibling(): FakeEl | null {
        const sibs = this.parentNode?.children ?? [];
        return sibs[sibs.indexOf(this) + 1] ?? null;
    }
    get previousElementSibling(): FakeEl | null {
        const sibs = this.parentNode?.children ?? [];
        return sibs[sibs.indexOf(this) - 1] ?? null;
    }
    setAttribute(k: string, v: string): void {
        this.attributes.set(k, v);
    }
    getAttribute(k: string): string | null {
        return this.attributes.get(k) ?? null;
    }
    appendChild(c: FakeEl): FakeEl {
        c.remove();
        c.parentNode = this;
        this.children.push(c);
        return c;
    }
    prepend(c: FakeEl): void {
        c.remove();
        c.parentNode = this;
        this.children.unshift(c);
    }
    after(c: FakeEl): void {
        const p = this.parentNode!;
        c.remove();
        c.parentNode = p;
        p.children.splice(p.children.indexOf(this) + 1, 0, c);
    }
    remove(): void {
        if (!this.parentNode) return;
        const sibs = this.parentNode.children;
        sibs.splice(sibs.indexOf(this), 1);
        this.parentNode = null;
    }
    replaceChildren(...cs: FakeEl[]): void {
        for (const c of [...this.children]) c.remove();
        this.text = '';
        cs.forEach((c) => this.appendChild(c));
    }
    contains(other: FakeEl | null): boolean {
        for (let at = other; at; at = at.parentNode) if (at === this) return true;
        return false;
    }
    matches(sel: string): boolean {
        return sel.split(',').some((s) => matchesSelector(this, s));
    }
    closest(sel: string): FakeEl | null {
        for (let at: FakeEl | null = this; at; at = at.parentNode) if (at.matches(sel)) return at;
        return null;
    }
    querySelectorAll(sel: string): FakeEl[] {
        const out: FakeEl[] = [];
        const walk = (el: FakeEl): void => {
            for (const c of el.children) {
                if (c.matches(sel)) out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }
    querySelector(sel: string): FakeEl | null {
        return this.querySelectorAll(sel)[0] ?? null;
    }
    addEventListener(type: string, fn: Listener): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
    }
    /** A click as a press of the element delivers it: none on a disabled
     *  button, then bubbling up through its ancestors. */
    click(): void {
        if (this.disabled) return;
        const e: FakeEvent = {
            type: 'click',
            target: this,
            defaultPrevented: false,
            preventDefault() {
                this.defaultPrevented = true;
            },
        };
        for (let at: FakeEl | null = this; at; at = at.parentNode) {
            at.onclick?.(e);
            for (const fn of at.listeners.get('click') ?? []) fn(e);
        }
    }
    focus(): void {
        if (!this.disabled) doc.activeElement = this;
    }
}

const doc = {
    activeElement: null as FakeEl | null,
    createElement: (tag: string) => new FakeEl(tag.toUpperCase()),
};

beforeEach(() => {
    doc.activeElement = null;
    vi.stubGlobal('document', doc);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setUiLang('en');
});

// ---- Fixtures ----

const voice = (name: string, extra: Partial<ScoredVoice> = {}): ScoredVoice => ({
    name,
    lang: 'en-US',
    score: 4,
    engine: 'browser',
    ...extra,
});

/** Render into a fresh list; `as unknown as HTMLElement` is the stand-in. */
function render(voices: ScoredVoice[], selected: string | null, options = {}): FakeEl {
    const list = new FakeEl('DIV');
    renderVoiceList(list as unknown as HTMLElement, voices, selected, options);
    return list;
}
const rows = (list: FakeEl) => list.querySelectorAll('.voice-row');
const rowOf = (list: FakeEl, name: string) => rows(list).find((r) => r.dataset['voiceName'] === name)!;
const pressed = (list: FakeEl) =>
    rows(list)
        .filter((r) => r.querySelector('.voice-row-name')!.getAttribute('aria-pressed') === 'true')
        .map((r) => r.dataset['voiceName']);

/**
 * The list handler the three views share in shape (setup, settings, session):
 * a click on Preview previews; any other click on a row, label included,
 * chooses that voice.
 */
function wireLikeAView(list: FakeEl): { previewed: string[] } {
    const previewed: string[] = [];
    list.addEventListener('click', (e) => {
        const row = e.target.closest('.voice-row');
        const name = row?.dataset['voiceName'];
        if (!row || !name) return;
        if (e.target.closest('.voice-row-preview')) {
            previewed.push(name);
            return;
        }
        if (row.classList.contains('voice-row-locked')) return;
        updateVoiceSelection(list as unknown as HTMLElement, name);
    });
    return { previewed };
}

// ---- Tests ----

describe('createPickerRow (the voice and the sound pickers both)', () => {
    it('makes the label a button that says whether it is the current choice', () => {
        const { row, choose } = createPickerRow('Bowl', true) as unknown as { row: FakeEl; choose: FakeEl };
        expect(choose.tagName).toBe('BUTTON');
        expect(choose.type).toBe('button');
        expect(choose.textContent).toBe('Bowl');
        expect(choose.getAttribute('aria-pressed')).toBe('true');
        expect(row.classList.contains('selected')).toBe(true);
        // The ✓ sits beside the label, out of the accessibility tree: the
        // pressed state already says it.
        const check = row.querySelector('.voice-row-check')!;
        expect(check.previousElementSibling).toBe(choose);
        expect(check.getAttribute('aria-hidden')).toBe('true');
    });

    it('moves the choice on and off without doubling the ✓', () => {
        const { row } = createPickerRow('Bowl', false) as unknown as { row: FakeEl };
        const label = row.querySelector('.voice-row-name')!;
        expect(label.getAttribute('aria-pressed')).toBe('false');
        expect(row.querySelector('.voice-row-check')).toBeNull();
        setPickerRowSelected(row as unknown as HTMLElement, true);
        setPickerRowSelected(row as unknown as HTMLElement, true);
        expect(row.querySelectorAll('.voice-row-check')).toHaveLength(1);
        expect(label.getAttribute('aria-pressed')).toBe('true');
        setPickerRowSelected(row as unknown as HTMLElement, false);
        expect(row.querySelector('.voice-row-check')).toBeNull();
        expect(row.classList.contains('selected')).toBe(false);
        expect(label.getAttribute('aria-pressed')).toBe('false');
    });
});

describe('renderVoiceList rows by keyboard and screen reader', () => {
    const voices = [voice('Ava'), voice('Daniel'), voice('Karen')];

    it('gives every row a focusable label button, pressed only on the current voice', () => {
        const list = render(voices, 'Daniel', { showEngine: true });
        for (const row of rows(list)) {
            const label = row.children[0]!;
            expect(label.tagName).toBe('BUTTON');
            expect(label.classList.contains('voice-row-name')).toBe(true);
            expect(label.disabled).toBe(false);
            // Its text is what a screen reader names it by: the voice, then
            // the badges.
            expect(label.textContent.startsWith(row.dataset['voiceName']!)).toBe(true);
        }
        expect(pressed(list)).toEqual(['Daniel']);
        expect(rowOf(list, 'Daniel').querySelector('.voice-row-name')!.textContent).toBe('DanielBrowser');
    });

    it('keeps Preview a separate, named button beside the label, never inside it', () => {
        const list = render(voices, 'Daniel');
        for (const row of rows(list)) {
            const preview = row.querySelector('.voice-row-preview')!;
            const label = row.querySelector('.voice-row-name')!;
            expect(preview.tagName).toBe('BUTTON');
            expect(preview.parentNode).toBe(row);
            expect(label.contains(preview)).toBe(false);
            expect(preview.getAttribute('aria-label')).toBe(`Preview ${row.dataset['voiceName']}`);
        }
    });

    it('chooses a voice when its label is pressed (Enter or Space reach it as a click)', () => {
        const list = render(voices, 'Daniel');
        wireLikeAView(list);
        const karen = rowOf(list, 'Karen').querySelector('.voice-row-name')!;
        karen.focus();
        expect(doc.activeElement).toBe(karen);
        karen.click();
        expect(pressed(list)).toEqual(['Karen']);
        expect(rowOf(list, 'Daniel').querySelector('.voice-row-check')).toBeNull();
        const check = rowOf(list, 'Karen').querySelector('.voice-row-check')!;
        expect(check.previousElementSibling).toBe(karen);
    });

    it('previews without choosing when Preview is pressed', () => {
        const list = render(voices, 'Daniel');
        const view = wireLikeAView(list);
        const preview = rowOf(list, 'Ava').querySelector('.voice-row-preview')!;
        preview.focus();
        expect(doc.activeElement).toBe(preview);
        preview.click();
        expect(view.previewed).toEqual(['Ava']);
        expect(pressed(list)).toEqual(['Daniel']);
    });

    it('leaves a voice still to download out of the Tab order, its Download button next', () => {
        const piper = voice('Lessac', { engine: 'piper', needsDownload: true, sizeDisplay: '60 MB' });
        const list = render([voice('Ava'), piper], 'Ava', { showLockedPiper: true });
        const row = rowOf(list, 'Lessac');
        expect(row.querySelector('.voice-row-name')!.disabled).toBe(true);
        expect(row.querySelector('.voice-row-download')!.disabled).toBe(false);
        wireLikeAView(list);
        row.querySelector('.voice-row-name')!.click();
        expect(pressed(list)).toEqual(['Ava']);
    });

    it('puts a dimmed voice\'s warning on its label, where a screen reader reads it', () => {
        const list = render([voice('Ava'), voice('Tingting', { lang: 'zh-CN', langMismatch: true })], 'Ava');
        const row = rowOf(list, 'Tingting');
        expect(row.title).toBe('This voice may not speak the session language well');
        expect(row.querySelector('.voice-row-name')!.title).toBe(row.title);
    });
});

describe('the Show all voices toggle by keyboard', () => {
    // An en session list with one voice hidden as not speaking it.
    const voices = [voice('Ava'), voice('Tingting', { lang: 'zh-CN', langMismatch: true }), voice('Karen')];
    const toggleOf = (list: FakeEl) => list.querySelector('.voice-more-piper')!;

    it('moves focus to the first voice it reveals, then back to itself on Show fewer', () => {
        const list = render(voices, 'Ava', { hideIncompatible: true });
        expect(rows(list).map((r) => r.dataset['voiceName'])).toEqual(['Ava', 'Karen']);
        const toggle = toggleOf(list);
        toggle.focusVisible = true;
        toggle.focus();
        toggle.click();
        const shown = doc.activeElement!;
        expect(shown.closest('.voice-row')!.dataset['voiceName']).toBe('Tingting');
        expect(shown.classList.contains('voice-row-name')).toBe(true);

        const fewer = toggleOf(list);
        expect(fewer.textContent).toBe('Show fewer voices ▲');
        fewer.focus();
        fewer.click();
        expect(doc.activeElement).toBe(toggleOf(list));
        expect(toggleOf(list).textContent).toBe('Show all voices ▼');
    });

    it('leaves focus alone when the toggle did not have it (a tap in Safari)', () => {
        const list = render(voices, 'Ava', { hideIncompatible: true });
        const elsewhere = new FakeEl('BUTTON');
        elsewhere.focus();
        toggleOf(list).click();
        expect(rows(list)).toHaveLength(3);
        expect(doc.activeElement).toBe(elsewhere);
    });
});

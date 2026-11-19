/**
 * toast.ts showSavedTick: its default label is read each time the tick shows,
 * so it follows a language change made while the app runs.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { showSavedTick } from '../ui/src/toast.js';
import { setUiLang } from '../ui/src/i18n.js';

function fakeDom(): { shown: () => string } {
    let last: { textContent: string } | null = null;
    const createElement = () => {
        const node = {
            className: '',
            textContent: '',
            // Not connected, so every call builds a fresh element to read.
            isConnected: false,
            offsetHeight: 0,
            style: {} as Record<string, string>,
            classList: { add() {}, remove() {} },
            setAttribute() {},
            addEventListener() {},
            remove() {},
        };
        last = node;
        return node;
    };
    vi.stubGlobal('document', {
        documentElement: {},
        body: { appendChild() {} },
        createElement,
        querySelectorAll: () => [],
    });
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 800, setTimeout: () => 0 });
    return { shown: () => last?.textContent ?? '' };
}

afterEach(() => {
    vi.unstubAllGlobals();
    setUiLang('en');
});

describe('showSavedTick', () => {
    it('reads its default label at show time', () => {
        const dom = fakeDom();
        showSavedTick();
        expect(dom.shown()).toBe('Saved!');
        setUiLang('zh');
        showSavedTick();
        expect(dom.shown()).toBe('已保存！');
    });
});

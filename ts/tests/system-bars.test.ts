/**
 * initSystemBarsTheme(): in the native mobile app the status/navigation bar
 * icons follow `data-theme`, whoever wrote it, and never the other way round
 * (the plugin's Dark means light icons, for a dark background).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const H = vi.hoisted(() => ({ setStyle: vi.fn(async (_opts: { style: string }) => {}) }));
vi.mock('@capacitor/core', () => ({
    SystemBars: { setStyle: H.setStyle },
    SystemBarsStyle: { Dark: 'DARK', Light: 'LIGHT', Default: 'DEFAULT' },
}));

import { initSystemBarsTheme } from '../ui/src/system-bars.js';

interface Planted {
    setTheme(theme: string): void;
    observed: () => boolean;
}

function plant(native: boolean, theme: string): Planted {
    let current = theme;
    let onChange: (() => void) | null = null;
    const g = globalThis as unknown as Record<string, unknown>;
    g.window = {
        Capacitor: { isNativePlatform: () => native, getPlatform: () => (native ? 'android' : 'web') },
    };
    g.document = { documentElement: { getAttribute: () => current } };
    g.MutationObserver = class {
        constructor(cb: () => void) {
            onChange = cb;
        }
        observe(): void {}
    };
    return {
        setTheme(next) {
            current = next;
            onChange?.();
        },
        observed: () => onChange !== null,
    };
}

async function settled(): Promise<void> {
    await vi.dynamicImportSettled();
    await new Promise((r) => setTimeout(r, 0));
}

afterEach(() => {
    const g = globalThis as unknown as Record<string, unknown>;
    delete g.window;
    delete g.document;
    delete g.MutationObserver;
    H.setStyle.mockClear();
});

describe('initSystemBarsTheme (native mobile)', () => {
    it('styles the bars for the theme showing at boot', async () => {
        plant(true, 'dark');
        initSystemBarsTheme();
        await settled();
        expect(H.setStyle.mock.calls).toEqual([[{ style: 'DARK' }]]);
    });

    it('follows a later theme change, whoever made it', async () => {
        const page = plant(true, 'light');
        initSystemBarsTheme();
        await settled();
        page.setTheme('dark');
        await settled();
        page.setTheme('light');
        await settled();
        expect(H.setStyle.mock.calls.map(([o]) => o.style)).toEqual(['LIGHT', 'DARK', 'LIGHT']);
    });
});

describe('initSystemBarsTheme (plain browser)', () => {
    it('leaves the bars alone', async () => {
        const page = plant(false, 'dark');
        initSystemBarsTheme();
        await settled();
        expect(page.observed()).toBe(false);
        expect(H.setStyle).not.toHaveBeenCalled();
    });
});

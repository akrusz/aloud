/**
 * isCapacitor() / capacitorPlatform() — the native-mobile platform gate.
 *
 * Capacitor injects a `window.Capacitor` global with isNativePlatform() /
 * getPlatform(). In Node there's no window, so both must report "not native"
 * without throwing; we simulate the native app by planting the global.
 */
import { describe, it, expect, afterEach } from 'vitest';

import { isCapacitor, capacitorPlatform } from '../ui/src/is-desktop.js';

type Win = { Capacitor?: { isNativePlatform?: () => boolean; getPlatform?: () => string } };

function setWindow(cap: Win['Capacitor'] | 'no-window'): void {
    if (cap === 'no-window') {
        delete (globalThis as unknown as { window?: unknown }).window;
        return;
    }
    (globalThis as unknown as { window: Win }).window = { Capacitor: cap };
}

afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
});

describe('isCapacitor', () => {
    it('is false with no window (Node/tests)', () => {
        setWindow('no-window');
        expect(isCapacitor()).toBe(false);
    });

    it('is false in a plain browser (no Capacitor global)', () => {
        setWindow(undefined);
        expect(isCapacitor()).toBe(false);
    });

    it('is false under the Capacitor web shim (isNativePlatform → false)', () => {
        setWindow({ isNativePlatform: () => false, getPlatform: () => 'web' });
        expect(isCapacitor()).toBe(false);
    });

    it('is true inside the native app', () => {
        setWindow({ isNativePlatform: () => true, getPlatform: () => 'ios' });
        expect(isCapacitor()).toBe(true);
    });
});

describe('capacitorPlatform', () => {
    it('is web with no window', () => {
        setWindow('no-window');
        expect(capacitorPlatform()).toBe('web');
    });

    it('reports ios / android when native', () => {
        setWindow({ isNativePlatform: () => true, getPlatform: () => 'ios' });
        expect(capacitorPlatform()).toBe('ios');
        setWindow({ isNativePlatform: () => true, getPlatform: () => 'android' });
        expect(capacitorPlatform()).toBe('android');
    });

    it('falls back to web for an unknown platform string', () => {
        setWindow({ isNativePlatform: () => false, getPlatform: () => 'electron' });
        expect(capacitorPlatform()).toBe('web');
    });
});

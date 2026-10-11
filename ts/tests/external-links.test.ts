/**
 * openExternal() in the native mobile app: web links open in the in-app browser
 * tab, and a `mailto:` must not, since @capacitor/browser can't take one (on
 * Android it left its transparent activity over the app, swallowing taps).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

const H = vi.hoisted(() => ({ open: vi.fn(async (_opts: { url: string }) => {}) }));
vi.mock('@capacitor/browser', () => ({ Browser: { open: H.open } }));

import { openExternal } from '../ui/src/external-links.js';

function plantWindow(native: boolean): { href: string } {
    const location = { href: 'https://localhost/' };
    (globalThis as unknown as { window: unknown }).window = {
        Capacitor: { isNativePlatform: () => native, getPlatform: () => (native ? 'android' : 'web') },
        location,
    };
    return location;
}

afterEach(() => {
    delete (globalThis as unknown as { window?: unknown }).window;
    H.open.mockClear();
});

describe('openExternal (native mobile)', () => {
    it('opens a web link in the in-app browser tab', async () => {
        const location = plantWindow(true);
        expect(await openExternal('https://aloud.rest')).toBe(true);
        expect(H.open).toHaveBeenCalledWith({ url: 'https://aloud.rest' });
        expect(location.href).toBe('https://localhost/');
    });

    it('hands a mailto: to the webview, not the browser tab', async () => {
        const location = plantWindow(true);
        expect(await openExternal('mailto:someone@example.com?subject=aloud')).toBe(true);
        expect(H.open).not.toHaveBeenCalled();
        expect(location.href).toBe('mailto:someone@example.com?subject=aloud');
    });
});

describe('openExternal (plain browser)', () => {
    it('leaves the link to the caller', async () => {
        const location = plantWindow(false);
        expect(await openExternal('mailto:someone@example.com')).toBe(false);
        expect(H.open).not.toHaveBeenCalled();
        expect(location.href).toBe('https://localhost/');
    });
});

import { describe, it, expect, vi, afterEach } from 'vitest';
import { initMediaKeys } from '../ui/src/media-keys.js';

function stubMediaSession(setActionHandler: (action: string, handler: unknown) => void): void {
    vi.stubGlobal('navigator', { mediaSession: { setActionHandler } });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('initMediaKeys', () => {
    it('on desktop, takes play, pause and stop with handlers that do nothing', () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        const setActionHandler = vi.fn();
        stubMediaSession(setActionHandler);

        initMediaKeys();

        expect(setActionHandler.mock.calls.map(([action]) => action)).toEqual(['play', 'pause', 'stop']);
        for (const [, handler] of setActionHandler.mock.calls) {
            expect(() => (handler as () => void)()).not.toThrow();
        }
    });

    it('registers nothing outside the desktop shell', () => {
        vi.stubGlobal('window', {});
        const setActionHandler = vi.fn();
        stubMediaSession(setActionHandler);

        initMediaKeys();

        expect(setActionHandler).not.toHaveBeenCalled();
    });

    it('an action WebKit rejects does not stop the others', () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        const registered: string[] = [];
        stubMediaSession((action) => {
            if (action === 'pause') throw new TypeError('unsupported action');
            registered.push(action);
        });

        expect(() => initMediaKeys()).not.toThrow();
        expect(registered).toEqual(['play', 'stop']);
    });

    it('does nothing where there is no media session', () => {
        vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
        vi.stubGlobal('navigator', {});
        expect(() => initMediaKeys()).not.toThrow();
    });
});

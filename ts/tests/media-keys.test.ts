import { describe, it, expect, vi, afterEach } from 'vitest';
import { initMediaKeys } from '../ui/src/media-keys.js';

function stubMediaSession(setActionHandler: (action: string, handler: unknown) => void): void {
    vi.stubGlobal('navigator', { mediaSession: { setActionHandler } });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('initMediaKeys', () => {
    it('takes play, pause and stop with handlers that do nothing', () => {
        const setActionHandler = vi.fn();
        stubMediaSession(setActionHandler);

        initMediaKeys();

        expect(setActionHandler.mock.calls.map(([action]) => action)).toEqual(['play', 'pause', 'stop']);
        for (const [, handler] of setActionHandler.mock.calls) {
            expect(() => (handler as () => void)()).not.toThrow();
        }
    });

    it('registers on every platform, not only in the desktop shell', () => {
        vi.stubGlobal('window', {});
        const setActionHandler = vi.fn();
        stubMediaSession(setActionHandler);

        initMediaKeys();

        expect(setActionHandler).toHaveBeenCalledTimes(3);
    });

    it('an action the browser rejects does not stop the others', () => {
        const registered: string[] = [];
        stubMediaSession((action) => {
            if (action === 'pause') throw new TypeError('unsupported action');
            registered.push(action);
        });

        expect(() => initMediaKeys()).not.toThrow();
        expect(registered).toEqual(['play', 'stop']);
    });

    it('does nothing where there is no media session', () => {
        vi.stubGlobal('navigator', {});
        expect(() => initMediaKeys()).not.toThrow();
    });
});

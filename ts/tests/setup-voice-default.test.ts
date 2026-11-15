import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// The setup screen's mic starts on at a desk and off on a phone, and a stored
// choice beats both. app-settings.ts builds its storage at import, so it gets
// a backing store first (as setup-voice-inheritance.test.ts does).
let store: Map<string, string>;
let appSettings: typeof import('../ui/src/app-settings.js');
const asWindow = globalThis as unknown as { window?: unknown; Capacitor?: unknown };

beforeAll(async () => {
    store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: (i: number) => Array.from(store.keys())[i] ?? null,
        get length() {
            return store.size;
        },
    } as Storage;
    appSettings = await import('../ui/src/app-settings.js');
});

beforeEach(() => store.clear());
afterEach(() => {
    delete asWindow.Capacitor;
    delete asWindow.window;
});

function onAPhone(): void {
    const capacitor = { isNativePlatform: () => true, getPlatform: () => 'android' };
    asWindow.Capacitor = capacitor;
    asWindow.window = { Capacitor: capacitor };
}

describe('voice on the setup screen, before anyone has chosen', () => {
    it('is on at a desk', async () => {
        expect((await appSettings.loadAppSettings()).setupVoice).toBe(true);
        store.set('aloud:app:settings', JSON.stringify({ defaultTtsRate: 150 }));
        expect((await appSettings.loadAppSettings()).setupVoice).toBe(true);
    });

    it('is off on a phone, where an open mic means call audio', async () => {
        onAPhone();
        expect((await appSettings.loadAppSettings()).setupVoice).toBe(false);
        store.set('aloud:app:settings', JSON.stringify({ defaultTtsRate: 150 }));
        expect((await appSettings.loadAppSettings()).setupVoice).toBe(false);
    });

    it('keeps a stored choice either way', async () => {
        store.set('aloud:app:settings', JSON.stringify({ setupVoice: false }));
        expect((await appSettings.loadAppSettings()).setupVoice).toBe(false);
        onAPhone();
        store.set('aloud:app:settings', JSON.stringify({ setupVoice: true }));
        expect((await appSettings.loadAppSettings()).setupVoice).toBe(true);
    });
});

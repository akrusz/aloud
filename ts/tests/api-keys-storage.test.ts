/**
 * BYOK key storage (api-keys.ts): rides the platform KV, and on native lifts
 * the keys an older build left in localStorage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const prefs = new Map<string, string>();
const local = new Map<string, string>();
let native = false;

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: prefs.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            prefs.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
            prefs.delete(key);
        },
        keys: async () => ({ keys: Array.from(prefs.keys()) }),
        clear: async () => prefs.clear(),
    },
}));

vi.mock('../ui/src/is-desktop.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../ui/src/is-desktop.js')>();
    return { ...actual, isCapacitor: () => native, isTauri: () => false };
});

// LocalStorageKv needs a window.localStorage; a Map-backed stand-in is enough.
(globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => local.get(k) ?? null,
    setItem: (k: string, v: string) => void local.set(k, v),
    removeItem: (k: string) => void local.delete(k),
    clear: () => local.clear(),
    key: (i: number) => Array.from(local.keys())[i] ?? null,
    get length() {
        return local.size;
    },
} as Storage;

/** A fresh module, as on app launch: the backend and the lift are per-launch. */
async function launch(): Promise<typeof import('../ui/src/api-keys.js')> {
    vi.resetModules();
    return import('../ui/src/api-keys.js');
}

beforeEach(() => {
    prefs.clear();
    local.clear();
});

describe('BYOK key storage', () => {
    it('lifts legacy localStorage keys into Preferences on native', async () => {
        native = true;
        local.set('aloud:apikey:openai', 'sk-old');
        local.set('aloud:apikey:anthropic', 'sk-ant-old');
        local.set('aloud:app:settings', '{}');
        const keys = await launch();
        expect(await keys.getApiKey('openai')).toBe('sk-old');
        // Every key slot moved on the first read, and nothing else did.
        expect(prefs.get('aloud:apikey:anthropic')).toBe('sk-ant-old');
        expect(Array.from(local.keys())).toEqual(['aloud:app:settings']);

        await keys.setApiKey('openai', '');
        expect(await (await launch()).getApiKey('openai')).toBeNull();
    });

    it('stays in localStorage off native', async () => {
        native = false;
        const keys = await launch();
        await keys.setApiKey('openai', 'sk-web');
        expect(local.get('aloud:apikey:openai')).toBe('sk-web');
        expect(prefs.size).toBe(0);
        expect(await (await launch()).getApiKey('openai')).toBe('sk-web');
    });
});

/**
 * Session setup storage (settings.ts loadSetup/saveSetup): rides the platform
 * KV, and on native lifts a setup an older build left in localStorage once
 * (meditation-pal-76cs).
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

import { loadSetup, saveSetup } from '../ui/src/settings.js';

beforeEach(() => {
    prefs.clear();
    local.clear();
});

describe('session setup storage', () => {
    it('lifts a legacy localStorage setup into Preferences on native, once', async () => {
        native = true;
        local.set('aloud:preview:setup', JSON.stringify({ meditationType: 'felt_sense' }));
        const setup = await loadSetup();
        expect(setup.meditationType).toBe('felt_sense');
        expect(prefs.get('aloud:preview:setup')).toContain('felt_sense');
        expect(local.has('aloud:preview:setup')).toBe(false);
    });

    it('round-trips through the durable slot on native', async () => {
        native = true;
        const setup = await loadSetup();
        await saveSetup({ ...setup, meditationType: 'noting' });
        expect(prefs.get('aloud:preview:setup')).toContain('noting');
        expect((await loadSetup()).meditationType).toBe('noting');
    });

    it("maps a saved 'bell' to its new name, 'bike-bell'", async () => {
        native = true;
        prefs.set(
            'aloud:preview:setup',
            JSON.stringify({
                notingUserTurnCueSound: 'bell',
                notingParticipants: [
                    { type: 'sound', sound: 'bell', timing: 'adaptive', fixedDelaySec: 4 },
                    { type: 'sound', sound: 'crow', timing: 'adaptive', fixedDelaySec: 4 },
                ],
            })
        );
        const setup = await loadSetup();
        expect(setup.notingUserTurnCueSound).toBe('bike-bell');
        expect(setup.notingParticipants.map((p) => p.type === 'sound' && p.sound)).toEqual(['bike-bell', 'crow']);
    });
});

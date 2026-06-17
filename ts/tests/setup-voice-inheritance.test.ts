import { describe, it, expect, beforeEach, beforeAll } from 'vitest';

// Regression for meditation-pal-9hu: the app-level default voice/rate must
// always win over any value an older 'preview:setup' persisted, so changing
// the voice in Settings actually propagates to sessions and the noting opener.
//
// settings.ts / app-settings.ts construct a LocalStorageKv at import; give
// them a shared backing store before importing.
let store: Map<string, string>;
let settings: typeof import('../ui/src/settings.js');
let appSettings: typeof import('../ui/src/app-settings.js');

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
    settings = await import('../ui/src/settings.js');
    appSettings = await import('../ui/src/app-settings.js');
});

beforeEach(() => store.clear());

describe('loadSetup voice/rate inheritance', () => {
    it('takes voice/rate from app settings even when a stale per-session voice is persisted', async () => {
        // App default the user picked in Settings.
        store.set(
            'aloud:app:settings',
            JSON.stringify({ defaultVoice: 'server:nice-voice', defaultTtsRate: 175 })
        );
        // A previously-persisted setup carrying a different (now stale) voice/rate.
        store.set(
            'aloud:preview:setup',
            JSON.stringify({ voice: 'browser:old-voice', ttsRate: 120, intention: 'keep me' })
        );

        const setup = await settings.loadSetup();

        expect(setup.voice).toBe('server:nice-voice');
        expect(setup.ttsRate).toBe(175);
        // Non-voice per-session fields are still honored.
        expect(setup.intention).toBe('keep me');
    });

    it('provider/model are still per-session overridable (persisted wins)', async () => {
        store.set(
            'aloud:app:settings',
            JSON.stringify({ defaultProvider: 'ollama', defaultModel: 'app-model' })
        );
        store.set(
            'aloud:preview:setup',
            JSON.stringify({ provider: 'anthropic', model: 'session-model' })
        );

        const setup = await settings.loadSetup();

        expect(setup.provider).toBe('anthropic');
        expect(setup.model).toBe('session-model');
    });

    it('a fresh setup (no persisted session) inherits the app default voice', async () => {
        store.set('aloud:app:settings', JSON.stringify({ defaultVoice: 'server:fresh' }));

        const setup = await settings.loadSetup();

        expect(setup.voice).toBe('server:fresh');
    });

    it('round-trips a default-voice change made through app settings', async () => {
        const s = await appSettings.loadAppSettings();
        await appSettings.saveAppSettings({ ...s, defaultVoice: 'server:chosen', defaultTtsRate: 140 });

        const setup = await settings.loadSetup();

        expect(setup.voice).toBe('server:chosen');
        expect(setup.ttsRate).toBe(140);
    });
});

describe('loadSetup per-mode intention', () => {
    it('migrates a legacy single intention to the active mode and keeps it there', async () => {
        store.set(
            'aloud:preview:setup',
            JSON.stringify({ meditationType: 'exploration', intention: 'play with flow' })
        );
        const setup = await settings.loadSetup();
        expect(setup.intention).toBe('play with flow');
        expect(setup.intentionByMode).toEqual({ exploration: 'play with flow' });
    });

    it('does not leak one mode’s intention into another on load', async () => {
        // Typed under exploration, then switched to felt sense before the
        // per-mode split existed: the stale shared value must not become the
        // felt-sense "something to sit with".
        store.set(
            'aloud:preview:setup',
            JSON.stringify({
                meditationType: 'felt_sense',
                intention: 'play with flow',
                intentionByMode: { exploration: 'play with flow' },
            })
        );
        const setup = await settings.loadSetup();
        expect(setup.intention).toBe('');
        expect(setup.intentionByMode).toEqual({ exploration: 'play with flow' });
    });

    it('resolves intention from the active mode’s slot', async () => {
        store.set(
            'aloud:preview:setup',
            JSON.stringify({
                meditationType: 'felt_sense',
                intention: 'stale exploration text',
                intentionByMode: {
                    exploration: 'stale exploration text',
                    felt_sense: 'the job decision',
                },
            })
        );
        const setup = await settings.loadSetup();
        expect(setup.intention).toBe('the job decision');
    });
});

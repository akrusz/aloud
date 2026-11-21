/**
 * Only an active pick is stored (app-settings.ts fieldsToStore): a field
 * nobody changed stays out of storage and follows the default, including one
 * a later release changes. Checked on the pure function, through both stores
 * (app settings and the session setup) on web and on a phone, for the voice
 * the setup screen resolves, and after each of the Settings resets.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const prefs = new Map<string, string>();
const local = new Map<string, string>();
const session = new Map<string, string>();
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

function mapStorage(m: Map<string, string>): Storage {
    return {
        getItem: (k: string) => m.get(k) ?? null,
        setItem: (k: string, v: string) => void m.set(k, v),
        removeItem: (k: string) => void m.delete(k),
        clear: () => m.clear(),
        key: (i: number) => Array.from(m.keys())[i] ?? null,
        get length() {
            return m.size;
        },
    } as Storage;
}
(globalThis as unknown as { localStorage: Storage }).localStorage = mapStorage(local);
(globalThis as unknown as { sessionStorage: Storage }).sessionStorage = mapStorage(session);

/** A fresh module graph, as on app launch (a new release, for a test that
 *  changes a default before it). */
async function launch() {
    vi.resetModules();
    const app = await import('../ui/src/app-settings.js');
    const setup = await import('../ui/src/settings.js');
    const voices = await import('../ui/src/voice-picker.js');
    return { ...app, ...setup, ...voices };
}

const kv = (): Map<string, string> => (native ? prefs : local);

function stored(key: 'app:settings' | 'preview:setup'): Record<string, unknown> | null {
    const raw = kv().get(`aloud:${key}`);
    return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
}

beforeEach(() => {
    prefs.clear();
    local.clear();
    session.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe('fieldsToStore', () => {
    it('leaves out a field nobody changed and writes one that differs', async () => {
        const { fieldsToStore } = await launch();
        expect(fieldsToStore({}, { a: 1, b: 'x', c: null }, { a: 1, b: 'y', c: null })).toEqual({ b: 'x' });
    });

    it('keeps a stored field written, even once it is back at the default', async () => {
        const { fieldsToStore } = await launch();
        expect(fieldsToStore({ a: 2 }, { a: 1, b: 1 }, { a: 1, b: 1 })).toEqual({ a: 1 });
    });

    it('compares arrays and objects by value', async () => {
        const { fieldsToStore } = await launch();
        const defaults = { list: ['a', 'b'], obj: { x: 1, y: [2] } };
        expect(fieldsToStore({}, { list: ['a', 'b'], obj: { y: [2], x: 1 } }, defaults)).toEqual({});
        expect(fieldsToStore({}, { list: ['b', 'a'], obj: { x: 1, y: [2] } }, defaults)).toEqual({ list: ['b', 'a'] });
        expect(fieldsToStore({}, { list: ['a', 'b'], obj: { x: 1, y: [3] } }, defaults)).toEqual({ obj: { x: 1, y: [3] } });
    });

    it('keeps a stored field the saved object lacks', async () => {
        const { fieldsToStore } = await launch();
        expect(fieldsToStore({ voiceStart: false }, { a: 1 }, { a: 1 })).toEqual({ voiceStart: false });
    });
});

describe.each([
    ['web', false],
    ['phone', true],
])('stored settings (%s)', (_name, onPhone) => {
    beforeEach(() => {
        native = onPhone;
    });

    it('a save stores only the field that changed', async () => {
        const { loadAppSettings, saveAppSettings } = await launch();
        await saveAppSettings({ ...(await loadAppSettings()), themeMode: 'dark' });
        expect(stored('app:settings')).toEqual({ themeMode: 'dark' });
    });

    it('a choice named in a patch is stored even at the default, and outlives a change to it', async () => {
        const first = await launch();
        const twenty = first.DEFAULT_APP_SETTINGS.sessionTimerMin;
        await first.patchAppSettings({ sessionClockMode: 'timer', sessionTimerMin: twenty });
        expect(stored('app:settings')).toEqual({ sessionClockMode: 'timer', sessionTimerMin: twenty });
        const later = await launch();
        later.DEFAULT_APP_SETTINGS.sessionTimerMin = twenty + 10;
        expect((await later.loadAppSettings()).sessionTimerMin).toBe(twenty);
    });

    it('a save that changes nothing writes nothing on a fresh install', async () => {
        const { loadAppSettings, saveAppSettings } = await launch();
        await saveAppSettings(await loadAppSettings());
        expect(stored('app:settings')).toBeNull();
    });

    it('a field set back to the default stays stored once it was', async () => {
        const { loadAppSettings, saveAppSettings, DEFAULT_APP_SETTINGS } = await launch();
        await saveAppSettings({ ...(await loadAppSettings()), defaultTtsRate: 120 });
        await saveAppSettings({ ...(await loadAppSettings()), defaultTtsRate: DEFAULT_APP_SETTINGS.defaultTtsRate });
        expect(stored('app:settings')).toEqual({ defaultTtsRate: DEFAULT_APP_SETTINGS.defaultTtsRate });
    });

    it("a later default reaches someone who never touched the field, not someone who did", async () => {
        const first = await launch();
        await first.saveAppSettings({ ...(await first.loadAppSettings()), themeMode: 'dark' });
        const untouched = kv().get('aloud:app:settings')!;

        kv().clear();
        await first.saveAppSettings({ ...(await first.loadAppSettings()), defaultTtsRate: 120 });
        await first.saveAppSettings({ ...(await first.loadAppSettings()), defaultTtsRate: 140 });
        const touched = kv().get('aloud:app:settings')!;

        const later = await launch();
        later.DEFAULT_APP_SETTINGS.defaultTtsRate = 150;
        kv().set('aloud:app:settings', untouched);
        expect((await later.loadAppSettings()).defaultTtsRate).toBe(150);
        kv().set('aloud:app:settings', touched);
        expect((await later.loadAppSettings()).defaultTtsRate).toBe(140);
    });

    it('a language nobody picked follows the locale', async () => {
        const { loadAppSettings, saveAppSettings } = await launch();
        vi.stubGlobal('navigator', { language: 'en-US' });
        await saveAppSettings({ ...(await loadAppSettings()), themeMode: 'dark' });
        expect(stored('app:settings')).toEqual({ themeMode: 'dark' });
        vi.stubGlobal('navigator', { language: 'zh-CN' });
        expect((await loadAppSettings()).language).toBe('zh');
    });

    it('keeps a stored key the settings no longer have', async () => {
        kv().set('aloud:app:settings', JSON.stringify({ voiceStart: false }));
        const { loadAppSettings, saveAppSettings } = await launch();
        await saveAppSettings({ ...(await loadAppSettings()), textScale: 1.2 });
        expect(stored('app:settings')).toEqual({ voiceStart: false, textScale: 1.2 });
    });

    it('a load straight after a save reads it back', async () => {
        const { loadAppSettings, saveAppSettings, loadSetup, saveSetup } = await launch();
        void saveAppSettings({ ...(await loadAppSettings()), language: 'zh' });
        expect((await loadAppSettings()).language).toBe('zh');
        void saveSetup({ ...(await loadSetup()), meditationType: 'felt_sense' });
        expect((await loadSetup()).meditationType).toBe('felt_sense');
    });

    it('a setup save stores only what the setup screen changed', async () => {
        const { loadSetup, saveSetup } = await launch();
        await saveSetup({ ...(await loadSetup()), meditationType: 'noting' });
        expect(stored('preview:setup')).toEqual({ meditationType: 'noting' });
    });

    it('a setup default changed later reaches a setup that never touched it', async () => {
        const first = await launch();
        await first.saveSetup({ ...(await first.loadSetup()), meditationType: 'noting' });
        const later = await launch();
        later.defaultSetup.dirStep = 3;
        expect((await later.loadSetup()).dirStep).toBe(3);
    });

    it("a setup provider and model that mirror Settings' default follow it", async () => {
        kv().set('aloud:app:settings', JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-a' }));
        const { loadSetup, saveSetup, loadAppSettings, saveAppSettings } = await launch();
        const setup = await loadSetup();
        expect(setup.provider).toBe('anthropic');
        await saveSetup({ ...setup, dirStep: 1 });
        expect(stored('preview:setup')).toEqual({ dirStep: 1 });
        await saveAppSettings({ ...(await loadAppSettings()), defaultProvider: 'openai', defaultModel: 'gpt-a' });
        const next = await loadSetup();
        expect([next.provider, next.model]).toEqual(['openai', 'gpt-a']);
    });

    it('a setup provider of its own is stored and wins', async () => {
        const { loadSetup, saveSetup } = await launch();
        await saveSetup({ ...(await loadSetup()), provider: 'groq', model: 'llama' });
        expect(stored('preview:setup')).toEqual({ provider: 'groq', model: 'llama' });
    });
});

describe.each([
    ['web', false],
    ['phone', true],
])('the voice (%s)', (_name, onPhone) => {
    beforeEach(() => {
        native = onPhone;
    });

    const catalog = (defaultName: string) =>
        ['Harper', 'Ethan', 'Luna'].map((name) => ({
            name,
            lang: 'en-US',
            score: 3,
            engine: 'aloud',
            ...(name === defaultName ? { hostedDefault: true } : {}),
        }));

    it('a first setup-screen load and a speed change store no voice, and a later default reaches it', async () => {
        const { loadSetup, saveSetup, loadAppSettings, saveAppSettings, effectiveVoice } = await launch();
        // What the setup screen does: resolve in memory, write the speed alone
        // (views/setup.ts loadVoiceCatalog, the speed slider), save the form.
        const setup = await loadSetup();
        setup.voice = effectiveVoice(setup.voice, catalog('Harper'), setup.language);
        expect(setup.voice).toBe('aloud:Harper');
        setup.ttsRate = 120;
        await saveAppSettings({ ...(await loadAppSettings()), defaultTtsRate: 120 });
        await saveSetup({ ...setup, verbosity: 'low' });
        expect(stored('app:settings')).toEqual({ defaultTtsRate: 120 });
        expect(stored('preview:setup')).toEqual({ verbosity: 'low' });

        const next = await loadSetup();
        expect(next.voice).toBeNull();
        expect(effectiveVoice(next.voice, catalog('Luna'), next.language)).toBe('aloud:Luna');
    });

    it('a picked voice is stored and stays when the default moves', async () => {
        const { loadSetup, loadAppSettings, saveAppSettings, effectiveVoice } = await launch();
        await saveAppSettings({ ...(await loadAppSettings()), defaultVoice: 'aloud:Harper' });
        expect(stored('app:settings')).toEqual({ defaultVoice: 'aloud:Harper' });
        const setup = await loadSetup();
        expect(effectiveVoice(setup.voice, catalog('Luna'), setup.language)).toBe('aloud:Harper');
    });

    it('a pick whose hosted voice is gone goes back to unset', async () => {
        kv().set('aloud:app:settings', JSON.stringify({ defaultVoice: 'aloud:Pulcherrima', themeMode: 'dark' }));
        const { unsetAppSettings, loadSetup, effectiveVoice } = await launch();
        await unsetAppSettings(['defaultVoice']);
        expect(stored('app:settings')).toEqual({ themeMode: 'dark' });
        const setup = await loadSetup();
        expect(effectiveVoice(setup.voice, catalog('Harper'), setup.language)).toBe('aloud:Harper');
    });
});

describe.each([
    ['web', false],
    ['phone', true],
])('after a reset, an unrelated save (%s)', (_name, onPhone) => {
    const APP = {
        defaultProvider: 'anthropic',
        defaultModel: 'claude-opus-5',
        defaultVoice: 'aloud:Ethan',
        defaultTtsRate: 120,
        houseVoice: 'Ethan',
        sttEngine: 'aloud-parakeet',
        sessionClockMode: 'timer',
        sessionTimerMin: 45,
        themeMode: 'dark',
    };
    const SETUP = {
        provider: 'openai',
        model: 'gpt-5',
        voice: 'aloud:Ethan',
        ttsRate: 120,
        meditationType: 'noting',
        dirStep: 4,
        verbosity: 'low',
        customInstructions: 'speak softly',
        focuses: ['open_awareness'],
    };

    beforeEach(() => {
        native = onPhone;
        kv().set('aloud:app:settings', JSON.stringify(APP));
        kv().set('aloud:preview:setup', JSON.stringify(SETUP));
    });

    /** A Settings change and a setup-screen change, each through the loaders
     *  the way the views do it. */
    async function unrelatedSaves(m: Awaited<ReturnType<typeof launch>>, setupChange: Partial<typeof SETUP>) {
        await m.saveAppSettings({ ...(await m.loadAppSettings()), textScale: 1.2 });
        await m.saveSetup({ ...(await m.loadSetup()), ...(setupChange as object) });
    }

    it('leaves the model and voice picks unset', async () => {
        const m = await launch();
        const { resetModelAndVoicePicks } = await import('../ui/src/settings-reset.js');
        await resetModelAndVoicePicks();
        await unrelatedSaves(m, { verbosity: 'high' });
        expect(stored('app:settings')).toEqual({
            sessionClockMode: 'timer',
            sessionTimerMin: 45,
            themeMode: 'dark',
            textScale: 1.2,
        });
        expect(stored('preview:setup')).toEqual({
            meditationType: 'noting',
            dirStep: 4,
            verbosity: 'high',
            customInstructions: 'speak softly',
            focuses: ['open_awareness'],
        });
    });

    it('leaves the session setup unset', async () => {
        const m = await launch();
        const { resetSessionSetup } = await import('../ui/src/settings-reset.js');
        await resetSessionSetup();
        await unrelatedSaves(m, { model: 'gpt-6' });
        const app = stored('app:settings')!;
        expect(app).not.toHaveProperty('sessionClockMode');
        expect(app).not.toHaveProperty('sessionTimerMin');
        expect(stored('preview:setup')).toEqual({ provider: 'openai', model: 'gpt-6', voice: 'aloud:Ethan', ttsRate: 120 });
    });

    it('brings back nothing the tour reset cleared', async () => {
        const m = await launch();
        const { resetTourAndTips } = await import('../ui/src/settings-reset.js');
        kv().set('aloud:aloud-index-guide-done', '1');
        await resetTourAndTips();
        await unrelatedSaves(m, { verbosity: 'high' });
        expect(kv().has('aloud:aloud-index-guide-done')).toBe(false);
        expect(stored('app:settings')).toEqual({ ...APP, textScale: 1.2 });
    });
});

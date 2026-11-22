/**
 * The guidance level is 1 to 5 everywhere. It used to be 0/3/5/7/10 in the
 * prompt and 0 to 4 on the setup slider and in the stored setup, so this
 * pins two things: each level still gets what its old value got, and a setup
 * stored by an older build (`dirStep`, `feltSensePaceStep`, 0 to 4) is read
 * as the level it meant, never as the same number on the new scale.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import {
    COMMON_OPENERS,
    DIRECTIVENESS_ADDITIONS,
    MINIMAL_OPENERS,
    PromptBuilder,
    defaultWaitSeconds,
} from '../src/facilitation/prompts.js';
import { checkinSuggestionFor } from '../src/facilitation/smart-checkin.js';

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

/** What each level was called and what it drove, indexed by the old slider
 *  position (0 to 4), written out rather than read from the code under test. */
const OLD = [
    {
        name: 'Following',
        firstLine: 'Be extremely non-directive. Only reflect back what is shared.',
        waitSec: 720,
        tier: 'none',
        opener: 'Keep it very minimal, just a few words.',
    },
    {
        name: 'Somewhat following',
        firstLine: 'Curious but mostly following. You might ask about specific areas',
        waitSec: 300,
        tier: 'offered',
        opener: "Keep it warm and concise. Don't direct their attention too specifically.",
    },
    {
        name: 'Balanced',
        firstLine: 'Balanced between following and guiding. Feel free to suggest',
        waitSec: 180,
        tier: 'offered',
        opener: null,
    },
    {
        name: 'Somewhat directing',
        firstLine: 'More actively guide attention while still responding to what arises.',
        waitSec: 90,
        tier: 'offered',
        opener: 'You can suggest where to begin or what to notice.',
    },
    {
        name: 'Directing',
        firstLine: 'Actively direct the meditation. Guide attention to specific areas or experiences.',
        waitSec: 30,
        tier: 'expected',
        opener: 'You can suggest where to begin or what to notice.',
    },
] as const;

const OPENER_LINES = [...new Set(OLD.map((o) => o.opener).filter((o) => o !== null))];

describe('each guidance level gets what its old value got', () => {
    // The opening of each level's text, not every word: what a level says may
    // be reworded; which text a level gets may not move.
    it.each(OLD.map((o, i) => [i + 1, o] as const))('level %i: its prompt section', (level, old) => {
        expect(DIRECTIVENESS_ADDITIONS[level]!.startsWith(`Guidance level: ${old.name}\n${old.firstLine}\n`)).toBe(true);
        const prompt = new PromptBuilder({ config: { directiveness: level } }).buildSystemPrompt();
        for (const [other, text] of Object.entries(DIRECTIVENESS_ADDITIONS)) {
            expect(prompt.includes(text), `level ${level} carries level ${other}'s text`).toBe(Number(other) === level);
        }
    });

    it.each(OLD.map((o, i) => [i + 1, o] as const))('level %i: its waits, check-ins and opener', (level, old) => {
        expect(defaultWaitSeconds(level)).toBe(old.waitSec);
        expect(new PromptBuilder({ config: { directiveness: level } }).checkinWaitSeconds()).toBe(old.waitSec);
        expect(checkinSuggestionFor(level)).toBe(old.tier);
        const opener = new PromptBuilder({ config: { directiveness: level } }).buildOpenerPrompt();
        for (const line of OPENER_LINES) expect(opener.includes(line)).toBe(line === old.opener);
        const canned = new PromptBuilder({ config: { directiveness: level }, random: () => 0 }).getSessionOpener();
        expect(canned).toBe((level === 1 ? MINIMAL_OPENERS : COMMON_OPENERS)[0]);
    });

    it('has exactly the five levels', () => {
        expect(Object.keys(DIRECTIVENESS_ADDITIONS).map(Number)).toEqual([1, 2, 3, 4, 5]);
    });
});

/** A fresh module graph, as on app launch. */
async function launch() {
    vi.resetModules();
    const setup = await import('../ui/src/settings.js');
    const reset = await import('../ui/src/settings-reset.js');
    return { ...setup, ...reset };
}

const kv = (): Map<string, string> => (native ? prefs : local);
const storeSetup = (value: object): void => void kv().set('aloud:preview:setup', JSON.stringify(value));
const storedSetup = (): Record<string, unknown> | null => {
    const raw = kv().get('aloud:preview:setup');
    return raw === undefined ? null : (JSON.parse(raw) as Record<string, unknown>);
};

beforeEach(() => {
    prefs.clear();
    local.clear();
});

describe.each([
    ['web', false],
    ['phone', true],
])('a setup stored on the old 0-4 slider (%s)', (_name, onPhone) => {
    beforeEach(() => {
        native = onPhone;
    });

    it.each(OLD.map((o, step) => [step, o] as const))('guidance stop %i loads as the level it was', async (step, old) => {
        storeSetup({ dirStep: step });
        const m = await launch();
        const setup = await m.loadSetup();
        expect(setup.directiveness).toBe(step + 1);
        expect(m.GUIDANCE_LEVEL_LABELS[setup.directiveness]).toBe(old.name);
        expect(DIRECTIVENESS_ADDITIONS[setup.directiveness]!.startsWith(`Guidance level: ${old.name}\n`)).toBe(true);
        expect(setup).not.toHaveProperty('dirStep');
    });

    it.each(OLD.map((o, step) => [step, o] as const))('check-in pace stop %i keeps its wait', async (step, old) => {
        storeSetup({ feltSensePaceStep: step });
        const setup = await (await launch()).loadSetup();
        expect(setup.feltSensePace).toBe(step + 1);
        expect(defaultWaitSeconds(setup.feltSensePace)).toBe(old.waitSec);
        expect(setup).not.toHaveProperty('feltSensePaceStep');
    });

    it('nothing stored is Balanced and Patient, as before', async () => {
        const m = await launch();
        const setup = await m.loadSetup();
        expect(m.GUIDANCE_LEVEL_LABELS[setup.directiveness]).toBe('Balanced');
        expect(m.CHECKIN_PACE_LABELS[setup.feltSensePace]).toBe('Patient');
        expect(defaultWaitSeconds(setup.feltSensePace)).toBe(300);
    });

    it('the next save writes the new fields only, and an old pick at the default stays a pick', async () => {
        storeSetup({ dirStep: 2, feltSensePaceStep: 1, meditationType: 'noting' });
        const first = await launch();
        await first.saveSetup({ ...(await first.loadSetup()), verbosity: 'high' });
        expect(storedSetup()).toEqual({ directiveness: 3, feltSensePace: 2, meditationType: 'noting', verbosity: 'high' });
        const later = await launch();
        later.defaultSetup.directiveness = 4;
        later.defaultSetup.feltSensePace = 4;
        const setup = await later.loadSetup();
        expect([setup.directiveness, setup.feltSensePace]).toEqual([3, 2]);
    });

    it('an untouched old setup still loads right on every launch', async () => {
        storeSetup({ dirStep: 4 });
        expect((await (await launch()).loadSetup()).directiveness).toBe(5);
        expect(storedSetup()).toEqual({ dirStep: 4 });
        expect((await (await launch()).loadSetup()).directiveness).toBe(5);
    });

    it('a new field wins over an old one beside it', async () => {
        storeSetup({ dirStep: 0, directiveness: 4 });
        const m = await launch();
        const setup = await m.loadSetup();
        expect(setup.directiveness).toBe(4);
        await m.saveSetup(setup);
        expect(storedSetup()).toEqual({ directiveness: 4 });
    });

    it('a reset that leaves the guidance alone carries it over to the new field', async () => {
        storeSetup({ dirStep: 4, provider: 'openai', model: 'gpt-5' });
        const m = await launch();
        await m.resetModelAndVoicePicks();
        expect(storedSetup()).toEqual({ directiveness: 5 });
    });

    it('the session setup reset drops the old fields too', async () => {
        storeSetup({ dirStep: 4, feltSensePaceStep: 0, provider: 'openai' });
        const m = await launch();
        await m.resetSessionSetup();
        expect(storedSetup()).toEqual({ provider: 'openai' });
        expect((await m.loadSetup()).directiveness).toBe(3);
    });
});

describe('upgradeStoredSetup', () => {
    it('clamps a stop out of range and drops one that is not a number', async () => {
        const { upgradeStoredSetup } = await launch();
        expect(upgradeStoredSetup({ dirStep: 9, feltSensePaceStep: -3 })).toEqual({ directiveness: 5, feltSensePace: 1 });
        expect(upgradeStoredSetup({ dirStep: '2', feltSensePaceStep: null })).toEqual({});
        expect(upgradeStoredSetup({ verbosity: 'low' })).toEqual({ verbosity: 'low' });
    });

    it('leaves what it was given alone', async () => {
        const { upgradeStoredSetup } = await launch();
        const stored = { dirStep: 1 };
        upgradeStoredSetup(stored);
        expect(stored).toEqual({ dirStep: 1 });
    });
});

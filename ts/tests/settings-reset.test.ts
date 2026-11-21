/**
 * Settings → Advanced → Reset (settings-reset.ts): each area clears exactly
 * its own keys and fields, removed rather than rewritten, on web (localStorage)
 * and on a phone (Preferences, with the voice hints still in localStorage).
 * Sign-in, own keys, history, the age tier, language, theme, consents and
 * developer switches survive all three.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

const APP_SETTINGS = {
    // Area 1
    defaultProvider: 'anthropic',
    defaultModel: 'claude-opus-5',
    showAllModels: true,
    keepModelOffShortlist: true,
    ttsEngine: 'piper',
    defaultVoice: 'aloud:Ethan',
    defaultTtsRate: 120,
    houseVoice: 'Ethan',
    sttEngine: 'aloud-parakeet',
    sparseSttEngine: 'web-speech',
    sttWhisperModel: 'small',
    // Area 2
    sessionClockMode: 'timer',
    sessionTimerMin: 45,
    showSessionClock: false,
    endSessionOnTimer: true,
    // Never reset
    language: 'zh',
    themeMode: 'dark',
    textScale: 1.2,
    enableByok: true,
    saveSessionLogs: false,
    voiceCommandsViaCloud: true,
    setupVoice: false,
    micDeviceId: 'mic-1',
    silenceBaseMs: 4000,
    checkinTiming: 'simple',
    signatureSound: 'none',
};

const SETUP = {
    // Area 1
    provider: 'openai',
    model: 'gpt-5',
    voice: 'aloud:Ethan',
    ttsRate: 120,
    // Area 2
    meditationType: 'noting',
    intention: 'rest',
    intentionByMode: { exploration: 'rest' },
    focuses: ['open_awareness'],
    qualities: ['playful'],
    dirStep: 4,
    feltSensePaceStep: 3,
    feltSenseCheckins: false,
    verbosity: 'low',
    customInstructions: 'speak softly',
    notingParticipants: [],
    notingUserTurnCue: true,
    notingUserTurnCueSound: 'rin',
    // Never reset (mirrored from Settings anyway)
    language: 'zh',
};

/** Keys of the platform KV, under the adapters' "aloud:" prefix. */
const KV: Record<string, string> = {
    'app:settings': JSON.stringify(APP_SETTINGS),
    'preview:setup': JSON.stringify(SETUP),
    'model-picks-off-shortlist': '["claude-opus-4"]',
    'aloud-index-guide-done': '1',
    'aloud-client-id': '1',
    'aloud-first-sit-follow-up': '1',
    'aloud-tour-quiet': '1',
    'aloud-tour-dismissed': '1',
    'aloud-narrator-notice-seen': '1',
    'aloud-setup-voice-hints': '3',
    'server:token': 'tok',
    'apikey:openai': 'sk-mine',
    ageTier: 'child',
    storeVerifyNoticeShown: '1',
    'session:index': '["s1"]',
    'session:s1': '{"sessionId":"s1"}',
    'session:active': 's1',
};

/** Plain localStorage on every platform. */
const LOCAL: Record<string, string> = {
    'aloud:voiceHint:speed': '1',
    'aloud:voiceHint:introSessions': '3',
    'apikey:elevenlabs': 'sk_el',
    themeMode: 'dark',
    'aloud:devMode': '1',
    'aloud-embers': '3',
    'aloud:lastUpdateCheck': '1',
};

const SESSION: Record<string, string> = {
    'aloud-index-guide-remind': '1',
    'aloud-tour-remind-later': '1',
    continueFrom: 's1',
};

function seed(): void {
    const kv = native ? prefs : local;
    for (const [k, v] of Object.entries(KV)) kv.set(`aloud:${k}`, v);
    for (const [k, v] of Object.entries(LOCAL)) local.set(k, v);
    for (const [k, v] of Object.entries(SESSION)) session.set(k, v);
}

/** Every stored value, the two settings objects spread out field by field. */
function snapshot(): Map<string, string> {
    const out = new Map<string, string>();
    const add = (where: string, m: Map<string, string>): void => {
        for (const [k, v] of m) {
            if (k === 'aloud:app:settings' || k === 'aloud:preview:setup') {
                for (const [f, fv] of Object.entries(JSON.parse(v) as Record<string, unknown>)) {
                    out.set(`${k.slice('aloud:'.length)}.${f}`, JSON.stringify(fv));
                }
            } else {
                out.set(`${where}:${k}`, v);
            }
        }
    };
    add('prefs', prefs);
    add('local', local);
    add('session', session);
    return out;
}

/** What changed between two snapshots, kv keys named without their store. */
function changed(before: Map<string, string>, after: Map<string, string>): string[] {
    const keys = new Set([...before.keys(), ...after.keys()]);
    return [...keys]
        .filter((k) => before.get(k) !== after.get(k))
        .map((k) => k.replace(/^(prefs|local):aloud:(?!voiceHint)/, 'kv:'))
        .sort();
}

/** A fresh module graph, as on app launch: state.ts picks its KV at import. */
async function launch(): Promise<typeof import('../ui/src/settings-reset.js')> {
    vi.resetModules();
    return import('../ui/src/settings-reset.js');
}

const PICKS_CLEARED = [
    'app:settings.defaultModel',
    'app:settings.defaultProvider',
    'app:settings.defaultTtsRate',
    'app:settings.defaultVoice',
    'app:settings.houseVoice',
    'app:settings.keepModelOffShortlist',
    'app:settings.showAllModels',
    'app:settings.sparseSttEngine',
    'app:settings.sttEngine',
    'app:settings.sttWhisperModel',
    'app:settings.ttsEngine',
    'kv:model-picks-off-shortlist',
    'preview:setup.model',
    'preview:setup.provider',
    'preview:setup.ttsRate',
    'preview:setup.voice',
];

const SETUP_CLEARED = [
    'app:settings.endSessionOnTimer',
    'app:settings.sessionClockMode',
    'app:settings.sessionTimerMin',
    'app:settings.showSessionClock',
    'preview:setup.customInstructions',
    'preview:setup.dirStep',
    'preview:setup.feltSenseCheckins',
    'preview:setup.feltSensePaceStep',
    'preview:setup.focuses',
    'preview:setup.intention',
    'preview:setup.intentionByMode',
    'preview:setup.meditationType',
    'preview:setup.notingParticipants',
    'preview:setup.notingUserTurnCue',
    'preview:setup.notingUserTurnCueSound',
    'preview:setup.qualities',
    'preview:setup.verbosity',
];

const TIPS_CLEARED = [
    'kv:aloud-client-id',
    'kv:aloud-first-sit-follow-up',
    'kv:aloud-index-guide-done',
    'kv:aloud-narrator-notice-seen',
    'kv:aloud-setup-voice-hints',
    'kv:aloud-tour-dismissed',
    'kv:aloud-tour-quiet',
    'local:aloud:voiceHint:introSessions',
    'local:aloud:voiceHint:speed',
    'session:aloud-index-guide-remind',
    'session:aloud-tour-remind-later',
];

beforeEach(() => {
    prefs.clear();
    local.clear();
    session.clear();
});

describe.each([
    ['web', false],
    ['phone', true],
])('settings reset (%s)', (_name, onPhone) => {
    beforeEach(() => {
        native = onPhone;
        seed();
    });

    it('model and voice picks: exactly the picks, removed', async () => {
        const { resetModelAndVoicePicks } = await launch();
        const before = snapshot();
        await resetModelAndVoicePicks();
        expect(changed(before, snapshot())).toEqual(PICKS_CLEARED);
    });

    it('session setup: exactly what the setup screen remembers', async () => {
        const { resetSessionSetup } = await launch();
        const before = snapshot();
        await resetSessionSetup();
        expect(changed(before, snapshot())).toEqual(SETUP_CLEARED);
    });

    it('tour and tips: exactly the shown flags', async () => {
        const { resetTourAndTips } = await launch();
        const before = snapshot();
        await resetTourAndTips();
        expect(changed(before, snapshot())).toEqual(TIPS_CLEARED);
    });

    it('all three leave sign-in, keys, history, the age tier and the rest alone', async () => {
        const reset = await launch();
        await reset.resetModelAndVoicePicks();
        await reset.resetSessionSetup();
        await reset.resetTourAndTips();
        const kv = native ? prefs : local;
        expect(kv.get('aloud:ageTier')).toBe('child');
        expect(kv.get('aloud:server:token')).toBe('tok');
        expect(kv.get('aloud:apikey:openai')).toBe('sk-mine');
        expect(local.get('apikey:elevenlabs')).toBe('sk_el');
        expect(kv.get('aloud:session:index')).toBe('["s1"]');
        expect(kv.get('aloud:session:s1')).toBe('{"sessionId":"s1"}');
        expect(kv.get('aloud:session:active')).toBe('s1');
        const settings = JSON.parse(kv.get('aloud:app:settings')!) as Record<string, unknown>;
        expect(settings).toEqual({
            language: 'zh',
            themeMode: 'dark',
            textScale: 1.2,
            enableByok: true,
            saveSessionLogs: false,
            voiceCommandsViaCloud: true,
            setupVoice: false,
            micDeviceId: 'mic-1',
            silenceBaseMs: 4000,
            checkinTiming: 'simple',
            signatureSound: 'none',
        });
        expect(JSON.parse(kv.get('aloud:preview:setup')!)).toEqual({ language: 'zh' });
    });

    it('leaves speech-to-text unset, so a tour with no pick listens on GPT', async () => {
        const { resetModelAndVoicePicks } = await launch();
        await resetModelAndVoicePicks();
        const { loadAppSettings, DEFAULT_APP_SETTINGS } = await import('../ui/src/app-settings.js');
        const { loadSetup } = await import('../ui/src/settings.js');
        const { resolveSttChoice, defaultSttChoice, setupHostedChoice } = await import(
            '../ui/src/adapters/stt-picker.js'
        );
        const s = await loadAppSettings();
        expect(s.sttEngine).toBeNull();
        expect(s.sparseSttEngine).toBeNull();
        expect(resolveSttChoice(s.sttEngine, true)).toBe(defaultSttChoice(true));
        expect(setupHostedChoice('aloud-parakeet', s.sttEngine, true, 'en')).toBe('aloud-gpt-transcribe');
        expect(s.defaultVoice).toBeNull();
        expect(s.houseVoice).toBeNull();
        expect(s.defaultModel).toBe(DEFAULT_APP_SETTINGS.defaultModel);
        const setup = await loadSetup();
        expect(setup.provider).toBe(DEFAULT_APP_SETTINGS.defaultProvider);
        expect(setup.model).toBe(DEFAULT_APP_SETTINGS.defaultModel);
    });
});

describe('settings reset, nothing stored', () => {
    it('writes nothing for a fresh install', async () => {
        native = false;
        const reset = await launch();
        await reset.resetModelAndVoicePicks();
        await reset.resetSessionSetup();
        await reset.resetTourAndTips();
        expect([...local.keys(), ...prefs.keys()]).toEqual([]);
    });
});

it('names the setup screen voice-hint key the setup view uses', async () => {
    const { SETUP_VOICE_HINT_KEY } = await launch();
    const here = dirname(fileURLToPath(import.meta.url));
    const setupSource = readFileSync(join(here, '../ui/src/views/setup.ts'), 'utf8');
    expect(setupSource).toContain(`const VOICE_HINT_KEY = '${SETUP_VOICE_HINT_KEY}';`);
});

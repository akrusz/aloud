/**
 * The run record a saved session carries (ui/src/session-run-record.ts): an
 * allowlist of settings copied by name, JSON-plain, and nothing a setup or the
 * app settings might hold beyond it.
 */
import { describe, it, expect } from 'vitest';

import {
    buildRunRecord,
    conversationRunSettings,
    notingRunSettings,
    runBuild,
    type ConversationRunInputs,
} from '../ui/src/session-run-record.js';
import { defaultSetup, type SessionSetup } from '../ui/src/settings.js';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../ui/src/app-settings.js';
import { defaultPromptConfig, type Focus } from '../src/facilitation/prompts.js';

const SECRET = 'sk-ant-secret-0000';

// Fields neither type has today, standing in for any that land later.
const setup = {
    ...defaultSetup,
    meditationType: 'felt_sense',
    intention: 'the tightness in my chest',
    directiveness: 2,
    feltSensePace: 4,
    provider: 'aloud',
    model: 'anthropic/claude-opus-5',
    voice: 'aloud:Harper',
    ttsRate: 140,
    apiKey: SECRET,
} as SessionSetup;
const appSettings = {
    ...DEFAULT_APP_SETTINGS,
    cloudToken: SECRET,
    account: { email: 'someone@example.com' },
} as AppSettings;

function inputs(over: Partial<ConversationRunInputs> = {}): ConversationRunInputs {
    return {
        setup,
        appSettings,
        // Felt sense composes its check-in pace as the directiveness.
        prompt: { ...defaultPromptConfig, directiveness: 4, appControls: 'voice', voiceNote: 'No "Right".' },
        mode: 'felt_sense',
        language: 'en',
        continuedFrom: null,
        checkinTiming: 'smart',
        checkinContent: 'smart',
        checkinWaitSec: 180,
        voiceCommands: 'hosted',
        silenceBaseMs: 3000,
        silenceMaxMs: 5000,
        timerMin: null,
        endSessionOnTimer: false,
        sttEngine: 'aloud-parakeet',
        sttModel: 'moondream/parakeet-ultra',
        wholeReply: true,
        ...over,
    };
}

/** True when every value is a string, number, boolean, null or string[]. */
function isFlat(settings: Record<string, unknown>): boolean {
    return Object.values(settings).every(
        (v) =>
            v === null ||
            ['string', 'number', 'boolean'].includes(typeof v) ||
            (Array.isArray(v) && v.every((x) => typeof x === 'string'))
    );
}

describe('conversationRunSettings', () => {
    it('copies only its allowlist, whatever else the setup and settings hold', () => {
        const settings = conversationRunSettings(inputs());
        const json = JSON.stringify(settings);
        expect(json).not.toContain(SECRET);
        expect(json).not.toContain('someone@example.com');
        expect(Object.keys(settings)).not.toContain('apiKey');
        expect(Object.keys(settings)).not.toContain('cloudToken');
    });

    it('is flat and survives a JSON round trip unchanged', () => {
        const settings = conversationRunSettings(inputs());
        expect(isFlat(settings)).toBe(true);
        expect(JSON.parse(JSON.stringify(settings))).toEqual(settings);
    });

    it('records what the prompt was composed from, not the setup slider', () => {
        const settings = conversationRunSettings(inputs());
        expect(settings).toMatchObject({
            mode: 'felt_sense',
            directiveness: 4,
            appControls: 'voice',
            voiceNote: 'No "Right".',
            model: 'anthropic/claude-opus-5',
            provider: 'aloud',
            voice: 'aloud:Harper',
            sttEngine: 'aloud-parakeet',
            sttModel: 'moondream/parakeet-ultra',
            checkinWaitSec: 180,
            autoQuitSilenceMin: 60,
        });
    });

    it('does not alias the live arrays', () => {
        const focuses: Focus[] = ['emotions'];
        const settings = conversationRunSettings(inputs({ prompt: { ...defaultPromptConfig, focuses } }));
        focuses.push('inner_parts');
        expect(settings.focuses).toEqual(['emotions']);
    });
});

describe('notingRunSettings', () => {
    it('describes each participant on one line and copies nothing else', () => {
        const settings = notingRunSettings(
            {
                ...setup,
                meditationType: 'noting',
                notingUserTurnCue: true,
                notingUserTurnCueSound: 'bowl',
                notingParticipants: [
                    { type: 'llm', voice: 'aloud:Ethan', reactive: 'low', timing: 'adaptive', fixedDelaySec: 3 },
                    { type: 'fixed', voice: null, phrase: 'thinking', timing: 'fixed', fixedDelaySec: 2 },
                    { type: 'sound', sound: 'rin', timing: 'adaptive', fixedDelaySec: 3 },
                ],
            },
            { engine: 'capacitor', model: '' }
        );
        expect(settings.participants).toEqual([
            'llm aloud:Ethan reactive=low adaptive',
            'fixed default "thinking" fixed=2s',
            'sound rin adaptive',
        ]);
        expect(settings.userTurnCue).toBe('bowl');
        expect(isFlat(settings)).toBe(true);
        expect(JSON.stringify(settings)).not.toContain(SECRET);
    });
});

describe('buildRunRecord', () => {
    it('carries the system prompt verbatim, and leaves it out when there is none', () => {
        const build = runBuild();
        const settings = conversationRunSettings(inputs());
        expect(buildRunRecord(build, settings, 'You are a facilitator.\n').systemPrompt).toBe(
            'You are a facilitator.\n'
        );
        expect('systemPrompt' in buildRunRecord(build, settings)).toBe(false);
    });

    it('names the build without throwing where no define was baked in', () => {
        // Vitest has no vite define and no native bridge.
        expect(runBuild()).toEqual({ version: '', commit: '', platform: 'web', dev: expect.any(Boolean) });
    });
});

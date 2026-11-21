/**
 * Settings → Advanced → Reset: put one area back to "never picked", the state
 * a fresh install is in, so the app's defaults apply to it again, today's and
 * any later ones. Unset means removed (a field dropped from the stored object,
 * a flag key deleted), never written with today's default.
 *
 * None of the three touches: sign-in, own API keys and endpoints, history and
 * saved sessions, the age tier, credits, language, theme and display, the two
 * consents (voice commands through aloud cloud, the setup screen's mic), the
 * microphone device, the Settings page's own preferences (pacing, check-ins,
 * sounds, session logs) or developer switches.
 */

import { unsetAppSettings, type AppSettings } from './app-settings.js';
import { unsetSetupFields, unsetSetupFieldsExcept, type SessionSetup } from './settings.js';
import { forgetModelPickerState } from './model-picker.js';
import { forgetGuideProgress } from './tour/index-guide.js';
import { forgetSettingsTourDismissal } from './tour/settings-tour.js';
import { forgetVoiceHints } from './voice-command-hints.js';
import { forgetNarratorNotice } from './cloud-gate.js';
import { sharedKv } from './state.js';

/** Which engine, provider, model or voice. Unset, each resolves at use:
 *  resolveSttChoice, defaultVoicePick, the model shortlist. */
const PICK_SETTINGS = [
    'defaultProvider',
    'defaultModel',
    'showAllModels',
    'keepModelOffShortlist',
    'ttsEngine',
    'defaultVoice',
    'defaultTtsRate',
    'houseVoice',
    'sttEngine',
    'sparseSttEngine',
    'sttWhisperModel',
] as const satisfies readonly (keyof AppSettings)[];

/** The setup's own provider/model, which wins over the Settings default
 *  (loadSetup), and its copy of voice and rate, which loadSetup overwrites. */
const PICK_SETUP_FIELDS = ['provider', 'model', 'voice', 'ttsRate'] as const satisfies readonly (keyof SessionSetup)[];

/** The session clock: set from the setup screen, but kept in AppSettings. */
const SETUP_SETTINGS = [
    'sessionClockMode',
    'sessionTimerMin',
    'showSessionClock',
    'endSessionOnTimer',
] as const satisfies readonly (keyof AppSettings)[];

/** What a session setup reset keeps of the stored setup: the picks above, and
 *  language, which loadSetup takes from Settings anyway. Everything else in it
 *  is the setup screen's memory, including any field added later. */
const SETUP_FIELDS_KEPT = [...PICK_SETUP_FIELDS, 'language'] as const satisfies readonly (keyof SessionSetup)[];

/** VOICE_HINT_KEY in views/setup.ts: how many times the setup mic has said what
 *  it is for (tests/settings-reset.test.ts checks the two match). */
export const SETUP_VOICE_HINT_KEY = 'aloud-setup-voice-hints';

export async function resetModelAndVoicePicks(): Promise<void> {
    await unsetAppSettings(PICK_SETTINGS);
    await unsetSetupFields(PICK_SETUP_FIELDS);
    await forgetModelPickerState();
}

export async function resetSessionSetup(): Promise<void> {
    await unsetAppSettings(SETUP_SETTINGS);
    await unsetSetupFieldsExcept(SETUP_FIELDS_KEPT);
}

export async function resetTourAndTips(): Promise<void> {
    await forgetGuideProgress();
    await forgetSettingsTourDismissal();
    await forgetNarratorNotice();
    await sharedKv.delete(SETUP_VOICE_HINT_KEY);
    forgetVoiceHints();
}

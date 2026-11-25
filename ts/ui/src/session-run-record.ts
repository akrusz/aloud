/**
 * The run record a saved session carries (SessionState.run in
 * src/facilitation/session.ts): the build, the settings behind the prompt and
 * the turn loop, and the frozen system prompt, so a real session can be
 * replayed or turned into an eval fixture.
 *
 * Every setting is copied by name from its source. Never spread SessionSetup
 * or AppSettings in here: they may hold or gain keys, tokens or account
 * details, and a session file is exported and shared.
 */

import type {
    RunSettingValue,
    SessionRunBuild,
    SessionRunRecord,
} from '../../src/facilitation/session.js';
import type { PromptConfig } from '../../src/facilitation/prompts.js';
import type { AppSettings } from './app-settings.js';
import type { NotingParticipantConfig, SessionSetup } from './settings.js';
import { clientPlatform, runningVersion } from './client-version.js';

export function runBuild(): SessionRunBuild {
    return {
        version: runningVersion(),
        commit: typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__ : '',
        platform: clientPlatform(),
        dev: import.meta.env.DEV === true,
    };
}

export function buildRunRecord(
    build: SessionRunBuild,
    settings: Record<string, RunSettingValue>,
    systemPrompt?: string
): SessionRunRecord {
    return { build, settings, ...(systemPrompt !== undefined && { systemPrompt }) };
}

/** What the session view settled on that SessionSetup and AppSettings don't
 *  say, or say differently (mountSessionView). */
export interface ConversationRunInputs {
    setup: SessionSetup;
    appSettings: AppSettings;
    /** The PromptBuilder's config as the prompt froze. */
    prompt: PromptConfig;
    mode: string;
    /** The session's 2-letter language; a continued session keeps its own. */
    language: string;
    continuedFrom: string | null;
    checkinTiming: string;
    checkinContent: string;
    checkinWaitSec: number | null;
    voiceCommands: string;
    silenceBaseMs: number;
    silenceMaxMs: number;
    timerMin: number | null;
    endSessionOnTimer: boolean;
    sttEngine: string;
    sttModel: string;
    wholeReply: boolean;
}

export type ConversationRunSettings = {
    mode: string;
    language: string;
    provider: string;
    /** The raw model id (SessionSetup.model), not the label in
     *  SessionState.model. */
    model: string;
    continuedFrom: string | null;
    focuses: string[];
    qualities: string[];
    /** As composed: felt sense's check-in pace stands in for the guidance. */
    directiveness: number;
    verbosity: string;
    customInstructions: string;
    intention: string;
    firstSit: boolean;
    appControls: string;
    voiceNote: string;
    checkinTiming: string;
    checkinContent: string;
    /** Smart timing's wait before the model's first [WAIT]; null off smart. */
    checkinWaitSec: number | null;
    silenceCheckinSec: number;
    silenceMode: boolean;
    responseDelayMs: number;
    /** The pause-before-submit window, provider-aware (non-streaming). */
    silenceBaseMs: number;
    silenceMaxMs: number;
    /** Minutes on the countdown at the freeze; null with no timer running. */
    timerMin: number | null;
    endSessionOnTimer: boolean;
    autoQuitSilenceMin: number | null;
    resumeFromSummary: boolean;
    voiceCommands: string;
    voice: string | null;
    ttsRate: number;
    wholeReply: boolean;
    sttEngine: string;
    /** The hosted model id or the Whisper size; '' for a recognizer that
     *  names none. */
    sttModel: string;
    sttSpeculation: boolean;
};

export function conversationRunSettings(i: ConversationRunInputs): ConversationRunSettings {
    const { setup, appSettings, prompt } = i;
    return {
        mode: i.mode,
        language: i.language,
        provider: setup.provider,
        model: setup.model,
        continuedFrom: i.continuedFrom,
        focuses: [...prompt.focuses],
        qualities: [...prompt.qualities],
        directiveness: prompt.directiveness,
        verbosity: prompt.verbosity,
        customInstructions: prompt.customInstructions,
        intention: setup.intention,
        firstSit: setup.firstSit === true,
        appControls: prompt.appControls,
        voiceNote: prompt.voiceNote,
        checkinTiming: i.checkinTiming,
        checkinContent: i.checkinContent,
        checkinWaitSec: i.checkinWaitSec,
        silenceCheckinSec: appSettings.silenceCheckinSec,
        silenceMode: appSettings.silenceModeEnabled,
        responseDelayMs: appSettings.responseDelayMs,
        silenceBaseMs: i.silenceBaseMs,
        silenceMaxMs: i.silenceMaxMs,
        timerMin: i.timerMin,
        endSessionOnTimer: i.endSessionOnTimer,
        autoQuitSilenceMin: appSettings.autoQuitAfterSilence ? appSettings.autoQuitSilenceMin : null,
        resumeFromSummary: appSettings.resumeFromSummary,
        voiceCommands: i.voiceCommands,
        voice: setup.voice,
        ttsRate: setup.ttsRate,
        wholeReply: i.wholeReply,
        sttEngine: i.sttEngine,
        sttModel: i.sttModel,
        sttSpeculation: appSettings.sttSpeculation,
    };
}

export type NotingRunSettings = {
    mode: 'noting';
    language: string;
    provider: string;
    model: string;
    voice: string | null;
    ttsRate: number;
    /** One line per participant, e.g. "llm aloud:Harper reactive=low adaptive". */
    participants: string[];
    /** The cue sound ('chime' for the synth one); null with the cue off. */
    userTurnCue: string | null;
    sttEngine: string;
    sttModel: string;
};

export function notingRunSettings(
    setup: SessionSetup,
    stt: { engine: string; model: string }
): NotingRunSettings {
    return {
        mode: 'noting',
        language: setup.language,
        provider: setup.provider,
        model: setup.model,
        voice: setup.voice,
        ttsRate: setup.ttsRate,
        participants: (setup.notingParticipants ?? []).map(describeParticipant),
        userTurnCue: setup.notingUserTurnCue ? (setup.notingUserTurnCueSound ?? 'chime') : null,
        sttEngine: stt.engine,
        sttModel: stt.model,
    };
}

function describeParticipant(p: NotingParticipantConfig): string {
    const timing = p.timing === 'fixed' ? `fixed=${p.fixedDelaySec}s` : 'adaptive';
    switch (p.type) {
        case 'llm':
            return `llm ${p.voice ?? 'default'} reactive=${p.reactive} ${timing}`;
        case 'fixed':
            return `fixed ${p.voice ?? 'default'} ${JSON.stringify(p.phrase)} ${timing}`;
        case 'sound':
            return `sound ${p.sound} ${timing}`;
    }
}

/**
 * App-wide settings - cross-session defaults plus chrome (theme, text scale).
 * Distinct from SessionSetup (per-session intention, focuses, qualities); a
 * fresh setup view inherits these where it has no override.
 *
 * Persisted to KvStorage under one key, with no version normalization: added
 * fields get defaults from the loader, removed ones are silently dropped.
 */

import { createKv } from './adapters/kv.js';
import type { Provider } from './settings.js';

export type ThemeMode = 'auto' | 'dark' | 'light';
export type TtsEngineChoice = 'cloud' | 'macos' | 'piper' | 'browser' | 'elevenlabs';
/** Speech-to-text source. Always an explicit pick (no hidden "automatic") so
 *  the user controls where audio goes and knows when it costs credits. A stored
 *  null means the mode's flow default: Whisper locally -> browser speech ->
 *  hosted (resolveSttChoice in adapters/stt-picker). */
/** 'aloud' is hosted STT on the server-default model (OpenAI gpt-4o-transcribe);
 *  'aloud-gpt-transcribe' pins the newer/cheaper gpt-transcribe on the same
 *  hosted route (stt-picker.ts CLOUD_STT_RATES has both ☁️ rates). */
export type SttEngineChoice = 'whisper' | 'web-speech' | 'aloud' | 'aloud-gpt-transcribe' | 'capacitor';

/** When the facilitator checks in during silence: never, after a fixed
 *  interval (silenceCheckinSec), or model-set ('smart': the LLM prefixes
 *  [WAIT:Nm] to say how long the next silence stays protected). */
export type CheckinTiming = 'none' | 'simple' | 'smart';
/** What a check-in says: a stock phrase, or an LLM line generated from the
 *  session so far (which may choose to stay quiet). */
export type CheckinContent = 'simple' | 'smart';

export interface AppSettings {
    // Provider defaults for new sessions
    defaultProvider: Provider;
    defaultModel: string;
    /** On the hosted/website build, show bring-your-own-key providers (off by
     *  default - the hosted proxy is the intended path there). No effect on a
     *  local build, where BYOK is always shown. */
    enableByok: boolean;
    /** Show the expanded tier of hosted models (older and niche models kept for
     *  their distinct voices) in the model picker. Off by default so new users
     *  see a short curated list; toggled inline in the picker itself. */
    showAllModels: boolean;

    // Display
    textScale: number;
    themeMode: ThemeMode;
    /** Show the live cloud credit balance during a session. Off by default: a
     *  ticking balance is distracting mid-meditation, and it's a tap away on the
     *  setup pill and in Settings. meditation-pal-14s. */
    showSessionBalance: boolean;
    /** Keep a local log of sessions (default on). When on, every turn autosaves
     *  without an LLM summary, so a crash or going offline still leaves a
     *  recoverable transcript (the detailed summary is generated only on a clean
     *  end). When off, the end-session dialog still offers a one-tap save. */
    saveSessionLogs: boolean;
    /** When continuing a saved session, seed the model's context from the stored
     *  recap + last few exchanges instead of replaying the whole transcript, so
     *  a long session resumes for a few cents. The UI still shows the full
     *  transcript. Default on. */
    resumeFromSummary: boolean;
    /** Auto-save and end after this many minutes of no user activity: an open
     *  session keeps listening and checking in, slowly burning cloud TTS/STT
     *  credit. Default on; minutes clamped 10-300. */
    autoQuitAfterSilence: boolean;
    autoQuitSilenceMin: number;

    // TTS preferences
    ttsEngine: TtsEngineChoice;
    defaultVoice: string | null;
    defaultTtsRate: number;

    // Speech recognition
    language: string;
    /** Local Whisper model size, sent per stt request (with `language`) so the
     *  desktop shell downloads/loads the matching whisper.cpp model. Named
     *  sttWhisperModel (not the pre-2.4 `whisperModel`) ON PURPOSE: the old key
     *  never did anything and everyone has its 'small' default persisted -
     *  honoring it now would silently pull a 466 MB model for every desktop
     *  user. The rename drops stored values once; explicit picks stick. */
    sttWhisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large';
    /** Where speech-to-text runs, or null to use the mode's flow default. See
     *  SttEngineChoice + resolveSttChoice. */
    sttEngine: SttEngineChoice | null;
    /** Capture device (MediaDeviceInfo.deviceId) for the mic-capturing STT
     *  paths (Whisper / aloud cloud); null = the system default. Applied as an
     *  `ideal` constraint, so an unplugged saved mic falls back to the default
     *  instead of a dead mic. Web Speech and native mobile pick their own. */
    micDeviceId: string | null;

    // Pacing - used by both the session view's PacingController and
    // the STT adapter's client-side VAD.
    silenceBaseMs: number;
    silenceMaxMs: number;
    responseDelayMs: number;
    /**
     * Pause-detection window (VAD trailing-silence submit base + max) for
     * non-streaming providers, i.e. the Claude subscription. Such a reply can't
     * speak until fully generated, so it can't talk over a mid-thought pause,
     * and these users pay by subscription, so a too-early submit that a resumed
     * utterance supersedes (respondTo's turnGen/activeFullAbort) costs nothing.
     * Shorter than the streaming values purely to cut latency. Floored at 1s.
     */
    nonStreamingSilenceBaseMs: number;
    nonStreamingSilenceMaxMs: number;
    silenceCheckinSec: number;
    checkinTiming: CheckinTiming;
    checkinContent: CheckinContent;
    silenceModeEnabled: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
    defaultProvider: 'ollama',
    defaultModel: '',
    enableByok: false,
    showAllModels: false,
    textScale: 1.0,
    themeMode: 'auto',
    showSessionBalance: false,
    saveSessionLogs: true,
    resumeFromSummary: true,
    autoQuitAfterSilence: true,
    autoQuitSilenceMin: 120,
    ttsEngine: 'cloud',
    defaultVoice: null,
    defaultTtsRate: 160,
    language: 'en',
    sttWhisperModel: 'base',
    sttEngine: null,
    micDeviceId: null,
    silenceBaseMs: 3000,
    silenceMaxMs: 5000,
    responseDelayMs: 2000,
    nonStreamingSilenceBaseMs: 1500,
    nonStreamingSilenceMaxMs: 4000,
    silenceCheckinSec: 300,
    // Smart by default for both halves: the model paces the silences ([WAIT:Nm],
    // guidance-biased defaults) and writes the line.
    checkinTiming: 'smart',
    checkinContent: 'smart',
    silenceModeEnabled: true,
};

/**
 * Speech-recognition / voice-preview languages. Single source of truth: the
 * settings dropdown renders these and `detectLocale()` validates against them.
 */
export const LANGUAGES: ReadonlyArray<[string, string]> = [
    ['en', 'English'],
    ['es', 'Español'],
    ['fr', 'Français'],
    ['de', 'Deutsch'],
    ['it', 'Italiano'],
    ['pt', 'Português'],
    ['nl', 'Nederlands'],
    ['pl', 'Polski'],
    ['ru', 'Русский'],
    ['uk', 'Українська'],
    ['ja', '日本語'],
    ['zh', '中文'],
    ['ko', '한국어'],
    ['ar', 'العربية'],
    ['hi', 'हिन्दी'],
    ['tr', 'Türkçe'],
    ['vi', 'Tiếng Việt'],
    ['th', 'ภาษาไทย'],
    ['sv', 'Svenska'],
    ['da', 'Dansk'],
    ['no', 'Norsk'],
    ['fi', 'Suomi'],
    ['el', 'Ελληνικά'],
    ['he', 'עברית'],
    ['cs', 'Čeština'],
    ['ro', 'Română'],
    ['hu', 'Magyar'],
    ['id', 'Bahasa Indonesia'],
    ['ms', 'Bahasa Melayu'],
    ['ca', 'Català'],
];

const SUPPORTED_LANGUAGE_CODES = new Set(LANGUAGES.map(([code]) => code));

/** The browser's UI language as a supported 2-letter code, or 'en' when it
 *  isn't listed (or there's no navigator, e.g. in tests). */
export function detectLocale(): string {
    if (typeof navigator === 'undefined') return 'en';
    const base = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED_LANGUAGE_CODES.has(base) ? base : 'en';
}

const KEY = 'app:settings';
const kv = createKv();

export async function loadAppSettings(): Promise<AppSettings> {
    const raw = await kv.get(KEY);
    // No stored settings, or none with an explicit language: seed from the
    // browser locale. An explicit stored choice wins.
    if (!raw) return { ...DEFAULT_APP_SETTINGS, language: detectLocale() };
    try {
        const parsed = JSON.parse(raw) as Partial<AppSettings> & {
            /** Pre-radio check-in toggle; folded into checkinTiming on load. */
            silenceCheckinsEnabled?: boolean;
        };
        if (parsed.checkinTiming === undefined && parsed.silenceCheckinsEnabled === false) {
            parsed.checkinTiming = 'none';
        }
        delete parsed.silenceCheckinsEnabled;
        return { ...DEFAULT_APP_SETTINGS, ...parsed, language: parsed.language ?? detectLocale() };
    } catch {
        return { ...DEFAULT_APP_SETTINGS, language: detectLocale() };
    }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
    await kv.set(KEY, JSON.stringify(settings));
}

/**
 * Apply chrome-level settings (text scale, theme) to the live document, at boot
 * and after a save. Theme also persists to localStorage (theme.ts owns the key)
 * so the FOUC preempt in index.html picks it up.
 */
export function applyChromeSettings(settings: AppSettings): void {
    document.documentElement.style.setProperty('--text-scale', String(settings.textScale));
    if (settings.themeMode === 'auto') {
        // theme.ts handles auto resolution; clear any explicit override.
        localStorage.removeItem('themeMode');
    } else {
        localStorage.setItem('themeMode', settings.themeMode);
        document.documentElement.setAttribute('data-theme', settings.themeMode);
    }
}

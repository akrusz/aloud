/**
 * App-wide settings - cross-session defaults plus chrome (theme, text scale).
 * Distinct from SessionSetup (per-session intention, focuses, qualities); a
 * fresh setup view inherits these where it has no override.
 *
 * Persisted to KvStorage under one key, with no version normalization: added
 * fields get defaults from the loader, removed ones are silently dropped.
 */

import { createKv } from './adapters/kv.js';
import type { KvStorage } from '../../src/platform/storage.js';
import type { Provider } from './settings.js';

export type ThemeMode = 'auto' | 'dark' | 'light';
export type TtsEngineChoice = 'cloud' | 'macos' | 'piper' | 'browser' | 'elevenlabs';
/** Speech-to-text source. Always an explicit pick (no hidden "automatic") so
 *  the user controls where audio goes and knows when it costs credits. A stored
 *  null means the mode's flow default: Whisper locally -> browser speech ->
 *  hosted (resolveSttChoice in adapters/stt-picker). */
/** 'aloud-gpt-transcribe' pins OpenAI's gpt-transcribe and is the one hosted
 *  choice, labelled "aloud cloud" (see stt-picker.ts sttEngineOptions). The id
 *  keeps the model in the name because a stored pick outlives the model. */
export type SttEngineChoice = 'whisper' | 'web-speech' | 'aloud-gpt-transcribe' | 'capacitor';

/** When the facilitator checks in during silence: never, after a fixed
 *  interval (silenceCheckinSec), or model-set ('smart': the LLM prefixes
 *  [WAIT:Nm] to say how long the next silence stays protected). */
export type CheckinTiming = 'none' | 'simple' | 'smart';
/** What a check-in says: a stock phrase, or an LLM line generated from the
 *  session so far (which may choose to stay quiet). */
export type CheckinContent = 'simple' | 'smart';

/** What the session clock reads out: time since the session started, the time
 *  of day, or a countdown to a set duration ('timer'). Tapping the clock opens
 *  the picker; the choice persists across sessions. */
export type SessionClockMode = 'elapsed' | 'wall' | 'timer';

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
    /** What the session clock reads out. Persists across sessions: tapping the
     *  clock (or the Session clock button on setup) opens the picker. */
    sessionClockMode: SessionClockMode;
    /** Timer length in minutes, remembered so a daily 20-minute sit re-arms
     *  itself. Only meaningful under sessionClockMode 'timer'. */
    sessionTimerMin: number;
    /** Show the clock readout during a session (default on). Independent of the
     *  mode ON PURPOSE: "run a 20 minute timer with no ticking clock, just tell
     *  me when" is a real ask, and hiding the readout must not disarm the
     *  timer's spoken notices. */
    showSessionClock: boolean;
    /** End the session once the timer's closing word has been spoken (default
     *  off). Off means the timer only says the time is up and the sit stays
     *  open, which is what a meditation timer usually means; on is for people
     *  who want the sit to actually stop. Either way the facilitator says so
     *  first - nothing ends the session without a spoken close. */
    endSessionOnTimer: boolean;
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
    sessionClockMode: 'elapsed',
    sessionTimerMin: 20,
    showSessionClock: true,
    endSessionOnTimer: false,
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
 * Session languages on offer. Single source of truth: the Settings dropdown
 * renders these and `detectLocale()` validates against them. There is no
 * per-session pick - setup's selector was removed 2026-08-31.
 *
 * Deliberately just the languages the app actually FACILITATES in (canned
 * pools, prompt fragment, mute command - src/facilitation/language.ts). The
 * pre-c3a0 list offered ~30 recognizer languages, which half-worked: STT heard
 * you and the model usually mirrored you, but every canned line stayed English.
 * The STT plumbing still accepts any 2-letter code, so restoring a language is
 * one row here plus its facilitation strings (the old list is in git history).
 */
export const LANGUAGES: ReadonlyArray<[string, string]> = [
    ['en', 'English'],
    ['zh', '中文 (Beta)'],
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
// Lazy: constructing a backend at module scope makes merely IMPORTING this file
// (or anything that re-exports through settings.ts) throw outside a browser,
// which is how a Node test that only wanted a pure helper ended up building
// localStorage. Same lazy pattern as cloud-auth.ts.
let lazyKv: KvStorage | null = null;
function kv(): KvStorage {
    if (!lazyKv) lazyKv = createKv();
    return lazyKv;
}

export async function loadAppSettings(): Promise<AppSettings> {
    const raw = await kv().get(KEY);
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
        // Language must be an offered code: the pre-c3a0 list had ~30, so a
        // stored 'es'/'ja' from that era normalizes back to the browser seed
        // rather than riding invisibly under a select that can't show it.
        const language =
            parsed.language && SUPPORTED_LANGUAGE_CODES.has(parsed.language)
                ? parsed.language
                : detectLocale();
        return { ...DEFAULT_APP_SETTINGS, ...parsed, language };
    } catch {
        return { ...DEFAULT_APP_SETTINGS, language: detectLocale() };
    }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
    await kv().set(KEY, JSON.stringify(settings));
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

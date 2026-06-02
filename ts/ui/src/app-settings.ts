/**
 * App-wide settings — defaults that apply across sessions.
 *
 * Distinct from SessionSetup (per-session config like intention,
 * focuses, qualities). These settings are what a fresh setup view
 * inherits when no per-session overrides exist, plus chrome-level
 * things like theme and text scale.
 *
 * Persisted to KvStorage under a single key. We don't normalize
 * across versions — when fields are added the loader fills in
 * defaults, when fields are removed old values are silently dropped.
 */

import { LocalStorageKv } from './adapters/localstorage-kv.js';
import type { Provider } from './settings.js';

export type ThemeMode = 'auto' | 'dark' | 'light';
export type TtsEngineChoice = 'macos' | 'piper' | 'browser' | 'elevenlabs';
/** Speech-to-text source — always an explicit pick (no hidden "automatic"), so
 *  the user controls where audio goes and knows when it costs credits. When the
 *  stored value is null, the mode's flow default is used (Whisper locally →
 *  browser speech → hosted; see resolveSttChoice in adapters/stt-picker). */
export type SttEngineChoice = 'whisper' | 'web-speech' | 'aloud';

export interface AppSettings {
    // Provider defaults for new sessions
    defaultProvider: Provider;
    defaultModel: string;
    /** On the hosted/website build, show bring-your-own-key providers (off by
     *  default — the hosted proxy is the intended path there). No effect on a
     *  local build, where BYOK is always shown. */
    enableByok: boolean;

    // Display
    textScale: number;
    themeMode: ThemeMode;
    /** Show the live cloud credit balance during a session (off by default — a
     *  ticking balance is distracting mid-meditation; the balance is always a tap
     *  away on the setup pill and in Settings). meditation-pal-14s. */
    showSessionBalance: boolean;

    // TTS preferences
    ttsEngine: TtsEngineChoice;
    defaultVoice: string | null;
    defaultTtsRate: number;

    // Speech recognition
    language: string;
    whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large';
    /** Where speech-to-text runs, or null to use the mode's flow default. See
     *  SttEngineChoice + resolveSttChoice. */
    sttEngine: SttEngineChoice | null;

    // Pacing — used by both the session view's PacingController and
    // the STT adapter's client-side VAD. Mirrors the Python config's
    // pacing block 1:1.
    silenceBaseMs: number;
    silenceMaxMs: number;
    responseDelayMs: number;
    silenceCheckinSec: number;
    silenceCheckinsEnabled: boolean;
    silenceModeEnabled: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
    defaultProvider: 'ollama',
    defaultModel: '',
    enableByok: false,
    textScale: 1.0,
    themeMode: 'auto',
    showSessionBalance: false,
    ttsEngine: 'browser',
    defaultVoice: null,
    defaultTtsRate: 160,
    language: 'en',
    whisperModel: 'small',
    sttEngine: null,
    silenceBaseMs: 3000,
    silenceMaxMs: 5000,
    responseDelayMs: 2000,
    silenceCheckinSec: 300,
    silenceCheckinsEnabled: true,
    silenceModeEnabled: true,
};

/**
 * Speech-recognition / voice-preview language options. Single source of
 * truth — the settings dropdown renders these and `detectLocale()` validates
 * the browser locale against them. Ported from the Flask settings page.
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

/**
 * The browser's UI language as a supported 2-letter code, or 'en' if the
 * locale isn't one we list (or there's no navigator, e.g. in tests).
 */
export function detectLocale(): string {
    if (typeof navigator === 'undefined') return 'en';
    const base = (navigator.language || 'en').slice(0, 2).toLowerCase();
    return SUPPORTED_LANGUAGE_CODES.has(base) ? base : 'en';
}

const KEY = 'app:settings';
const kv = new LocalStorageKv();

export async function loadAppSettings(): Promise<AppSettings> {
    const raw = await kv.get(KEY);
    // No stored settings, or none with an explicit language: seed the
    // language from the browser locale (matching the old Flask page, which
    // pre-selected navigator.language). An explicit stored choice wins.
    if (!raw) return { ...DEFAULT_APP_SETTINGS, language: detectLocale() };
    try {
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        return { ...DEFAULT_APP_SETTINGS, ...parsed, language: parsed.language ?? detectLocale() };
    } catch {
        return { ...DEFAULT_APP_SETTINGS, language: detectLocale() };
    }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
    await kv.set(KEY, JSON.stringify(settings));
}

/**
 * Apply chrome-level settings (text scale, theme) to the live document.
 * Called at app boot and after settings are saved. Theme persists via
 * localStorage too (theme.ts manages that key) so the FOUC preempt in
 * index.html picks it up.
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

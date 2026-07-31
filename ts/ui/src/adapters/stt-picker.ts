/**
 * Pick an STT adapter at runtime, in order of preference:
 *
 *   1. Capacitor native plugin   - best on iOS/Android. The PLATFORM's
 *                                  recognizer, so not necessarily on-device:
 *                                  Android's may send audio to Google
 *   2. Web Speech API            - Chrome / Edge / Android Chrome
 *   3. Server Whisper            - covers Firefox, Safari, and anywhere else
 *                                  Web Speech doesn't, given a reachable
 *                                  endpoint (the desktop Rust shell's
 *                                  /app/v1/stt/whisper), so it's the reliable
 *                                  desktop path
 *   4. null                      - text-only mode
 *
 * Detection is async (Capacitor + server probe); the result is cached.
 */

import type { SttEngine } from '../../../src/platform/stt.js';
import type { PacingConfig } from '../../../src/facilitation/pacing.js';

import { rateSuffix } from '../credit-rate.js';
import { CapacitorSttEngine, type CapacitorSttEngineOptions } from './capacitor-stt.js';
import { WhisperPcmSttEngine } from './whisper-pcm-stt.js';
import {
    WebSpeechSttEngine,
    isWebSpeechSupported,
    type WebSpeechSttEngineOptions,
} from './web-speech-stt.js';
import { cloudUrl } from '../cloud-base.js';
import { ensureCloudToken, clearCloudToken } from '../cloud-auth.js';
import { isTauri, isCapacitor } from '../is-desktop.js';
import { appUrl } from '../app-base.js';
import type { SttEngineChoice } from '../app-settings.js';

/** VAD-tuning subset of PacingConfig the picker forwards to adapters, plus the
 *  capture-device pick and the local-Whisper model params. Only the PCM
 *  engines (Whisper / aloud cloud) consume micDeviceId - Web Speech and the
 *  native recognizer own their capture; whisperModelSize/language reach only
 *  the LOCAL Whisper engine (the cloud endpoint picks its own model). */
type VadOpts = Partial<
    Pick<
        PacingConfig,
        'silenceBaseMs' | 'silenceMaxMs' | 'silenceRampRate' | 'minSpeechDurationMs'
    >
> & { micDeviceId?: string | null; whisperModelSize?: string | null; language?: string | null };

export type SttBackend = 'capacitor' | 'web-speech' | 'server-whisper' | 'none';

// Resolved through appUrl(): the desktop's embedded Rust backend
// (127.0.0.1:<port>) under Tauri, or the relative /app path (Hono) on the web.
const SERVER_WHISPER_PATH = '/stt/whisper';
const SERVER_WHISPER_WARM_PATH = '/stt/whisper/warm';
let cachedBackend: SttBackend | null = null;

async function isServerWhisperReachable(vadOpts: VadOpts = {}): Promise<boolean> {
    if (!WhisperPcmSttEngine.isAvailable()) return false;
    try {
        // GET /warm: a 200 proves the local whisper route is wired (the web
        // Hono 404s, Vite's proxy 5xxes when the backend is down - both fail
        // closed). The model params make the shell start loading THIS
        // session's model now, during setup - without the warm, the retarget
        // waited for the first utterance, which 503'd into a lost first turn
        // after a model/language change.
        const params = vadOpts.whisperModelSize
            ? `?model_size=${encodeURIComponent(vadOpts.whisperModelSize)}` +
              `&lang=${encodeURIComponent(vadOpts.language ?? 'en')}`
            : '';
        const response = await fetch(appUrl(`${SERVER_WHISPER_WARM_PATH}${params}`));
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * Force a re-probe on the next detectSttBackend / createBestStt. Needed when
 * the Whisper backend came up after page load - otherwise the picker keeps the
 * cached "none" and the user has to reload.
 */
export function invalidateSttBackendCache(): void {
    cachedBackend = null;
}

/**
 * STT through the aloud cloud's authed /cloud/v1/stt (OpenAI gpt-4o-transcribe
 * by default; Groq/custom via server env). Same client-side capture/VAD as
 * desktop server-Whisper - only endpoint + bearer token differ. Used when a
 * session runs on the hosted ('aloud') provider. Null when mic capture isn't
 * available here.
 */
export function createServerAloudStt(vadOpts: VadOpts = {}, model?: string): SttEngine | null {
    if (!WhisperPcmSttEngine.isAvailable()) return null;
    // Strip the local-Whisper model params: the cloud endpoint would receive
    // them as stray query params (it picks its own model server-side unless
    // `model` pins one of its allowlisted alternates).
    const { whisperModelSize: _size, language: _lang, ...rest } = vadOpts;
    return new WhisperPcmSttEngine({
        ...rest,
        ...(model ? { cloudModel: model } : {}),
        endpointUrl: cloudUrl('/stt'),
        authProvider: ensureCloudToken,
        // Drop a rejected token and re-sign-in once (mirrors the LLM/TTS
        // adapters), so a stale session doesn't break hosted STT page-wide.
        onAuthError: clearCloudToken,
    });
}

/** Detect which STT path the current environment supports. vadOpts (when the
 *  caller has them) ride along to the whisper probe, which doubles as the
 *  model warm-up. */
export async function detectSttBackend(vadOpts: VadOpts = {}): Promise<SttBackend> {
    if (cachedBackend !== null) return cachedBackend;

    // Prefer the native on-device recognizer (SFSpeechRecognizer / Android
    // SpeechRecognizer). isCapacitor() is the native-only gate - a plain browser
    // running the Capacitor web shim reports false and falls through.
    if (isCapacitor()) {
        try {
            const available = await CapacitorSttEngine.isAvailable();
            if (available) {
                cachedBackend = 'capacitor';
                return cachedBackend;
            }
        } catch {
            // Fall through to next option.
        }
    }

    // The macOS WKWebView exposes `webkitSpeechRecognition` but recognition
    // silently never returns results inside an embedded app webview: the mic
    // captures, no transcript ever arrives. Skip it under Tauri and fall through
    // to server-Whisper, which is the free/on-device path we want there anyway.
    if (!isTauri() && isWebSpeechSupported()) {
        cachedBackend = 'web-speech';
        return cachedBackend;
    }

    if (await isServerWhisperReachable(vadOpts)) {
        cachedBackend = 'server-whisper';
        return cachedBackend;
    }

    cachedBackend = 'none';
    return cachedBackend;
}

/**
 * Construct the best-available STT engine, or null so the caller can switch the
 * UI into text-only mode. Only the server-Whisper path does client-side VAD;
 * Web Speech and Capacitor self-endpoint, but both honor the pause window by
 * holding the turn open across a mid-thought pause (Web Speech runs continuous;
 * Capacitor restart-stitches, since Android won't keep the mic open).
 */
export async function createBestStt(vadOpts: VadOpts = {}): Promise<SttEngine | null> {
    const backend = await detectSttBackend(vadOpts);
    switch (backend) {
        case 'capacitor':
            return new CapacitorSttEngine(capacitorOpts(vadOpts));
        case 'web-speech':
            return new WebSpeechSttEngine(webSpeechOpts(vadOpts));
        case 'server-whisper':
            return new WhisperPcmSttEngine({
                ...vadOpts,
                endpointUrl: appUrl(SERVER_WHISPER_PATH),
            });
        case 'none':
            return null;
    }
}

/** Map the VAD pause settings onto Web Speech's submit-delay options (Chrome
 *  otherwise submits the instant it detects a pause). Mirrors the
 *  server-Whisper adaptive ramp: base + speech×ramp, capped at max. */
function webSpeechOpts(vadOpts: VadOpts): WebSpeechSttEngineOptions {
    const opts: WebSpeechSttEngineOptions = {};
    if (vadOpts.silenceBaseMs !== undefined) opts.submitDelayMs = vadOpts.silenceBaseMs;
    if (vadOpts.silenceMaxMs !== undefined) opts.submitMaxDelayMs = vadOpts.silenceMaxMs;
    if (vadOpts.silenceRampRate !== undefined) opts.submitRampRate = vadOpts.silenceRampRate;
    return opts;
}

/** Same mapping for the native engine. Android's recognizer endpoints on a
 *  ~1.5s pause, so without this a mid-thought pause ships a fragment to the AI;
 *  the engine restart-stitches to hold the turn open for this window instead. */
function capacitorOpts(vadOpts: VadOpts): CapacitorSttEngineOptions {
    const opts: CapacitorSttEngineOptions = {};
    if (vadOpts.silenceBaseMs !== undefined) opts.submitDelayMs = vadOpts.silenceBaseMs;
    if (vadOpts.silenceMaxMs !== undefined) opts.submitMaxDelayMs = vadOpts.silenceMaxMs;
    if (vadOpts.silenceRampRate !== undefined) opts.submitRampRate = vadOpts.silenceRampRate;
    return opts;
}

/**
 * Build the STT engine for an explicit user choice (Settings → Speech
 * Recognition). Null when that source isn't usable here (Whisper with no local
 * backend, web-speech without the API), so the caller can show the honest
 * mic-unavailable state.
 */
export async function createSttForChoice(
    choice: SttEngineChoice,
    vadOpts: VadOpts = {}
): Promise<SttEngine | null> {
    switch (choice) {
        case 'capacitor':
            // Native app only; a stale stored pick outside it gets the honest
            // mic-unavailable state, not a plugin that throws at start().
            return isCapacitor() ? new CapacitorSttEngine(capacitorOpts(vadOpts)) : null;
        case 'aloud':
            return createServerAloudStt(vadOpts);
        case 'aloud-gpt-transcribe':
            return createServerAloudStt(vadOpts, 'gpt-transcribe');
        case 'web-speech':
            // Same Tauri guard as detectSttBackend/sttEngineOptions - honor a
            // stale stored pick with null rather than a mic that pulses forever.
            return !isTauri() && isWebSpeechSupported()
                ? new WebSpeechSttEngine(webSpeechOpts(vadOpts))
                : null;
        case 'whisper':
            // The probe doubles as the model warm-up (see above), so pass the
            // session's model params through.
            return (await isServerWhisperReachable(vadOpts))
                ? new WhisperPcmSttEngine({ ...vadOpts, endpointUrl: appUrl(SERVER_WHISPER_PATH) })
                : null;
    }
}

/** The SttBackend label for a choice - drives the barge-in wrapper decision
 *  downstream (continuous-capture backends self-detect and skip the wrapper). */
export function sttBackendForChoice(choice: SttEngineChoice): SttBackend {
    switch (choice) {
        case 'capacitor':
            return 'capacitor';
        case 'aloud':
        case 'aloud-gpt-transcribe':
        case 'whisper':
            return 'server-whisper';
        case 'web-speech':
            return 'web-speech';
    }
}

/** ☁️/hr badges for the hosted STT options — the flat advertised rates the
 *  server bills exactly (its pricing/providers.ts STT_MODEL_PRICING; per
 *  typical session-hour of talking, the same unit as the model/voice pickers).
 *  'aloud' is the server-default model (OpenAI gpt-4o-transcribe);
 *  'aloud-gpt-transcribe' pins OpenAI's newer gpt-transcribe (July 2026),
 *  offered alongside while it's validated — it may replace the default. */
export const CLOUD_STT_RATES = { aloud: 2, 'aloud-gpt-transcribe': 1 } as const;

/** The hosted (credit-spending, cloud-auth) STT choices. */
export function isHostedSttChoice(choice: SttEngineChoice): boolean {
    return choice === 'aloud' || choice === 'aloud-gpt-transcribe';
}

/** ☁️/hr for a picker choice — 0 for the free local/browser engines. */
export function cloudSttCreditsPerHour(choice: SttEngineChoice): number {
    return choice === 'aloud' || choice === 'aloud-gpt-transcribe'
        ? CLOUD_STT_RATES[choice]
        : 0;
}

/**
 * Which STT choices to offer for the current mode, in flow-default order:
 * Whisper (local-only - no on-device backend on the web), then browser speech
 * (only when the browser exposes the API), then the hosted option (always, and
 * the only one that costs credits). The first entry is the mode's default.
 */
export function sttEngineOptions(webMode: boolean): Array<{ value: SttEngineChoice; label: string }> {
    const out: Array<{ value: SttEngineChoice; label: string }> = [];
    // The native mobile recognizer: free, no sign-in, no credits. Labelled for
    // what it IS, not where the audio goes - Android's routes to Google, so
    // don't reintroduce a privacy claim ("private" went in 580e049, "On-device"
    // after it; sn1w tracks earning it back). Capacitor-only (web/desktop builds
    // never have it), and first so it defaults there. Vocabulary per the plan
    // (meditation-pal-7ej); meditation-speech quality still device-validated
    // (meditation-pal-0ao), with aloud cloud one tap below if it disappoints.
    if (isCapacitor()) out.push({ value: 'capacitor', label: 'Built-in speech' });
    // Local Whisper exists only in the desktop (Tauri) Rust shell: Hono doesn't
    // serve the /app whisper route, and the desktop's loopback backend isn't
    // reachable from a separate browser, so offering it on the web gives a dead
    // mic. Browsers fall through to web-speech (Chrome) / aloud cloud.
    if (!webMode && isTauri()) out.push({ value: 'whisper', label: 'Whisper (on this device)' });
    // Browser speech needs a recognizer that actually works. Not under Tauri:
    // the macOS WKWebView exposes webkitSpeechRecognition but never returns
    // results (same reason detectSttBackend skips it), and desktop has Whisper +
    // cloud. Not in the native app either: the plugin above is better.
    if (!isTauri() && !isCapacitor() && isWebSpeechSupported()) {
        out.push({ value: 'web-speech', label: 'Browser speech recognition' });
    }
    out.push({ value: 'aloud', label: `aloud cloud${rateSuffix(CLOUD_STT_RATES['aloud'])}` });
    // OpenAI's gpt-transcribe on the same hosted route: cheaper and (per
    // benchmarks) more accurate than the default's gpt-4o-transcribe. A second
    // entry while it's validated in real sessions — it may replace the default,
    // retiring this split.
    out.push({
        value: 'aloud-gpt-transcribe',
        label: `aloud cloud - new${rateSuffix(CLOUD_STT_RATES['aloud-gpt-transcribe'])}`,
    });
    return out;
}

/** The mode's default STT source: the first available option in flow order. */
export function defaultSttChoice(webMode: boolean): SttEngineChoice {
    return sttEngineOptions(webMode)[0]!.value;
}

/** The stored pick if this mode offers it, else the mode's flow default.
 *  Handles null (never chosen) and a stale pick carried across a mode change. */
export function resolveSttChoice(stored: SttEngineChoice | null, webMode: boolean): SttEngineChoice {
    const offered = sttEngineOptions(webMode).map((o) => o.value);
    return stored && offered.includes(stored) ? stored : defaultSttChoice(webMode);
}

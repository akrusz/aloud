/**
 * Pick an STT adapter at runtime based on what the host environment
 * supports. Order of preference:
 *
 *   1. Capacitor native plugin   — best on iOS/Android (no network)
 *   2. Web Speech API            — fine on Chrome / Edge / Android Chrome
 *   3. Server Whisper            — universal fallback when Flask is up
 *   4. null                      — text-only mode
 *
 * Server Whisper is preferred over `null` because it works on Firefox,
 * Safari, and anywhere else the Web Speech API doesn't cover. It does
 * require the Flask backend to be reachable — that's the user's
 * desktop runtime, so it's reliable in development.
 *
 * Detection is async (Capacitor + server probe) and the result is
 * cached so the picker stays cheap.
 */

import type { SttEngine } from '../../../src/platform/stt.js';
import type { PacingConfig } from '../../../src/facilitation/pacing.js';

import { CapacitorSttEngine } from './capacitor-stt.js';
import { CloudWhisperSttEngine } from './cloud-whisper-stt.js';
import {
    WebSpeechSttEngine,
    isWebSpeechSupported,
    type WebSpeechSttEngineOptions,
} from './web-speech-stt.js';
import { cloudUrl } from '../cloud-base.js';
import { ensureCloudToken } from '../cloud-auth.js';
import { isTauri } from '../is-desktop.js';
import { appUrl } from '../app-base.js';
import type { SttEngineChoice } from '../app-settings.js';

/** VAD-tuning subset of PacingConfig the picker forwards to adapters. */
type VadOpts = Partial<
    Pick<
        PacingConfig,
        'silenceBaseMs' | 'silenceMaxMs' | 'silenceRampRate' | 'minSpeechDurationMs'
    >
>;

export type SttBackend = 'capacitor' | 'web-speech' | 'server-whisper' | 'none';

// Resolved through appUrl() so it targets the desktop's embedded Rust backend
// (127.0.0.1:<port>) under Tauri, or the relative path (Flask via the Vite
// proxy / same-origin) in the browser dev + web builds.
const SERVER_WHISPER_PATH = '/stt/whisper';
let cachedBackend: SttBackend | null = null;

async function isServerWhisperReachable(): Promise<boolean> {
    if (!CloudWhisperSttEngine.isAvailable()) return false;
    try {
        // Empty POST → the backend returns 400 (route exists, body missing) or
        // 503 (model still loading). Either proves the STT route is wired. A 5xx
        // from Vite's proxy (ECONNREFUSED, etc.) means the backend is down —
        // fail closed so we don't pretend the mic will work.
        const response = await fetch(appUrl(SERVER_WHISPER_PATH), {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
        });
        return response.status === 400 || response.status === 503;
    } catch {
        return false;
    }
}

/**
 * Force a re-probe on the next detectSttBackend / createBestStt call.
 * Call this when Flask was started after the page loaded — otherwise
 * the picker caches "none" and the user has to reload.
 */
export function invalidateSttBackendCache(): void {
    cachedBackend = null;
}

/**
 * STT that routes mic audio through the aloud cloud's authed /v1/stt (Groq
 * Whisper) instead of Flask. Same client-side capture/VAD as server-Whisper —
 * only the endpoint and a bearer token differ. Used when a session is on the
 * hosted ('aloud') provider so the whole pipeline runs against @aloud/server.
 * Returns null when mic capture isn't available in this environment.
 */
export function createServerAloudStt(vadOpts: VadOpts = {}): SttEngine | null {
    if (!CloudWhisperSttEngine.isAvailable()) return null;
    return new CloudWhisperSttEngine({
        ...vadOpts,
        endpointUrl: cloudUrl('/stt'),
        authProvider: ensureCloudToken,
    });
}

/** Detect which STT path the current environment supports. */
export async function detectSttBackend(): Promise<SttBackend> {
    if (cachedBackend !== null) return cachedBackend;

    // Capacitor sets `window.Capacitor` when running inside the native
    // wrapper — cheap synchronous check before the async availability probe.
    const hasCapacitor =
        typeof window !== 'undefined' &&
        (window as unknown as { Capacitor?: unknown }).Capacitor !== undefined;
    if (hasCapacitor) {
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

    // The macOS WKWebView exposes `webkitSpeechRecognition` (so
    // isWebSpeechSupported() is true) but recognition silently never returns
    // results inside an embedded app webview — the mic captures audio but no
    // transcript ever arrives. Skip Web Speech under Tauri and fall through to
    // server-Whisper (the desktop's own STT backend), which is also the
    // free/on-device path we want on desktop anyway.
    if (!isTauri() && isWebSpeechSupported()) {
        cachedBackend = 'web-speech';
        return cachedBackend;
    }

    if (await isServerWhisperReachable()) {
        cachedBackend = 'server-whisper';
        return cachedBackend;
    }

    cachedBackend = 'none';
    return cachedBackend;
}

/**
 * Construct the best-available STT engine. Returns null when nothing is
 * available so the caller can switch the UI into text-only mode.
 *
 * Only the server-Whisper path implements client-side VAD, so the VAD
 * tuning fields are silently ignored by the other adapters (Capacitor
 * and Web Speech both auto-detect end-of-utterance themselves).
 */
export async function createBestStt(vadOpts: VadOpts = {}): Promise<SttEngine | null> {
    const backend = await detectSttBackend();
    switch (backend) {
        case 'capacitor':
            return new CapacitorSttEngine();
        case 'web-speech':
            return new WebSpeechSttEngine(webSpeechOpts(vadOpts));
        case 'server-whisper':
            return new CloudWhisperSttEngine({
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

/**
 * Build the STT engine for an explicit user choice (Settings → Speech
 * Recognition). Returns null when that source isn't usable here — Whisper
 * picked but no local backend, or web-speech in a browser without the API — so
 * the caller shows the honest mic-unavailable state. 'auto' defers to
 * createBestStt (the environment cascade).
 */
export async function createSttForChoice(
    choice: SttEngineChoice,
    vadOpts: VadOpts = {}
): Promise<SttEngine | null> {
    switch (choice) {
        case 'aloud':
            return createServerAloudStt(vadOpts);
        case 'web-speech':
            return isWebSpeechSupported() ? new WebSpeechSttEngine(webSpeechOpts(vadOpts)) : null;
        case 'whisper':
            return (await isServerWhisperReachable())
                ? new CloudWhisperSttEngine({ ...vadOpts, endpointUrl: appUrl(SERVER_WHISPER_PATH) })
                : null;
    }
}

/** The SttBackend label for a choice — drives the barge-in wrapper decision
 *  downstream (continuous-capture backends self-detect and skip the wrapper). */
export function sttBackendForChoice(choice: SttEngineChoice): SttBackend {
    switch (choice) {
        case 'aloud':
        case 'whisper':
            return 'server-whisper';
        case 'web-speech':
            return 'web-speech';
    }
}

/**
 * Which STT choices to offer for the current mode, in flow-default order:
 * Whisper (local-only — no on-device backend on the web), then browser speech
 * (only when the browser exposes the API), then the hosted option (always, and
 * the only one that costs credits). The first entry is the mode's default.
 */
export function sttEngineOptions(webMode: boolean): Array<{ value: SttEngineChoice; label: string }> {
    const out: Array<{ value: SttEngineChoice; label: string }> = [];
    if (!webMode) out.push({ value: 'whisper', label: 'Whisper — on this device' });
    if (isWebSpeechSupported()) out.push({ value: 'web-speech', label: 'Browser speech recognition' });
    out.push({ value: 'aloud', label: 'aloud cloud — uses credits' });
    return out;
}

/** The mode's default STT source: the first available option in flow order. */
export function defaultSttChoice(webMode: boolean): SttEngineChoice {
    return sttEngineOptions(webMode)[0]!.value;
}

/** Resolve the effective STT choice: the stored pick if it's offered in this
 *  mode, otherwise the mode's flow default. Handles null (never chosen) and a
 *  stale pick carried across a mode change. */
export function resolveSttChoice(stored: SttEngineChoice | null, webMode: boolean): SttEngineChoice {
    const offered = sttEngineOptions(webMode).map((o) => o.value);
    return stored && offered.includes(stored) ? stored : defaultSttChoice(webMode);
}

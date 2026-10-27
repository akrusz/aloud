/**
 * STT adapter selection, always from an explicit choice: sttEngineOptions lists
 * what the mode offers (first = default), resolveSttChoice settles a stored
 * pick, createSttForChoice builds the engine.
 *
 *   capacitor       - the PLATFORM's recognizer on iOS/Android, so not
 *                     necessarily on-device: Android's may send audio to Google
 *   web-speech      - Chrome / Edge / Android Chrome. NOT iOS, which exposes
 *                     the API but can only error on it (isWebSpeechSupported),
 *                     and not under Tauri (sttEngineOptions)
 *   whisper         - the desktop Rust shell's /app/v1/stt/whisper, so the
 *                     reliable desktop path
 *   aloud cloud     - /cloud/v1/stt through the same PCM engine; the fallback
 *                     every mode can reach
 */

import type { SttEngine } from '../../../src/platform/stt.js';
import type { PacingConfig } from '../../../src/facilitation/pacing.js';

import { rateSuffix } from '../credit-rate.js';
import { CapacitorSttEngine, type CapacitorSttEngineOptions } from './capacitor-stt.js';
import {
    CLOUD_FINAL_RETRY_BUDGET_MS,
    CLOUD_SPEC_EARLY_MAX_BUFFER_MS,
    WhisperPcmSttEngine,
} from './whisper-pcm-stt.js';
import {
    WebSpeechSttEngine,
    isWebSpeechSupported,
    type WebSpeechSttEngineOptions,
} from './web-speech-stt.js';
import { cloudUrl } from '../cloud-base.js';
import { ensureCloudToken, clearCloudToken } from '../cloud-auth.js';
import { isTauri, isCapacitor } from '../is-desktop.js';
import { appUrl } from '../app-base.js';
import { simulateSttFault } from '../dev-sim.js';
import { whisperWarmUrl } from '../whisper-ready.js';
import type { AppSettings, SttEngineChoice } from '../app-settings.js';
import type { MeditationType } from '../settings.js';
import { getMode } from '../../../src/facilitation/modes.js';

/** VAD-tuning subset of PacingConfig the picker forwards to adapters, plus the
 *  capture-device pick and the local-Whisper model params. Only the PCM
 *  engines (Whisper / aloud cloud) consume micDeviceId - Web Speech and the
 *  native recognizer own their capture. `language` reaches every engine: the
 *  local Whisper endpoint (model params), the Web Speech / native recognizers
 *  (as a BCP-47 tag), and the cloud endpoint (a transcription hint). */
type VadOpts = Partial<
    Pick<
        PacingConfig,
        'silenceBaseMs' | 'silenceMaxMs' | 'silenceRampRate' | 'minSpeechDurationMs'
    >
> & {
    micDeviceId?: string | null;
    whisperModelSize?: string | null;
    language?: string | null;
    speculation?: boolean;
};

export type SttBackend = 'capacitor' | 'web-speech' | 'server-whisper' | 'none';

// Resolved through appUrl(): the desktop's embedded Rust backend
// (127.0.0.1:<port>) under Tauri, or the relative /app path (Hono) on the web.
const SERVER_WHISPER_PATH = '/stt/whisper';

async function isServerWhisperReachable(vadOpts: VadOpts = {}): Promise<boolean> {
    if (!WhisperPcmSttEngine.isAvailable()) return false;
    try {
        // GET /warm: a 200 proves the local whisper route is wired (the web
        // Hono 404s, Vite's proxy 5xxes when the backend is down - both fail
        // closed). The model params make the shell start loading THIS
        // session's model now, during setup - without the warm, the retarget
        // waits for the first utterance, which 503s into a lost first turn
        // after a model/language change.
        const response = await fetch(
            whisperWarmUrl(vadOpts.whisperModelSize, vadOpts.language ?? 'en')
        );
        return response.ok;
    } catch {
        return false;
    }
}

/**
 * STT through the aloud cloud's authed /cloud/v1/stt (OpenAI gpt-transcribe
 * by default; Groq/custom via server env). Same client-side capture/VAD as
 * desktop server-Whisper - only endpoint + bearer token differ. Used when a
 * session runs on the hosted ('aloud') provider. Null when mic capture isn't
 * available here.
 */
export function createServerAloudStt(vadOpts: VadOpts = {}, model?: string): SttEngine | null {
    if (!WhisperPcmSttEngine.isAvailable()) return null;
    // Strip the local-Whisper model-size param: the cloud endpoint picks its
    // own model server-side (unless `model` pins an allowlisted alternate).
    // `language` stays: the cloud /stt route forwards it to the provider as a
    // transcription hint (meditation-pal-c3a0.2).
    const { whisperModelSize: _size, ...rest } = vadOpts;
    return new WhisperPcmSttEngine({
        ...rest,
        ...(model ? { cloudModel: model } : {}),
        specEarlyMaxBufferMs: CLOUD_SPEC_EARLY_MAX_BUFFER_MS,
        finalRetryBudgetMs: CLOUD_FINAL_RETRY_BUDGET_MS,
        endpointUrl: cloudUrl('/stt'),
        authProvider: ensureCloudToken,
        onAuthError: clearCloudToken,
    });
}

/**
 * The 2-letter Language setting as a BCP-47 tag with its likely region
 * (es -> es-ES, ja -> ja-JP), which is what both recognizers document.
 * Intl.Locale's likely-subtags data does the mapping; a code it can't expand
 * passes through bare, which the recognizers treat as a base tag.
 */
export function sttLangTag(lang: string): string {
    try {
        const region = new Intl.Locale(lang).maximize().region;
        return region ? `${lang}-${region}` : lang;
    } catch {
        return lang;
    }
}

/** Map the VAD pause settings onto the self-endpointing recognizers' submit
 *  window, mirroring the server-Whisper adaptive ramp (base + speech×ramp,
 *  capped at max). Without it Chrome submits the instant it detects a pause,
 *  and Android's recognizer on a ~1.5s one, shipping a mid-thought fragment. */
function submitWindowOpts(
    vadOpts: VadOpts
): Pick<WebSpeechSttEngineOptions, 'submitDelayMs' | 'submitMaxDelayMs' | 'submitRampRate'> {
    const opts: ReturnType<typeof submitWindowOpts> = {};
    if (vadOpts.silenceBaseMs !== undefined) opts.submitDelayMs = vadOpts.silenceBaseMs;
    if (vadOpts.silenceMaxMs !== undefined) opts.submitMaxDelayMs = vadOpts.silenceMaxMs;
    if (vadOpts.silenceRampRate !== undefined) opts.submitRampRate = vadOpts.silenceRampRate;
    return opts;
}

function webSpeechOpts(vadOpts: VadOpts): WebSpeechSttEngineOptions {
    const opts: WebSpeechSttEngineOptions = submitWindowOpts(vadOpts);
    // Without this the recognizer falls back to the page's hardcoded lang="en"
    // and the Language setting is a no-op on web.
    if (vadOpts.language) opts.lang = sttLangTag(vadOpts.language);
    return opts;
}

function capacitorOpts(vadOpts: VadOpts): CapacitorSttEngineOptions {
    const opts: CapacitorSttEngineOptions = submitWindowOpts(vadOpts);
    if (vadOpts.language) opts.language = sttLangTag(vadOpts.language);
    return opts;
}

function localWhisperStt(vadOpts: VadOpts): SttEngine {
    return new WhisperPcmSttEngine({ ...vadOpts, endpointUrl: appUrl(SERVER_WHISPER_PATH) });
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
    // Dev-build simulation hook (no-op everywhere else). A recognizer that only
    // errors is otherwise reachable only on the specific browser/OS that breaks
    // it, which is exactly why those bugs reach users.
    return simulateSttFault(await buildSttForChoice(choice, vadOpts));
}

async function buildSttForChoice(
    choice: SttEngineChoice,
    vadOpts: VadOpts = {}
): Promise<SttEngine | null> {
    switch (choice) {
        case 'capacitor':
            // Native app only; a stale stored pick outside it gets the honest
            // mic-unavailable state, not a plugin that throws at start().
            return isCapacitor() ? new CapacitorSttEngine(capacitorOpts(vadOpts)) : null;
        case 'aloud-gpt-transcribe':
            return createServerAloudStt(vadOpts, 'gpt-transcribe');
        case 'web-speech':
            // Same Tauri guard as sttEngineOptions - honor a stale stored pick
            // with null rather than a mic that pulses forever.
            return !isTauri() && isWebSpeechSupported()
                ? new WebSpeechSttEngine(webSpeechOpts(vadOpts))
                : null;
        case 'whisper':
            // The probe doubles as the model warm-up (isServerWhisperReachable),
            // so pass the session's model params through.
            return (await isServerWhisperReachable(vadOpts)) ? localWhisperStt(vadOpts) : null;
    }
}

/** The SttBackend label for a choice - drives the barge-in wrapper decision
 *  downstream (continuous-capture backends self-detect and skip the wrapper). */
export function sttBackendForChoice(choice: SttEngineChoice): SttBackend {
    switch (choice) {
        case 'capacitor':
            return 'capacitor';
        case 'aloud-gpt-transcribe':
        case 'whisper':
            return 'server-whisper';
        case 'web-speech':
            return 'web-speech';
    }
}

/** aloud cloud STT bills at provider cost: credits/hour of speech at the
 *  assumed talk profile. UNROUNDED, like the server's model/voice rates, so it
 *  composes honestly into the setup footer's session total.
 *
 *  This is a SEED, not the authority: /me/models carries the server's own
 *  estimateStt figure and setCloudSttCreditsPerHour overwrites this the moment
 *  the model catalog loads. It only renders when the picker paints before (or
 *  without) a reachable cloud, so it should stay roughly right but can't drift
 *  into a real charge. 'aloud-gpt-transcribe' pins OpenAI's gpt-transcribe,
 *  which is what the picker calls "aloud cloud". */
const FALLBACK_STT_CREDITS_PER_HOUR = 1.9;

let sttCreditsPerHour = FALLBACK_STT_CREDITS_PER_HOUR;

/** Adopt the server's hosted-STT rate (model-picker.ts, from /me/models). A
 *  missing or non-positive value leaves the seed in place rather than zeroing
 *  the leg - a hosted choice must never read as free. */
export function setCloudSttCreditsPerHour(rate: number | null | undefined): void {
    if (typeof rate === 'number' && rate > 0) sttCreditsPerHour = rate;
}

/** The hosted (credit-spending, cloud-auth) STT choice. */
export function isHostedSttChoice(choice: SttEngineChoice): boolean {
    return choice === 'aloud-gpt-transcribe';
}

/** ☁/hr for a picker choice - 0 for the free local/browser engines. */
export function cloudSttCreditsPerHour(choice: SttEngineChoice): number {
    return isHostedSttChoice(choice) ? sttCreditsPerHour : 0;
}

/**
 * Which STT choices to offer for the current mode, in flow-default order:
 * Whisper (local-only - no on-device backend on the web), then browser speech
 * (only when the browser exposes the API), then the hosted option (always, and
 * the only one that costs credits), then the phone's own recognizer. The first
 * entry is the mode's default. In a sparse-speech mode (noting) the phone's
 * recognizer leads instead (see sparseSttEngine in app-settings.ts).
 */
export function sttEngineOptions(
    webMode: boolean,
    mode: MeditationType = 'exploration'
): Array<{ value: SttEngineChoice; label: string }> {
    const out: Array<{ value: SttEngineChoice; label: string }> = [];
    const native = { value: 'capacitor' as const, label: 'Built-in transcription' };
    const sparse = sparseSpeech(mode);
    if (isCapacitor() && sparse) out.push(native);
    // Local Whisper exists only in the desktop (Tauri) Rust shell: Hono doesn't
    // serve the /app whisper route, and the desktop's loopback backend isn't
    // reachable from a separate browser, so offering it on the web gives a dead
    // mic. Browsers fall through to web-speech (Chrome) / aloud cloud.
    if (!webMode && isTauri()) out.push({ value: 'whisper', label: 'Whisper (local)' });
    // Browser speech needs a recognizer that actually works. Not under Tauri:
    // the macOS WKWebView exposes webkitSpeechRecognition but never returns
    // results (the mic captures, no transcript ever arrives), and desktop has
    // Whisper + cloud. Not in the native app either: the plugin above is
    // better. And not on iOS/iPadOS, where isWebSpeechSupported reports false
    // for a recognizer that's present but unusable - those browsers default to
    // aloud cloud.
    if (!isTauri() && !isCapacitor() && isWebSpeechSupported()) {
        out.push({ value: 'web-speech', label: 'Browser' });
    }
    // OpenAI's gpt-transcribe: cheaper upstream and (per benchmarks) more
    // accurate than gpt-4o-transcribe (meditation-pal-vazw). Always offered, so
    // it's the fallback every mode can reach.
    out.push({
        value: 'aloud-gpt-transcribe',
        label: `aloud cloud${rateSuffix(sttCreditsPerHour)}`,
    });
    // The native mobile recognizer: free, no credits. Labelled for what it IS,
    // not where the audio goes - Android's routes to Google, so don't
    // reintroduce a privacy claim ("private", "On-device"; sn1w tracks earning
    // one back). Capacitor-only (web/desktop builds never have it). In the
    // facilitated modes it comes after aloud cloud, which those sessions
    // already sign in for: the recognizer can't barge in or reject the
    // facilitator's voice from the speaker, and hosted STT's echo-cancelled
    // capture does both. A sparse mode has no facilitator to talk over and
    // (noting) must run with no account, as the store listings promise, so
    // there it leads.
    if (isCapacitor() && !sparse) out.push(native);
    return out;
}

/** A word now and then, nobody speaking over the meditator (ModeSpec.sparseSpeech). */
function sparseSpeech(mode: MeditationType): boolean {
    return getMode(mode)?.sparseSpeech === true;
}

/** Which AppSettings field holds the STT pick for a mode: one for the
 *  conversational modes, one for the sparse ones. */
export function sttSettingKey(mode: MeditationType): 'sttEngine' | 'sparseSttEngine' {
    return sparseSpeech(mode) ? 'sparseSttEngine' : 'sttEngine';
}

/** The STT choice a session in `mode` will use: its own stored pick, settled
 *  against what the mode offers. */
export function sttChoiceForMode(
    settings: Pick<AppSettings, 'sttEngine' | 'sparseSttEngine'>,
    webMode: boolean,
    mode: MeditationType
): SttEngineChoice {
    return resolveSttChoice(settings[sttSettingKey(mode)] ?? null, webMode, mode);
}

/** The mode's default STT source: the first available option in flow order. */
export function defaultSttChoice(webMode: boolean, mode: MeditationType = 'exploration'): SttEngineChoice {
    return sttEngineOptions(webMode, mode)[0]!.value;
}

/** The stored pick if this mode offers it, else the mode's flow default.
 *  Handles null (never chosen) and a stale pick carried across a mode change. */
export function resolveSttChoice(
    stored: SttEngineChoice | null,
    webMode: boolean,
    mode: MeditationType = 'exploration'
): SttEngineChoice {
    const offered = sttEngineOptions(webMode, mode).map((o) => o.value);
    return stored && offered.includes(stored) ? stored : defaultSttChoice(webMode, mode);
}

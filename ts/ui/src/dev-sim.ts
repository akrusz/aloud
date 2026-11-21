/**
 * Simulated failures, for exercising states that are painful or impossible to
 * reach on purpose: being out of credits, a browser that blocks its speech
 * recognizer, a machine with no microphone, a TTS catalog that came back empty,
 * a build too old for aloud cloud (the update screen, update-gate.ts).
 *
 * Each knob is a sessionStorage value (so it dies with the tab) settable from
 * Settings → Developer or a URL param. The wrappers below are applied at the
 * points where the real engines are built, so a simulated fault travels the
 * SAME path as the real one: same error text, same handler, same toast, same
 * banner. A simulation that took a shortcut past the parsing would test nothing.
 *
 * SECURITY: every read is gated on `import.meta.env.DEV`, like the ?mode= and
 * ?dev overrides in app-mode.ts and NOT like the 7-tap dev mode in dev-mode.ts.
 * Faking "out of credits" or a dead mic is harmless in a dev build and awful in
 * a shipped one, so this must never be reachable from a release bundle.
 */

import type { LLMProvider } from '../../src/llm/base.js';
import type { SttEngine, SttEvent } from '../../src/platform/stt.js';
import type { TtsEngine } from '../../src/platform/tts.js';
import type { VoiceEntry } from './voices.js';
import type { DesktopUpdate } from './desktop-updater.js';
import type { ClientPlatform, MinVersionPlatform, UpdateGateInput } from './client-version.js';
import { adoptSimMicParam, getSimMic, setSimMic } from './mic-check.js';

/** Hosted-service faults, keyed by the server's error code. The value is the
 *  HTTP status the real endpoint returns with it, which is what the client-side
 *  matchers (describeCloudError, the 402 checks in views/session.ts) key on. */
const CLOUD_FAULTS = {
    insufficient_credits: 402,
    unauthenticated: 401,
    email_unverified: 403,
    quota_exceeded: 429,
} as const;

export type CloudFault = keyof typeof CLOUD_FAULTS;

/** Recognizer faults. The first three are Web Speech error codes; the last is
 *  the desktop Whisper backend answering before its model has loaded. */
export const STT_FAULTS = [
    'service-not-allowed',
    'network',
    'not-allowed',
    'whisper-503',
] as const;

export type SttFault = (typeof STT_FAULTS)[number];

export const CLOUD_FAULT_NAMES = Object.keys(CLOUD_FAULTS) as CloudFault[];

const KEYS = {
    cloud: 'aloud:simCloudFault',
    stt: 'aloud:simSttFault',
    voices: 'aloud:simNoVoices',
} as const;

function readSim(key: string, allowed: readonly string[]): string | null {
    if (!import.meta.env.DEV) return null;
    try {
        const value = sessionStorage.getItem(key);
        return value && allowed.includes(value) ? value : null;
    } catch {
        return null;
    }
}

function writeSim(key: string, value: string | null): void {
    try {
        if (value) sessionStorage.setItem(key, value);
        else sessionStorage.removeItem(key);
    } catch {
        /* storage unavailable: the simulation just won't stick */
    }
}

export function getCloudFault(): CloudFault | null {
    return readSim(KEYS.cloud, CLOUD_FAULT_NAMES) as CloudFault | null;
}
export function setCloudFault(fault: CloudFault | null): void {
    writeSim(KEYS.cloud, fault);
}
export function getSttFault(): SttFault | null {
    return readSim(KEYS.stt, STT_FAULTS) as SttFault | null;
}
export function setSttFault(fault: SttFault | null): void {
    writeSim(KEYS.stt, fault);
}
export function getNoVoices(): boolean {
    return readSim(KEYS.voices, ['1']) === '1';
}
export function setNoVoices(on: boolean): void {
    writeSim(KEYS.voices, on ? '1' : null);
}

/**
 * The update screen for a build below aloud cloud's minimum, in one platform's
 * variant: `?sim=outdated` for this platform's (desktop in a browser),
 * `?sim=outdated-desktop`, `-android`, `-ios` for a given one. This load only,
 * unlike the switches above: the screen is the whole page, with no Settings
 * to switch it off from and, in the desktop app, no URL bar, so a reload has
 * to be the real app.
 */
export const OUTDATED_SIMS = ['this platform', 'desktop', 'android', 'ios'] as const;
export type OutdatedSim = (typeof OUTDATED_SIMS)[number];

let simOutdated: OutdatedSim | null = null;

export function getSimOutdated(): OutdatedSim | null {
    return import.meta.env.DEV ? simOutdated : null;
}

/** `?sim=` for a variant, as the Settings menu and the cheatsheet name it. */
export function outdatedSimParam(sim: OutdatedSim): string {
    return sim === 'this platform' ? 'outdated' : `outdated-${sim}`;
}

/**
 * The updater's answer in the desktop variant, there with or without a real
 * release: a ~2 s download that installs nothing, then a reload in place of
 * the relaunch, which is the real app again.
 */
export function simulatedDesktopUpdate(version: string): DesktopUpdate {
    return {
        version,
        installAndRelaunch: async (onProgress) => {
            for (let i = 0; i <= 10; i++) {
                onProgress?.(i / 10);
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
            window.location.reload();
        },
    };
}

/** Which platform's screen a variant shows. */
function outdatedSimPlatform(sim: OutdatedSim, here: ClientPlatform): MinVersionPlatform {
    if (sim !== 'this platform') return sim;
    return here === 'web' ? 'desktop' : here;
}

/** The update gate's input under a simulation: the real decision, with a
 *  minimum one patch above this build and an updater that always has one. */
export function simulatedGateInput(sim: OutdatedSim, here: ClientPlatform, running: string): UpdateGateInput {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(running);
    const ahead = m ? `${m[1]}.${m[2]}.${Number(m[3]) + 1}` : '9.9.9';
    return {
        platform: outdatedSimPlatform(sim, here),
        running: m ? running : '0.0.0',
        minimum: ahead,
        checkDesktopUpdate: async () => simulatedDesktopUpdate(ahead),
    };
}

/** Everything currently being faked, for the banner. */
function activeSimulations(): string[] {
    const active: string[] = [];
    const mic = getSimMic();
    if (mic) active.push(`mic: ${mic}`);
    const stt = getSttFault();
    if (stt) active.push(`speech: ${stt}`);
    const cloud = getCloudFault();
    if (cloud) active.push(`cloud: ${cloud}`);
    if (getNoVoices()) active.push('no voices');
    const outdated = getSimOutdated();
    if (outdated) active.push(`outdated: ${outdated}`);
    return active;
}

/**
 * A standing banner while any simulation is on. Without it, a toggle left set
 * in a previous tab reads as a real bug, and the next hour goes to debugging
 * something you switched on yourself.
 */
export function renderSimBanner(): void {
    if (!import.meta.env.DEV || typeof document === 'undefined') return;
    const active = activeSimulations();
    let el = document.getElementById('dev-sim-banner');
    if (active.length === 0) {
        el?.remove();
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = 'dev-sim-banner';
        document.body.appendChild(el);
    }
    el.textContent = `SIMULATING - ${active.join(' · ')}`;
}

/**
 * The error a cloud endpoint really produces, verbatim in shape: the client
 * flattens `{error:{code}}` responses to "<label> endpoint <status>: <body>",
 * and every matcher downstream parses that string.
 */
function cloudError(fault: CloudFault, label: string): Error {
    const status = CLOUD_FAULTS[fault];
    return new Error(`${label} endpoint ${status}: {"error":{"code":"${fault}"}}`);
}

/** Fail the LLM leg: the apology, the buy-credits prompt, the toasts. */
export function simulateLlmFault(provider: LLMProvider): LLMProvider {
    const fault = getCloudFault();
    if (!fault) return provider;
    const fail = (): never => {
        throw cloudError(fault, 'aloud');
    };
    return {
        get model() {
            return provider.model;
        },
        // `async` matters: a real provider REJECTS, and a synchronous throw
        // would sail past any caller using .catch() instead of try/await.
        complete: async () => fail(),
        // Streaming is feature-checked by callers, so the wrapper must offer it
        // too or a simulated fault would silently exercise the non-stream path.
        // eslint-disable-next-line require-yield
        completeStream: async function* () {
            fail();
        },
    };
}

/** Fail the TTS leg, which handles the same conditions separately from the LLM
 *  (handleTtsError in views/session.ts). */
export function simulateTtsFault(engine: TtsEngine): TtsEngine {
    const fault = getCloudFault();
    if (!fault) return engine;
    return {
        speak: () => Promise.reject(cloudError(fault, 'TTS')),
        cancel: () => engine.cancel(),
        listVoices: () => engine.listVoices(),
    };
}

/**
 * Fail the recognizer. Yields one error event and completes, which is what a
 * real engine does - so the listen loop's backoff, the status line, the toast
 * de-duplication, and the two-strike trouble banner all get exercised.
 */
export function simulateSttFault(engine: SttEngine | null): SttEngine | null {
    const fault = getSttFault();
    if (!fault || !engine) return engine;
    const error: unknown =
        fault === 'whisper-503'
            ? new Error('Whisper endpoint 503: {"error":"Whisper model still loading."}')
            : fault;
    return {
        start: async function* (): AsyncIterable<SttEvent> {
            yield { type: 'error', error };
        },
        stop: (options) => engine.stop(options),
        prime: () => Promise.resolve(),
    };
}

/** Empty the voice catalog: the no-voices banners, the default-voice fallback. */
export function simulateVoiceCatalog(voices: VoiceEntry[]): VoiceEntry[] {
    return getNoVoices() ? [] : voices;
}

/**
 * Adopt `?sim=` and `?nomic=` params into sessionStorage, so a simulation can
 * be started from a URL as well as from Settings: `?sim=insufficient_credits`,
 * `?sim=network`, `?sim=no-voices`, `?nomic=denied`, `?sim=off`. Called once
 * at boot. `?sim=outdated[-platform]` is held for this load only, and comes off
 * the URL here, since a blocked boot never reaches the router that strips the
 * rest.
 */
export function adoptSimulationParams(): void {
    if (!import.meta.env.DEV) return;
    adoptSimMicParam();
    try {
        const url = new URL(window.location.href);
        const q = url.searchParams.get('sim');
        if (q === null) return;
        const outdated = OUTDATED_SIMS.find((sim) => outdatedSimParam(sim) === q);
        if (outdated) {
            simOutdated = outdated;
            url.searchParams.delete('sim');
            window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
            return;
        }
        if (q === 'off' || q === '0') {
            setCloudFault(null);
            setSttFault(null);
            setNoVoices(false);
            setSimMic(null);
            return;
        }
        if ((CLOUD_FAULT_NAMES as string[]).includes(q)) setCloudFault(q as CloudFault);
        else if ((STT_FAULTS as readonly string[]).includes(q)) setSttFault(q as SttFault);
        else if (q === 'no-voices') setNoVoices(true);
    } catch {
        /* ignore */
    }
}

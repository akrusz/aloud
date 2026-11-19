/**
 * Mic availability, independent of which STT engine is selected.
 *
 * aloud is voice-only: there is no text input, so a
 * session with no microphone is a session that can't happen. Rather than let
 * one start and stall on a dead mic (or, in noting, silently roll past the
 * user's turns), both start paths pre-flight through here.
 *
 * This is a LOCAL check. Every engine except Web Speech and the Capacitor
 * plugin captures via getUserMedia in the page - cloud STT included, since
 * WhisperPcmSttEngine records locally and only uploads PCM - and those two
 * still need the same OS grant. So nothing here costs credits, needs a sign-in,
 * or touches the network.
 *
 * Two probes, because only one of them can be trusted and only one of them is
 * free:
 *   - probeMic()      silent, never prompts, safe to run while the user is
 *                     still on setup. Reports only what it can know for sure.
 *   - acquireMicOnce() definitive: actually opens a stream (so it may prompt)
 *                     and releases it immediately; in the Android app the
 *                     RECORD_AUDIO grant answers instead. Run from the Begin
 *                     handler, where the prompt has a user gesture behind it,
 *                     only until a mic has opened on this page (micForBegin).
 */

import { ensureMicPermission } from './mic-permission.js';
import { capacitorPlatform, isTauri, isCapacitor } from './is-desktop.js';
import { t } from './i18n.js';

export type MicStatus =
    /** A stream is available, or nothing we can check says otherwise. */
    | 'ok'
    /** No getUserMedia at all: an ancient browser, or a non-secure origin. */
    | 'no-api'
    /** The browser has capture APIs but no input device. */
    | 'no-device'
    /** Permission explicitly refused, by the user or by policy. */
    | 'denied'
    /** Present, permitted, and still wouldn't open (in use, hardware fault). */
    | 'error';

function hasGetUserMedia(): boolean {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
}

const SIM_KEY = 'aloud:simMic';

/** The failures worth simulating: every MicStatus except 'ok'. */
export const MIC_SIM_STATUSES = ['no-api', 'no-device', 'denied', 'error'] as const;

const SIM_STATUSES: readonly string[] = MIC_SIM_STATUSES;

/** The simulated status as Settings → Developer renders it (null = working). */
export function getSimMic(): MicStatus | null {
    if (!import.meta.env.DEV) return null;
    try {
        const value = sessionStorage.getItem(SIM_KEY);
        return value && SIM_STATUSES.includes(value) ? (value as MicStatus) : null;
    } catch {
        return null;
    }
}

export function setSimMic(status: MicStatus | null): void {
    try {
        if (status && SIM_STATUSES.includes(status)) sessionStorage.setItem(SIM_KEY, status);
        else sessionStorage.removeItem(SIM_KEY);
    } catch {
        /* storage unavailable: the simulation just won't stick */
    }
}

/**
 * DEV-BUILD ONLY simulated mic failure, for testing the gate without unplugging
 * anything: `?nomic=denied` (also no-device, no-api, error), sticky for the tab
 * until `?nomic=off`. Mirrors the ?dev cloud bypass in app-mode.ts, including
 * its `import.meta.env.DEV` compile-time gate - a release build can't reach it.
 *
 * Real browsers only offer some of these (blocking the site gives 'denied'; the
 * rest need hardware you don't have), which is exactly why this exists.
 *
 * Adopted at boot (dev-sim.ts adoptSimulationParams), not when a probe runs:
 * the router has stripped the query off the URL long before the first probe.
 */
export function adoptSimMicParam(): void {
    if (!import.meta.env.DEV) return;
    try {
        const q = new URL(window.location.href).searchParams.get('nomic');
        if (q === 'off' || q === '0') setSimMic(null);
        else if (q !== null && SIM_STATUSES.includes(q)) setSimMic(q as MicStatus);
    } catch {
        /* no URL to read */
    }
}

function simulatedMicStatus(): MicStatus | null {
    const stored = getSimMic();
    if (stored) {
        // eslint-disable-next-line no-console
        console.info(`[aloud] simulating mic status '${stored}'. Clear with ?nomic=off.`);
    }
    return stored;
}

/**
 * What we can learn without prompting. Deliberately optimistic: it returns 'ok'
 * whenever it can't be certain, because a false "no mic" would block a user who
 * has one. The Begin-time acquireMicOnce() is what actually decides.
 */
export async function probeMic(): Promise<MicStatus> {
    // The simulation stands in for hardware/permission state, so the silent
    // probe still only reports what it could genuinely know without prompting:
    // 'error' (mic present and permitted, opens anyway) is invisible here and
    // surfaces at Begin, exactly as it would in the real world.
    const sim = simulatedMicStatus();
    if (sim) return sim === 'error' ? 'ok' : sim;
    if (!hasGetUserMedia()) return 'no-api';
    // Chromium/Firefox answer this without prompting; Safari throws on the
    // 'microphone' descriptor. Only 'denied' is actionable - 'prompt' and
    // 'granted' both mean "try it and see".
    try {
        const perm = await navigator.permissions?.query({
            name: 'microphone' as PermissionName,
        });
        if (perm?.state === 'denied') return 'denied';
    } catch {
        /* descriptor unsupported - fall through */
    }
    // Device presence. Browsers that hide devices until permission is granted
    // return an empty list, which is indistinguishable from "no hardware", so
    // only a list that HAS entries but no audioinput counts as no-device.
    try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (devices.length > 0 && !devices.some((d) => d.kind === 'audioinput')) {
            return 'no-device';
        }
    } catch {
        /* can't enumerate - fall through */
    }
    return 'ok';
}

/**
 * Open a capture stream and release it (in the Android app, ask for the grant
 * instead: see below). The only reliable answer, at the cost
 * of a permission prompt on first run - which is why callers run it from the
 * Begin click, where a prompt is expected and (on WebKit) allowed.
 *
 * The stream is fully stopped before returning: macOS re-arbitrates its single
 * voice-processing input between concurrent captures, so the session's own
 * engine must never find this one still open.
 */
export async function acquireMicOnce(): Promise<MicStatus> {
    const status = await acquireMic();
    if (status === 'ok') openedThisPage = true;
    return status;
}

let openedThisPage = false;

/** True once the mic has been opened (or its grant confirmed) since this page
 *  loaded: from then on, opening it again won't prompt. What the setup
 *  screen's "begin" listener goes by where no permission query can be trusted
 *  (voice-start.ts micPermission). */
export function micOpenedThisPage(): boolean {
    return openedThisPage;
}

/** Capture streams of ours that are open now (whisper-pcm-stt.ts reports them). */
const openCaptures = new Map<MediaStream, () => boolean>();
let lastLiveCaptureClosedAt = -Infinity;

/** A capture stream of ours opened. `live` says whether it still is (open,
 *  delivering, not muted). */
export function noteCaptureOpened(stream: MediaStream, live: () => boolean): void {
    openedThisPage = true;
    openCaptures.set(stream, live);
}

/** About to stop that stream's tracks. */
export function noteCaptureClosing(stream: MediaStream): void {
    const live = openCaptures.get(stream);
    openCaptures.delete(stream);
    if (live?.()) lastLiveCaptureClosedAt = performance.now();
}

/** Whether a capture stream of ours is open and live now, a kept one
 *  included (SttStopOptions.keepMicUntil). */
export function captureLive(): boolean {
    return [...openCaptures.values()].some((live) => live());
}

/**
 * How recently a capture of ours must have been live for Begin to take it as
 * the answer. Long enough for a spoken "begin", whose listener closes before
 * the settings it named are saved; short enough that a mic unplugged or
 * revoked since still gets acquireMicOnce's clear message, not a session
 * that fails later (noting would never say why).
 */
export const RECENT_CAPTURE_MS = 3000;

/**
 * Begin's mic check, which opens no stream once one has opened on this page:
 * a probe opens and closes the mic once more, and each open or close of an
 * echo-cancelled stream rebuilds the audio output on macOS, under the opening
 * sound (meditation-pal-uz8t), and switches call mode on Android. A capture of
 * ours that is live, or was a moment ago (the setup screen's listener, held
 * by this same Begin), is the answer. An older one leaves the silent probe,
 * which can see a mic unplugged or blocked since (the device list is no longer
 * hidden once a capture has worked), so a lost mic is still caught here and
 * not inside the session, where noting would never say why. The page's first
 * Begin goes to acquireMicOnce. Call it before any await, so a prompt keeps
 * the click's gesture.
 */
export function micForBegin(): Promise<MicStatus> {
    // A simulated failure stands in for the hardware, which a capture would
    // otherwise vouch for (acquireMicOnce answers it without opening one).
    if (getSimMic()) return acquireMicOnce();
    if (captureLive() || performance.now() - lastLiveCaptureClosedAt <= RECENT_CAPTURE_MS) return Promise.resolve('ok');
    return openedThisPage ? probeMic() : acquireMicOnce();
}

/**
 * Begin's hand-over (views/setup.ts beginFromSetup, and voice-start.ts on a
 * spoken "begin"). The setup screen's capture stops listening at Begin but
 * stays open, as the listener's keepMicUntil, until the session's own capture
 * can hear beside it, so the OS never sees the mic close between the two. On
 * Android the WebView holds the app in call mode exactly while a capture is
 * open, and each switch mutes or moves the sounds playing (measured on a
 * phone, 2026-11-19: dev-docs/audio-output.md); on macOS the last close and
 * the first open each rebuild the audio output.
 */
let handover: { until: Promise<void>; end: () => void } | null = null;

/** The longest Begin keeps the setup screen's capture for a session whose own
 *  never hears (a mic sending only silence, a sign-in left open). */
export const CAPTURE_HANDOVER_CAP_MS = 10_000;

/**
 * Hold the capture being stopped at Begin: settles when a capture of ours
 * next hears (noteCaptureHearing), when endCaptureHandover is called, or
 * after CAPTURE_HANDOVER_CAP_MS, whichever is first. Asked again while one is
 * pending, the same promise.
 */
export function holdCaptureForSession(): Promise<void> {
    if (!handover) {
        let settle!: () => void;
        const until = new Promise<void>((resolve) => (settle = resolve));
        const cap = setTimeout(endCaptureHandover, CAPTURE_HANDOVER_CAP_MS);
        handover = {
            until,
            end: () => {
                clearTimeout(cap);
                settle();
            },
        };
    }
    return handover.until;
}

/** Let the capture held at Begin go: the session has no capture of ours, its
 *  open failed, it ended, or the start was turned back. */
export function endCaptureHandover(): void {
    const ending = handover;
    handover = null;
    ending?.end();
}

/** A capture of ours delivered a frame with sound in it (whisper-pcm-stt.ts):
 *  one held at Begin is no longer needed. A first frame is too soon, being
 *  the silence a fresh capture sends while the OS sets it up. */
export function noteCaptureHearing(): void {
    if (handover) endCaptureHandover();
}

async function acquireMic(): Promise<MicStatus> {
    const sim = simulatedMicStatus();
    if (sim) return sim;
    if (!hasGetUserMedia()) return 'no-api';
    // Native Android: the WebView only grants capture when the app already
    // holds RECORD_AUDIO, so ask through the plugin first (no-op elsewhere).
    const granted = await ensureMicPermission();
    // ...and there that grant is the answer, so open no probe stream. One puts
    // the app in call mode, and leaving it a moment later makes Android drop
    // the WebView's audio outputs for ~0.5s, under the opening sound
    // (meditation-pal-6fjb).
    if (granted !== null && capacitorPlatform() === 'android') return granted ? 'ok' : 'denied';
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        for (const track of stream.getTracks()) track.stop();
        return 'ok';
    } catch (err) {
        const name = err instanceof Error ? err.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') return 'denied';
        if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'no-device';
        return 'error';
    }
}

/** The user-facing reason, or null when the mic is fine. */
export function describeMicProblem(status: MicStatus): string | null {
    switch (status) {
        case 'ok':
            return null;
        case 'no-api':
            // Three different causes wear this one status, and only one of them
            // is the browser's fault. Naming the wrong one sends people to a
            // fix that can't work: a packaged app can't switch browsers, and no
            // browser exposes a mic over a non-secure origin.
            if (isTauri() || isCapacitor()) {
                // Most likely a webview without media support (Linux WebKitGTK
                // varies by build). Nothing the user can toggle, so don't
                // pretend otherwise.
                return t("aloud can't reach a microphone on this device.");
            }
            if (typeof window !== 'undefined' && window.isSecureContext === false) {
                return t('A microphone needs a secure connection. Open aloud over https.');
            }
            return t("This browser can't reach a microphone. Try Chrome, Edge, or Safari.");
        case 'no-device':
            return t('No microphone found. Connect one, then reload.');
        case 'denied':
            return t('Microphone access is blocked. Allow the mic for this site, then reload.');
        case 'error':
            return t("Couldn't open the microphone. Check that nothing else is using it.");
    }
}

/** The same reason with the why in front, for the setup-page notice. */
export function describeMicRequirement(status: MicStatus): string | null {
    const problem = describeMicProblem(status);
    return problem && t('aloud is voice-based and needs a mic. {problem}', { problem });
}

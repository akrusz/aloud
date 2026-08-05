/**
 * Mic availability, independent of which STT engine is selected.
 *
 * aloud is voice-only and always will be: there is no text-input mode, so a
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
 *                     and releases it immediately. Run from the Begin handler,
 *                     where the prompt has a user gesture behind it.
 */

import { ensureMicPermission } from './mic-permission.js';
import { isTauri, isCapacitor } from './is-desktop.js';

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
 */
function simulatedMicStatus(): MicStatus | null {
    if (!import.meta.env.DEV) return null;
    try {
        const q = new URL(window.location.href).searchParams.get('nomic');
        if (q === 'off' || q === '0') setSimMic(null);
        else if (q !== null && SIM_STATUSES.includes(q)) setSimMic(q as MicStatus);
    } catch {
        /* no URL to read - fall through to the stored value */
    }
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
 * Open a capture stream and release it. The only reliable answer, at the cost
 * of a permission prompt on first run - which is why callers run it from the
 * Begin click, where a prompt is expected and (on WebKit) allowed.
 *
 * The stream is fully stopped before returning: macOS re-arbitrates its single
 * voice-processing input between concurrent captures, so the session's own
 * engine must never find this one still open.
 */
export async function acquireMicOnce(): Promise<MicStatus> {
    const sim = simulatedMicStatus();
    if (sim) return sim;
    if (!hasGetUserMedia()) return 'no-api';
    // Native Android: the WebView only grants capture when the app already
    // holds RECORD_AUDIO, so ask through the plugin first (no-op elsewhere).
    await ensureMicPermission();
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
                return "aloud can't reach a microphone on this device.";
            }
            if (typeof window !== 'undefined' && window.isSecureContext === false) {
                return 'A microphone needs a secure connection. Open aloud over https.';
            }
            return "This browser can't reach a microphone. Try Chrome, Edge, or Safari.";
        case 'no-device':
            return 'No microphone found. Connect one, then reload.';
        case 'denied':
            return 'Microphone access is blocked. Allow the mic for this site, then reload.';
        case 'error':
            return "Couldn't open the microphone. Check that nothing else is using it.";
    }
}

/** The same reason with the why in front, for the setup-page notice. */
export function describeMicRequirement(status: MicStatus): string | null {
    const problem = describeMicProblem(status);
    return problem && `aloud is voice-based and needs a mic. ${problem}`;
}

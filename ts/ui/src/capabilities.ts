/**
 * Runtime capability detection: what can this environment actually reach?
 * Menus key off it so they only offer sources that work here.
 *
 * Three independent axes, NOT one "desktop" binary:
 *   - flask:  the local app backend (Piper/macOS voices, claude_proxy,
 *             Ollama proxy, config-folder + voice-management tools).
 *   - cloud:  aloud cloud, the @aloud/server proxy (LLM/STT/TTS, credits).
 *   - ollama: a local Ollama daemon (reachable via the dev proxy).
 *
 * Probes run once at boot, cached, re-runnable via invalidate + detect. The
 * `flask` axis delegates to is-desktop.ts so isDesktop()/isDesktopSync()
 * callers and this share one probe.
 */

import { detectIsDesktop, isDesktopSync } from './is-desktop.js';
import { cloudUrl } from './cloud-base.js';
import {
    setRuntimeGoogleClientId,
    setRuntimeGoogleDesktopClientId,
    setRuntimeAppleClientId,
} from './cloud-auth.js';

export type Capability = 'flask' | 'cloud' | 'ollama';

export interface Capabilities {
    flask: boolean;
    cloud: boolean;
    ollama: boolean;
}

let cached: Capabilities | null = null;
let inflight: Promise<Capabilities> | null = null;

async function reachable(url: string): Promise<boolean> {
    try {
        const r = await fetch(url, { method: 'GET' });
        return r.ok;
    } catch {
        return false;
    }
}

/** The public `/config` route proves reachability AND carries the sign-in
 *  client ids in one round-trip, so any install shows real sign-in for whatever
 *  server it points at. Failure reads as unreachable + no ids. (meditation-pal-rfb) */
interface CloudConfig {
    reachable: boolean;
    googleClientId: string;
    googleDesktopClientId: string;
    appleClientId: string;
}

const NO_CLOUD: CloudConfig = {
    reachable: false,
    googleClientId: '',
    googleDesktopClientId: '',
    appleClientId: '',
};

async function probeCloud(): Promise<CloudConfig> {
    try {
        const r = await fetch(cloudUrl('/config'), { method: 'GET' });
        if (!r.ok) return NO_CLOUD;
        const data = (await r.json()) as {
            googleClientId?: string;
            googleDesktopClientId?: string;
            appleClientId?: string;
        };
        return {
            reachable: true,
            googleClientId: data.googleClientId ?? '',
            googleDesktopClientId: data.googleDesktopClientId ?? '',
            appleClientId: data.appleClientId ?? '',
        };
    } catch {
        return NO_CLOUD;
    }
}

/** Short backoff before concluding cloud is down, so a boot blip (Fly cold
 *  start, dev server mid-`tsx watch` restart) isn't frozen into a session-long
 *  false negative. */
async function probeCloudWithRetry(): Promise<CloudConfig> {
    const backoffMs = [300, 900];
    let result = await probeCloud();
    for (const ms of backoffMs) {
        if (result.reachable) return result;
        await new Promise((resolve) => setTimeout(resolve, ms));
        result = await probeCloud();
    }
    return result;
}

export async function detectCapabilities(): Promise<Capabilities> {
    // A positive cache holds for the session. A negative `cloud` is usually a
    // transient blip, so don't freeze it: re-probe cloud only on the next call
    // so sign-in/credits self-heal as the user navigates. flask/ollama are
    // structural and stable for the session, so they aren't re-hammered.
    if (cached?.cloud) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
        // Cloud was previously unreachable: recheck just that axis, single
        // attempt, since the next navigation retries.
        const base = cached;
        if (base) {
            const cloud = await probeCloud();
            setRuntimeGoogleClientId(cloud.googleClientId);
            setRuntimeGoogleDesktopClientId(cloud.googleDesktopClientId);
            setRuntimeAppleClientId(cloud.appleClientId);
            cached = { ...base, cloud: cloud.reachable };
            inflight = null;
            return cached;
        }
        // First detect: retry the cloud probe to ride out cold-start/restart.
        //
        // The ollama axis rides the Vite dev proxy (/ollama → :11434), the ONLY
        // place that raw path resolves. No production build (hosted web,
        // desktop, self-host) has that route, so the probe could only 404 (the
        // console noise on aloud.rest); skip it there. Desktop Ollama
        // availability comes from /app/v1/providers (provider-markers.ts).
        const [flask, cloud, ollama] = await Promise.all([
            detectIsDesktop(), // GET /app/v1/system-info
            probeCloudWithRetry(),
            import.meta.env.DEV ? reachable('/ollama/api/tags') : Promise.resolve(false),
        ]);
        setRuntimeGoogleClientId(cloud.googleClientId);
        setRuntimeGoogleDesktopClientId(cloud.googleDesktopClientId);
        setRuntimeAppleClientId(cloud.appleClientId);
        cached = { flask, cloud: cloud.reachable, ollama };
        inflight = null;
        return cached;
    })();
    return inflight;
}

/** Cached read for sync render paths; unprobed axes read false (flask falls
 *  back to the shared is-desktop cache). */
export function capabilitiesSync(): Capabilities {
    return cached ?? { flask: isDesktopSync(), cloud: false, ollama: false };
}

export function invalidateCapabilities(): void {
    cached = null;
}

// --- Cloud reachability watch ------------------------------------------------
//
// The initial probe can miss aloud cloud on a flaky or slow connection (the
// server itself stays warm). probeCloudWithRetry keeps first paint fast with a
// short retry; this is the longer tail: a shared exponential-backoff re-probe
// that fires once the server answers, so surfaces gated on cloud reachability
// (account page, sign-in nav, setup pickers) heal without a reload.

type CloudUpListener = () => void;
const cloudUpListeners = new Set<CloudUpListener>();
let cloudWatchTimer: ReturnType<typeof setTimeout> | null = null;

function runCloudWatch(): void {
    if (cloudWatchTimer !== null) return; // a poll is already scheduled
    let delayMs = 1500;
    const tick = async (): Promise<void> => {
        cloudWatchTimer = null;
        if (cloudUpListeners.size === 0) return; // nobody waiting → stop polling
        // detectCapabilities re-probes cloud whenever it's down, so this rides
        // its inflight de-dup rather than running a parallel probe.
        const caps = await detectCapabilities();
        if (caps.cloud) {
            const listeners = [...cloudUpListeners];
            cloudUpListeners.clear();
            for (const fn of listeners) fn();
            return;
        }
        delayMs = Math.min(Math.round(delayMs * 1.5), 15000);
        cloudWatchTimer = setTimeout(() => void tick(), delayMs);
    };
    cloudWatchTimer = setTimeout(() => void tick(), delayMs);
}

/**
 * Call `onUp` once aloud cloud is reachable: synchronously if it already is,
 * otherwise when a shared background backoff re-probe reaches it. Unsubscribe
 * on teardown so a pending wait can't fire into a view that's gone. Fires at
 * most once, since a positive cloud result sticks for the session.
 */
export function watchCloudReachable(onUp: CloudUpListener): () => void {
    if (capabilitiesSync().cloud) {
        onUp();
        return () => {};
    }
    cloudUpListeners.add(onUp);
    runCloudWatch();
    return () => {
        cloudUpListeners.delete(onUp);
    };
}

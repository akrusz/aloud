/**
 * Runtime capability detection — what can the current environment actually
 * reach? Menus key off this so they only offer sources that work here
 * ("show what's available"): on the website there's no local app backend or
 * Ollama, in a pure local app aloud cloud may be unreachable, etc.
 *
 * Three independent axes (NOT one "desktop" binary):
 *   - flask:  the local app backend (Piper/macOS voices, claude_proxy,
 *             Ollama proxy, config-folder + voice-management tools).
 *   - cloud:  aloud cloud — the @aloud/server proxy (LLM/STT/TTS, credits).
 *   - ollama: a local Ollama daemon (reachable via the dev proxy).
 *
 * Probes run once at boot, are cached, and can be re-run (invalidate +
 * detect) when the environment may have changed — mirroring the
 * invalidateSttBackendCache pattern. The `flask` axis delegates to
 * is-desktop.ts so the existing isDesktop()/isDesktopSync() callers and this
 * share one probe.
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

/** Probe aloud cloud via its public `/config` route: proves reachability (the
 *  `cloud` axis) AND learns the Google client id in one round-trip, so any
 *  install can show real sign-in for whatever server it's pointed at. A failure
 *  (no server / offline) reads as unreachable + no id. (meditation-pal-rfb) */
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

/** Probe cloud a few times with short backoff before concluding it's down, so a
 *  transient blip at boot — a Fly cold start, or the dev server mid-`tsx watch`
 *  restart — isn't frozen into a session-long false negative. */
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
    // A positive cache holds for the session. A negative `cloud`, though, is the
    // fragile axis — usually a transient blip — so we don't freeze it: re-probe
    // cloud (only) on the next call so sign-in/credits self-heal as the user
    // navigates, without re-hammering the structural flask/ollama probes (which
    // are legitimately absent on the website and stable for the session).
    if (cached?.cloud) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
        // Re-probe path: cloud was previously unreachable. Recheck just that
        // axis (single attempt — the next navigation retries) and keep the rest.
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
        // /cloud/v1/* is aloud cloud (proxied in dev; absolute in prod); its
        // public /config route proves reachability and carries the Google client
        // id (→ runtime sign-in, build-agnostic).
        //
        // The ollama axis rides the Vite dev proxy (/ollama → :11434), the ONLY
        // place that raw path resolves. A production build — hosted web, desktop,
        // self-host — has no such route, so the probe could only 404 (the
        // console noise users were seeing on aloud.rest); skip it there and
        // report unreachable. Desktop Ollama availability comes from
        // /app/v1/providers (see provider-markers.ts), not this axis.
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

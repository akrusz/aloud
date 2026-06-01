/**
 * Runtime capability detection — what can the current environment actually
 * reach? Menus key off this so they only offer sources that work here
 * ("show what's available"): on the website there's no local Flask or Ollama,
 * in a pure local app aloud cloud may be unreachable, etc.
 *
 * Three independent axes (NOT one "desktop" binary):
 *   - flask:  the local Flask backend (Piper/macOS voices, claude_proxy,
 *             Ollama proxy, config-folder + voice-management tools).
 *   - cloud:  aloud cloud — the @aloud/server proxy (LLM/STT/TTS, credits).
 *   - ollama: a local Ollama daemon (reachable via the dev proxy).
 *
 * Probes run once at boot, are cached, and can be re-run (invalidate +
 * detect) when the environment may have changed — mirroring the
 * invalidateSttBackendCache pattern. `flask` delegates to is-desktop.ts so the
 * existing isDesktop()/isDesktopSync() callers and this share one probe.
 */

import { detectIsDesktop, isDesktopSync } from './is-desktop.js';
import { cloudUrl } from './cloud-base.js';
import { setRuntimeGoogleClientId, setRuntimeAppleClientId } from './cloud-auth.js';

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
    appleClientId: string;
}

async function probeCloud(): Promise<CloudConfig> {
    try {
        const r = await fetch(cloudUrl('/config'), { method: 'GET' });
        if (!r.ok) return { reachable: false, googleClientId: '', appleClientId: '' };
        const data = (await r.json()) as { googleClientId?: string; appleClientId?: string };
        return {
            reachable: true,
            googleClientId: data.googleClientId ?? '',
            appleClientId: data.appleClientId ?? '',
        };
    } catch {
        return { reachable: false, googleClientId: '', appleClientId: '' };
    }
}

export async function detectCapabilities(): Promise<Capabilities> {
    if (cached) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
        const [flask, cloud, ollama] = await Promise.all([
            detectIsDesktop(), // GET /api/system-info
            // /cloud/v1/* is aloud cloud (proxied in dev; absolute in prod). The
            // public /config route proves reachability and carries the Google
            // client id (→ runtime sign-in, build-agnostic).
            probeCloud(),
            // Ollama via the dev proxy (/ollama → :11434); 404s on the website.
            reachable('/ollama/api/tags'),
        ]);
        setRuntimeGoogleClientId(cloud.googleClientId);
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

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

export async function detectCapabilities(): Promise<Capabilities> {
    if (cached) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
        const [flask, cloud, ollama] = await Promise.all([
            detectIsDesktop(), // GET /api/system-info
            // /cloud/v1/* is aloud cloud (proxied in dev; absolute in prod). Any
            // public route proves reachability; models is always non-empty.
            reachable(cloudUrl('/me/models')),
            // Ollama via the dev proxy (/ollama → :11434); 404s on the website.
            reachable('/ollama/api/tags'),
        ]);
        cached = { flask, cloud, ollama };
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

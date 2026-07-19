/**
 * Base URL for aloud cloud, the `/cloud/v1/*` surface (@aloud/server): auth,
 * account, billing/credits, and the metered LLM/STT/TTS those credits buy.
 *
 * In dev the UI calls relative paths and the Vite proxy forwards them. A
 * deployed static build has no proxy, so it needs the absolute origin baked in
 * via VITE_ALOUD_CLOUD_URL. Leave unset for dev and for any deploy where the
 * static host reverse-proxies /cloud on the same origin.
 *
 * Mirrors `app-base.ts` (`/app/v1/*`); on web one origin serves both, so they
 * share VITE_ALOUD_CLOUD_URL.
 */

const CLOUD_PREFIX = '/cloud/v1';

const BASE = (import.meta.env.VITE_ALOUD_CLOUD_URL ?? '').replace(/\/+$/, '');

/** Resolve a sub-path (e.g. "/llm/complete") to a full URL. Callers pass the
 *  path *after* `/cloud/v1`; this helper owns the prefix. */
export function cloudUrl(path: string): string {
    return `${BASE}${CLOUD_PREFIX}${path}`;
}

/** True for a build shipped with an explicit cloud URL (cloud/website/mobile),
 *  where the metered proxy is the intended path. Defaults BYOK providers off (a
 *  public site asking for the visitor's API key feels wrong); a local/dev build
 *  keeps BYOK on. Build-time fact, so an unreachable server can't flip it. */
export function isCloudBuild(): boolean {
    return BASE !== '';
}

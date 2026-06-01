/**
 * Base URL for aloud cloud — the `/cloud/v1/*` surface
 * (@aloud/server). This is the signed-in, billed service: auth, account,
 * billing/credits, and the metered LLM/STT/TTS forwarding those credits buy.
 *
 * Dev: the UI calls relative `/cloud/v1/...` paths and the Vite proxy forwards
 * them to the server (ui/vite.config.ts). A deployed static build has no proxy,
 * so it needs the absolute server origin, baked in at build time via
 * VITE_ALOUD_CLOUD_URL (e.g. `VITE_ALOUD_CLOUD_URL=https://api.aloud.example
 * npm run ui:build`). Leave it unset for dev and for any deploy where the static
 * host reverse-proxies /cloud to the server on the same origin.
 *
 * Mirrors `app-base.ts` (the app's own `/app/v1/*` backend); the same origin
 * serves both surfaces on web, so they share VITE_ALOUD_CLOUD_URL.
 */

/** Version-namespaced prefix for every aloud cloud route. */
const CLOUD_PREFIX = '/cloud/v1';

const BASE = (import.meta.env.VITE_ALOUD_CLOUD_URL ?? '').replace(/\/+$/, '');

/** Resolve a cloud-service sub-path (e.g. "/llm/complete") to a full URL. The
 *  caller passes the path *after* `/cloud/v1`; this helper owns the prefix. */
export function cloudUrl(path: string): string {
    return `${BASE}${CLOUD_PREFIX}${path}`;
}

/** True for the cloud/website/mobile build — i.e. one shipped with an explicit
 *  aloud cloud URL, where the metered proxy is the intended path. Used to default
 *  bring-your-own-key providers off (a public site asking for the visitor's API
 *  key feels wrong); a local/dev build (no base) keeps BYOK on. Build-time fact,
 *  not a runtime probe, so a momentarily-unreachable server can't flip it. */
export function isCloudBuild(): boolean {
    return BASE !== '';
}

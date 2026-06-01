/**
 * Base URL for the app's own backend — the `/app/v1/*` surface (formerly the
 * Flask `/api/*` routes). This is the backend that serves the running
 * application's own needs: provider/model/voice catalogs, system info, and (on
 * desktop) on-device STT/TTS, the claude-proxy bridge, Ollama management, and
 * shell escapes.
 *
 * Where the base points:
 * - **Dev**: empty base — the UI calls relative `/app/v1/...` paths and the Vite
 *   proxy forwards them (see ui/vite.config.ts).
 * - **Web (hosted)**: a static build (e.g. GitHub Pages) has no proxy and lives
 *   on a different origin than the backend, so the API origin is baked in at
 *   build time via `VITE_ALOUD_CLOUD_URL` — the same origin that serves the
 *   `/cloud/v1/*` service (one Hono process answers both).
 * - **Tauri desktop**: the Rust shell starts an embedded server on an ephemeral
 *   loopback port and injects `window.__ALOUD_API_BASE__` via an
 *   initialization_script before any page script runs (see src-tauri/lib.rs +
 *   server.rs). That takes precedence so `/app/v1/...` resolves to the local
 *   server.
 *
 * Mirrors `cloud-base.ts` (the hosted `/cloud/v1/*` service) so desktop and web
 * share one set of fetch-based adapters — only the base differs.
 */

/** Version-namespaced prefix for every app-backend route. */
const APP_PREFIX = '/app/v1';

const BASE = (
    (globalThis as unknown as { __ALOUD_API_BASE__?: string }).__ALOUD_API_BASE__ ??
    import.meta.env.VITE_ALOUD_CLOUD_URL ??
    ''
).replace(/\/+$/, '');

/** Resolve an app-backend sub-path (e.g. "/system-info") to a full URL.
 *  The caller passes the path *after* `/app/v1`; this helper owns the prefix so
 *  call sites can't drift. */
export function appUrl(path: string): string {
    return `${BASE}${APP_PREFIX}${path}`;
}

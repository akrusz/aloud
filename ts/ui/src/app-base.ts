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

// --- Desktop API token ------------------------------------------------------
//
// The embedded loopback server requires a random per-launch token on every
// request (anything on the machine — or any website, via localhost fetch / DNS
// rebinding — can reach a loopback port, and this one proxies the claude CLI
// and reads/writes session files). The Rust shell injects the token alongside
// the base URL (lib.rs initialization_script); here we wrap global fetch so
// every request to the loopback base carries it. A global wrapper, rather than
// per-call headers, because /app/v1 fetches are scattered across many modules
// — and they all import this module (for appUrl) before issuing any request,
// so the wrap is in place first. On web builds the token global doesn't exist
// (the Hono /app/v1 needs no token) and fetch is left untouched.

const API_TOKEN = (globalThis as unknown as { __ALOUD_API_TOKEN__?: string }).__ALOUD_API_TOKEN__;

if (API_TOKEN && BASE) {
    const realFetch = globalThis.fetch.bind(globalThis);
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.startsWith(`${BASE}/`)) {
            const headers = new Headers(
                init?.headers ?? (input instanceof Request ? input.headers : undefined)
            );
            headers.set('x-aloud-token', API_TOKEN);
            return realFetch(input, { ...init, headers });
        }
        return realFetch(input, init);
    };
}

/**
 * Base URL for the app's own backend, the `/app/v1/*` surface: catalogs, system
 * info, and on desktop on-device STT/TTS, claude-proxy, Ollama, shell escapes.
 * Mirrors `cloud-base.ts` so desktop and web share one set of fetch adapters.
 *
 * - Dev: empty base; the Vite proxy forwards relative paths (ui/vite.config.ts).
 * - Web (hosted): static build on a different origin than the backend, so the
 *   origin is baked in at build time via `VITE_ALOUD_CLOUD_URL` (one Hono
 *   process answers both `/app/v1` and `/cloud/v1`).
 * - Tauri desktop: the Rust shell injects `window.__ALOUD_API_BASE__` (an
 *   ephemeral loopback port) via initialization_script before any page script
 *   runs (src-tauri/lib.rs + server.rs); it takes precedence.
 */

/** Version-namespaced prefix for every app-backend route. */
const APP_PREFIX = '/app/v1';

const BASE = (
    (globalThis as unknown as { __ALOUD_API_BASE__?: string }).__ALOUD_API_BASE__ ??
    import.meta.env.VITE_ALOUD_CLOUD_URL ??
    ''
).replace(/\/+$/, '');

/** Resolve an app-backend sub-path (the part *after* `/app/v1`, e.g.
 *  "/system-info") to a full URL. */
export function appUrl(path: string): string {
    return `${BASE}${APP_PREFIX}${path}`;
}

// --- Desktop API token ------------------------------------------------------
//
// The embedded loopback server requires a random per-launch token on every
// request: anything on the machine, or any website via localhost fetch / DNS
// rebinding, can reach a loopback port, and this one proxies the claude CLI and
// reads/writes session files. The Rust shell injects the token alongside the
// base URL (lib.rs initialization_script). We wrap global fetch rather than
// setting per-call headers because /app/v1 fetches are scattered across many
// modules, and they all import this module (for appUrl) before issuing a
// request, so the wrap is in place first. Web builds have no token global (Hono
// needs none) and fetch is left untouched.

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

/**
 * Session token for the aloud cloud (@aloud/server).
 *
 * The metered LLM proxy (/v1/llm/complete) is behind bearer auth: every
 * request carries a short-lived session JWT the server minted. In production
 * that token comes from Google sign-in (meditation-pal-rfb); until that flow
 * exists, `ensureCloudToken()` falls back to the server's dev sign-in route
 * (/v1/auth/dev, local-only) so the whole loop runs end-to-end locally.
 *
 * The token is cached in a KvStorage slot (localStorage today, swappable per
 * platform — same pattern as api-keys.ts). It's not a secret in the BYOK
 * sense, but treating it like one keeps it out of serialized setup/state.
 */

import { LocalStorageKv } from './adapters/localstorage-kv.js';
import { cloudUrl } from './cloud-base.js';
import type { KvStorage } from '../../src/platform/storage.js';

const TOKEN_KEY = 'server:token';

/** Shape mirrors the server's AuthResponse (ts/server/src/contract.ts).
 *  Hand-mirrored until the shared @aloud/contract package lands. */
export interface AuthResponse {
    token: string;
    isNewAccount: boolean;
    account: { id: string; email: string; emailVerified: boolean; creditsRemaining: number };
}

// Lazy so importing this module doesn't construct LocalStorageKv (which throws
// outside a browser, e.g. in Node tests). Tests call setCloudAuthBackend first.
let backendOverride: KvStorage | null = null;
let lazyBackend: KvStorage | null = null;
function kv(): KvStorage {
    if (backendOverride) return backendOverride;
    if (!lazyBackend) lazyBackend = new LocalStorageKv();
    return lazyBackend;
}
let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

/** Swap the storage backend (tests / future Capacitor secure storage). */
export function setCloudAuthBackend(kvStorage: KvStorage): void {
    backendOverride = kvStorage;
}

/** Swap fetch (tests). */
export function setCloudAuthFetch(impl: typeof fetch): void {
    fetchImpl = impl;
}

/** The configured Google OAuth web client id, or '' when unset. Build-time
 *  fact (Vite inlines `import.meta.env.VITE_*`), so a build is "Google sign-in
 *  capable" iff this was set at build time. */
export function googleClientId(): string {
    return import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '';
}

/** True when the build ships real Google sign-in (vs the dev fallback). */
export function isGoogleSignInConfigured(): boolean {
    return googleClientId() !== '';
}

/** Thrown by ensureCloudToken when a hosted (Google-configured) build has no
 *  cached session: the user must complete interactive sign-in, which can't be
 *  done from a mid-session LLM call. Callers catch this to surface the sign-in
 *  UI (google-signin.ts) instead of erroring the turn. */
export class CloudSignInRequiredError extends Error {
    constructor() {
        super('Sign in to continue.');
        this.name = 'CloudSignInRequiredError';
    }
}

export async function getCloudToken(): Promise<string | null> {
    return kv().get(TOKEN_KEY);
}

/** GET /cloud/v1/me — the signed-in account + live balance. Returns null when
 *  there's no cached token or the server rejects it (expired/invalid); callers
 *  treat null as "signed out". Shape mirrors the server's AccountView. */
export async function fetchMe(): Promise<AuthResponse['account'] | null> {
    const token = await getCloudToken();
    if (!token) return null;
    const res = await fetchImpl(cloudUrl('/me'), { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return (await res.json()) as AuthResponse['account'];
}

export async function clearCloudToken(): Promise<void> {
    await kv().delete(TOKEN_KEY);
}

/** POST /v1/auth/dev — mint (or reuse) the local dev session. */
export async function devSignIn(): Promise<AuthResponse> {
    const res = await fetchImpl(cloudUrl('/auth/dev'), { method: 'POST' });
    if (!res.ok) {
        throw new Error(
            res.status === 404
                ? 'aloud cloud has dev sign-in disabled (production mode).'
                : `aloud cloud sign-in failed (${res.status}). Is it running on :8787?`
        );
    }
    const body = (await res.json()) as AuthResponse;
    await kv().set(TOKEN_KEY, body.token);
    return body;
}

/** POST /cloud/v1/auth/google — exchange a Google ID token for an aloud
 *  session. The production sign-in (meditation-pal-rfb): the server verifies
 *  the token against Google's JWKS, creates the account on first sign-in, and
 *  grants free credits to verified emails. The returned token is cached like
 *  the dev one. Called from the Google Identity Services callback in
 *  google-signin.ts. */
export async function googleSignIn(idToken: string): Promise<AuthResponse> {
    const res = await fetchImpl(cloudUrl('/auth/google'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ idToken }),
    });
    if (!res.ok) {
        throw new Error(
            res.status === 401
                ? 'Google sign-in was rejected. Please try again.'
                : `aloud cloud sign-in failed (${res.status}).`
        );
    }
    const body = (await res.json()) as AuthResponse;
    await kv().set(TOKEN_KEY, body.token);
    return body;
}

/**
 * Return a valid server token. A cached token wins. Otherwise: a Google-
 * configured (hosted) build can't mint one non-interactively, so it throws
 * CloudSignInRequiredError for the caller to surface the sign-in UI; a dev
 * build (no Google client id) signs in via the local dev route so the loop
 * runs end-to-end. The session JWT is long-lived (7 days) so we don't
 * proactively refresh; an expired/invalid token surfaces as a 401 from the
 * proxy, which the caller clears and retries through here.
 */
export async function ensureCloudToken(): Promise<string> {
    const existing = await getCloudToken();
    if (existing) return existing;
    if (isGoogleSignInConfigured()) throw new CloudSignInRequiredError();
    const { token } = await devSignIn();
    return token;
}

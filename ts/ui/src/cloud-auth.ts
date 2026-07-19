/**
 * Session token for the aloud cloud (@aloud/server).
 *
 * Metered proxies are behind bearer auth: every request carries a session JWT
 * the server minted, from Google/Apple/email sign-in. A dev build with no
 * Google client id falls back to /v1/auth/dev (local-only) so the loop runs
 * end-to-end locally.
 *
 * Cached in a KvStorage slot (localStorage today, swappable per platform, same
 * pattern as api-keys.ts). Not a BYOK secret, but treating it like one keeps it
 * out of serialized setup/state.
 */

import { LocalStorageKv } from './adapters/localstorage-kv.js';
import { cloudUrl } from './cloud-base.js';
import { setKnownBalance, clearKnownBalance } from './cloud-balance.js';
import { setRetreatCovered, clearRetreatCovered } from './cloud-coverage.js';
import { isDevBypass } from './app-mode.js';
import type { KvStorage } from '../../src/platform/storage.js';

const TOKEN_KEY = 'server:token';

/** Mirrors the server's AuthResponse (ts/server/src/contract.ts), by hand. */
export type SignInProvider = 'google' | 'apple' | 'email';

export interface AccountView {
    id: string;
    email: string;
    emailVerified: boolean;
    creditsRemaining: number;
    /** Linked sign-in methods; drives the "connect Google/Apple for credits"
     *  affordance (meditation-pal-116). */
    providers: SignInProvider[];
    /** Retreat pass covering this account (meditation-pal-414): usage is free,
     *  so the UI drops spend prompts + cost estimates. Absent from servers
     *  deployed before retreat passes (treated as false). */
    retreatCovered?: boolean;
}

export interface AuthResponse {
    token: string;
    isNewAccount: boolean;
    account: AccountView;
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

/** Google OAuth web client id discovered at runtime from the reachable cloud
 *  (`GET /cloud/v1/config`, via capabilities.detectCapabilities), so ANY install
 *  shows real Google sign-in when its server is Google-configured, with nothing
 *  baked in at build. null until the probe runs; '' means the server has none. */
let runtimeClientId: string | null = null;

/** Record (or clear) the client id the server advertises; idempotent.
 *  (meditation-pal-rfb) */
export function setRuntimeGoogleClientId(id: string): void {
    runtimeClientId = id;
}

/** The effective Google OAuth web client id, or ''. Runtime value wins, else the
 *  build-time bake (`VITE_GOOGLE_CLIENT_ID`), so a hosted build works before the
 *  probe resolves and an unbaked local/desktop build picks it up from its cloud. */
export function googleClientId(): string {
    return runtimeClientId || (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '');
}

/** True when real Google sign-in is available (vs the dev fallback). */
export function isGoogleSignInConfigured(): boolean {
    return googleClientId() !== '';
}

/** Google "Desktop app" OAuth client id for the Tauri loopback PKCE flow. Public
 *  (it appears in the auth URL the user sees); the secret stays on the server.
 *  Discovered from `/config` like the web id; '' disables it. (meditation-pal-fae) */
let runtimeGoogleDesktopClientId = '';

export function setRuntimeGoogleDesktopClientId(id: string): void {
    runtimeGoogleDesktopClientId = id;
}

export function googleDesktopClientId(): string {
    return runtimeGoogleDesktopClientId;
}

// Sign in with Apple: same runtime discovery as Google (the Services ID comes
// from the server's /config; meditation-pal-s75). No build-time bake today.
let runtimeAppleClientId: string | null = null;

export function setRuntimeAppleClientId(id: string): void {
    runtimeAppleClientId = id;
}

/** The effective Apple Services id, or '' when unset. */
export function appleClientId(): string {
    return runtimeAppleClientId || (import.meta.env.VITE_APPLE_CLIENT_ID ?? '');
}

export function isAppleSignInConfigured(): boolean {
    return appleClientId() !== '';
}

/** True when the cloud offers ANY interactive sign-in: web Google, the desktop
 *  loopback Google client, or Apple. The session gate (cloud-gate) keys off this
 *  rather than web-Google-only, since a desktop release talks to a server with
 *  only the *desktop* client configured, and gating on the web id alone let
 *  credit-spending sessions start unauthenticated. The silent dev-sign-in
 *  fallback is only correct against a bare server advertising none of them. */
export function isInteractiveSignInConfigured(): boolean {
    return (
        isGoogleSignInConfigured() || googleDesktopClientId() !== '' || isAppleSignInConfigured()
    );
}

/** Thrown by ensureCloudToken when a hosted build has no cached session:
 *  interactive sign-in is required and can't happen from a mid-session LLM call.
 *  Callers catch it to surface the sign-in UI instead of erroring the turn. */
export class CloudSignInRequiredError extends Error {
    constructor() {
        super('Sign in to continue.');
        this.name = 'CloudSignInRequiredError';
    }
}

export async function getCloudToken(): Promise<string | null> {
    return kv().get(TOKEN_KEY);
}

/** Adopt a slid session: the server re-mints a token once the presented one is a
 *  day old (X-Session-Refresh, CORS-exposed). fetchMe runs on every app launch
 *  (views/setup.ts), so a weekly user never has to re-sign-in. */
async function adoptRefreshedToken(res: Response): Promise<void> {
    const fresh = res.headers.get('x-session-refresh');
    if (fresh) await kv().set(TOKEN_KEY, fresh);
}

/** GET /cloud/v1/me: the signed-in account + live balance. null when there's no
 *  cached token or the server rejects it; callers read null as "signed out". */
export async function fetchMe(): Promise<AuthResponse['account'] | null> {
    const token = await getCloudToken();
    if (!token) return null;
    let res = await fetchImpl(cloudUrl('/me'), { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) {
        // Stale / secret-rotated token: clear, re-mint once, retry, matching the
        // LLM/TTS proxies' self-heal. dev/local re-signs-in silently; a hosted
        // build with no live session can't, so return null (signed out) rather
        // than throwing or popping a sign-in.
        await clearCloudToken();
        let fresh: string;
        try {
            fresh = await ensureCloudToken();
        } catch {
            return null;
        }
        res = await fetchImpl(cloudUrl('/me'), { headers: { authorization: `Bearer ${fresh}` } });
    }
    if (!res.ok) return null;
    await adoptRefreshedToken(res);
    const account = (await res.json()) as AuthResponse['account'];
    // Seed the shared balance store; live surfaces subscribe (meditation-pal-14s).
    if (typeof account.creditsRemaining === 'number') setKnownBalance(account.creditsRemaining);
    setRetreatCovered(account.retreatCovered === true);
    // `providers` is newer than some deployed servers; default it so callers can
    // always `.some()`/`.map()` it (missing, it crashed the account panel).
    return { ...account, providers: account.providers ?? [] };
}

export async function clearCloudToken(): Promise<void> {
    await kv().delete(TOKEN_KEY);
}

/** DELETE /cloud/v1/me (meditation-pal-8jc). Soft-delete server-side: identities
 *  freed, balance forfeit, account anonymized and unable to sign in again.
 *  Clears the local session; throws (with the server message) on failure. */
export async function deleteAccount(): Promise<void> {
    const token = await getCloudToken();
    if (!token) {
        // Nothing to delete; treat as already signed out.
        await clearCloudToken();
        clearKnownBalance();
        clearRetreatCovered();
        return;
    }
    const res = await fetchImpl(cloudUrl('/me'), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
        let serverMsg = '';
        try {
            serverMsg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
        } catch {
            /* non-JSON body */
        }
        throw new Error(serverMsg || `Could not delete the account (${res.status}).`);
    }
    await clearCloudToken();
    clearKnownBalance();
    clearRetreatCovered();
}

/** POST /v1/auth/dev - mint (or reuse) the local dev session. */
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

/**
 * POST an auth request and cache the returned session token. A cached token
 * rides along as a bearer so the server LINKS the new identity to the signed-in
 * account (the "connect to claim credits" flow, meditation-pal-116) instead of
 * making a separate one. Prefers the server's error message over the per-call
 * generic. Shared by every sign-in method below.
 */
async function postAuthAndCache(
    path: string,
    payload: unknown,
    genericError: (status: number) => string
): Promise<AuthResponse> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const existing = await getCloudToken();
    if (existing) headers['authorization'] = `Bearer ${existing}`;
    const res = await fetchImpl(cloudUrl(path), {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
    });
    if (!res.ok) {
        let serverMsg = '';
        try {
            serverMsg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? '';
        } catch {
            /* non-JSON body */
        }
        throw new Error(serverMsg || genericError(res.status));
    }
    const body = (await res.json()) as AuthResponse;
    await kv().set(TOKEN_KEY, body.token);
    return body;
}

/** POST /cloud/v1/auth/google: exchange a Google ID token for a session
 *  (meditation-pal-rfb). The server verifies against Google's JWKS and signs in,
 *  or on first connect creates/links the account and grants free credits.
 *  Called from the GIS callback in google-signin.ts. */
export function googleSignIn(idToken: string): Promise<AuthResponse> {
    return postAuthAndCache('/auth/google', { idToken }, (status) =>
        status === 401
            ? 'Google sign-in was rejected. Please try again.'
            : `aloud cloud sign-in failed (${status}).`
    );
}

/** POST /cloud/v1/auth/google/desktop: finish the loopback PKCE flow by handing
 *  the server the code the app caught, which it redeems with the held secret.
 *  Same session/credits as web. (meditation-pal-fae) */
export function desktopGoogleSignIn(args: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
}): Promise<AuthResponse> {
    return postAuthAndCache('/auth/google/desktop', args, (status) =>
        status === 401
            ? 'Google sign-in was rejected. Please try again.'
            : `aloud cloud sign-in failed (${status}).`
    );
}

/** POST /cloud/v1/auth/apple: exchange a Sign in with Apple identity token
 *  (meditation-pal-s75). Same connect semantics as Google. */
export function appleSignIn(idToken: string): Promise<AuthResponse> {
    return postAuthAndCache('/auth/apple', { idToken }, (status) =>
        status === 401
            ? 'Apple sign-in was rejected. Please try again.'
            : `aloud cloud sign-in failed (${status}).`
    );
}

/** POST /cloud/v1/auth/email/signup. Gets NO free credits until a Google/Apple
 *  identity is connected (meditation-pal-116). */
export function emailSignup(email: string, password: string): Promise<AuthResponse> {
    return postAuthAndCache('/auth/email/signup', { email, password }, () =>
        'Could not create the account. Please try again.'
    );
}

/** POST /cloud/v1/auth/email/login. */
export function emailLogin(email: string, password: string): Promise<AuthResponse> {
    return postAuthAndCache('/auth/email/login', { email, password }, (status) =>
        status === 401
            ? 'Incorrect email or password.'
            : `aloud cloud sign-in failed (${status}).`
    );
}

/** POST /cloud/v1/auth/email/set-password: add or change a password credential
 *  so a Google/Apple user can also sign in by email. Requires the current
 *  session as bearer, which postAuthAndCache supplies (and refreshes). */
export function setCloudPassword(password: string): Promise<AuthResponse> {
    return postAuthAndCache('/auth/email/set-password', { password }, (status) =>
        status === 401
            ? 'Please sign in again to set a password.'
            : `Could not set the password (${status}).`
    );
}

/**
 * Return a valid server token. A cached one wins. Otherwise a hosted
 * (Google-configured) build can't mint one non-interactively and throws
 * CloudSignInRequiredError for the caller to surface sign-in; a dev build uses
 * the local dev route. The JWT is long-lived (7 days) so there's no proactive
 * refresh: expiry surfaces as a proxy 401, which the caller clears and retries.
 */
export async function ensureCloudToken(): Promise<string> {
    const existing = await getCloudToken();
    if (existing) return existing;
    // DEV cloud-bypass (?dev): mint a local /auth/dev session even against a
    // Google-configured server, so hosted STT/LLM/TTS run without the sign-in
    // popup (e.g. in Brave). Compile-time gated + local-only route; see
    // app-mode.isDevBypass.
    if (isGoogleSignInConfigured() && !isDevBypass()) throw new CloudSignInRequiredError();
    const { token } = await devSignIn();
    return token;
}

/**
 * Session token for the aloud cloud (@aloud/server).
 *
 * The metered LLM proxy (/v1/llm/complete) is behind bearer auth: every
 * request carries a short-lived session JWT the server minted. In production
 * that token comes from Google/Apple/email sign-in (the sign-in modal); on a
 * dev build with no Google client id configured, `ensureCloudToken()` falls
 * back to the server's dev sign-in route (/v1/auth/dev, local-only) so the
 * whole loop runs end-to-end locally.
 *
 * The token is cached in a KvStorage slot (localStorage today, swappable per
 * platform — same pattern as api-keys.ts). It's not a secret in the BYOK
 * sense, but treating it like one keeps it out of serialized setup/state.
 */

import { LocalStorageKv } from './adapters/localstorage-kv.js';
import { cloudUrl } from './cloud-base.js';
import { setKnownBalance, clearKnownBalance } from './cloud-balance.js';
import { setRetreatCovered, clearRetreatCovered } from './cloud-coverage.js';
import type { KvStorage } from '../../src/platform/storage.js';

const TOKEN_KEY = 'server:token';

/** Shape mirrors the server's AuthResponse (ts/server/src/contract.ts).
 *  Hand-mirrored until the shared @aloud/contract package lands. */
export type SignInProvider = 'google' | 'apple' | 'email';

export interface AccountView {
    id: string;
    email: string;
    emailVerified: boolean;
    creditsRemaining: number;
    /** Linked sign-in methods — drives the "connect Google/Apple for credits"
     *  affordance (meditation-pal-116). */
    providers: SignInProvider[];
    /** True when a retreat pass currently covers this account (meditation-pal-414)
     *  — usage is free, so the UI drops spend prompts + cost estimates. Optional:
     *  absent from servers deployed before retreat passes (treated as false). */
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

/** Google OAuth web client id discovered at runtime from the reachable aloud
 *  cloud (`GET /cloud/v1/config`, set by capabilities.detectCapabilities). Lets
 *  ANY install — local/desktop/web — show real Google sign-in as long as the
 *  server it talks to is Google-configured, without baking the id in at build.
 *  null until the probe runs; '' means the server reported none. */
let runtimeClientId: string | null = null;

/** Record (or clear) the client id the server advertises. Called by the
 *  capability probe; idempotent. (meditation-pal-rfb) */
export function setRuntimeGoogleClientId(id: string): void {
    runtimeClientId = id;
}

/** The effective Google OAuth web client id, or '' when unset. The runtime
 *  value (from the server we're pointed at) wins; otherwise the build-time bake
 *  (`VITE_GOOGLE_CLIENT_ID`, inlined by Vite) — so a hosted build still works
 *  before the probe resolves, and a local/desktop build with nothing baked
 *  picks the id up from its cloud server. */
export function googleClientId(): string {
    return runtimeClientId || (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '');
}

/** True when real Google sign-in is available (vs the dev fallback) — from the
 *  server config or a build-time bake. */
export function isGoogleSignInConfigured(): boolean {
    return googleClientId() !== '';
}

/** Google "Desktop app" OAuth client id for the desktop (Tauri) loopback PKCE
 *  flow. Public (it appears in the auth URL the user sees); the secret stays on
 *  the server. Discovered from the cloud `/config` like the web id; '' disables
 *  desktop Google sign-in. (meditation-pal-fae) */
let runtimeGoogleDesktopClientId = '';

export function setRuntimeGoogleDesktopClientId(id: string): void {
    runtimeGoogleDesktopClientId = id;
}

export function googleDesktopClientId(): string {
    return runtimeGoogleDesktopClientId;
}

// Sign in with Apple — same runtime-discovery pattern as Google (the Services ID
// comes from the server's /config; meditation-pal-s75). No build-time bake today.
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

/** True when the cloud we're pointed at offers ANY interactive sign-in method —
 *  web Google, the desktop loopback Google client, or Apple. The session gate
 *  (cloud-gate.ensureCloudAccess) keys off this rather than web-Google-only:
 *  a desktop release talks to a server configured with just the *desktop* Google
 *  client, so gating on the web id alone let credit-spending sessions start
 *  unauthenticated. The silent dev-sign-in fallback is only correct against a
 *  bare local server that advertises no sign-in method at all. */
export function isInteractiveSignInConfigured(): boolean {
    return (
        isGoogleSignInConfigured() || googleDesktopClientId() !== '' || isAppleSignInConfigured()
    );
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
    let res = await fetchImpl(cloudUrl('/me'), { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 401) {
        // Stale / secret-rotated token — clear and re-mint once, then retry,
        // matching the LLM/TTS proxies' self-heal. dev/local re-signs-in
        // silently; a hosted build with no live session can't, so we surface
        // null (signed out) rather than throwing or popping a sign-in.
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
    const account = (await res.json()) as AuthResponse['account'];
    // Seed the shared balance store with this authoritative reading (live
    // surfaces subscribe to it — meditation-pal-14s).
    if (typeof account.creditsRemaining === 'number') setKnownBalance(account.creditsRemaining);
    setRetreatCovered(account.retreatCovered === true);
    // `providers` is newer than some deployed servers; default it so callers can
    // always `.some()`/`.map()` it (a missing field crashed the account panel
    // against a not-yet-redeployed server).
    return { ...account, providers: account.providers ?? [] };
}

export async function clearCloudToken(): Promise<void> {
    await kv().delete(TOKEN_KEY);
}

/** DELETE /cloud/v1/me — permanently delete the signed-in account
 *  (meditation-pal-8jc). Soft-delete server-side: identities freed, balance
 *  forfeit, the account anonymized and unable to sign in again. Clears the local
 *  session on success. Throws (with the server message when present) on failure. */
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

/**
 * POST an auth request and cache the returned session token. If a token is
 * already cached, it rides along as a bearer so the server LINKS the new
 * identity to the signed-in account (the "connect to claim credits" flow,
 * meditation-pal-116) instead of making a separate account. Prefers the
 * server's error message (e.g. "email already exists", identity conflict),
 * falling back to a per-call generic. Shared by every sign-in method below.
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

/** POST /cloud/v1/auth/google — exchange a Google ID token for an aloud
 *  session (meditation-pal-rfb). The server verifies the token against Google's
 *  JWKS, signs in (or, on first connect, creates/links the account and grants
 *  free credits). Called from the Google Identity Services callback in
 *  google-signin.ts. */
export function googleSignIn(idToken: string): Promise<AuthResponse> {
    return postAuthAndCache('/auth/google', { idToken }, (status) =>
        status === 401
            ? 'Google sign-in was rejected. Please try again.'
            : `aloud cloud sign-in failed (${status}).`
    );
}

/** POST /cloud/v1/auth/google/desktop — finish the desktop loopback PKCE flow:
 *  hand the server the code the app caught on its loopback; it redeems it with
 *  the held secret and verifies. Same session/credits as web. (meditation-pal-fae) */
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

/** POST /cloud/v1/auth/apple — exchange a Sign in with Apple identity token
 *  (meditation-pal-s75). Same connect semantics as Google. */
export function appleSignIn(idToken: string): Promise<AuthResponse> {
    return postAuthAndCache('/auth/apple', { idToken }, (status) =>
        status === 401
            ? 'Apple sign-in was rejected. Please try again.'
            : `aloud cloud sign-in failed (${status}).`
    );
}

/** POST /cloud/v1/auth/email/signup — create an email/password account. Gets NO
 *  free credits until a Google/Apple identity is connected (meditation-pal-116). */
export function emailSignup(email: string, password: string): Promise<AuthResponse> {
    return postAuthAndCache('/auth/email/signup', { email, password }, () =>
        'Could not create the account. Please try again.'
    );
}

/** POST /cloud/v1/auth/email/login — sign in with an email/password account. */
export function emailLogin(email: string, password: string): Promise<AuthResponse> {
    return postAuthAndCache('/auth/email/login', { email, password }, (status) =>
        status === 401
            ? 'Incorrect email or password.'
            : `aloud cloud sign-in failed (${status}).`
    );
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

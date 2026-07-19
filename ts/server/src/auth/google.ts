/**
 * Verify a Google Sign-In ID token against Google's published JWKS with `jose`,
 * no google-auth-library, keeping the dependency and audit surface small.
 *
 * meditation-pal-rfb: account identity gates free credits and holds balances.
 * meditation-pal-2yb: email_verified is REQUIRED before granting free credits,
 * the primary cheap anti-multi-account lever (a throwaway unverified Google
 * address can't farm signup grants).
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const GOOGLE_JWKS_URL = new URL('https://www.googleapis.com/oauth2/v3/certs');
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';

// Cached + auto-refreshing on key rotation; build once.
const jwks = createRemoteJWKSet(GOOGLE_JWKS_URL);

export interface GoogleIdentity {
    /** Stable per-user id (`sub`). Use this, not email, as the key. */
    sub: string;
    email: string;
    emailVerified: boolean;
}

/** Verify signature, issuer, audience, and expiry. Throws on any failure. */
export async function verifyGoogleIdToken(
    idToken: string,
    allowedClientIds: string[],
    verifier = jwtVerify
): Promise<GoogleIdentity> {
    if (allowedClientIds.length === 0) {
        throw new Error('no GOOGLE_CLIENT_IDS configured; cannot verify Google sign-in');
    }
    const { payload } = await verifier(idToken, jwks, {
        issuer: [...GOOGLE_ISSUERS],
        audience: allowedClientIds,
    });

    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : '';
    // Google sends email_verified as a boolean or the string "true".
    const ev = payload['email_verified'];
    const emailVerified = ev === true || ev === 'true';

    if (!sub || !email) throw new Error('Google ID token missing sub/email');
    return { sub, email, emailVerified };
}

/**
 * Exchange a desktop loopback authorization code for a Google ID token
 * (meditation-pal-fae). The client secret stays server-side, never in the
 * desktop binary: the app does the PKCE browser dance, catches the `code` on its
 * loopback, and posts it here to be redeemed. Returns the raw `id_token` JWT for
 * verifyGoogleIdToken. `fetchImpl` is injectable for tests.
 */
export async function exchangeGoogleCode(
    params: {
        code: string;
        codeVerifier: string;
        redirectUri: string;
        clientId: string;
        clientSecret: string;
    },
    fetchImpl: typeof fetch = fetch
): Promise<string> {
    const form = new URLSearchParams({
        code: params.code,
        client_id: params.clientId,
        client_secret: params.clientSecret,
        code_verifier: params.codeVerifier,
        redirect_uri: params.redirectUri,
        grant_type: 'authorization_code',
    });
    const res = await fetchImpl(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Google token exchange failed (${res.status}): ${detail}`);
    }
    const data = (await res.json()) as { id_token?: string };
    if (!data.id_token) throw new Error('Google token response missing id_token');
    return data.id_token;
}

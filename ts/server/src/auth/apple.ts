/**
 * Verify a Sign in with Apple ID token (meditation-pal-s75). Like google.ts:
 * verify the JWT against Apple's published JWKS with `jose`, no Apple SDK. The
 * token carries a stable `sub`, `email` (first authorization only; may be absent
 * later), and `email_verified` (Apple verifies the address itself, private-relay
 * addresses included).
 *
 * `aud` is the Services ID (web) or bundle id (native), from APPLE_CLIENT_IDS.
 * Empty config disables Apple sign-in.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

// Cached + auto-refreshing on key rotation; build once.
const jwks = createRemoteJWKSet(APPLE_JWKS_URL);

export interface AppleIdentity {
    /** Stable per-user id (`sub`). The key: email can be absent/relayed. */
    sub: string;
    /** '' when Apple omits it on later sign-ins; harmless, the existing identity
     *  row already holds the account. */
    email: string;
    emailVerified: boolean;
}

/** Verify signature, issuer, audience, and expiry. Throws on any failure. */
export async function verifyAppleIdToken(
    idToken: string,
    allowedClientIds: string[],
    verifier = jwtVerify
): Promise<AppleIdentity> {
    if (allowedClientIds.length === 0) {
        throw new Error('no APPLE_CLIENT_IDS configured; cannot verify Apple sign-in');
    }
    const { payload } = await verifier(idToken, jwks, {
        issuer: APPLE_ISSUER,
        audience: allowedClientIds,
    });

    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    const email = typeof payload['email'] === 'string' ? (payload['email'] as string) : '';
    // Apple sends email_verified as a boolean or the string "true".
    const ev = payload['email_verified'];
    const emailVerified = ev === true || ev === 'true';

    if (!sub) throw new Error('Apple ID token missing sub');
    return { sub, email, emailVerified };
}

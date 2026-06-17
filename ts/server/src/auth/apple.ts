/**
 * Verify a Sign in with Apple ID token (meditation-pal-s75). Same approach as
 * google.ts — verify the JWT directly against Apple's published JWKS with `jose`,
 * no apple-specific SDK. Apple's identity token carries a stable `sub`, the
 * `email` (present on first authorization; may be absent on later ones), and an
 * `email_verified` claim Apple sets (Apple verifies the address itself, and
 * private-relay addresses are verified too).
 *
 * The `aud` is the app's Services ID (web) or bundle id (native), supplied as
 * APPLE_CLIENT_IDS. Empty config means Apple sign-in is disabled.
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS_URL = new URL('https://appleid.apple.com/auth/keys');

// Cached + auto-refreshing on key rotation; build once.
const jwks = createRemoteJWKSet(APPLE_JWKS_URL);

export interface AppleIdentity {
    /** Stable per-user id (the `sub` claim). The key — email can be absent/relayed. */
    sub: string;
    /** May be '' when Apple omits it (later sign-ins); the existing identity row
     *  already holds the account, so a blank here is harmless. */
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

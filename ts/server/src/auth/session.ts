/**
 * Our own session tokens. Once an identity is proven (Google/Apple/email), we
 * mint a short-lived HS256 JWT carrying just the account id; later requests send
 * it as a bearer token, so we don't re-verify with the provider on every call.
 *
 * Minimal claims: account id + expiry. No email, no profile - less PII in the
 * token means less leaks if one is captured.
 */

import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'aloud-cloud';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

/** Age past which an authenticated request gets a re-minted token in the
 *  X-Session-Refresh response header (auth/middleware.ts), adopted client-side
 *  (ui cloud-auth.ts fetchMe). Makes the 7-day TTL SLIDING for anyone opening the
 *  app weekly; only a 7+ day absence forces an interactive re-sign-in. A day, not
 *  every request, keeps the header off the hot path and token churn low. */
export const REFRESH_AFTER_SECONDS = 60 * 60 * 24; // 1 day

export interface SessionClaims {
    accountId: string;
    /** iat, seconds since epoch. Drives the sliding refresh above. */
    issuedAtSeconds: number;
}

function key(secret: string): Uint8Array {
    return new TextEncoder().encode(secret);
}

export async function issueSessionToken(accountId: string, secret: string): Promise<string> {
    return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(accountId)
        .setIssuer(ISSUER)
        .setIssuedAt()
        .setExpirationTime(`${TTL_SECONDS}s`)
        .sign(key(secret));
}

/** Returns the claims, or undefined if the token is missing/invalid/expired. */
export async function verifySessionToken(
    token: string,
    secret: string
): Promise<SessionClaims | undefined> {
    try {
        const { payload } = await jwtVerify(token, key(secret), { issuer: ISSUER });
        if (typeof payload.sub === 'string' && payload.sub) {
            // We always mint with setIssuedAt(), so a missing iat means an
            // old/foreign token: treat as maximally stale so it refreshes.
            return { accountId: payload.sub, issuedAtSeconds: payload.iat ?? 0 };
        }
        return undefined;
    } catch {
        return undefined;
    }
}

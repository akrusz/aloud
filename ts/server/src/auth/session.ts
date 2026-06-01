/**
 * Our own session tokens. After a user proves their Google identity once
 * (auth/google.ts), we mint a short-lived HS256 JWT carrying just the account
 * id. Subsequent requests send it as a bearer token, so we don't re-verify
 * against Google on every call.
 *
 * Deliberately minimal claims: account id + expiry. No email, no profile — the
 * less PII rides in the token, the less leaks if one is captured.
 */

import { SignJWT, jwtVerify } from 'jose';

const ISSUER = 'aloud-cloud';
const TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export interface SessionClaims {
    accountId: string;
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
            return { accountId: payload.sub };
        }
        return undefined;
    } catch {
        return undefined;
    }
}

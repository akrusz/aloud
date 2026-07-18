/**
 * Sliding sessions (X-Session-Refresh). The 7-day session JWT re-mints on any
 * authenticated request once it's a day old, so users who open the app at
 * least weekly never face an interactive re-sign-in; only a 7+ day absence
 * expires the session for real.
 */

import { describe, it, expect } from 'vitest';
import { SignJWT } from 'jose';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { AuthResponse } from '../src/contract.js';

function devApp() {
    const config = loadConfig({
        ALOUD_ENABLE_DEV_AUTH: '1',
        ANTHROPIC_API_KEY: 'sk-test',
        ALOUD_FREE_SIGNUP_CREDITS: '20',
    });
    return createApp(buildDeps(config));
}

async function signInDev(app: ReturnType<typeof createApp>): Promise<AuthResponse> {
    const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    expect(res.status).toBe(200);
    return (await res.json()) as AuthResponse;
}

/** A token like session.ts mints, but with a backdated iat (still unexpired). */
async function backdatedToken(accountId: string, ageSeconds: number): Promise<string> {
    const iat = Math.floor(Date.now() / 1000) - ageSeconds;
    return new SignJWT({})
        .setProtectedHeader({ alg: 'HS256' })
        .setSubject(accountId)
        .setIssuer('aloud-cloud')
        .setIssuedAt(iat)
        .setExpirationTime(iat + 60 * 60 * 24 * 7)
        .sign(new TextEncoder().encode('dev-insecure-secret')); // loadConfig({}) non-strict default
}

describe('sliding session refresh', () => {
    it('a fresh token gets no refresh header', async () => {
        const app = devApp();
        const { token } = await signInDev(app);
        const res = await app.request('/cloud/v1/me', {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
        expect(res.headers.get('x-session-refresh')).toBeNull();
    });

    it('a day-old token gets a re-minted one that authenticates', async () => {
        const app = devApp();
        const { account } = await signInDev(app);
        const old = await backdatedToken(account.id, 60 * 60 * 24 * 2); // 2 days

        const res = await app.request('/cloud/v1/me', {
            headers: { authorization: `Bearer ${old}` },
        });
        expect(res.status).toBe(200);
        const fresh = res.headers.get('x-session-refresh');
        expect(fresh).toBeTruthy();
        expect(fresh).not.toBe(old);

        // The refreshed token is a full-strength session…
        const res2 = await app.request('/cloud/v1/me', {
            headers: { authorization: `Bearer ${fresh}` },
        });
        expect(res2.status).toBe(200);
        // …and being newly minted, it does not itself trigger another refresh.
        expect(res2.headers.get('x-session-refresh')).toBeNull();
    });

    it('an expired token still 401s (refresh only slides LIVE sessions)', async () => {
        const app = devApp();
        const { account } = await signInDev(app);
        const expired = await backdatedToken(account.id, 60 * 60 * 24 * 8); // past the 7d TTL
        const res = await app.request('/cloud/v1/me', {
            headers: { authorization: `Bearer ${expired}` },
        });
        expect(res.status).toBe(401);
    });
});

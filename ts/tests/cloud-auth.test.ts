/**
 * cloud-auth.ts — the hosted-session token flow. Covers the new Google
 * sign-in path (meditation-pal-rfb) and the dev fallback, with an injected KV
 * + fetch so it runs hermetically in Node.
 *
 * Note: VITE_GOOGLE_CLIENT_ID is unset in the test env, so
 * isGoogleSignInConfigured() is false here — ensureCloudToken takes the dev
 * branch. The Google-configured branch (throws CloudSignInRequiredError) is a
 * build-time toggle we can't flip per-test; it's exercised by typecheck + the
 * unit assertion on googleSignIn directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    googleSignIn,
    appleSignIn,
    emailSignup,
    emailLogin,
    fetchMe,
    devSignIn,
    ensureCloudToken,
    getCloudToken,
    clearCloudToken,
    googleClientId,
    isGoogleSignInConfigured,
    setRuntimeGoogleClientId,
    CloudSignInRequiredError,
    setCloudAuthBackend,
    setCloudAuthFetch,
} from '../ui/src/cloud-auth.js';
import type { KvStorage } from '../src/platform/storage.js';

class MemoryKv implements KvStorage {
    private m = new Map<string, string>();
    async get(k: string) {
        return this.m.get(k) ?? null;
    }
    async set(k: string, v: string) {
        this.m.set(k, v);
    }
    async delete(k: string) {
        this.m.delete(k);
    }
    async keys() {
        return [...this.m.keys()];
    }
    async clear() {
        this.m.clear();
    }
}

const AUTH_BODY = {
    token: 'tok-google',
    isNewAccount: true,
    account: { id: 'a1', email: 'u@example.com', emailVerified: true, creditsRemaining: 20 },
};

let kv: MemoryKv;

beforeEach(() => {
    kv = new MemoryKv();
    setCloudAuthBackend(kv);
    setRuntimeGoogleClientId(''); // reset the runtime client id between tests
});

describe('googleSignIn', () => {
    it('POSTs the ID token as JSON and caches the returned session token', async () => {
        let seen: { url: string; init?: RequestInit } | null = null;
        setCloudAuthFetch(async (url, init) => {
            seen = { url: String(url), init };
            return new Response(JSON.stringify(AUTH_BODY), { status: 200 });
        });

        const body = await googleSignIn('id-token-xyz');

        expect(body.token).toBe('tok-google');
        expect(seen!.url).toMatch(/\/cloud\/v1\/auth\/google$/);
        expect(seen!.init?.method).toBe('POST');
        expect(JSON.parse(String(seen!.init?.body))).toEqual({ idToken: 'id-token-xyz' });
        // Token is cached for subsequent ensureCloudToken() calls.
        expect(await getCloudToken()).toBe('tok-google');
    });

    it('throws a friendly message when the server rejects the token (401)', async () => {
        setCloudAuthFetch(async () => new Response('nope', { status: 401 }));
        await expect(googleSignIn('bad')).rejects.toThrow(/rejected/i);
        expect(await getCloudToken()).toBeNull();
    });
});

describe('ensureCloudToken', () => {
    it('returns a cached token without any network call', async () => {
        await kv.set('server:token', 'cached');
        setCloudAuthFetch(async () => {
            throw new Error('should not fetch when a token is cached');
        });
        expect(await ensureCloudToken()).toBe('cached');
    });

    it('falls back to dev sign-in when Google is not configured (dev build)', async () => {
        // Guard the assumption this whole branch rests on.
        expect(isGoogleSignInConfigured()).toBe(false);
        setCloudAuthFetch(async () =>
            new Response(JSON.stringify({ ...AUTH_BODY, token: 'tok-dev' }), { status: 200 })
        );
        await clearCloudToken();
        expect(await ensureCloudToken()).toBe('tok-dev');
    });
});

describe('fetchMe — sliding session refresh', () => {
    it('adopts a re-minted token from X-Session-Refresh', async () => {
        await kv.set('server:token', 'tok-day-old');
        setCloudAuthFetch(async () =>
            new Response(
                JSON.stringify({ id: 'a1', email: 'u@e.com', emailVerified: true, creditsRemaining: 5, providers: [] }),
                { status: 200, headers: { 'x-session-refresh': 'tok-slid' } }
            )
        );
        const me = await fetchMe();
        expect(me?.creditsRemaining).toBe(5);
        expect(await getCloudToken()).toBe('tok-slid');
    });

    it('keeps the cached token when the server sends no refresh header', async () => {
        await kv.set('server:token', 'tok-fresh-enough');
        setCloudAuthFetch(async () =>
            new Response(
                JSON.stringify({ id: 'a1', email: 'u@e.com', emailVerified: true, creditsRemaining: 5, providers: [] }),
                { status: 200 }
            )
        );
        await fetchMe();
        expect(await getCloudToken()).toBe('tok-fresh-enough');
    });
});

describe('fetchMe — tolerant of an older server', () => {
    it('defaults a missing `providers` to [] so the account panel can map it', async () => {
        await kv.set('server:token', 'tok');
        // An older (not-yet-redeployed) server omits `providers` entirely.
        setCloudAuthFetch(async () =>
            new Response(
                JSON.stringify({ id: 'a1', email: 'u@e.com', emailVerified: true, creditsRemaining: 5 }),
                { status: 200 }
            )
        );
        const me = await fetchMe();
        expect(me?.providers).toEqual([]);
        expect(me?.creditsRemaining).toBe(5);
    });

    it('self-heals a stale token: on 401 it re-mints (dev) and retries /me', async () => {
        await kv.set('server:token', 'stale');
        let meCalls = 0;
        let devSignIns = 0;
        setCloudAuthFetch(async (url) => {
            const u = String(url);
            if (u.endsWith('/auth/dev')) {
                devSignIns++;
                return new Response(JSON.stringify({ ...AUTH_BODY, token: 'tok-fresh' }), { status: 200 });
            }
            // /me: reject the stale token once, accept the re-minted one.
            meCalls++;
            return meCalls === 1
                ? new Response('unauthorized', { status: 401 })
                : new Response(
                      JSON.stringify({ id: 'a1', email: 'u@e.com', emailVerified: true, creditsRemaining: 7, providers: [] }),
                      { status: 200 }
                  );
        });

        const me = await fetchMe();
        expect(devSignIns).toBe(1); // cleared the stale token, re-signed-in once
        expect(meCalls).toBe(2); // 401, then retried with the fresh token
        expect(me?.creditsRemaining).toBe(7);
        expect(await getCloudToken()).toBe('tok-fresh');
    });

    it('returns null (no throw, no sign-in loop) when the retry also fails', async () => {
        await kv.set('server:token', 'stale');
        setCloudAuthFetch(async (url) =>
            String(url).endsWith('/auth/dev')
                ? new Response(JSON.stringify({ ...AUTH_BODY, token: 'tok-fresh' }), { status: 200 })
                : new Response('unauthorized', { status: 401 })
        );
        expect(await fetchMe()).toBeNull();
    });
});

describe('additional sign-in methods (meditation-pal-s75)', () => {
    it('appleSignIn POSTs the identity token to /auth/apple and caches the token', async () => {
        let seen: { url: string; init?: RequestInit } | null = null;
        setCloudAuthFetch(async (url, init) => {
            seen = { url: String(url), init };
            return new Response(JSON.stringify({ ...AUTH_BODY, token: 'tok-apple' }), { status: 200 });
        });
        const body = await appleSignIn('apple-id-token');
        expect(body.token).toBe('tok-apple');
        expect(seen!.url).toMatch(/\/auth\/apple$/);
        expect(JSON.parse(String(seen!.init?.body))).toEqual({ idToken: 'apple-id-token' });
        expect(await getCloudToken()).toBe('tok-apple');
    });

    it('emailSignup and emailLogin POST credentials to their routes', async () => {
        const seen: string[] = [];
        setCloudAuthFetch(async (url) => {
            seen.push(String(url));
            return new Response(JSON.stringify(AUTH_BODY), { status: 200 });
        });
        await emailSignup('a@b.com', 'password1');
        await emailLogin('a@b.com', 'password1');
        expect(seen[0]).toMatch(/\/auth\/email\/signup$/);
        expect(seen[1]).toMatch(/\/auth\/email\/login$/);
    });

    it('surfaces the server error message (e.g. duplicate email)', async () => {
        setCloudAuthFetch(async () =>
            new Response(JSON.stringify({ error: { code: 'bad_request', message: 'email already exists' } }), {
                status: 400,
            })
        );
        await expect(emailSignup('dup@b.com', 'password1')).rejects.toThrow(/email already exists/);
    });

    it('rides the cached token as a bearer so a connect LINKS to the account', async () => {
        await kv.set('server:token', 'existing-tok');
        let authHeader: string | undefined;
        setCloudAuthFetch(async (_url, init) => {
            authHeader = (init?.headers as Record<string, string>)?.['authorization'];
            return new Response(JSON.stringify(AUTH_BODY), { status: 200 });
        });
        await googleSignIn('id-token');
        expect(authHeader).toBe('Bearer existing-tok');
    });
});

describe('runtime Google client id (meditation-pal-rfb)', () => {
    it('is picked up from the server probe, flipping sign-in on without a build bake', () => {
        expect(isGoogleSignInConfigured()).toBe(false); // nothing baked in test env
        setRuntimeGoogleClientId('server-web-client-id');
        expect(googleClientId()).toBe('server-web-client-id');
        expect(isGoogleSignInConfigured()).toBe(true);
    });

    it('makes ensureCloudToken require interactive sign-in instead of dev sign-in', async () => {
        setRuntimeGoogleClientId('server-web-client-id');
        await clearCloudToken();
        setCloudAuthFetch(async () => {
            throw new Error('must not hit the dev route once a client id is known');
        });
        await expect(ensureCloudToken()).rejects.toBeInstanceOf(CloudSignInRequiredError);
    });
});

describe('devSignIn', () => {
    it('surfaces the production-mode 404 as a clear message', async () => {
        setCloudAuthFetch(async () => new Response('', { status: 404 }));
        await expect(devSignIn()).rejects.toThrow(/production mode/i);
    });
});

/**
 * Ending sessions. A session token is a signature over an account id: nothing
 * is stored about it, it lasts 90 days and renews itself on use. So signing
 * out on a device only forgets the token there, and one that has leaked
 * worked until it went a season unused; changing the password did not touch
 * it. These pin the one lever that ends a token: the account's
 * sessionsValidAfter, moved by a password change and by "sign out everywhere".
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps, type Deps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { connectIdentity, issueAuthResponse } from '../src/auth/identity.js';
import { tokenStillValid } from '../src/auth/session.js';
import type { AuthResponse } from '../src/contract.js';

// Token timestamps are whole seconds, so the clock has to move between a
// sign-in and the revocation that is meant to end it. Only Date is faked:
// scrypt and the router run on the real event loop.
const T0 = Date.parse('2026-11-10T12:00:00Z');
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());
const later = (seconds: number): void => void vi.setSystemTime(Date.now() + seconds * 1000);

function setup(env: Record<string, string> = {}): { deps: Deps; app: ReturnType<typeof createApp> } {
    const deps = buildDeps(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ...env }));
    return { deps, app: createApp(deps) };
}

type App = ReturnType<typeof createApp>;
const post = (app: App, path: string, body: unknown, token?: string) =>
    app.request(`/cloud/v1${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
    });
const me = async (app: App, token: string): Promise<number> =>
    (await app.request('/cloud/v1/me', { headers: { authorization: `Bearer ${token}` } })).status;
const tokenOf = async (res: Response): Promise<string> => ((await res.json()) as AuthResponse).token;

const EMAIL = 'sitter@example.com';
const signup = (app: App, password = 'first-password') => post(app, '/auth/email/signup', { email: EMAIL, password });
const login = (app: App, password = 'first-password') => post(app, '/auth/email/login', { email: EMAIL, password });

describe('tokenStillValid', () => {
    it('passes everything while nothing has been revoked', () => {
        expect(tokenStillValid({ accountId: 'a', issuedAtSeconds: 0 }, {})).toBe(true);
    });
    it('fails a token from before the revocation, passes one from its second or after', () => {
        const account = { sessionsValidAfter: 1000 };
        expect(tokenStillValid({ accountId: 'a', issuedAtSeconds: 999 }, account)).toBe(false);
        expect(tokenStillValid({ accountId: 'a', issuedAtSeconds: 1000 }, account)).toBe(true);
        expect(tokenStillValid({ accountId: 'a', issuedAtSeconds: 1001 }, account)).toBe(true);
    });
});

describe('sign out everywhere', () => {
    it('ends every session on the account, the one that asked included', async () => {
        const { app } = setup();
        const phone = await tokenOf(await signup(app));
        later(60);
        const laptop = await tokenOf(await login(app));
        later(60);
        expect(await me(app, phone)).toBe(200);
        expect(await me(app, laptop)).toBe(200);

        expect((await post(app, '/auth/signout-all', {}, phone)).status).toBe(200);
        expect(await me(app, phone)).toBe(401);
        expect(await me(app, laptop)).toBe(401);

        // Signing in again works: only what came before is gone.
        later(5);
        expect(await me(app, await tokenOf(await login(app)))).toBe(200);
    });

    it('ends a token minted the same second it is called', async () => {
        const { app } = setup();
        const fresh = await tokenOf(await signup(app));
        expect((await post(app, '/auth/signout-all', {}, fresh)).status).toBe(200);
        expect(await me(app, fresh)).toBe(401);
    });

    it('needs a live session itself, and does nothing to another account', async () => {
        const { app } = setup();
        const mine = await tokenOf(await signup(app));
        const theirs = await tokenOf(
            await post(app, '/auth/email/signup', { email: 'other@example.com', password: 'other-password' })
        );
        later(60);
        expect((await post(app, '/auth/signout-all', {})).status).toBe(401);
        expect((await post(app, '/auth/signout-all', {}, 'not-a-token')).status).toBe(401);
        expect((await post(app, '/auth/signout-all', {}, mine)).status).toBe(200);
        expect(await me(app, theirs)).toBe(200);
    });

    it('a revoked token is not handed a renewal either', async () => {
        const { app } = setup();
        const leaked = await tokenOf(await signup(app));
        later(60);
        const owner = await tokenOf(await login(app));
        later(60);
        await post(app, '/auth/signout-all', {}, owner);
        // Old enough that a live token would be re-minted in the response.
        later(3 * 24 * 3600);
        const res = await app.request('/cloud/v1/me', { headers: { authorization: `Bearer ${leaked}` } });
        expect(res.status).toBe(401);
        expect(res.headers.get('X-Session-Refresh')).toBeNull();
    });
});

describe('changing the password', () => {
    it('ends the other sessions and hands this device a replacement', async () => {
        const { app } = setup();
        const thisDevice = await tokenOf(await signup(app));
        later(60);
        const elsewhere = await tokenOf(await login(app));
        later(60);

        const changed = await post(app, '/auth/email/set-password', { password: 'second-password' }, thisDevice);
        expect(changed.status).toBe(200);
        const replacement = await tokenOf(changed);

        expect(await me(app, replacement)).toBe(200);
        expect(await me(app, elsewhere)).toBe(401);
        expect(await me(app, thisDevice)).toBe(401);
        // And the old password opens nothing new.
        later(5);
        expect((await login(app, 'first-password')).status).toBe(401);
        expect((await login(app, 'second-password')).status).toBe(200);
    });

    it('adding a first password to a Google account revokes nothing', async () => {
        const { deps, app } = setup();
        const { account } = await connectIdentity(deps, {
            provider: 'google', sub: 'g-1', email: EMAIL, emailVerified: true,
        });
        const phone = (await issueAuthResponse(deps, account, true)).token;
        later(60);
        const laptop = (await issueAuthResponse(deps, account, false)).token;
        later(60);
        expect((await post(app, '/auth/email/set-password', { password: 'a-new-password' }, laptop)).status).toBe(200);
        expect(await me(app, phone)).toBe(200);
        expect(await me(app, laptop)).toBe(200);
    });
});

describe('every surface that honours a session token agrees', () => {
    it('the admin gate refuses a revoked token', async () => {
        const { deps, app } = setup({ ALOUD_ADMIN_EMAILS: EMAIL });
        const { account } = await connectIdentity(deps, {
            provider: 'google', sub: 'g-admin', email: EMAIL, emailVerified: true,
        });
        const token = (await issueAuthResponse(deps, account, true)).token;
        const metrics = () => app.request('/cloud/v1/admin/metrics', { headers: { authorization: `Bearer ${token}` } });
        later(60);
        expect((await metrics()).status).toBe(200);
        await post(app, '/auth/signout-all', {}, token);
        expect((await metrics()).status).toBe(401);
    });

    it("a sign-in carrying a deleted account's token starts fresh instead of joining the tombstone", async () => {
        // The account was deleted on one device; another still holds its token
        // and signs in again. Linking to "the caller's account" off the
        // signature alone attached the new login to the dead row, and that
        // login could then never sign in.
        const { deps, app } = setup();
        const stale = await tokenOf(await signup(app));
        later(60);
        expect((await app.request('/cloud/v1/me', { method: 'DELETE', headers: { authorization: `Bearer ${stale}` } })).status).toBe(200);
        later(60);

        const again = await post(app, '/auth/email/signup', { email: 'new@example.com', password: 'another-password' }, stale);
        expect(again.status).toBe(200);
        const body = (await again.json()) as AuthResponse;
        expect(await me(app, body.token)).toBe(200);
        expect((await deps.store.getAccountById(body.account.id))?.deletedAt).toBeUndefined();
    });

    it("a sign-in carrying a revoked token is not linked to that account", async () => {
        const { app } = setup();
        const revoked = await tokenOf(await signup(app));
        later(60);
        const owner = await tokenOf(await login(app));
        later(60);
        await post(app, '/auth/signout-all', {}, owner);
        later(60);
        // Whoever holds the revoked token can't use "connect a login" to climb back in.
        const res = await post(app, '/auth/email/signup', { email: 'intruder@example.com', password: 'intruder-password' }, revoked);
        const body = (await res.json()) as AuthResponse;
        expect(body.account.email).toBe('intruder@example.com');
        expect(body.account.providers).toEqual(['email']);
        const mine = (await (await app.request('/cloud/v1/me', { headers: { authorization: `Bearer ${await tokenOf(await login(app))}` } })).json()) as { id: string };
        expect(body.account.id).not.toBe(mine.id);
    });
});

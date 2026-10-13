/**
 * Beta bonus (meditation-pal-bb4k): a one-time grant for a Google/Apple sign-in
 * whose verified token names a store beta client. grantBetaBonus runs against a
 * MemoryCreditsStore-backed Deps; the /auth/google route runs with the token
 * check stubbed, since the real one needs Google's JWKS.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/auth/google.js', async (original) => ({
    ...(await original<typeof import('../src/auth/google.js')>()),
    verifyGoogleIdToken: vi.fn(),
}));

import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import type { Deps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { AuthResponse } from '../src/contract.js';
import { verifyGoogleIdToken } from '../src/auth/google.js';
import { connectIdentity, deleteAccount, type VerifiedIdentity } from '../src/auth/identity.js';
import { grantBetaBonus } from '../src/quota/beta-bonus.js';

const WEB = ['web-client'];
const ANDROID = ['web-client', 'android-client'];
const IOS_APPLE = ['app.aloud.meditation'];

function deps(env: Record<string, string> = {}): Deps {
    return buildDeps(
        loadConfig({
            ANTHROPIC_API_KEY: 'sk-test',
            ALOUD_FREE_SIGNUP_CREDITS: '20',
            ALOUD_BETA_BONUS_CLIENT_IDS: 'android-client, ios-client, app.aloud.meditation',
            ...env,
        })
    );
}

const google = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
    provider: 'google',
    sub: 'g-1',
    email: 'a@example.com',
    emailVerified: true,
    ...over,
});

const apple = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
    provider: 'apple',
    sub: 'apple-1',
    email: 'relay@privaterelay.appleid.com',
    emailVerified: true,
    ...over,
});

/** Sign in the way the route does: connect, then the bonus. */
async function signIn(d: Deps, ident: VerifiedIdentity, clients: string[], linkToAccountId?: string) {
    const { account } = await connectIdentity(d, ident, linkToAccountId ? { linkToAccountId } : {});
    return { account, beta: await grantBetaBonus(d, account, ident, clients) };
}

describe('grantBetaBonus', () => {
    it('grants once, on top of the connect grant, and never again', async () => {
        const d = deps();
        const first = await signIn(d, google(), ANDROID);
        expect(first.beta).toBe(40);
        expect(await d.ledger.balance(first.account.id)).toBe(60);

        const again = await signIn(d, google(), ANDROID);
        expect(again.beta).toBe(0);
        expect(await d.ledger.balance(first.account.id)).toBe(60);
    });

    it('reaches an account that already existed before it signed in from the beta', async () => {
        const d = deps();
        const web = await signIn(d, google(), WEB);
        expect(web.beta).toBe(0);
        const android = await signIn(d, google(), ANDROID);
        expect(android.beta).toBe(40);
        expect(await d.ledger.balance(web.account.id)).toBe(60);
    });

    it('takes the iOS bundle id on an Apple token as a beta client', async () => {
        const d = deps();
        expect((await signIn(d, apple(), IOS_APPLE)).beta).toBe(40);
    });

    it('is off with no client listed, and off at 0 credits', async () => {
        const unlisted = deps({ ALOUD_BETA_BONUS_CLIENT_IDS: '' });
        expect((await signIn(unlisted, google(), ANDROID)).beta).toBe(0);

        const zeroed = deps({ ALOUD_BETA_BONUS_CREDITS: '0' });
        expect((await signIn(zeroed, google(), ANDROID)).beta).toBe(0);
    });

    it('a second login on the same account collects nothing more', async () => {
        const d = deps();
        const first = await signIn(d, google(), ANDROID);
        const linked = await signIn(d, apple(), IOS_APPLE, first.account.id);
        expect(linked.account.id).toBe(first.account.id);
        expect(linked.beta).toBe(0);
    });

    it('delete-and-recreate collects nothing more, by identity or by mailbox', async () => {
        const d = deps();
        const first = await signIn(d, google(), ANDROID);
        await deleteAccount(d, first.account);

        const sameLogin = await signIn(d, google(), ANDROID);
        expect(sameLogin.account.id).not.toBe(first.account.id);
        expect(sameLogin.beta).toBe(0);
        await deleteAccount(d, sameLogin.account);

        // Same inbox through the other provider (Gmail ignores dots and +tags).
        const sameMailbox = await signIn(d, apple({ email: 'A+ios@example.com' }), IOS_APPLE);
        expect(sameMailbox.beta).toBe(0);
    });

    it('refuses an unverified address, but not a token that carries none', async () => {
        const d = deps();
        expect((await signIn(d, google({ emailVerified: false }), ANDROID)).beta).toBe(0);
        // Apple leaves the address off later sign-ins; the account is found by sub.
        const first = await signIn(d, apple(), WEB);
        const later = await signIn(d, apple({ email: '', emailVerified: false }), IOS_APPLE);
        expect(later.account.id).toBe(first.account.id);
        expect(later.beta).toBe(40);
    });

    it('a tripped breaker holds it back without spending the claim', async () => {
        const d = deps();
        const { account } = await connectIdentity(d, google());
        d.grantBreaker.setBudget(0);
        expect(await grantBetaBonus(d, account, google(), ANDROID)).toBe(0);
        d.grantBreaker.setBudget(2000);
        expect(await grantBetaBonus(d, account, google(), ANDROID)).toBe(40);
    });

    it('two sign-ins racing on one account grant once', async () => {
        const d = deps();
        const { account } = await connectIdentity(d, google());
        const granted = await Promise.all([
            grantBetaBonus(d, account, google(), ANDROID),
            grantBetaBonus(d, account, google(), ANDROID),
        ]);
        expect(granted.sort()).toEqual([0, 40]);
        expect(await d.ledger.balance(account.id)).toBe(60);
    });
});

describe('POST /cloud/v1/auth/google reports what the sign-in granted', () => {
    const verify = vi.mocked(verifyGoogleIdToken);
    let app: ReturnType<typeof createApp>;

    beforeEach(() => {
        app = createApp(deps());
    });

    async function signInWith(clients: string[]): Promise<AuthResponse> {
        verify.mockResolvedValue({ sub: 'g-1', email: 'a@example.com', emailVerified: true, clients });
        const res = await app.request('/cloud/v1/auth/google', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ idToken: 'tok' }),
        });
        expect(res.status).toBe(200);
        return (await res.json()) as AuthResponse;
    }

    it('both grants on a first sign-in from the beta, nothing on the next', async () => {
        const first = await signInWith(ANDROID);
        expect(first.granted).toEqual({ connect: 20, beta: 40 });
        expect(first.account.creditsRemaining).toBe(60);

        const next = await signInWith(ANDROID);
        expect(next.granted).toBeUndefined();
        expect(next.account.creditsRemaining).toBe(60);
    });

    it('the connect grant alone from the web, then the bonus when the beta signs in', async () => {
        expect((await signInWith(WEB)).granted).toEqual({ connect: 20, beta: 0 });
        expect((await signInWith(ANDROID)).granted).toEqual({ connect: 0, beta: 40 });
    });
});

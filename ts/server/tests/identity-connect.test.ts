/**
 * Identity connection + free-grant economics (meditation-pal-116). Exercises
 * connectIdentity against a real MemoryCreditsStore-backed Deps and the pure
 * decideConnectGrant rules: credits come from connecting a TRUSTED, verified
 * identity — once per account and once per identity — and a bare email signup
 * gets none until it connects Google/Apple.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import type { Deps } from '../src/deps.js';
import {
    connectIdentity,
    IdentityConflictError,
    type VerifiedIdentity,
} from '../src/auth/identity.js';
import { decideConnectGrant, isTrustedProvider } from '../src/quota/freetier.js';

function deps(env: Record<string, string> = {}): Deps {
    return buildDeps(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ALOUD_FREE_SIGNUP_CREDITS: '20', ...env }));
}

const google = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
    provider: 'google',
    sub: 'g-1',
    email: 'a@example.com',
    emailVerified: true,
    ...over,
});

describe('connectIdentity — grant on first trusted, verified connect', () => {
    it('new Google user gets an account and the free grant', async () => {
        const d = deps();
        const r = await connectIdentity(d, google());
        expect(r.isNewAccount).toBe(true);
        expect(r.isNewIdentity).toBe(true);
        expect(r.granted).toBe(20);
        expect(await d.ledger.balance(r.account.id)).toBe(20);
    });

    it('returning Google user reuses the account and never re-grants', async () => {
        const d = deps();
        const first = await connectIdentity(d, google());
        const second = await connectIdentity(d, google());
        expect(second.isNewIdentity).toBe(false);
        expect(second.account.id).toBe(first.account.id);
        expect(second.granted).toBe(0);
        expect(await d.ledger.balance(first.account.id)).toBe(20);
    });

    it('unverified Google email creates the account but grants nothing', async () => {
        const d = deps();
        const r = await connectIdentity(d, google({ emailVerified: false }));
        expect(r.granted).toBe(0);
        expect(await d.ledger.balance(r.account.id)).toBe(0);
    });
});

describe('connectIdentity — email signup vs connecting an identity', () => {
    it('a bare email identity is untrusted: account, but no free credits', async () => {
        const d = deps();
        const r = await connectIdentity(d, {
            provider: 'email',
            sub: 'a@example.com',
            email: 'a@example.com',
            emailVerified: false,
        });
        expect(r.isNewAccount).toBe(true);
        expect(r.granted).toBe(0);
        expect(await d.ledger.balance(r.account.id)).toBe(0);
    });

    it('connecting Google to an existing email account unlocks the grant', async () => {
        const d = deps();
        const email = await connectIdentity(d, {
            provider: 'email',
            sub: 'a@example.com',
            email: 'a@example.com',
            emailVerified: false,
        });
        expect(await d.ledger.balance(email.account.id)).toBe(0);

        const linked = await connectIdentity(d, google(), { linkToAccountId: email.account.id });
        expect(linked.isNewAccount).toBe(false);
        expect(linked.account.id).toBe(email.account.id);
        expect(linked.granted).toBe(20);
        expect(await d.ledger.balance(email.account.id)).toBe(20);
    });

    it('only ONE grant per account, even across two trusted identities', async () => {
        const d = deps();
        const r = await connectIdentity(d, google());
        const apple = await connectIdentity(
            d,
            { provider: 'apple', sub: 'ap-1', email: 'a@example.com', emailVerified: true },
            { linkToAccountId: r.account.id }
        );
        expect(apple.granted).toBe(0); // account already granted via Google
        expect(await d.ledger.balance(r.account.id)).toBe(20);
    });
});

describe('connectIdentity — one identity, one account', () => {
    it('refuses to link an identity already bound to a different account', async () => {
        const d = deps();
        const first = await connectIdentity(d, google()); // creates account A, links g-1
        // A second, different account tries to claim the same Google login.
        const other = await connectIdentity(d, {
            provider: 'email',
            sub: 'b@example.com',
            email: 'b@example.com',
            emailVerified: false,
        });
        await expect(
            connectIdentity(d, google(), { linkToAccountId: other.account.id })
        ).rejects.toBeInstanceOf(IdentityConflictError);
        // The original linkage and grant are untouched.
        expect(await d.ledger.balance(first.account.id)).toBe(20);
    });
});

describe('connectIdentity — free-grant breaker', () => {
    it('creates the account but grants nothing when the hourly budget is 0', async () => {
        const d = deps({ ALOUD_FREE_GRANT_BUDGET_PER_HOUR: '0' });
        const r = await connectIdentity(d, google());
        expect(r.breakerTripped).toBe(true);
        expect(r.granted).toBe(0);
        expect(await d.ledger.balance(r.account.id)).toBe(0);
    });
});

describe('decideConnectGrant (pure rules)', () => {
    const base = {
        provider: 'google' as const,
        emailVerified: true,
        accountAlreadyGranted: false,
        identityAlreadyGranted: false,
        freeCredits: 20,
    };
    it('grants for a trusted, verified, first-time connect', () => {
        expect(decideConnectGrant(base).grantCredits).toBe(20);
    });
    it('withholds from an untrusted (email) provider', () => {
        expect(decideConnectGrant({ ...base, provider: 'email' }).grantCredits).toBe(0);
    });
    it('withholds when unverified, already-granted account, or already-granted identity', () => {
        expect(decideConnectGrant({ ...base, emailVerified: false }).grantCredits).toBe(0);
        expect(decideConnectGrant({ ...base, accountAlreadyGranted: true }).grantCredits).toBe(0);
        expect(decideConnectGrant({ ...base, identityAlreadyGranted: true }).grantCredits).toBe(0);
    });
    it('classifies trusted providers', () => {
        expect(isTrustedProvider('google')).toBe(true);
        expect(isTrustedProvider('apple')).toBe(true);
        expect(isTrustedProvider('email')).toBe(false);
    });
});

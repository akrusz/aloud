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
    deleteAccount,
    IdentityConflictError,
    EmailInUseError,
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

describe('connectIdentity — cold sign-in links a second method by verified email', () => {
    const apple = (over: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
        provider: 'apple',
        sub: 'ap-1',
        email: 'a@example.com',
        emailVerified: true,
        ...over,
    });

    it('Google then Apple for the same verified mailbox is ONE account, not two', async () => {
        const d = deps();
        const g = await connectIdentity(d, google());
        const a = await connectIdentity(d, apple()); // cold, no linkToAccountId
        expect(a.isNewAccount).toBe(false);
        expect(a.account.id).toBe(g.account.id); // linked, not duplicated
        expect(a.granted).toBe(0); // account already granted via Google
        const ids = await d.store.getIdentitiesForAccount(g.account.id);
        expect(ids.map((i) => i.provider).sort()).toEqual(['apple', 'google']);
    });

    it('links across Gmail dot/+tag variants of the same mailbox', async () => {
        const d = deps();
        const g = await connectIdentity(d, google({ email: 'john.doe@gmail.com' }));
        const a = await connectIdentity(d, apple({ email: 'johndoe+promo@googlemail.com' }));
        expect(a.account.id).toBe(g.account.id);
    });

    it('refuses to auto-link onto an UNVERIFIED account (email/password squatter)', async () => {
        const d = deps();
        // An unverified password account claims the mailbox first.
        await connectIdentity(d, {
            provider: 'email', sub: 'a@example.com', email: 'a@example.com', emailVerified: false,
        });
        // A verified Google sign-in for the same mailbox must NOT graft onto it.
        await expect(connectIdentity(d, google())).rejects.toBeInstanceOf(EmailInUseError);
    });

    it('refuses an UNVERIFIED new identity onto a verified account', async () => {
        const d = deps();
        await connectIdentity(d, google()); // verified account for a@example.com
        await expect(
            connectIdentity(d, {
                provider: 'email', sub: 'a@example.com', email: 'a@example.com', emailVerified: false,
            })
        ).rejects.toBeInstanceOf(EmailInUseError);
    });

    it('a deleted account frees the mailbox for a fresh, separate sign-up', async () => {
        const d = deps();
        const first = await connectIdentity(d, google());
        await deleteAccount(d, first.account);
        const second = await connectIdentity(d, google({ sub: 'g-2' }));
        expect(second.isNewAccount).toBe(true);
        expect(second.account.id).not.toBe(first.account.id);
    });
});

describe('connectIdentity — stale session token', () => {
    it('a linkToAccountId for a missing account falls back to a new account (no throw)', async () => {
        const d = deps();
        // Simulates a stale bearer: the token verified to an account id that no
        // longer exists (e.g. an in-memory dev server restarted). Must not 500.
        const r = await connectIdentity(d, google(), { linkToAccountId: 'gone-account-id' });
        expect(r.isNewAccount).toBe(true);
        expect(r.account.id).not.toBe('gone-account-id');
        expect(r.granted).toBe(20);
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

describe('deleteAccount — soft-delete + anti-farming (meditation-pal-8jc)', () => {
    it('anonymizes, frees identities, zeroes the balance, and blocks re-auth', async () => {
        const d = deps();
        const r = await connectIdentity(d, google());
        expect(await d.ledger.balance(r.account.id)).toBe(20);

        await deleteAccount(d, r.account);

        const after = await d.store.getAccountById(r.account.id);
        expect(after?.deletedAt).toBeTypeOf('number');
        expect(after?.email).not.toBe('a@example.com'); // scrubbed
        expect(await d.ledger.balance(r.account.id)).toBe(0); // forfeited
        // The Google identity is freed (so the human can sign in fresh).
        expect(await d.store.getIdentity('google', 'g-1')).toBeUndefined();
    });

    it('a deleted user can return but does NOT get the free grant again', async () => {
        const d = deps();
        const first = await connectIdentity(d, google());
        await deleteAccount(d, first.account);

        // Same person signs in again with the same Google login → brand-new
        // account (identity was freed), but the email grant key is burned.
        const second = await connectIdentity(d, google());
        expect(second.isNewAccount).toBe(true);
        expect(second.account.id).not.toBe(first.account.id);
        expect(second.granted).toBe(0);
        expect(await d.ledger.balance(second.account.id)).toBe(0);
    });

    it('normalized email variants (dots/+tags) share one grant — no re-farming', async () => {
        const d = deps();
        const a = await connectIdentity(d, google({ sub: 'g-a', email: 'john.doe@gmail.com' }));
        expect(a.granted).toBe(20);
        // A different Google login but the SAME mailbox (dots + tag tricks).
        const b = await connectIdentity(d, google({ sub: 'g-b', email: 'johndoe+promo@googlemail.com' }));
        expect(b.granted).toBe(0);
    });

    it('a genuinely different email still gets its own grant (no false collision)', async () => {
        const d = deps();
        await connectIdentity(d, google({ sub: 'g-a', email: 'a@example.com' }));
        const other = await connectIdentity(d, google({ sub: 'g-b', email: 'b@example.com' }));
        expect(other.granted).toBe(20);
    });
});

describe('decideConnectGrant (pure rules)', () => {
    const base = {
        provider: 'google' as const,
        emailVerified: true,
        accountAlreadyGranted: false,
        identityAlreadyGranted: false,
        emailKeyAlreadyGranted: false,
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
    it('withholds when the email was already granted (delete-and-recreate farming)', () => {
        expect(decideConnectGrant({ ...base, emailKeyAlreadyGranted: true }).grantCredits).toBe(0);
    });
    it('classifies trusted providers', () => {
        expect(isTrustedProvider('google')).toBe(true);
        expect(isTrustedProvider('apple')).toBe(true);
        expect(isTrustedProvider('email')).toBe(false);
    });
});

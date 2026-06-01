/**
 * Identity connection — the shared core behind every sign-in route
 * (meditation-pal-116). A verified identity (Google/Apple token, or an
 * email+password the route already checked) is either:
 *   - already linked → sign in as its account (no grant), or
 *   - new → create a fresh account, OR link it to the caller's existing account
 *     (the "connect to claim credits" flow), then apply the free-grant rules.
 *
 * Free credits come from connecting a TRUSTED, verified identity (decideConnectGrant
 * in quota/freetier.ts): once per account and once per identity, ever. A bare
 * email signup is untrusted, so it gets an account but no credits until it
 * connects Google/Apple.
 */

import { randomUUID } from 'node:crypto';
import type { Deps } from '../deps.js';
import type { Account, IdentityProvider } from '../credits/store.js';
import type { AuthResponse } from '../contract.js';
import { decideConnectGrant } from '../quota/freetier.js';
import { issueSessionToken } from './session.js';
import { log } from '../logger.js';

/** An identity whose proof the route has already validated (OAuth token verified,
 *  or password checked) — ready to link to an account. */
export interface VerifiedIdentity {
    provider: IdentityProvider;
    /** Provider's stable id: Google/Apple `sub`, or the lower-cased email. */
    sub: string;
    email: string;
    emailVerified: boolean;
}

export interface ConnectOptions {
    /** Captured client IP, stored on a newly-created account for abuse signals. */
    signupIp?: string;
    /** When set, link the identity to this EXISTING account (the connect flow)
     *  instead of creating a new one. From the caller's verified session. */
    linkToAccountId?: string;
    /** Credential to persist on the identity (email/password hash). OAuth
     *  identities omit this. */
    secretHash?: string;
}

export interface ConnectResult {
    account: Account;
    isNewAccount: boolean;
    /** False when the identity was already linked (a returning sign-in). */
    isNewIdentity: boolean;
    granted: number;
    breakerTripped: boolean;
}

/** Raised when an identity is already linked to a DIFFERENT account than the one
 *  the caller is trying to connect it to — re-using one Google/Apple login to
 *  claim a second account's credits is exactly what we forbid. */
export class IdentityConflictError extends Error {
    constructor() {
        super('That login is already linked to a different aloud account.');
        this.name = 'IdentityConflictError';
    }
}

export async function connectIdentity(
    deps: Deps,
    ident: VerifiedIdentity,
    opts: ConnectOptions = {}
): Promise<ConnectResult> {
    const now = Date.now() / 1000;
    const existing = await deps.store.getIdentity(ident.provider, ident.sub);
    if (existing) {
        // Already linked. If the caller asked to link it to a different account,
        // that's the farming attempt we block; otherwise just sign in.
        if (opts.linkToAccountId && opts.linkToAccountId !== existing.accountId) {
            throw new IdentityConflictError();
        }
        const account = await deps.store.getAccountById(existing.accountId);
        if (!account) throw new Error(`identity ${ident.provider} points at a missing account`);
        return { account, isNewAccount: false, isNewIdentity: false, granted: 0, breakerTripped: false };
    }

    // New identity: link to the caller's account, or mint a fresh one.
    let account: Account;
    let isNewAccount = false;
    if (opts.linkToAccountId) {
        const target = await deps.store.getAccountById(opts.linkToAccountId);
        if (!target) throw new Error('cannot link identity: signed-in account not found');
        account = target;
    } else {
        account = {
            id: randomUUID(),
            email: ident.email,
            emailVerified: ident.emailVerified,
            createdAt: now,
            ...(opts.signupIp ? { signupIp: opts.signupIp } : {}),
        };
        await deps.store.createAccount(account);
        isNewAccount = true;
    }

    // Decide the grant BEFORE creating the identity (the account "already
    // granted?" check must not count the row we're about to add).
    const existingIdentities = await deps.store.getIdentitiesForAccount(account.id);
    const accountAlreadyGranted = existingIdentities.some((i) => i.grantedCredits);
    const decision = decideConnectGrant({
        provider: ident.provider,
        emailVerified: ident.emailVerified,
        accountAlreadyGranted,
        identityAlreadyGranted: false, // brand-new identity
        freeCredits: deps.config.freeSignupCredits,
    });

    await deps.store.createIdentity({
        provider: ident.provider,
        sub: ident.sub,
        accountId: account.id,
        emailVerified: ident.emailVerified,
        grantedCredits: false, // flipped below once the grant actually settles
        createdAt: now,
        ...(opts.secretHash ? { secretHash: opts.secretHash } : {}),
    });

    let granted = 0;
    let breakerTripped = false;
    if (decision.grantCredits > 0) {
        // Emergency brake: refuse the grant if the global hourly free-credit
        // budget is exhausted (mass-signup flood). The account/identity still
        // exist and can buy credits — they just get no freebie right now.
        if (deps.grantBreaker.tryConsume(decision.grantCredits)) {
            await deps.ledger.grant(account.id, decision.grantCredits, decision.reason);
            await deps.store.markIdentityGranted(ident.provider, ident.sub);
            granted = decision.grantCredits;
        } else {
            breakerTripped = true;
        }
    }

    log.info('identity connected', {
        accountId: account.id,
        provider: ident.provider,
        isNewAccount,
        emailVerified: ident.emailVerified,
        granted,
        ...(breakerTripped ? { breakerTripped: true } : {}),
    });
    if (breakerTripped) log.warn('free-grant breaker tripped', { accountId: account.id });

    return { account, isNewAccount, isNewIdentity: true, granted, breakerTripped };
}

/** Mint a session token + the account view a sign-in route returns. */
export async function issueAuthResponse(
    deps: Deps,
    account: Account,
    isNewAccount: boolean
): Promise<AuthResponse> {
    const token = await issueSessionToken(account.id, deps.config.sessionSecret);
    return {
        token,
        isNewAccount,
        account: {
            id: account.id,
            email: account.email,
            emailVerified: account.emailVerified,
            creditsRemaining: await deps.ledger.balance(account.id),
        },
    };
}

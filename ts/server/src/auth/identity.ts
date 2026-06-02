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
import type { AccountView, AuthResponse } from '../contract.js';
import { decideConnectGrant } from '../quota/freetier.js';
import { issueSessionToken } from './session.js';
import { emailGrantKey } from './email-key.js';
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

    // New identity: link it to the caller's account when they're genuinely
    // signed in, else mint a fresh one. A linkToAccountId that no longer resolves
    // — a STALE/expired session token, common after an in-memory dev server
    // restart wipes accounts while the browser keeps a still-valid-signature
    // token — is treated as "not signed in" and falls through to a new account,
    // NOT a 500 (the bug that made sign-in look broken).
    let account: Account;
    let isNewAccount = false;
    const linked = opts.linkToAccountId
        ? await deps.store.getAccountById(opts.linkToAccountId)
        : undefined;
    if (linked) {
        account = linked;
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
    // The email-derived grant key survives account deletion, so a deleted-then-
    // recreated user can't re-farm the freebie (meditation-pal-8jc). Empty email
    // (Apple omits it on repeat sign-ins) ⇒ no key to check; the identity/account
    // gates still apply.
    const grantKey = ident.email ? emailGrantKey(ident.email) : null;
    const emailKeyAlreadyGranted = grantKey ? await deps.store.hasGrantKey(grantKey) : false;
    const decision = decideConnectGrant({
        provider: ident.provider,
        emailVerified: ident.emailVerified,
        accountAlreadyGranted,
        identityAlreadyGranted: false, // brand-new identity
        emailKeyAlreadyGranted,
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
            // Burn the email key so this mailbox can't claim the freebie again,
            // even after deleting and recreating the account (meditation-pal-8jc).
            if (grantKey) await deps.store.recordGrantKey(grantKey, now);
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

/** The account + live balance + linked sign-in methods (GET /me and every auth
 *  response). Centralised so both paths report `providers` consistently. */
export async function buildAccountView(deps: Deps, account: Account): Promise<AccountView> {
    const identities = await deps.store.getIdentitiesForAccount(account.id);
    return {
        id: account.id,
        email: account.email,
        emailVerified: account.emailVerified,
        creditsRemaining: await deps.ledger.balance(account.id),
        providers: identities.map((i) => i.provider),
    };
}

/**
 * Soft-delete an account at the user's request (meditation-pal-8jc). We:
 *   - zero any remaining balance with a `debit` entry (credits are forfeit, not
 *     refunded — the ledger stays a complete, append-only audit trail),
 *   - delete the account's identities so each (provider, sub) is free to sign in
 *     fresh later (a genuine clean start for the human), and
 *   - anonymize + tombstone the account row (scrub email, stamp deletedAt) so it
 *     can no longer authenticate while its ledger foreign keys still resolve.
 * The email's grant key (recorded at grant time) is deliberately KEPT, so the
 * person can return and buy credits but can't re-claim the free grant.
 */
export async function deleteAccount(deps: Deps, account: Account): Promise<void> {
    const now = Date.now() / 1000;
    const balance = await deps.ledger.balance(account.id);
    if (balance > 0) {
        await deps.ledger.debit(account.id, balance, 'account_deleted:balance_zeroed');
    }
    await deps.store.deleteIdentitiesForAccount(account.id);
    await deps.store.markAccountDeleted(account.id, now, `deleted+${account.id}@deleted.invalid`);
    log.info('account deleted', { accountId: account.id, forfeited: balance });
}

/** Mint a session token + the account view a sign-in route returns. */
export async function issueAuthResponse(
    deps: Deps,
    account: Account,
    isNewAccount: boolean
): Promise<AuthResponse> {
    const token = await issueSessionToken(account.id, deps.config.sessionSecret);
    return { token, isNewAccount, account: await buildAccountView(deps, account) };
}

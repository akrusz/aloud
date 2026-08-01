/**
 * Identity connection, the shared core behind every sign-in route
 * (meditation-pal-116). A verified identity (Google/Apple token, or an
 * email+password the route already checked) is either:
 *   - already linked → sign in as its account (no grant), or
 *   - new → create a fresh account, OR link it to the caller's existing account
 *     (the "connect to claim credits" flow), then apply the free-grant rules.
 *
 * Free credits come from connecting a TRUSTED, verified identity
 * (decideConnectGrant in quota/freetier.ts): once per account and once per
 * identity, ever. A bare email signup is untrusted, so it gets an account but no
 * credits until it connects Google/Apple.
 */

import { randomUUID } from 'node:crypto';
import type { Deps } from '../deps.js';
import type { Account, IdentityProvider } from '../credits/store.js';
import type { AccountView, AuthResponse } from '../contract.js';
import { decideConnectGrant } from '../quota/freetier.js';
import { issueSessionToken } from './session.js';
import { emailGrantKey, normalizeEmail } from './email-key.js';
import { log } from '../logger.js';

/** An identity whose proof the route already validated (OAuth token verified or
 *  password checked), ready to link to an account. */
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
     *  instead of creating one. From the caller's verified session. */
    linkToAccountId?: string;
    /** Credential to persist on the identity (password hash). OAuth omits it. */
    secretHash?: string;
    /** The signup form's "email me occasional updates" checkbox. Only applied to
     *  a NEWLY minted account; an existing account keeps its stored choice (the
     *  account page is where that changes). */
    emailUpdates?: boolean;
}

export interface ConnectResult {
    account: Account;
    isNewAccount: boolean;
    /** False when the identity was already linked (a returning sign-in). */
    isNewIdentity: boolean;
    granted: number;
    breakerTripped: boolean;
}

/** Raised when an identity is already linked to a DIFFERENT account than the
 *  caller is connecting it to. Re-using one Google/Apple login to claim a second
 *  account's credits is exactly what we forbid. */
export class IdentityConflictError extends Error {
    constructor() {
        super('That login is already linked to a different aloud account.');
        this.name = 'IdentityConflictError';
    }
}

/** Raised on a cold sign-in when this mailbox already has a live account we
 *  can't safely auto-link to (a new login can only join an existing account when
 *  BOTH are email-verified). The human signs in with their existing method and
 *  connects this one from settings, the authenticated path. Prevents duplicate
 *  accounts and an unverified signup grafting onto a verified account. */
export class EmailInUseError extends Error {
    constructor() {
        super('An account already exists for this email. Sign in with your original method, then connect this one in settings.');
        this.name = 'EmailInUseError';
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
        // Already linked. Linking it to a different account is the farming
        // attempt we block; otherwise just sign in.
        if (opts.linkToAccountId && opts.linkToAccountId !== existing.accountId) {
            throw new IdentityConflictError();
        }
        const account = await deps.store.getAccountById(existing.accountId);
        if (!account) throw new Error(`identity ${ident.provider} points at a missing account`);
        return { account, isNewAccount: false, isNewIdentity: false, granted: 0, breakerTripped: false };
    }

    // New identity: link to the caller's account when they're genuinely signed
    // in, else mint a fresh one. A linkToAccountId that no longer resolves (a
    // STALE session token, common after an in-memory dev restart wipes accounts
    // while the browser keeps a still-valid-signature token) counts as "not
    // signed in" and falls through to a new account, NOT a 500 (the bug that made
    // sign-in look broken).
    let account: Account;
    let isNewAccount = false;
    const linked = opts.linkToAccountId
        ? await deps.store.getAccountById(opts.linkToAccountId)
        : undefined;
    if (linked) {
        account = linked;
    } else {
        // Cold sign-in (no caller session). Before minting an account, check
        // whether this mailbox already has one - canonical match, so Gmail
        // dot/+tag variants count as the same person. If so, attach only when
        // BOTH sides are email-verified (Google/Apple vouch for the address),
        // which safely reunites a split Google+Apple login into one account.
        // Otherwise refuse rather than fork a duplicate or let an unverified
        // signup graft onto a verified account.
        const sibling = await deps.store.findLiveAccountByEmail(ident.email);
        if (sibling) {
            if (ident.emailVerified && sibling.emailVerified) {
                account = sibling;
            } else {
                throw new EmailInUseError();
            }
        } else {
            account = {
                id: randomUUID(),
                email: ident.email,
                emailVerified: ident.emailVerified,
                createdAt: now,
                ...(opts.signupIp ? { signupIp: opts.signupIp } : {}),
                ...(opts.emailUpdates ? { emailUpdates: true } : {}),
            };
            await deps.store.createAccount(account);
            isNewAccount = true;
        }
    }

    // Decide the grant BEFORE creating the identity: the account "already
    // granted?" check must not count the row we're about to add.
    const existingIdentities = await deps.store.getIdentitiesForAccount(account.id);
    const accountAlreadyGranted = existingIdentities.some((i) => i.grantedCredits);
    // The email-derived grant key survives account deletion, so delete-then-
    // recreate can't re-farm the freebie (meditation-pal-8jc). Empty email (Apple
    // omits it on repeat sign-ins) means no key to check; the identity/account
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
        // Emergency brake: refuse the grant when the global hourly free-credit
        // budget is exhausted (mass-signup flood). The account/identity still
        // exist and can buy credits, just no freebie right now.
        if (deps.grantBreaker.tryConsume(decision.grantCredits)) {
            await deps.ledger.grant(account.id, decision.grantCredits, decision.reason);
            await deps.store.markIdentityGranted(ident.provider, ident.sub);
            // Burn the email key so this mailbox can't claim the freebie again,
            // even after delete-and-recreate (meditation-pal-8jc).
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

/**
 * Set (or change) the email/password credential on an already-signed-in account.
 * A Google/Apple user with no password gains one; an existing 'email' identity
 * changes it. Keyed on the account's OWN canonical email, never a client-supplied
 * address, so it can only add a password to your own mailbox. Grants no credits
 * (email identities are untrusted), bypassing connectIdentity's grant path.
 *
 * Guards the one unsafe case: an 'email' identity for this canonical mailbox
 * owned by a DIFFERENT account (a cross-account takeover) → IdentityConflictError.
 * The one-account-per-mailbox invariant makes that unreachable in practice, but
 * we fail closed rather than trust it.
 */
export async function setAccountPassword(
    deps: Deps,
    account: Account,
    passwordHash: string
): Promise<void> {
    const sub = normalizeEmail(account.email);
    const existing = await deps.store.getIdentity('email', sub);
    if (existing && existing.accountId !== account.id) {
        throw new IdentityConflictError();
    }
    if (existing) {
        await deps.store.setIdentitySecret('email', sub, passwordHash);
    } else {
        await deps.store.createIdentity({
            provider: 'email',
            sub,
            accountId: account.id,
            // The federated sign-in that owns this account already proved the
            // address, so the password identity inherits that trust.
            emailVerified: account.emailVerified,
            grantedCredits: false,
            createdAt: Date.now() / 1000,
            secretHash: passwordHash,
        });
    }
    log.info('account password set', { accountId: account.id, changed: existing != null });
}

/** Account + live balance + linked sign-in methods (GET /me and every auth
 *  response). Centralised so both paths report `providers` consistently. */
export async function buildAccountView(deps: Deps, account: Account): Promise<AccountView> {
    const identities = await deps.store.getIdentitiesForAccount(account.id);
    // "Covered" tracks an active in-window pass, NOT the daily-cap check: a
    // member who hits their cap for the day shouldn't suddenly see buy prompts.
    const pass = await deps.store.activeRetreatPassForAccount(account.id, Date.now() / 1000);
    return {
        id: account.id,
        email: account.email,
        emailVerified: account.emailVerified,
        creditsRemaining: await deps.ledger.balance(account.id),
        providers: identities.map((i) => i.provider),
        retreatCovered: pass != null,
        emailUpdates: account.emailUpdates === true,
    };
}

/**
 * Soft-delete an account at the user's request (meditation-pal-8jc):
 *   - zero any remaining balance with a `debit` entry (credits are forfeit, not
 *     refunded, so the ledger stays a complete append-only audit trail),
 *   - delete the account's identities so each (provider, sub) is free to sign in
 *     fresh later (a genuine clean start), and
 *   - anonymize + tombstone the account row (scrub email + signup IP, clear the
 *     email-updates opt-in, stamp deletedAt) so it can no longer authenticate
 *     while its ledger foreign keys still resolve. With no email, identities,
 *     or IP left, surviving
 *     ledger/usage rows are keyed by a random UUID only, effectively anonymous
 *     (meditation-pal-9rkg).
 * The email's grant key is KEPT, so the person can return and buy credits but
 * can't re-claim the free grant.
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

/** How long a signup IP is kept before scrubbing (meditation-pal-9rkg). Its only
 *  job is velocity-checking new signups; past this window it's just personal data
 *  sitting in the DB and its backups. */
export const SIGNUP_IP_RETENTION_DAYS = 90;

/** Scrub signup IPs past the retention window. Called from the entrypoint's
 *  hourly sweep; idempotent, so overlapping runs are harmless. */
export async function ageOutSignupIps(deps: Deps, now: number): Promise<number> {
    const cutoff = now - SIGNUP_IP_RETENTION_DAYS * 86_400;
    const cleared = await deps.store.clearSignupIpsBefore(cutoff);
    if (cleared > 0) log.info('signup IPs aged out', { cleared });
    return cleared;
}

/** Turn pending retreat invites (meditation-pal-n9kd) addressed to this account's
 *  email into memberships, then forget the invites. Lets an operator add
 *  attendees by email before they have an account; coverage binds on first
 *  sign-in, in any order. Matched case-insensitively. */
async function bindRetreatInvites(deps: Deps, account: Account): Promise<void> {
    const email = account.email.toLowerCase();
    const invites = await deps.store.invitesForEmail(email);
    if (invites.length === 0) return;
    const now = Date.now() / 1000;
    for (const invite of invites) {
        await deps.store.addRetreatMember({ passId: invite.passId, accountId: account.id, joinedAt: now });
        await deps.store.removeRetreatInvite(invite.passId, email);
    }
    log.info('retreat invites bound on sign-in', { accountId: account.id, count: invites.length });
}

/** Mint a session token + the account view a sign-in route returns. */
export async function issueAuthResponse(
    deps: Deps,
    account: Account,
    isNewAccount: boolean
): Promise<AuthResponse> {
    const token = await issueSessionToken(account.id, deps.config.sessionSecret);
    // Claim invites before building the view, so a freshly-bound pass shows up as
    // covered in the same response.
    await bindRetreatInvites(deps, account);
    return { token, isNewAccount, account: await buildAccountView(deps, account) };
}

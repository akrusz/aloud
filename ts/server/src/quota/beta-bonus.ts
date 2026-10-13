/**
 * Beta bonus (meditation-pal-bb4k): a one-time thank-you in credits for signing
 * in from a store beta build. A new Play developer account can't ship until a
 * closed test has held 12 testers for 14 days, and this is what recruits them.
 * Temporary: set the admin panel's knob to 0 to end it, then delete this file
 * with its call in routes/auth.ts.
 *
 * "From a beta build" is read off the verified ID token, never claimed by the
 * client: a native sign-in names the client that asked for the token
 * (config.betaBonusClientIds). Play services hands the Android client's only to
 * the registered package + signing cert, and Apple the bundle-id audience only
 * to the app. The iOS Google client is the soft one: a public OAuth client, so
 * its token can be minted off the device by someone who tries, for one bonus
 * per Google account.
 *
 * The credits land in the ordinary balance and spend anywhere. Once per account,
 * per identity and per mailbox, ever, the connect grant's gates
 * (decideConnectGrant): a second login on the same account, the same person on
 * both stores, or a delete-and-recreate collects nothing more.
 */

import { createHash } from 'node:crypto';
import type { Deps } from '../deps.js';
import type { Account } from '../credits/store.js';
import type { VerifiedIdentity } from '../auth/identity.js';
import { normalizeEmail } from '../auth/email-key.js';
import { log } from '../logger.js';

/** Hashed like the connect grant's key, so the log that outlives a deleted
 *  account never carries an address or a provider id. */
function bonusKey(part: string): string {
    return createHash('sha256').update(`beta-bonus:${part}`).digest('hex');
}

/** Grant the bonus if this sign-in has it coming. Returns the credits granted. */
export async function grantBetaBonus(
    deps: Deps,
    account: Account,
    ident: VerifiedIdentity,
    clients: readonly string[]
): Promise<number> {
    const { betaBonusCredits: credits, betaBonusClientIds } = deps.config;
    if (credits <= 0 || betaBonusClientIds.length === 0) return 0;

    const eligible = clients.some((id) => betaBonusClientIds.includes(id));
    // Names the client behind every sign-in while the programme runs, which is
    // how a native client missing from the list shows up.
    log.info('beta bonus check', { accountId: account.id, provider: ident.provider, clients, eligible });
    if (!eligible) return 0;
    // An address the provider won't vouch for earns nothing, as with the connect
    // grant. No address at all (Apple, after the first sign-in) is not that.
    if (ident.email && !ident.emailVerified) return 0;

    const accountKey = bonusKey(`account:${account.id}`);
    const otherKeys = [
        bonusKey(`${ident.provider}:${ident.sub}`),
        ...(ident.email ? [bonusKey(`email:${normalizeEmail(ident.email)}`)] : []),
    ];
    for (const key of [accountKey, ...otherKeys]) {
        if (await deps.store.hasGrantKey(key)) return 0;
    }

    // Refused before any key is burned, so the next sign-in tries again.
    if (!deps.grantBreaker.tryConsume(credits)) {
        log.warn('beta bonus held back by the free-grant breaker', { accountId: account.id });
        return 0;
    }
    const now = Date.now() / 1000;
    // The account key is the claim: of two sign-ins racing on one account, only
    // the one that records it grants.
    if (!(await deps.store.recordGrantKey(accountKey, now))) return 0;
    await deps.ledger.grant(account.id, credits, 'beta_bonus');
    for (const key of otherKeys) await deps.store.recordGrantKey(key, now);

    log.info('beta bonus granted', { accountId: account.id, provider: ident.provider, credits });
    return credits;
}

/**
 * Grant-eligibility key derived from an email (meditation-pal-8jc). The free
 * signup grant costs real money (~$0.50/account), so deleting an account must not
 * farm a fresh grant. Account and identity rows are both removed on delete (so
 * the human can genuinely start over), leaving nothing to gate on - so the GRANT
 * is gated on a stable email-derived key, with a tiny append-only log of
 * ever-granted keys that survives deletion. A returning person can sign in and
 * buy credits, just not get a second freebie.
 *
 * `normalizeEmail` collapses "same inbox, different string" tricks to one key:
 * case/whitespace, +tag sub-addressing, and Gmail dot-insensitivity (plus the
 * googlemail.com alias). Not a routing normalizer, only a farming-resistant key.
 */

import { createHash } from 'node:crypto';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Collapse address variants that reach the same mailbox to one canonical form. */
export function normalizeEmail(email: string): string {
    const trimmed = email.trim().toLowerCase();
    const at = trimmed.lastIndexOf('@');
    if (at <= 0 || at === trimmed.length - 1) return trimmed; // not email-shaped: key off the raw string
    let local = trimmed.slice(0, at);
    let domain = trimmed.slice(at + 1);
    // Plus-addressing routes to the bare local part on every major provider.
    const plus = local.indexOf('+');
    if (plus !== -1) local = local.slice(0, plus);
    // Gmail ignores dots in the local part and treats googlemail.com as gmail.com.
    if (GMAIL_DOMAINS.has(domain)) {
        local = local.replace(/\./g, '');
        domain = 'gmail.com';
    }
    return `${local}@${domain}`;
}

/** Hash of the normalized email, so the grant log never stores the address. */
export function emailGrantKey(email: string): string {
    return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

/**
 * Grant-eligibility key derived from an email (meditation-pal-8jc). The free
 * signup grant costs real money (currently ~$0.50/account), so a deleted account
 * must not be a way to farm a fresh grant. We can't gate on the account or the
 * identity row — both are removed/freed on delete so the human can genuinely
 * start over — so we gate the GRANT on a stable key derived from the email, and
 * keep a tiny append-only log of keys that have ever been granted (it survives
 * account deletion). A returning person can sign in again and buy credits; they
 * just don't get a second freebie.
 *
 * `normalizeEmail` collapses the common "same inbox, different string" tricks so
 * one mailbox maps to one key:
 *   - case and surrounding whitespace,
 *   - +tag sub-addressing (user+anything@ routes to user@ everywhere), and
 *   - Gmail's dot-insensitivity (and the googlemail.com alias).
 * It is NOT a routing normalizer — only a farming-resistant grant key.
 */

import { createHash } from 'node:crypto';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/** Collapse address variants that reach the same mailbox to one canonical form. */
export function normalizeEmail(email: string): string {
    const trimmed = email.trim().toLowerCase();
    const at = trimmed.lastIndexOf('@');
    if (at <= 0 || at === trimmed.length - 1) return trimmed; // not email-shaped — key off the raw string
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

/** Stable, privacy-preserving grant key: a hash of the normalized email, so the
 *  grant log never stores the address itself. */
export function emailGrantKey(email: string): string {
    return createHash('sha256').update(normalizeEmail(email)).digest('hex');
}

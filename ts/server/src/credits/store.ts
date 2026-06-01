/**
 * Persistence boundary for accounts + credit ledger. The interface is the
 * contract; implementations are swappable.
 *
 * Ships with an in-memory implementation (memory-store.ts) used by tests and
 * local dev. PRODUCTION SWAP: implement this same interface over SQLite
 * (own-your-data, on-brand) or Postgres — nothing above this file knows which
 * backing store is in use. The ledger logic (ledger.ts) is pure and sits on
 * top of whichever store is injected.
 *
 * Design notes:
 *  - The ledger is append-only: balance is derived from entries, never mutated
 *    in place. That gives a full audit trail (every grant, debit, hold,
 *    release, top-up) which is exactly what billing disputes need.
 *  - Holds are first-class: a session places a hold at start, then settles it
 *    to an actual debit (releasing the remainder). An unsettled hold reduces
 *    spendable balance without yet being a charge.
 */

// Type-only import (erased at compile) — the raw usage telemetry row this store
// also persists, kept beside the ledger. Defined in usage.ts with its
// aggregation logic; here we only need the row shape for the store methods.
import type { UsageEvent } from './usage.js';

export type LedgerKind =
    | 'signup_grant'
    | 'purchase'
    | 'debit'
    | 'hold'
    | 'hold_release'
    | 'refund';

export interface LedgerEntry {
    id: string;
    accountId: string;
    kind: LedgerKind;
    /** Signed credit delta. Grants/purchases/releases positive; debits/holds
     *  negative. Balance = sum of all entries' amounts. */
    amount: number;
    /** For hold/hold_release/settle linkage. */
    holdId?: string;
    /** Free-text reason, e.g. "llm:anthropic:claude-sonnet-4-6". Never carries
     *  message content. */
    reason: string;
    createdAt: number;
}

export interface Account {
    id: string;
    /** Primary email for the account (from its first identity). Display + the
     *  lookup key for email/password sign-in. */
    email: string;
    emailVerified: boolean;
    createdAt: number;
    /** Client IP at signup, if captured. Feeds velocity-based abuse detection
     *  (mass-account creation tends to cluster by IP/subnet). Optional — absent
     *  when behind a proxy that doesn't forward it. */
    signupIp?: string;
}

/** The sign-in methods an account can carry. TRUSTED providers (google, apple)
 *  are hard enough to mint at scale that connecting one unlocks the free-credit
 *  grant; 'email' is a local password account that gets none until it connects
 *  a trusted identity (meditation-pal-116). */
export type IdentityProvider = 'google' | 'apple' | 'email';

/**
 * A sign-in identity linked to an account. One account may carry several
 * (Google + Apple + email). The (provider, sub) pair is GLOBALLY UNIQUE — an
 * external identity belongs to at most one aloud account, ever — which is the
 * anti-farming lever behind the free grant: you can't reuse one Google account
 * to seed credits on many aloud accounts.
 */
export interface Identity {
    provider: IdentityProvider;
    /** The provider's stable user id: Google/Apple `sub`, or the lower-cased
     *  email address for the local 'email' provider. */
    sub: string;
    accountId: string;
    /** Whether the provider asserts the email is verified. Only a verified
     *  trusted provider unlocks the grant. */
    emailVerified: boolean;
    /** Whether connecting this identity ever produced a free-credit grant. Set
     *  once, never cleared, so re-connecting can't re-trigger it. */
    grantedCredits: boolean;
    createdAt: number;
    /** Opaque credential the provider verifies against — a password hash for the
     *  'email' provider, absent for OAuth identities whose proof is the upstream
     *  token. Never leaves the server. */
    secretHash?: string;
}

/** A purchased gift of clouds, addressed to an email. Funded by a CLEARED Stripe
 *  payment, so it never cancels: the clouds are granted exactly once — to the
 *  recipient on accept, or back to the buyer on decline/expiry. (meditation-pal-bd5) */
export type GiftStatus = 'pending' | 'accepted' | 'declined' | 'expired';

export interface Gift {
    id: string;
    buyerAccountId: string;
    /** Lower-cased email the gift is addressed to (the recipient may not have an
     *  account yet — it waits in 'pending' until someone with this email signs in). */
    recipientEmail: string;
    credits: number;
    /** The Stripe checkout session that funded it — the idempotency key. */
    stripeSessionId: string;
    status: GiftStatus;
    createdAt: number;
    /** When it left 'pending' (accepted/declined/expired). */
    resolvedAt?: number;
}

export interface CreditsStore {
    getAccountById(id: string): Promise<Account | undefined>;
    createAccount(account: Account): Promise<void>;

    // ---- Identities (sign-in methods, meditation-pal-116) -------------------
    /** Look up an identity by its globally-unique (provider, sub). */
    getIdentity(provider: IdentityProvider, sub: string): Promise<Identity | undefined>;
    /** Link a new identity to an account. Must be atomic; throws the contract
     *  error 'identity already linked' if (provider, sub) already exists. */
    createIdentity(identity: Identity): Promise<void>;
    /** All identities linked to an account (to decide "already granted?"). */
    getIdentitiesForAccount(accountId: string): Promise<Identity[]>;
    /** Flip an identity's grantedCredits flag to true after a grant settles. */
    markIdentityGranted(provider: IdentityProvider, sub: string): Promise<void>;

    // ---- Gifts (gift-clouds, meditation-pal-bd5) ---------------------------
    /** Record a purchased gift (status 'pending'). Idempotent on stripeSessionId:
     *  a webhook retry must not create a second gift for the same payment. */
    createGift(gift: Gift): Promise<void>;
    getGiftById(id: string): Promise<Gift | undefined>;
    /** A payment's gift, for webhook idempotency (one gift per checkout session). */
    getGiftByStripeSession(stripeSessionId: string): Promise<Gift | undefined>;
    /** Pending gifts addressed to an email (lower-cased), for the accept prompt. */
    getPendingGiftsForEmail(email: string): Promise<Gift[]>;
    /** All pending gifts created on/before `cutoff` (the expiry sweep). */
    pendingGiftsCreatedBefore(cutoff: number): Promise<Gift[]>;
    /** Move a gift to a terminal state. Implementations should no-op if it isn't
     *  still 'pending' (so concurrent accept/decline/expire can't double-resolve). */
    resolveGift(id: string, status: Exclude<GiftStatus, 'pending'>, resolvedAt: number): Promise<boolean>;

    /** Append a ledger entry. Implementations must make this atomic. */
    appendEntry(entry: LedgerEntry): Promise<void>;
    /** All entries for an account, oldest first. */
    listEntries(accountId: string): Promise<LedgerEntry[]>;

    // ---- Aggregation reads (spend monitoring) -------------------------------
    // Trial-scale implementations may scan; a SQL store should answer these with
    // indexed aggregate queries. Kept narrow so the metrics layer stays pure.

    /** All accounts (for signup counts + velocity signals). */
    allAccounts(): Promise<Account[]>;
    /** Every ledger entry across all accounts (for spend aggregates). */
    allEntries(): Promise<LedgerEntry[]>;

    // ---- Usage telemetry (cost attribution) ---------------------------------
    // Raw per-call cost records, separate from the money ledger (see usage.ts).
    // Best-effort writes; reads feed the admin cost dashboard.

    /** Append a raw usage telemetry row. */
    appendUsage(event: UsageEvent): Promise<void>;
    /** Every usage row across all accounts (trial-scale scan; a SQL store
     *  answers the dashboard's aggregates with indexed queries instead). */
    allUsage(): Promise<UsageEvent[]>;

    // ---- Operator settings (durable runtime config) -------------------------
    // A tiny key→value store for operator-tunable knobs (free-credit grant,
    // hourly budget) set from the admin panel. Kept here so an override survives
    // restart/redeploy instead of snapping back to the env default. Separate
    // from accounts/ledger; never carries user content.

    /** A persisted setting value, or undefined if never set. */
    getSetting(key: string): Promise<string | undefined>;
    /** Persist a setting value (upsert). */
    setSetting(key: string, value: string): Promise<void>;
}

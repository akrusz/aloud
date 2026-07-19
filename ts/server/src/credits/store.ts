/**
 * Persistence boundary for accounts + credit ledger. This interface is the
 * contract; implementations are swappable, and nothing above this file knows
 * which is in use. Ships with memory-store.ts (tests, local dev) and
 * sqlite-store.ts (production); the same interface ports to Postgres.
 *
 * Design notes:
 *  - Append-only ledger: balance is derived from entries, never mutated in
 *    place, giving the full audit trail (grant, debit, hold, release, top-up)
 *    billing disputes need.
 *  - Holds are first-class: a session holds at start, then settles to an actual
 *    debit (releasing the remainder). An unsettled hold reduces spendable
 *    balance without yet being a charge.
 */

// Type-only import: the raw usage telemetry row this store also persists.
// Defined with its aggregation logic in usage.ts; here we need only the shape.
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
    /** Free-text, e.g. "llm:anthropic:claude-sonnet-5". Never message content. */
    reason: string;
    createdAt: number;
}

export interface Account {
    id: string;
    /** Primary email (from the first identity). Display + the lookup key for
     *  email/password sign-in. */
    email: string;
    emailVerified: boolean;
    createdAt: number;
    /** Client IP at signup, if captured. Feeds velocity-based abuse detection
     *  (mass-account creation clusters by IP/subnet). Absent behind a proxy that
     *  doesn't forward it. */
    signupIp?: string;
    /** Soft-delete tombstone (meditation-pal-8jc). Set ⇒ anonymized, identities
     *  freed, balance zeroed, can no longer sign in. The row stays so the
     *  append-only ledger's FKs (its audit trail) survive. */
    deletedAt?: number;
}

/** Sign-in methods an account can carry. TRUSTED providers (google, apple) are
 *  hard enough to mint at scale that connecting one unlocks the free-credit
 *  grant; 'email' is a local password account that gets none until it connects a
 *  trusted identity (meditation-pal-116). */
export type IdentityProvider = 'google' | 'apple' | 'email';

/**
 * A sign-in identity linked to an account; one account may carry several
 * (Google + Apple + email). (provider, sub) is GLOBALLY UNIQUE: an external
 * identity belongs to at most one aloud account, ever. That's the anti-farming
 * lever behind the free grant - one Google account can't seed credits on many.
 */
export interface Identity {
    provider: IdentityProvider;
    /** The provider's stable user id: Google/Apple `sub`, or the lower-cased
     *  email for the local 'email' provider. */
    sub: string;
    accountId: string;
    /** Whether the provider asserts the email is verified. Only a verified
     *  trusted provider unlocks the grant. */
    emailVerified: boolean;
    /** Whether connecting this identity ever produced a free-credit grant. Set
     *  once, never cleared, so re-connecting can't re-trigger it. */
    grantedCredits: boolean;
    createdAt: number;
    /** Opaque credential the provider verifies against: a password hash for
     *  'email', absent for OAuth identities (whose proof is the upstream token).
     *  Never leaves the server. */
    secretHash?: string;
}

/** A purchased gift of clouds, addressed to an email (meditation-pal-bd5).
 *  Funded by a CLEARED Stripe payment, so it never cancels: granted exactly
 *  once. The recipient accepts ('accepted'), or it bounces (declined, or 30-day
 *  unclaimed) to 'returned', held for the buyer to RE-GIFT ('regifted', spawning
 *  a fresh pending gift) or CLAIM to their own balance ('claimed'). No refunds;
 *  value stays in the credit system. 'declined'/'expired' are legacy terminal
 *  states from before re-gifting, when a bounce credited the buyer directly,
 *  kept so old rows still read. */
export type GiftStatus =
    | 'pending'
    | 'accepted'
    | 'returned'
    | 'regifted'
    | 'claimed'
    | 'declined'
    | 'expired';

export interface Gift {
    id: string;
    buyerAccountId: string;
    /** Lower-cased email the gift is addressed to. The recipient may have no
     *  account yet; it waits in 'pending' until someone with this email signs in. */
    recipientEmail: string;
    credits: number;
    /** The Stripe checkout session that funded it: the idempotency key. */
    stripeSessionId: string;
    status: GiftStatus;
    createdAt: number;
    /** When the status last changed (left 'pending', or returned→regifted/claimed). */
    resolvedAt?: number;
}

/** Retreat passes (meditation-pal-414). An OPERATOR-created, time-boxed grant of
 *  unlimited access for a meditation retreat: members aren't metered during the
 *  window, then silently fall back to their own balance. Admin-only, members
 *  added by email in the admin panel; no attendee UI, no shareable code. */
export type RetreatPassStatus = 'active' | 'revoked';

export interface RetreatPass {
    id: string;
    /** Operator-facing label, e.g. "Retreat Name". */
    label: string;
    /** Coverage window (seconds since epoch). A pass covers an account only when
     *  startsAt <= now <= endsAt and status === 'active'. */
    startsAt: number;
    endsAt: number;
    /** Per-attendee daily credit-equivalent ceiling (null = truly unlimited).
     *  With admin-picked members (no leakable code) it's a cost backstop against
     *  one runaway client, not a gate. */
    perAttendeeDailyCap: number | null;
    status: RetreatPassStatus;
    createdAt: number;
}

export interface RetreatMembership {
    passId: string;
    accountId: string;
    joinedAt: number;
}

/** A pending invite to a pass, addressed to an email with no account yet
 *  (meditation-pal-n9kd). Resolved to a membership on that person's first
 *  sign-in (matched by email), like a gift waiting for its recipient. */
export interface RetreatInvite {
    passId: string;
    /** Lower-cased email the invite is addressed to. */
    email: string;
    invitedAt: number;
}

export interface CreditsStore {
    /** Release the backing handle on graceful shutdown (SQLite: closes the DB,
     *  checkpointing the WAL into the main file). Optional; the in-memory store
     *  has nothing to close. */
    close?(): void;
    getAccountById(id: string): Promise<Account | undefined>;
    createAccount(account: Account): Promise<void>;
    /** The live (non-deleted) account whose email canonicalizes to the same
     *  mailbox as `email`, via auth/email-key normalizeEmail (case, +tag, Gmail
     *  dots / googlemail), so j.o.h.n+x@gmail.com matches john@gmail.com. The
     *  one-account-per-mailbox key behind sign-in linking and the duplicate
     *  guard. Excludes tombstones, so a deleted mailbox can sign up fresh. */
    findLiveAccountByEmail(email: string): Promise<Account | undefined>;

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
    /** Replace an identity's credential hash: a Google/Apple user adding an
     *  email/password, or later changing it. No-op if (provider, sub) is absent. */
    setIdentitySecret(provider: IdentityProvider, sub: string, secretHash: string): Promise<void>;
    /** Remove every identity linked to an account, freeing each (provider, sub)
     *  so the same Google/Apple/email can sign in fresh later. Used by account
     *  deletion (meditation-pal-8jc). */
    deleteIdentitiesForAccount(accountId: string): Promise<void>;
    /** Anonymize + tombstone an account in place (soft-delete): scrub email to
     *  `anonymizedEmail`, drop the signup IP, stamp `deletedAt`, keep the row so
     *  ledger FKs hold. With email, identities, and IP gone, surviving
     *  ledger/usage rows hang off a random UUID only (meditation-pal-9rkg). */
    markAccountDeleted(accountId: string, deletedAt: number, anonymizedEmail: string): Promise<void>;
    /** Scrub the signup IP from every account created at or before `cutoff`
     *  (data minimization, meditation-pal-9rkg: the IP's only job is
     *  velocity-checking new signups). Returns rows cleared. */
    clearSignupIpsBefore(cutoff: number): Promise<number>;

    // ---- Grant-eligibility keys (anti-farming, meditation-pal-8jc) ----------
    // Append-only log of email-derived keys (auth/email-key.ts) that have ever
    // received the free grant. Survives account deletion, so delete-then-recreate
    // can't claim the freebie twice. Never carries the address.

    /** True if this grant key has ever been recorded (i.e. already granted). */
    hasGrantKey(keyHash: string): Promise<boolean>;
    /** Record that this grant key received a free grant. Idempotent. */
    recordGrantKey(keyHash: string, createdAt: number): Promise<void>;

    // ---- Gifts (gift-clouds, meditation-pal-bd5) ---------------------------
    /** Record a purchased gift (status 'pending'). Idempotent on stripeSessionId:
     *  a webhook retry must not create a second gift for the same payment. */
    createGift(gift: Gift): Promise<void>;
    getGiftById(id: string): Promise<Gift | undefined>;
    /** A payment's gift, for webhook idempotency (one gift per checkout session). */
    getGiftByStripeSession(stripeSessionId: string): Promise<Gift | undefined>;
    /** Pending gifts addressed to an email (lower-cased), for the accept prompt. */
    getPendingGiftsForEmail(email: string): Promise<Gift[]>;
    /** Returned (bounced) gifts a buyer can re-gift or claim (meditation-pal-bd5). */
    getReturnedGiftsForBuyer(buyerAccountId: string): Promise<Gift[]>;
    /** All pending gifts created on/before `cutoff` (the expiry sweep). */
    pendingGiftsCreatedBefore(cutoff: number): Promise<Gift[]>;
    /** Move a gift out of 'pending'. No-ops if it isn't still pending, so
     *  concurrent accept/decline/expire can't double-resolve. */
    resolveGift(id: string, status: Exclude<GiftStatus, 'pending'>, resolvedAt: number): Promise<boolean>;
    /** Atomic compare-and-set on status: transition only if currently `from`;
     *  true if this call made the change. For the buyer acting on a 'returned'
     *  gift (→ 'regifted' / 'claimed'), so two clicks can't both fire. */
    transitionGift(id: string, from: GiftStatus, to: GiftStatus, resolvedAt: number): Promise<boolean>;

    /** Append a ledger entry. Implementations must make this atomic. */
    appendEntry(entry: LedgerEntry): Promise<void>;
    /** All entries for an account, oldest first. */
    listEntries(accountId: string): Promise<LedgerEntry[]>;

    // ---- Aggregation reads (spend monitoring) -------------------------------
    // Trial-scale implementations may scan; a SQL store should answer these with
    // indexed aggregates. Kept narrow so the metrics layer stays pure.

    /** All accounts (for signup counts + velocity signals). */
    allAccounts(): Promise<Account[]>;
    /** Every ledger entry across all accounts (for spend aggregates). */
    allEntries(): Promise<LedgerEntry[]>;

    // ---- Usage telemetry (cost attribution) ---------------------------------
    // Raw per-call cost records, separate from the money ledger (see usage.ts).
    // Best-effort writes; reads feed the admin cost dashboard.

    /** Append a raw usage telemetry row. */
    appendUsage(event: UsageEvent): Promise<void>;
    /** Every usage row across all accounts (trial-scale scan). */
    allUsage(): Promise<UsageEvent[]>;

    // ---- Operator settings (durable runtime config) -------------------------
    // Key→value store for operator-tunable knobs (free-credit grant, hourly
    // budget) set from the admin panel. Persisted so an override survives
    // restart/redeploy instead of snapping back to the env default. Never
    // carries user content.

    /** A persisted setting value, or undefined if never set. */
    getSetting(key: string): Promise<string | undefined>;
    /** Persist a setting value (upsert). */
    setSetting(key: string, value: string): Promise<void>;

    // ---- Retreat passes (meditation-pal-414) --------------------------------
    // Time-boxed unlimited-access grants. Members are added by account id (the
    // admin route resolves the email first); the metered routes bypass billing
    // when activeRetreatPassForAccount returns a pass.

    createRetreatPass(pass: RetreatPass): Promise<void>;
    getRetreatPass(id: string): Promise<RetreatPass | undefined>;
    /** All passes, newest first (for the admin Retreats list). */
    listRetreatPasses(): Promise<RetreatPass[]>;
    /** Flip a pass to 'revoked'. Coverage stops immediately. */
    revokeRetreatPass(id: string): Promise<void>;
    /** Permanently delete a pass and its roster (memberships + pending invites).
     *  Revoke leaves the card in the admin list; this removes it for good, for
     *  clearing out spent/test passes. Usage rows keep their passId as telemetry. */
    deleteRetreatPass(id: string): Promise<void>;
    /** Add an account to a pass. Idempotent on (passId, accountId). */
    addRetreatMember(membership: RetreatMembership): Promise<void>;
    /** Members of a pass (for the admin roster / attendee count). */
    listRetreatMembers(passId: string): Promise<RetreatMembership[]>;
    /** The pass covering this account right now: an 'active' pass it's a member
     *  of whose window contains `now`. Latest-ending match wins (a member is
     *  normally on just one). */
    activeRetreatPassForAccount(accountId: string, now: number): Promise<RetreatPass | undefined>;
    /** Sum of metered credits for an account since `sinceTs`, for the
     *  per-attendee daily-cap backstop. Counts usage whether or not it was
     *  charged, so pass-covered turns still accrue toward the cap. */
    usageCreditsSince(accountId: string, sinceTs: number): Promise<number>;

    // ---- Retreat invites (pending membership by email, meditation-pal-n9kd) --
    /** Add a pending invite. Idempotent on (passId, email). */
    addRetreatInvite(invite: RetreatInvite): Promise<void>;
    /** Pending invites for a pass (for the admin roster). */
    listRetreatInvites(passId: string): Promise<RetreatInvite[]>;
    /** All pending invites addressed to an email (lower-cased), across passes,
     *  resolved to memberships on that account's first sign-in. */
    invitesForEmail(email: string): Promise<RetreatInvite[]>;
    /** Remove an invite (after it's claimed into a membership). */
    removeRetreatInvite(passId: string, email: string): Promise<void>;
}

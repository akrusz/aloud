/**
 * Durable CreditsStore over SQLite (Node's built-in `node:sqlite`). Same
 * contract as MemoryCreditsStore (store.ts) — the ledger logic above it
 * (ledger.ts) is agnostic to which store is injected. This is the production
 * swap the store.ts header calls for: own-your-data, on-brand, zero extra
 * dependencies (SQLite ships with Node 22).
 *
 * Why SQLite and not Postgres at this stage: the deploy is a single small
 * always-on box (meditation-pal-a3u) at trial scale. A file on a persistent
 * volume is durable across restarts (the one thing MemoryCreditsStore can't
 * do), gives us the append-only audit trail billing disputes need, and answers
 * the metrics aggregates with indexed queries. If we outgrow one box, the same
 * interface ports to Postgres without touching anything above this file.
 *
 * The ledger is append-only (see store.ts): we only ever INSERT, never UPDATE
 * or DELETE a ledger row. Balance is summed from entries, so the table IS the
 * audit log.
 *
 * `node:sqlite` is still flagged "experimental" by Node (it prints one warning
 * at first use) but the synchronous API is stable enough for this trial-scale,
 * single-process use; revisit if Node changes the surface.
 */

import { DatabaseSync } from 'node:sqlite';
import type {
    Account,
    CreditsStore,
    Gift,
    GiftStatus,
    Identity,
    IdentityProvider,
    LedgerEntry,
    LedgerKind,
    RetreatMembership,
    RetreatPass,
    RetreatPassStatus,
} from './store.js';
import type { UsageEvent, UsageKind } from './usage.js';

/** SQL DDL — created on open if absent. Idempotent (IF NOT EXISTS). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    email_verified INTEGER NOT NULL,
    created_at    REAL NOT NULL,
    signup_ip     TEXT,
    -- Soft-delete tombstone (meditation-pal-8jc): set ⇒ anonymized + can't sign
    -- in; the row stays so the append-only ledger's FKs survive.
    deleted_at    REAL
);
-- Sign-in identities (meditation-pal-116). (provider, sub) is globally unique:
-- one external identity → at most one account, ever. granted_credits records
-- whether connecting it produced the free grant (so it can't re-trigger).
CREATE TABLE IF NOT EXISTS identities (
    provider        TEXT NOT NULL,
    sub             TEXT NOT NULL,
    account_id      TEXT NOT NULL REFERENCES accounts(id),
    email_verified  INTEGER NOT NULL,
    granted_credits INTEGER NOT NULL DEFAULT 0,
    created_at      REAL NOT NULL,
    secret_hash     TEXT,
    PRIMARY KEY (provider, sub)
);
CREATE INDEX IF NOT EXISTS idx_identities_account ON identities(account_id);
-- Gift clouds (meditation-pal-bd5). Funded by a cleared Stripe payment; granted
-- once — to the recipient on accept, or back to the buyer on decline/expiry.
CREATE TABLE IF NOT EXISTS gifts (
    id                TEXT PRIMARY KEY,
    buyer_account_id  TEXT NOT NULL REFERENCES accounts(id),
    recipient_email   TEXT NOT NULL,
    credits           REAL NOT NULL,
    stripe_session_id TEXT NOT NULL UNIQUE,
    status            TEXT NOT NULL,
    created_at        REAL NOT NULL,
    resolved_at       REAL
);
CREATE INDEX IF NOT EXISTS idx_gifts_recipient ON gifts(recipient_email, status);
CREATE TABLE IF NOT EXISTS ledger (
    id         TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    kind       TEXT NOT NULL,
    amount     REAL NOT NULL,
    hold_id    TEXT,
    reason     TEXT NOT NULL,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_account ON ledger(account_id);
-- Idempotent purchases (meditation-pal-0g6 / du9): at most one credit per
-- payment proof. A purchase reason embeds the unique external ref (Stripe
-- session id, or x402 settlement tx hash), so a replayed webhook / resubmitted
-- settlement hits this constraint instead of double-crediting. Partial index:
-- only 'purchase' rows are constrained; debits/holds/grants are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_purchase_ref
    ON ledger(reason) WHERE kind = 'purchase';
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
-- Grant-eligibility keys (anti-farming, meditation-pal-8jc). Append-only log of
-- email-derived hashes (auth/email-key.ts) that have ever received the free
-- grant. Outlives the accounts/identities it came from, so deleting and
-- recreating an account can't re-claim the freebie. Never stores the address.
CREATE TABLE IF NOT EXISTS grant_keys (
    key_hash   TEXT PRIMARY KEY,
    created_at REAL NOT NULL
);
-- Raw per-call usage telemetry (cost attribution), separate from the money
-- ledger above. One row per metered provider call. provider_cost_usd is full
-- precision; credits is the fractional amount debited. See usage.ts.
CREATE TABLE IF NOT EXISTS usage_events (
    id                TEXT PRIMARY KEY,
    account_id        TEXT NOT NULL REFERENCES accounts(id),
    session_id        TEXT,
    ts                REAL NOT NULL,
    kind              TEXT NOT NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    tokens_in         INTEGER NOT NULL,
    tokens_out        INTEGER NOT NULL,
    cache_read        INTEGER NOT NULL,
    cache_creation    INTEGER NOT NULL,
    seconds           REAL NOT NULL,
    chars             INTEGER NOT NULL,
    provider_cost_usd REAL NOT NULL,
    credits           REAL NOT NULL,
    -- Retreat pass that covered this call (meditation-pal-414), or NULL when
    -- metered normally. Lets the admin attribute per-retreat spend.
    pass_id           TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_events(account_id);
CREATE INDEX IF NOT EXISTS idx_usage_pass ON usage_events(pass_id);
-- Retreat passes (meditation-pal-414). Operator-created, time-boxed unlimited
-- access: a member's metered calls bypass billing while now is inside the
-- window and status='active'. Members are added by the admin (no shareable
-- code), so there's no seat cap — the operator controls the roster.
CREATE TABLE IF NOT EXISTS retreat_passes (
    id                     TEXT PRIMARY KEY,
    label                  TEXT NOT NULL,
    starts_at              REAL NOT NULL,
    ends_at                REAL NOT NULL,
    -- Per-attendee daily credit-equivalent ceiling; NULL = truly unlimited.
    per_attendee_daily_cap REAL,
    status                 TEXT NOT NULL,
    created_at             REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS retreat_memberships (
    pass_id    TEXT NOT NULL REFERENCES retreat_passes(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    joined_at  REAL NOT NULL,
    PRIMARY KEY (pass_id, account_id)
);
CREATE INDEX IF NOT EXISTS idx_retreat_members_account ON retreat_memberships(account_id);
`;

type Row = Record<string, string | number | bigint | Uint8Array | null>;

function rowToAccount(r: Row): Account {
    const account: Account = {
        id: String(r['id']),
        email: String(r['email']),
        emailVerified: Number(r['email_verified']) !== 0,
        createdAt: Number(r['created_at']),
    };
    // exactOptionalPropertyTypes: only attach signupIp when actually present.
    if (r['signup_ip'] != null) account.signupIp = String(r['signup_ip']);
    if (r['deleted_at'] != null) account.deletedAt = Number(r['deleted_at']);
    return account;
}

function rowToIdentity(r: Row): Identity {
    const identity: Identity = {
        provider: String(r['provider']) as IdentityProvider,
        sub: String(r['sub']),
        accountId: String(r['account_id']),
        emailVerified: Number(r['email_verified']) !== 0,
        grantedCredits: Number(r['granted_credits']) !== 0,
        createdAt: Number(r['created_at']),
    };
    if (r['secret_hash'] != null) identity.secretHash = String(r['secret_hash']);
    return identity;
}

function rowToGift(r: Row): Gift {
    const gift: Gift = {
        id: String(r['id']),
        buyerAccountId: String(r['buyer_account_id']),
        recipientEmail: String(r['recipient_email']),
        credits: Number(r['credits']),
        stripeSessionId: String(r['stripe_session_id']),
        status: String(r['status']) as GiftStatus,
        createdAt: Number(r['created_at']),
    };
    if (r['resolved_at'] != null) gift.resolvedAt = Number(r['resolved_at']);
    return gift;
}

function rowToEntry(r: Row): LedgerEntry {
    const entry: LedgerEntry = {
        id: String(r['id']),
        accountId: String(r['account_id']),
        kind: String(r['kind']) as LedgerKind,
        amount: Number(r['amount']),
        reason: String(r['reason']),
        createdAt: Number(r['created_at']),
    };
    if (r['hold_id'] != null) entry.holdId = String(r['hold_id']);
    return entry;
}

function rowToUsage(r: Row): UsageEvent {
    return {
        id: String(r['id']),
        accountId: String(r['account_id']),
        sessionId: r['session_id'] != null ? String(r['session_id']) : null,
        passId: r['pass_id'] != null ? String(r['pass_id']) : null,
        ts: Number(r['ts']),
        kind: String(r['kind']) as UsageKind,
        provider: String(r['provider']),
        model: String(r['model']),
        tokensIn: Number(r['tokens_in']),
        tokensOut: Number(r['tokens_out']),
        cacheRead: Number(r['cache_read']),
        cacheCreation: Number(r['cache_creation']),
        seconds: Number(r['seconds']),
        chars: Number(r['chars']),
        providerCostUsd: Number(r['provider_cost_usd']),
        credits: Number(r['credits']),
    };
}

function rowToRetreatPass(r: Row): RetreatPass {
    return {
        id: String(r['id']),
        label: String(r['label']),
        startsAt: Number(r['starts_at']),
        endsAt: Number(r['ends_at']),
        perAttendeeDailyCap:
            r['per_attendee_daily_cap'] != null ? Number(r['per_attendee_daily_cap']) : null,
        status: String(r['status']) as RetreatPassStatus,
        createdAt: Number(r['created_at']),
    };
}

export class SqliteCreditsStore implements CreditsStore {
    private readonly db: DatabaseSync;

    /** @param path file path for the DB, or ':memory:' for an ephemeral one
     *  (used by the store-parity tests so they exercise the real SQL). */
    constructor(path: string) {
        this.db = new DatabaseSync(path);
        // WAL: better read/write concurrency and a durable, crash-safe journal —
        // the right default for an always-on server holding a credit ledger.
        // No-op (harmless) for an in-memory database.
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec(SCHEMA);
        this.migrateLegacyGoogleSub();
        this.migrateAddDeletedAt();
        this.migrateAddUsagePassId();
    }

    /** Add usage_events.pass_id to a DB created before retreat passes existed
     *  (meditation-pal-414). The CREATE in SCHEMA only covers fresh DBs. No-op
     *  once the column is there. */
    private migrateAddUsagePassId(): void {
        const cols = this.db.prepare('PRAGMA table_info(usage_events)').all() as Row[];
        if (cols.some((c) => String(c['name']) === 'pass_id')) return;
        this.db.exec('ALTER TABLE usage_events ADD COLUMN pass_id TEXT');
    }

    /** Add accounts.deleted_at to a DB created before soft-delete existed
     *  (meditation-pal-8jc). The CREATE in SCHEMA only covers fresh DBs; an
     *  already-deployed prod DB needs this ALTER. No-op once the column is there. */
    private migrateAddDeletedAt(): void {
        const cols = this.db.prepare('PRAGMA table_info(accounts)').all() as Row[];
        if (cols.some((c) => String(c['name']) === 'deleted_at')) return;
        this.db.exec('ALTER TABLE accounts ADD COLUMN deleted_at REAL');
    }

    /**
     * One-time migration from the original 1:1 accounts.google_sub schema to the
     * accounts ↔ identities model (meditation-pal-116). Detects the legacy
     * `google_sub` column; if present, backfills a 'google' identity per account
     * (granted_credits set from whether the account already has a signup_grant in
     * the ledger, so we never re-grant nor wrongly block a never-granted account),
     * then rebuilds `accounts` without the column. No-op on a fresh DB (the new
     * SCHEMA has no google_sub) and on an already-migrated one.
     */
    private migrateLegacyGoogleSub(): void {
        const cols = this.db.prepare('PRAGMA table_info(accounts)').all() as Row[];
        const hasLegacy = cols.some((c) => String(c['name']) === 'google_sub');
        if (!hasLegacy) return;

        // Backfill identities from the legacy column (idempotent via OR IGNORE).
        this.db.exec(`
            INSERT OR IGNORE INTO identities
                (provider, sub, account_id, email_verified, granted_credits, created_at)
            SELECT 'google', a.google_sub, a.id, a.email_verified,
                   CASE WHEN EXISTS (
                       SELECT 1 FROM ledger l
                       WHERE l.account_id = a.id AND l.kind = 'signup_grant'
                   ) THEN 1 ELSE 0 END,
                   a.created_at
            FROM accounts a
            WHERE a.google_sub IS NOT NULL;
        `);

        // Rebuild accounts without google_sub. FK off + a transaction so the
        // ledger/usage/identities rows that reference accounts(id) survive the
        // DROP/RENAME (ids are preserved, so the by-name FK re-resolves).
        this.db.exec('PRAGMA foreign_keys = OFF');
        this.db.exec('BEGIN');
        try {
            this.db.exec(`
                CREATE TABLE accounts_new (
                    id            TEXT PRIMARY KEY,
                    email         TEXT NOT NULL,
                    email_verified INTEGER NOT NULL,
                    created_at    REAL NOT NULL,
                    signup_ip     TEXT
                );
                INSERT INTO accounts_new (id, email, email_verified, created_at, signup_ip)
                    SELECT id, email, email_verified, created_at, signup_ip FROM accounts;
                DROP TABLE accounts;
                ALTER TABLE accounts_new RENAME TO accounts;
            `);
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        } finally {
            this.db.exec('PRAGMA foreign_keys = ON');
        }
    }

    /** Release the file handle. Optional — handy for tests and graceful shutdown. */
    close(): void {
        this.db.close();
    }

    async getAccountById(id: string): Promise<Account | undefined> {
        const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
        return row ? rowToAccount(row) : undefined;
    }

    async createAccount(account: Account): Promise<void> {
        this.db
            .prepare(
                `INSERT INTO accounts (id, email, email_verified, created_at, signup_ip)
                 VALUES (?, ?, ?, ?, ?)`
            )
            .run(
                account.id,
                account.email,
                account.emailVerified ? 1 : 0,
                account.createdAt,
                account.signupIp ?? null
            );
    }

    async getIdentity(provider: IdentityProvider, sub: string): Promise<Identity | undefined> {
        const row = this.db
            .prepare('SELECT * FROM identities WHERE provider = ? AND sub = ?')
            .get(provider, sub) as Row | undefined;
        return row ? rowToIdentity(row) : undefined;
    }

    async createIdentity(identity: Identity): Promise<void> {
        try {
            this.db
                .prepare(
                    `INSERT INTO identities
                        (provider, sub, account_id, email_verified, granted_credits, created_at, secret_hash)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    identity.provider,
                    identity.sub,
                    identity.accountId,
                    identity.emailVerified ? 1 : 0,
                    identity.grantedCredits ? 1 : 0,
                    identity.createdAt,
                    identity.secretHash ?? null
                );
        } catch (err) {
            // Match MemoryCreditsStore: a duplicate identity is a domain error.
            if (String(err).includes('UNIQUE') || String(err).includes('constraint')) {
                throw new Error('identity already linked to an account');
            }
            throw err;
        }
    }

    async getIdentitiesForAccount(accountId: string): Promise<Identity[]> {
        const rows = this.db
            .prepare('SELECT * FROM identities WHERE account_id = ? ORDER BY created_at')
            .all(accountId) as Row[];
        return rows.map(rowToIdentity);
    }

    async markIdentityGranted(provider: IdentityProvider, sub: string): Promise<void> {
        this.db
            .prepare('UPDATE identities SET granted_credits = 1 WHERE provider = ? AND sub = ?')
            .run(provider, sub);
    }

    async deleteIdentitiesForAccount(accountId: string): Promise<void> {
        this.db.prepare('DELETE FROM identities WHERE account_id = ?').run(accountId);
    }

    async markAccountDeleted(
        accountId: string,
        deletedAt: number,
        anonymizedEmail: string
    ): Promise<void> {
        this.db
            .prepare(
                'UPDATE accounts SET deleted_at = ?, email = ?, email_verified = 0 WHERE id = ?'
            )
            .run(deletedAt, anonymizedEmail, accountId);
    }

    async hasGrantKey(keyHash: string): Promise<boolean> {
        const row = this.db
            .prepare('SELECT 1 FROM grant_keys WHERE key_hash = ?')
            .get(keyHash) as Row | undefined;
        return row != null;
    }

    async recordGrantKey(keyHash: string, createdAt: number): Promise<void> {
        this.db
            .prepare('INSERT OR IGNORE INTO grant_keys (key_hash, created_at) VALUES (?, ?)')
            .run(keyHash, createdAt);
    }

    async createGift(gift: Gift): Promise<void> {
        try {
            this.db
                .prepare(
                    `INSERT INTO gifts
                        (id, buyer_account_id, recipient_email, credits, stripe_session_id, status, created_at, resolved_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    gift.id,
                    gift.buyerAccountId,
                    gift.recipientEmail,
                    gift.credits,
                    gift.stripeSessionId,
                    gift.status,
                    gift.createdAt,
                    gift.resolvedAt ?? null
                );
        } catch (err) {
            // Idempotent on the funding payment: a webhook retry for the same
            // checkout session must not create a second gift.
            if (String(err).includes('UNIQUE') || String(err).includes('constraint')) return;
            throw err;
        }
    }

    async getGiftById(id: string): Promise<Gift | undefined> {
        const row = this.db.prepare('SELECT * FROM gifts WHERE id = ?').get(id) as Row | undefined;
        return row ? rowToGift(row) : undefined;
    }

    async getGiftByStripeSession(stripeSessionId: string): Promise<Gift | undefined> {
        const row = this.db
            .prepare('SELECT * FROM gifts WHERE stripe_session_id = ?')
            .get(stripeSessionId) as Row | undefined;
        return row ? rowToGift(row) : undefined;
    }

    async getPendingGiftsForEmail(email: string): Promise<Gift[]> {
        const rows = this.db
            .prepare("SELECT * FROM gifts WHERE recipient_email = ? AND status = 'pending' ORDER BY created_at")
            .all(email) as Row[];
        return rows.map(rowToGift);
    }

    async getReturnedGiftsForBuyer(buyerAccountId: string): Promise<Gift[]> {
        const rows = this.db
            .prepare("SELECT * FROM gifts WHERE buyer_account_id = ? AND status = 'returned' ORDER BY created_at")
            .all(buyerAccountId) as Row[];
        return rows.map(rowToGift);
    }

    async pendingGiftsCreatedBefore(cutoff: number): Promise<Gift[]> {
        const rows = this.db
            .prepare("SELECT * FROM gifts WHERE status = 'pending' AND created_at <= ? ORDER BY created_at")
            .all(cutoff) as Row[];
        return rows.map(rowToGift);
    }

    async resolveGift(
        id: string,
        status: Exclude<GiftStatus, 'pending'>,
        resolvedAt: number
    ): Promise<boolean> {
        // Conditional on still-pending so concurrent accept/decline/expire can't
        // double-resolve (and thus can't double-grant). changes() = rows updated.
        this.db
            .prepare("UPDATE gifts SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
            .run(status, resolvedAt, id);
        const changed = this.db.prepare('SELECT changes() AS n').get() as { n: number };
        return changed.n > 0;
    }

    async transitionGift(
        id: string,
        from: GiftStatus,
        to: GiftStatus,
        resolvedAt: number
    ): Promise<boolean> {
        // Atomic CAS: only the caller that finds it in `from` makes the change.
        this.db
            .prepare('UPDATE gifts SET status = ?, resolved_at = ? WHERE id = ? AND status = ?')
            .run(to, resolvedAt, id, from);
        const changed = this.db.prepare('SELECT changes() AS n').get() as { n: number };
        return changed.n > 0;
    }

    async appendEntry(entry: LedgerEntry): Promise<void> {
        try {
            this.db
                .prepare(
                    `INSERT INTO ledger (id, account_id, kind, amount, hold_id, reason, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                )
                .run(
                    entry.id,
                    entry.accountId,
                    entry.kind,
                    entry.amount,
                    entry.holdId ?? null,
                    entry.reason,
                    entry.createdAt
                );
        } catch (err) {
            // Idempotent purchases (idx_ledger_purchase_ref): a duplicate
            // (kind='purchase', reason) is a replayed payment proof — a Stripe
            // webhook retry or a resubmitted x402 settlement. Swallow it so the
            // account is credited exactly once. Any other constraint failure is
            // a real bug, so only purchases are forgiven.
            if (
                entry.kind === 'purchase' &&
                (String(err).includes('UNIQUE') || String(err).includes('constraint'))
            ) {
                return;
            }
            throw err;
        }
    }

    async listEntries(accountId: string): Promise<LedgerEntry[]> {
        // ORDER BY rowid = insertion order (oldest first), per the store
        // contract. The UUID `id` is random, so we can't order by it; SQLite's
        // implicit rowid is monotonic with INSERT.
        const rows = this.db
            .prepare('SELECT * FROM ledger WHERE account_id = ? ORDER BY rowid')
            .all(accountId) as Row[];
        return rows.map(rowToEntry);
    }

    async allAccounts(): Promise<Account[]> {
        const rows = this.db.prepare('SELECT * FROM accounts').all() as Row[];
        return rows.map(rowToAccount);
    }

    async allEntries(): Promise<LedgerEntry[]> {
        const rows = this.db.prepare('SELECT * FROM ledger').all() as Row[];
        return rows.map(rowToEntry);
    }

    async appendUsage(event: UsageEvent): Promise<void> {
        this.db
            .prepare(
                `INSERT INTO usage_events
                 (id, account_id, session_id, ts, kind, provider, model,
                  tokens_in, tokens_out, cache_read, cache_creation,
                  seconds, chars, provider_cost_usd, credits, pass_id)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                event.id,
                event.accountId,
                event.sessionId,
                event.ts,
                event.kind,
                event.provider,
                event.model,
                event.tokensIn,
                event.tokensOut,
                event.cacheRead,
                event.cacheCreation,
                event.seconds,
                event.chars,
                event.providerCostUsd,
                event.credits,
                event.passId
            );
    }

    async allUsage(): Promise<UsageEvent[]> {
        const rows = this.db.prepare('SELECT * FROM usage_events ORDER BY ts').all() as Row[];
        return rows.map(rowToUsage);
    }

    async getSetting(key: string): Promise<string | undefined> {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
            | Row
            | undefined;
        return row ? String(row['value']) : undefined;
    }

    async setSetting(key: string, value: string): Promise<void> {
        this.db
            .prepare(
                `INSERT INTO settings (key, value) VALUES (?, ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
            )
            .run(key, value);
    }

    async createRetreatPass(pass: RetreatPass): Promise<void> {
        this.db
            .prepare(
                `INSERT INTO retreat_passes
                    (id, label, starts_at, ends_at, per_attendee_daily_cap, status, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                pass.id,
                pass.label,
                pass.startsAt,
                pass.endsAt,
                pass.perAttendeeDailyCap,
                pass.status,
                pass.createdAt
            );
    }

    async getRetreatPass(id: string): Promise<RetreatPass | undefined> {
        const row = this.db.prepare('SELECT * FROM retreat_passes WHERE id = ?').get(id) as
            | Row
            | undefined;
        return row ? rowToRetreatPass(row) : undefined;
    }

    async listRetreatPasses(): Promise<RetreatPass[]> {
        const rows = this.db
            .prepare('SELECT * FROM retreat_passes ORDER BY created_at DESC')
            .all() as Row[];
        return rows.map(rowToRetreatPass);
    }

    async revokeRetreatPass(id: string): Promise<void> {
        this.db.prepare("UPDATE retreat_passes SET status = 'revoked' WHERE id = ?").run(id);
    }

    async addRetreatMember(membership: RetreatMembership): Promise<void> {
        this.db
            .prepare(
                `INSERT OR IGNORE INTO retreat_memberships (pass_id, account_id, joined_at)
                 VALUES (?, ?, ?)`
            )
            .run(membership.passId, membership.accountId, membership.joinedAt);
    }

    async listRetreatMembers(passId: string): Promise<RetreatMembership[]> {
        const rows = this.db
            .prepare('SELECT * FROM retreat_memberships WHERE pass_id = ? ORDER BY joined_at')
            .all(passId) as Row[];
        return rows.map((r) => ({
            passId: String(r['pass_id']),
            accountId: String(r['account_id']),
            joinedAt: Number(r['joined_at']),
        }));
    }

    async activeRetreatPassForAccount(
        accountId: string,
        now: number
    ): Promise<RetreatPass | undefined> {
        const row = this.db
            .prepare(
                `SELECT p.* FROM retreat_passes p
                 JOIN retreat_memberships m ON m.pass_id = p.id
                 WHERE m.account_id = ?
                   AND p.status = 'active'
                   AND p.starts_at <= ? AND p.ends_at >= ?
                 ORDER BY p.ends_at DESC
                 LIMIT 1`
            )
            .get(accountId, now, now) as Row | undefined;
        return row ? rowToRetreatPass(row) : undefined;
    }

    async usageCreditsSince(accountId: string, sinceTs: number): Promise<number> {
        const row = this.db
            .prepare(
                'SELECT COALESCE(SUM(credits), 0) AS c FROM usage_events WHERE account_id = ? AND ts >= ?'
            )
            .get(accountId, sinceTs) as { c: number };
        return Number(row.c);
    }
}

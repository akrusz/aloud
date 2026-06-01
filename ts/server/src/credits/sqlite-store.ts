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
import type { Account, CreditsStore, LedgerEntry, LedgerKind } from './store.js';
import type { UsageEvent, UsageKind } from './usage.js';

/** SQL DDL — created on open if absent. Idempotent (IF NOT EXISTS). */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
    id            TEXT PRIMARY KEY,
    google_sub    TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL,
    email_verified INTEGER NOT NULL,
    created_at    REAL NOT NULL,
    signup_ip     TEXT
);
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
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
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
    credits           REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_account ON usage_events(account_id);
`;

type Row = Record<string, string | number | bigint | Uint8Array | null>;

function rowToAccount(r: Row): Account {
    const account: Account = {
        id: String(r['id']),
        googleSub: String(r['google_sub']),
        email: String(r['email']),
        emailVerified: Number(r['email_verified']) !== 0,
        createdAt: Number(r['created_at']),
    };
    // exactOptionalPropertyTypes: only attach signupIp when actually present.
    if (r['signup_ip'] != null) account.signupIp = String(r['signup_ip']);
    return account;
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
    }

    /** Release the file handle. Optional — handy for tests and graceful shutdown. */
    close(): void {
        this.db.close();
    }

    async getAccountByGoogleSub(sub: string): Promise<Account | undefined> {
        const row = this.db
            .prepare('SELECT * FROM accounts WHERE google_sub = ?')
            .get(sub) as Row | undefined;
        return row ? rowToAccount(row) : undefined;
    }

    async getAccountById(id: string): Promise<Account | undefined> {
        const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Row | undefined;
        return row ? rowToAccount(row) : undefined;
    }

    async createAccount(account: Account): Promise<void> {
        try {
            this.db
                .prepare(
                    `INSERT INTO accounts (id, google_sub, email, email_verified, created_at, signup_ip)
                     VALUES (?, ?, ?, ?, ?, ?)`
                )
                .run(
                    account.id,
                    account.googleSub,
                    account.email,
                    account.emailVerified ? 1 : 0,
                    account.createdAt,
                    account.signupIp ?? null
                );
        } catch (err) {
            // Match MemoryCreditsStore's contract: a duplicate Google identity is
            // a domain error, not a raw SQLITE_CONSTRAINT leak.
            if (String(err).includes('UNIQUE') || String(err).includes('constraint')) {
                throw new Error('account already exists for this Google identity');
            }
            throw err;
        }
    }

    async appendEntry(entry: LedgerEntry): Promise<void> {
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
                  seconds, chars, provider_cost_usd, credits)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
                event.credits
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
}

/**
 * SqliteCreditsStore parity + durability tests. The SQLite store is the
 * production swap for MemoryCreditsStore, so it must behave identically; the
 * shared suite runs the same assertions against both. A separate test proves
 * the one thing the memory store can't do — survive a "restart" (reopen the
 * same file).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { SqliteCreditsStore } from '../src/credits/sqlite-store.js';
import { Ledger } from '../src/credits/ledger.js';
import type { Account, CreditsStore, Identity } from '../src/credits/store.js';
import type { UsageEvent } from '../src/credits/usage.js';

const ACCOUNT: Account = {
    id: 'acct-1',
    email: 'a@example.com',
    emailVerified: true,
    createdAt: 100,
    signupIp: '203.0.113.7',
};

const IDENTITY: Identity = {
    provider: 'google',
    sub: 'sub-1',
    accountId: 'acct-1',
    emailVerified: true,
    grantedCredits: false,
    createdAt: 100,
};

function usageEvent(over: Partial<UsageEvent> = {}): UsageEvent {
    return {
        id: 'u-1',
        accountId: 'acct-1',
        sessionId: null,
        ts: 1000,
        kind: 'llm',
        provider: 'google',
        model: 'gemini-2.5-flash-lite',
        tokensIn: 50,
        tokensOut: 20,
        cacheRead: 4000,
        cacheCreation: 0,
        seconds: 0,
        chars: 0,
        providerCostUsd: 0.000123,
        credits: 0.00246,
        ...over,
    };
}

// Run the identical suite against each store implementation.
const implementations: Array<[string, () => CreditsStore]> = [
    ['MemoryCreditsStore', () => new MemoryCreditsStore()],
    ['SqliteCreditsStore(:memory:)', () => new SqliteCreditsStore(':memory:')],
];

describe.each(implementations)('CreditsStore parity: %s', (_name, make) => {
    let store: CreditsStore;

    beforeEach(() => {
        store = make();
    });

    it('round-trips an account by id (including signupIp)', async () => {
        await store.createAccount(ACCOUNT);
        expect(await store.getAccountById('acct-1')).toEqual(ACCOUNT);
        expect(await store.getAccountById('missing')).toBeUndefined();
    });

    it('omits signupIp when absent (exactOptionalPropertyTypes)', async () => {
        const noIp: Account = { ...ACCOUNT };
        delete noIp.signupIp;
        await store.createAccount(noIp);
        const got = await store.getAccountById('acct-1');
        expect(got).toEqual(noIp);
        expect('signupIp' in got!).toBe(false);
    });

    it('round-trips an identity by (provider, sub) and lists by account', async () => {
        await store.createAccount(ACCOUNT);
        await store.createIdentity(IDENTITY);
        expect(await store.getIdentity('google', 'sub-1')).toEqual(IDENTITY);
        expect(await store.getIdentity('google', 'nope')).toBeUndefined();
        expect(await store.getIdentitiesForAccount('acct-1')).toEqual([IDENTITY]);
    });

    it('rejects a duplicate (provider, sub) identity with the contract error', async () => {
        await store.createAccount(ACCOUNT);
        await store.createIdentity(IDENTITY);
        await expect(store.createIdentity({ ...IDENTITY, accountId: 'acct-1' })).rejects.toThrow(
            /already linked/
        );
    });

    it('marks an identity granted (idempotent flag flip)', async () => {
        await store.createAccount(ACCOUNT);
        await store.createIdentity(IDENTITY);
        await store.markIdentityGranted('google', 'sub-1');
        expect((await store.getIdentity('google', 'sub-1'))?.grantedCredits).toBe(true);
    });

    it('round-trips an email identity with its secretHash', async () => {
        await store.createAccount(ACCOUNT);
        const email: Identity = {
            provider: 'email',
            sub: 'a@example.com',
            accountId: 'acct-1',
            emailVerified: false,
            grantedCredits: false,
            createdAt: 100,
            secretHash: 'scrypt$deadbeef',
        };
        await store.createIdentity(email);
        expect(await store.getIdentity('email', 'a@example.com')).toEqual(email);
    });

    it('keeps ledger entries in insertion order (oldest first)', async () => {
        await store.createAccount(ACCOUNT);
        const ledger = new Ledger(store, () => 100);
        await ledger.grant('acct-1', 20);
        const holdId = await ledger.placeHold('acct-1', 5, 'turn');
        await ledger.settleHold('acct-1', holdId, 2, 'llm:anthropic');
        const entries = await store.listEntries('acct-1');
        expect(entries.map((e) => e.kind)).toEqual([
            'signup_grant',
            'hold',
            'hold_release',
            'debit',
        ]);
        expect(await ledger.balance('acct-1')).toBe(18);
    });

    it('aggregation reads see every account and entry', async () => {
        await store.createAccount(ACCOUNT);
        await store.createAccount({ ...ACCOUNT, id: 'acct-2' });
        const ledger = new Ledger(store, () => 100);
        await ledger.grant('acct-1', 20);
        await ledger.grant('acct-2', 30);
        expect((await store.allAccounts()).map((a) => a.id).sort()).toEqual(['acct-1', 'acct-2']);
        expect((await store.allEntries()).reduce((s, e) => s + e.amount, 0)).toBe(50);
    });

    it('round-trips usage telemetry rows (full precision, null sessionId)', async () => {
        await store.createAccount(ACCOUNT);
        const llm = usageEvent({ id: 'u-llm' });
        const tts = usageEvent({
            id: 'u-tts',
            kind: 'tts',
            provider: 'google',
            model: 'Leda',
            tokensIn: 0,
            cacheRead: 0,
            chars: 420,
            sessionId: 'sess-9',
            providerCostUsd: 0.0126,
            credits: 0.252,
        });
        await store.appendUsage(llm);
        await store.appendUsage(tts);
        const all = await store.allUsage();
        expect(all).toHaveLength(2);
        // Exact round-trip including the fractional USD/credits and null session.
        expect(all.find((e) => e.id === 'u-llm')).toEqual(llm);
        expect(all.find((e) => e.id === 'u-tts')).toEqual(tts);
    });

    it('round-trips gifts; resolveGift is atomic; createGift idempotent on session', async () => {
        await store.createAccount(ACCOUNT); // the buyer
        const g = {
            id: 'gift-1',
            buyerAccountId: 'acct-1',
            recipientEmail: 'friend@e.com',
            credits: 50,
            stripeSessionId: 'cs_1',
            status: 'pending' as const,
            createdAt: 100,
        };
        await store.createGift(g);
        await store.createGift({ ...g, id: 'gift-2' }); // same session → idempotent no-op
        expect(await store.getGiftById('gift-1')).toEqual(g);
        expect(await store.getGiftById('gift-2')).toBeUndefined();
        expect((await store.getGiftByStripeSession('cs_1'))?.id).toBe('gift-1');
        expect((await store.getPendingGiftsForEmail('friend@e.com')).map((x) => x.id)).toEqual(['gift-1']);

        // First resolve wins; a second can't (no double-spend), and it leaves pending lists empty.
        expect(await store.resolveGift('gift-1', 'accepted', 200)).toBe(true);
        expect(await store.resolveGift('gift-1', 'declined', 300)).toBe(false);
        expect(await store.getPendingGiftsForEmail('friend@e.com')).toEqual([]);
        expect((await store.getGiftById('gift-1'))?.status).toBe('accepted');
    });

    it('round-trips and upserts operator settings', async () => {
        expect(await store.getSetting('free_signup_credits')).toBeUndefined();
        await store.setSetting('free_signup_credits', '0');
        expect(await store.getSetting('free_signup_credits')).toBe('0');
        await store.setSetting('free_signup_credits', '7'); // upsert, not duplicate
        expect(await store.getSetting('free_signup_credits')).toBe('7');
    });
});

describe('SqliteCreditsStore durability', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'aloud-db-'));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('persists accounts + identities + ledger across a reopen (restart)', async () => {
        const path = join(dir, 'aloud.db');
        const first = new SqliteCreditsStore(path);
        await first.createAccount(ACCOUNT);
        await first.createIdentity(IDENTITY);
        await new Ledger(first, () => 100).grant('acct-1', 20);
        first.close();

        // Reopen the same file — a fresh process would see exactly this.
        const second = new SqliteCreditsStore(path);
        expect(await second.getAccountById('acct-1')).toEqual(ACCOUNT);
        expect(await second.getIdentity('google', 'sub-1')).toEqual(IDENTITY);
        expect(await new Ledger(second, () => 100).balance('acct-1')).toBe(20);
        second.close();
    });

    // The production DB predates the identity model; opening it must migrate the
    // legacy accounts.google_sub column into the identities table and drop it,
    // preserving the ledger and not re-granting. (meditation-pal-116)
    it('migrates a legacy google_sub schema into identities on open', async () => {
        const path = join(dir, 'legacy.db');
        // Hand-build the OLD schema + a granted account and a never-granted one.
        const legacy = new DatabaseSync(path);
        legacy.exec(`
            CREATE TABLE accounts (
                id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL,
                email_verified INTEGER NOT NULL, created_at REAL NOT NULL, signup_ip TEXT
            );
            CREATE TABLE ledger (
                id TEXT PRIMARY KEY, account_id TEXT NOT NULL, kind TEXT NOT NULL,
                amount REAL NOT NULL, hold_id TEXT, reason TEXT NOT NULL, created_at REAL NOT NULL
            );
            INSERT INTO accounts VALUES ('old-1','gsub-1','x@e.com',1,10,NULL);
            INSERT INTO accounts VALUES ('old-2','gsub-2','y@e.com',1,11,NULL);
            INSERT INTO ledger VALUES ('l1','old-1','signup_grant',20,NULL,'grant',10);
        `);
        legacy.close();

        const store = new SqliteCreditsStore(path);
        // google_sub became a 'google' identity, ledger balance preserved.
        const id1 = await store.getIdentity('google', 'gsub-1');
        expect(id1?.accountId).toBe('old-1');
        expect(id1?.grantedCredits).toBe(true); // had a signup_grant
        const id2 = await store.getIdentity('google', 'gsub-2');
        expect(id2?.grantedCredits).toBe(false); // never granted
        expect(await new Ledger(store, () => 100).balance('old-1')).toBe(20);
        // The legacy column is gone; the account round-trips in the new shape.
        expect(await store.getAccountById('old-1')).toEqual({
            id: 'old-1',
            email: 'x@e.com',
            emailVerified: true,
            createdAt: 10,
        });
        // Re-opening the already-migrated DB is a clean no-op.
        store.close();
        const reopened = new SqliteCreditsStore(path);
        expect((await reopened.getIdentity('google', 'gsub-1'))?.accountId).toBe('old-1');
        reopened.close();
    });
});

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
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { SqliteCreditsStore } from '../src/credits/sqlite-store.js';
import { Ledger } from '../src/credits/ledger.js';
import type { Account, CreditsStore } from '../src/credits/store.js';

const ACCOUNT: Account = {
    id: 'acct-1',
    googleSub: 'sub-1',
    email: 'a@example.com',
    emailVerified: true,
    createdAt: 100,
    signupIp: '203.0.113.7',
};

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

    it('round-trips an account by id and by Google sub (including signupIp)', async () => {
        await store.createAccount(ACCOUNT);
        expect(await store.getAccountById('acct-1')).toEqual(ACCOUNT);
        expect(await store.getAccountByGoogleSub('sub-1')).toEqual(ACCOUNT);
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

    it('rejects a duplicate Google identity with the contract error', async () => {
        await store.createAccount(ACCOUNT);
        await expect(store.createAccount({ ...ACCOUNT, id: 'acct-2' })).rejects.toThrow(
            /already exists/
        );
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
        await store.createAccount({ ...ACCOUNT, id: 'acct-2', googleSub: 'sub-2' });
        const ledger = new Ledger(store, () => 100);
        await ledger.grant('acct-1', 20);
        await ledger.grant('acct-2', 30);
        expect((await store.allAccounts()).map((a) => a.id).sort()).toEqual(['acct-1', 'acct-2']);
        expect((await store.allEntries()).reduce((s, e) => s + e.amount, 0)).toBe(50);
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

    it('persists accounts + ledger across a reopen (restart)', async () => {
        const path = join(dir, 'aloud.db');
        const first = new SqliteCreditsStore(path);
        await first.createAccount(ACCOUNT);
        await new Ledger(first, () => 100).grant('acct-1', 20);
        first.close();

        // Reopen the same file — a fresh process would see exactly this.
        const second = new SqliteCreditsStore(path);
        expect(await second.getAccountByGoogleSub('sub-1')).toEqual(ACCOUNT);
        expect(await new Ledger(second, () => 100).balance('acct-1')).toBe(20);
        second.close();
    });
});

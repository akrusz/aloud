import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { Ledger, InsufficientCreditsError } from '../src/credits/ledger.js';
import type { Account } from '../src/credits/store.js';

const ACCOUNT: Account = {
    id: 'acct-1',
    email: 'a@example.com',
    emailVerified: true,
    createdAt: 0,
};

describe('Ledger', () => {
    let store: MemoryCreditsStore;
    let ledger: Ledger;
    let clock = 100;

    beforeEach(async () => {
        store = new MemoryCreditsStore();
        ledger = new Ledger(store, () => clock);
        await store.createAccount(ACCOUNT);
    });

    it('balance is derived by summing append-only entries', async () => {
        expect(await ledger.balance(ACCOUNT.id)).toBe(0);
        await ledger.grant(ACCOUNT.id, 100);
        expect(await ledger.balance(ACCOUNT.id)).toBe(100);
        await ledger.purchase(ACCOUNT.id, 500, 'purchase:starter');
        expect(await ledger.balance(ACCOUNT.id)).toBe(600);
    });

    it('a hold reduces spendable balance, settling debits only the actual', async () => {
        await ledger.grant(ACCOUNT.id, 100);
        const holdId = await ledger.placeHold(ACCOUNT.id, 25, 'turn');
        expect(await ledger.balance(ACCOUNT.id)).toBe(75); // hold is outstanding

        await ledger.settleHold(ACCOUNT.id, holdId, 4, 'llm:anthropic');
        // released the 25 hold, debited the real 4
        expect(await ledger.balance(ACCOUNT.id)).toBe(96);
    });

    it('releasing a hold returns the full held amount, no charge', async () => {
        await ledger.grant(ACCOUNT.id, 100);
        const holdId = await ledger.placeHold(ACCOUNT.id, 25, 'turn');
        await ledger.releaseHold(ACCOUNT.id, holdId);
        expect(await ledger.balance(ACCOUNT.id)).toBe(100);
    });

    it('settling twice does not double-release (idempotent on the hold magnitude)', async () => {
        await ledger.grant(ACCOUNT.id, 100);
        const holdId = await ledger.placeHold(ACCOUNT.id, 25, 'turn');
        await ledger.settleHold(ACCOUNT.id, holdId, 4, 'llm');
        await ledger.settleHold(ACCOUNT.id, holdId, 4, 'llm'); // already released
        // second settle finds 0 held -> releases 0, debits another 4
        expect(await ledger.balance(ACCOUNT.id)).toBe(92);
    });

    it('refuses a hold that exceeds available balance', async () => {
        await ledger.grant(ACCOUNT.id, 10);
        await expect(ledger.placeHold(ACCOUNT.id, 25, 'turn')).rejects.toBeInstanceOf(
            InsufficientCreditsError
        );
        expect(await ledger.balance(ACCOUNT.id)).toBe(10);
    });

    it('direct debit refuses to overdraw', async () => {
        await ledger.grant(ACCOUNT.id, 5);
        await expect(ledger.debit(ACCOUNT.id, 10, 'x')).rejects.toBeInstanceOf(
            InsufficientCreditsError
        );
    });
});

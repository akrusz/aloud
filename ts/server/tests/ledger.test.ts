import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryCreditsStore } from '../src/credits/memory-store.js';
import { Ledger, InsufficientCreditsError, STALE_HOLD_MAX_AGE_SEC } from '../src/credits/ledger.js';
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

    it('settling twice is idempotent: the second settle does not re-charge', async () => {
        await ledger.grant(ACCOUNT.id, 100);
        const holdId = await ledger.placeHold(ACCOUNT.id, 25, 'turn');
        await ledger.settleHold(ACCOUNT.id, holdId, 4, 'llm');
        await ledger.settleHold(ACCOUNT.id, holdId, 4, 'llm'); // already released -> no-op
        // first settle: released the 25 hold, debited the real 4 -> 96.
        // second settle finds 0 held and bails before the debit (no double-charge).
        expect(await ledger.balance(ACCOUNT.id)).toBe(96);
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

    // Regression (meditation-pal): the balance check and the hold append are a
    // read-then-write across an `await`. Concurrent same-account requests must
    // not both pass the check and overdraw — per-account serialization closes it.
    it('concurrent holds on one account never overdraw the balance', async () => {
        await ledger.grant(ACCOUNT.id, 10);
        // Five requests race to hold the whole balance at once. Only one can win;
        // the rest must see the depleted balance and be refused.
        const attempts = await Promise.allSettled(
            Array.from({ length: 5 }, () => ledger.placeHold(ACCOUNT.id, 10, 'turn'))
        );
        const granted = attempts.filter((a) => a.status === 'fulfilled').length;
        const refused = attempts.filter(
            (a) => a.status === 'rejected' && a.reason instanceof InsufficientCreditsError
        ).length;
        expect(granted).toBe(1);
        expect(refused).toBe(4);
        // The invariant that matters: balance never went negative.
        expect(await ledger.balance(ACCOUNT.id)).toBe(0);
    });

    it('concurrent settles of one hold charge exactly once', async () => {
        await ledger.grant(ACCOUNT.id, 100);
        const holdId = await ledger.placeHold(ACCOUNT.id, 25, 'turn');
        await Promise.all([
            ledger.settleHold(ACCOUNT.id, holdId, 4, 'llm'),
            ledger.settleHold(ACCOUNT.id, holdId, 4, 'llm'),
        ]);
        // Released the 25 hold and debited the real 4 once -> 96, not 92.
        expect(await ledger.balance(ACCOUNT.id)).toBe(96);
    });
});

describe('stale-hold sweeping', () => {
    let store: MemoryCreditsStore;
    let ledger: Ledger;
    let clock = 100;

    beforeEach(async () => {
        clock = 100;
        store = new MemoryCreditsStore();
        ledger = new Ledger(store, () => clock);
        await store.createAccount(ACCOUNT);
    });

    it('releaseStaleHolds frees holds older than the max age, leaves fresh ones', async () => {
        await ledger.grant(ACCOUNT.id, 100);
        await ledger.placeHold(ACCOUNT.id, 10, 'turn:old'); // placed at t=100
        clock += STALE_HOLD_MAX_AGE_SEC - 1;
        await ledger.placeHold(ACCOUNT.id, 10, 'turn:fresh');
        expect(await ledger.balance(ACCOUNT.id)).toBe(80);

        clock += 2; // old hold is now past the cutoff; fresh one is not
        await ledger.releaseStaleHolds(ACCOUNT.id);
        expect(await ledger.balance(ACCOUNT.id)).toBe(90);
    });

    it('does not touch settled or released holds (idempotent against history)', async () => {
        await ledger.grant(ACCOUNT.id, 100);
        const settledId = await ledger.placeHold(ACCOUNT.id, 10, 'turn');
        await ledger.settleHold(ACCOUNT.id, settledId, 4, 'llm');
        const releasedId = await ledger.placeHold(ACCOUNT.id, 10, 'turn');
        await ledger.releaseHold(ACCOUNT.id, releasedId);
        expect(await ledger.balance(ACCOUNT.id)).toBe(96);

        clock += STALE_HOLD_MAX_AGE_SEC * 2;
        await ledger.releaseStaleHolds(ACCOUNT.id);
        expect(await ledger.balance(ACCOUNT.id)).toBe(96); // no double release
    });

    it('placeHold sweeps orphans first, so a stale hold cannot starve the next turn', async () => {
        await ledger.grant(ACCOUNT.id, 10);
        await ledger.placeHold(ACCOUNT.id, 10, 'turn:orphaned'); // eats the whole balance
        clock += STALE_HOLD_MAX_AGE_SEC + 1;
        // Without the sweep this would throw InsufficientCreditsError.
        const holdId = await ledger.placeHold(ACCOUNT.id, 10, 'turn:new');
        expect(holdId).toBeTruthy();
        expect(await ledger.balance(ACCOUNT.id)).toBe(0); // one live hold, not two
    });
});

describe('Ledger.refund (clawback)', () => {
    let store: MemoryCreditsStore;
    let ledger: Ledger;

    beforeEach(async () => {
        store = new MemoryCreditsStore();
        ledger = new Ledger(store, () => 0);
        await store.createAccount(ACCOUNT);
    });

    it('appends a negative entry and is idempotent on reason (webhook retry)', async () => {
        await ledger.purchase(ACCOUNT.id, 100, 'purchase:plus:cs_1');
        await ledger.refund(ACCOUNT.id, 100, 'refund:ch_1');
        await ledger.refund(ACCOUNT.id, 100, 'refund:ch_1'); // re-delivered event
        expect(await ledger.balance(ACCOUNT.id)).toBe(0); // clawed back exactly once
    });

    it('drives the balance negative when the credits were already spent', async () => {
        await ledger.purchase(ACCOUNT.id, 50, 'purchase:starter:cs_2');
        await ledger.debit(ACCOUNT.id, 50, 'llm:spend');
        await ledger.refund(ACCOUNT.id, 50, 'dispute:dp_1');
        expect(await ledger.balance(ACCOUNT.id)).toBe(-50);
    });
});

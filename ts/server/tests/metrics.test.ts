import { describe, it, expect } from 'vitest';
import { buildMetrics } from '../src/admin/metrics.js';
import type { Account, LedgerEntry } from '../src/credits/store.js';
import { USD_PER_CREDIT } from '../src/pricing/meter.js';

let seq = 0;
function entry(accountId: string, kind: LedgerEntry['kind'], amount: number, at: number): LedgerEntry {
    return { id: `e${seq++}`, accountId, kind, amount, reason: kind, createdAt: at };
}
function account(id: string, at: number, ip?: string): Account {
    return { id, email: `${id}@x.com`, emailVerified: true, createdAt: at, ...(ip ? { signupIp: ip } : {}) };
}

describe('buildMetrics', () => {
    const now = 1_000_000;
    const since = now - 3600; // last hour
    const inWin = now - 100; // inside the window

    it('isolates free burn to accounts that never purchased', () => {
        const accounts = [account('free', inWin, '1.1.1.1'), account('payer', inWin, '2.2.2.2')];
        const entries: LedgerEntry[] = [
            entry('free', 'signup_grant', 20, inWin),
            entry('free', 'debit', -8, inWin), // free user spent 8 (pure free burn)
            entry('payer', 'signup_grant', 20, inWin),
            entry('payer', 'purchase', 110, inWin),
            entry('payer', 'debit', -30, inWin), // payer spent 30 — NOT free burn
        ];
        const m = buildMetrics(accounts, entries, now, since);

        expect(m.totals.creditsGranted).toBe(40);
        expect(m.totals.creditsPurchased).toBe(110);
        expect(m.totals.creditsDebited).toBe(38);
        // Provider cost = all debits * cost; free burn = only the non-purchaser's.
        expect(m.totals.providerCostUsd).toBeCloseTo(38 * USD_PER_CREDIT, 6);
        expect(m.totals.freeBurnUsd).toBeCloseTo(8 * USD_PER_CREDIT, 6);
    });

    it('flags IP clusters (mass-account velocity)', () => {
        const accounts = [
            account('a', inWin, '9.9.9.9'),
            account('b', inWin, '9.9.9.9'),
            account('c', inWin, '9.9.9.9'), // 3 from one IP -> over threshold
            account('d', inWin, '4.4.4.4'),
        ];
        const m = buildMetrics(accounts, [], now, since);
        expect(m.window.signups).toBe(4);
        expect(m.abuse.distinctSignupIps).toBe(2);
        expect(m.abuse.ipsOverThreshold).toBe(1); // 9.9.9.9 has 3 (>= threshold)
        expect(m.abuse.topSignupIps[0]).toEqual({ ip: '9.9.9.9', signups: 3 });
    });

    it('windows the slice by createdAt', () => {
        const accounts = [account('old', now - 7200), account('new', inWin)];
        const entries = [
            entry('old', 'debit', -10, now - 7200), // before window (2h ago)
            entry('new', 'debit', -5, inWin), // in window
        ];
        const m = buildMetrics(accounts, entries, now, since);
        expect(m.totals.creditsDebited).toBe(15); // all-time
        expect(m.window.creditsDebited).toBe(5); // windowed
        expect(m.window.signups).toBe(1); // only 'new'
    });
});

/**
 * x402 credit-purchase channel (meditation-pal-du9). The money invariant: a
 * SETTLED payment credits the account EXACTLY ONCE, keyed on the settlement tx
 * hash — a resubmitted settlement (or a duplicate delivery) must not
 * double-credit, and an unsuccessful settlement must not credit at all. The
 * facilitator's verify/settle (the cryptography) is the facilitator's job; here
 * we test our credit logic and the channel-config gating.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import type { Deps } from '../src/deps.js';
import { creditFromSettlement, x402Configured } from '../src/billing/x402.js';
import type { Account } from '../src/credits/store.js';

function deps(env: Record<string, string> = {}): Deps {
    return buildDeps(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ...env }));
}

async function account(d: Deps): Promise<Account> {
    const a: Account = { id: randomUUID(), email: 'buyer@e.com', emailVerified: true, createdAt: 1000 };
    await d.store.createAccount(a);
    return a;
}

describe('creditFromSettlement', () => {
    it('credits the pack once on a settled payment', async () => {
        const d = deps();
        const a = await account(d);
        const r = await creditFromSettlement(d, a.id, 'plus', { success: true, transaction: '0xabc' });
        expect(r.credited).toBe(true);
        expect(r.credits).toBe(110); // the 'plus' pack
        expect(await d.ledger.balance(a.id)).toBe(110);
    });

    it('is idempotent on the settlement tx hash (no double-credit on replay)', async () => {
        const d = deps();
        const a = await account(d);
        const settle = { success: true, transaction: '0xdeadbeef' };
        await creditFromSettlement(d, a.id, 'plus', settle);
        await creditFromSettlement(d, a.id, 'plus', settle); // resubmitted same tx
        expect(await d.ledger.balance(a.id)).toBe(110); // balance moved once
        const purchases = (await d.store.listEntries(a.id)).filter((e) => e.kind === 'purchase');
        expect(purchases).toHaveLength(1);
    });

    it('does NOT credit when settlement was not successful', async () => {
        const d = deps();
        const a = await account(d);
        const r = await creditFromSettlement(d, a.id, 'plus', { success: false, transaction: '0xabc' });
        expect(r.credited).toBe(false);
        expect(await d.ledger.balance(a.id)).toBe(0);
    });

    it('does NOT credit a successful settlement with no tx hash', async () => {
        const d = deps();
        const a = await account(d);
        const r = await creditFromSettlement(d, a.id, 'plus', { success: true });
        expect(r.credited).toBe(false);
        expect(await d.ledger.balance(a.id)).toBe(0);
    });

    it('does NOT credit an unknown pack', async () => {
        const d = deps();
        const a = await account(d);
        const r = await creditFromSettlement(d, a.id, 'no-such-pack', { success: true, transaction: '0xabc' });
        expect(r.credited).toBe(false);
        expect(await d.ledger.balance(a.id)).toBe(0);
    });
});

describe('x402Configured', () => {
    it('is undefined unless enabled AND a pay-to address is set', () => {
        expect(x402Configured(deps())).toBeUndefined();
        expect(x402Configured(deps({ X402_ENABLED: '1' }))).toBeUndefined(); // no address
        expect(x402Configured(deps({ X402_PAY_TO_ADDRESS: '0xabc' }))).toBeUndefined(); // not enabled
    });

    it('defaults to base-sepolia (keyless testnet facilitator) when enabled', () => {
        const s = x402Configured(deps({ X402_ENABLED: '1', X402_PAY_TO_ADDRESS: '0xabc' }));
        expect(s).toMatchObject({ payTo: '0xabc', network: 'base-sepolia', useCdpFacilitator: false });
    });

    it('flags the CDP facilitator only on Base mainnet', () => {
        const s = x402Configured(
            deps({ X402_ENABLED: '1', X402_PAY_TO_ADDRESS: '0xabc', X402_NETWORK: 'base' })
        );
        expect(s).toMatchObject({ network: 'base', useCdpFacilitator: true });
    });
});

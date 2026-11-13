/**
 * The check between the server's 402 challenge and the wallet. The wallet
 * signs what the app builds from the challenge, as raw atomic units most
 * people can't read, so the app is the one place a wrong or hostile challenge
 * can be caught: the amount has to be the pack's price, the token real USDC.
 */

import { describe, it, expect } from 'vitest';
import {
    buildAuthorization,
    buildTypedData,
    challengeProblem,
    MAX_AUTHORIZATION_SECONDS,
    USDC_ADDRESS,
    type X402Requirements,
} from '../ui/src/x402-sign.js';

/** What server/src/billing/x402.ts sends for a $5 pack on Base. */
const honest: X402Requirements = {
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: '5000000',
    payTo: '0x1111111111111111111111111111111111111111',
    asset: USDC_ADDRESS.base,
    maxTimeoutSeconds: 300,
    extra: { name: 'USD Coin', version: '2' },
};

describe('challengeProblem', () => {
    it("passes the server's own challenge for the pack that was clicked", () => {
        expect(challengeProblem(honest, 500)).toBeNull();
        expect(challengeProblem({ ...honest, network: 'base-sepolia', asset: USDC_ADDRESS['base-sepolia'] }, 500)).toBeNull();
        // Address case is not significant.
        expect(challengeProblem({ ...honest, asset: USDC_ADDRESS.base.toLowerCase() }, 500)).toBeNull();
    });

    it('refuses an amount that is not the price', () => {
        expect(challengeProblem({ ...honest, maxAmountRequired: '5000000000' }, 500)).toMatch(/amount/);
        expect(challengeProblem({ ...honest, maxAmountRequired: '5000001' }, 500)).toMatch(/amount/);
        // The price of a different pack is still not this one's.
        expect(challengeProblem(honest, 1000)).toMatch(/amount/);
        expect(challengeProblem(honest, 0)).toMatch(/price/);
    });

    it('refuses a token that is not USDC on that network', () => {
        expect(challengeProblem({ ...honest, asset: '0x2222222222222222222222222222222222222222' }, 500)).toMatch(/USDC/);
        // Sepolia's token named on mainnet.
        expect(challengeProblem({ ...honest, asset: USDC_ADDRESS['base-sepolia'] }, 500)).toMatch(/USDC/);
        expect(challengeProblem({ ...honest, network: 'ethereum' as never }, 500)).toMatch(/network/);
    });

    it('refuses a long-lived authorization, a malformed recipient, another scheme', () => {
        expect(challengeProblem({ ...honest, maxTimeoutSeconds: MAX_AUTHORIZATION_SECONDS + 1 }, 500)).toMatch(/window/);
        expect(challengeProblem({ ...honest, maxTimeoutSeconds: 86_400 * 365 }, 500)).toMatch(/window/);
        expect(challengeProblem({ ...honest, payTo: 'attacker.eth' }, 500)).toMatch(/recipient/);
        expect(challengeProblem({ ...honest, scheme: 'upto' }, 500)).toMatch(/scheme/);
    });
});

describe('typed data', () => {
    it('signs the challenge it was checked against, field for field', () => {
        const auth = buildAuthorization(honest, '0x3333333333333333333333333333333333333333', 1_000_000, '0x' + '00'.repeat(32));
        expect(auth).toMatchObject({ to: honest.payTo, value: '5000000', validBefore: '1000300' });
        const typed = buildTypedData(honest, auth);
        expect(typed.domain).toEqual({ name: 'USD Coin', version: '2', chainId: 8453, verifyingContract: USDC_ADDRESS.base });
    });
});

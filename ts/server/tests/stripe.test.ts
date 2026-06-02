import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
    parseCheckoutCompleted,
    verifyStripeSignature,
    packById,
    customPack,
    isValidCustomCredits,
    CREDIT_PACKS,
    CUSTOM_CENTS_PER_CREDIT,
    MIN_CUSTOM_CREDITS,
    MAX_CUSTOM_CREDITS,
} from '../src/billing/stripe.js';
import { safeReturnPath } from '../src/routes/billing.js';

function sign(payload: string, secret: string, t: number): string {
    const v1 = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
    return `t=${t},v1=${v1}`;
}

describe('verifyStripeSignature', () => {
    const secret = 'whsec_test';
    const payload = '{"hello":"world"}';

    it('accepts a correctly signed, in-tolerance payload', () => {
        const now = 1_000_000;
        const header = sign(payload, secret, now);
        expect(verifyStripeSignature(payload, header, secret, 300, () => now)).toBe(true);
    });

    it('rejects a tampered payload', () => {
        const now = 1_000_000;
        const header = sign(payload, secret, now);
        expect(verifyStripeSignature('{"hello":"evil"}', header, secret, 300, () => now)).toBe(false);
    });

    it('rejects a stale timestamp (replay defense)', () => {
        const t = 1_000_000;
        const header = sign(payload, secret, t);
        expect(verifyStripeSignature(payload, header, secret, 300, () => t + 10_000)).toBe(false);
    });

    it('rejects a malformed header', () => {
        expect(verifyStripeSignature(payload, 'garbage', secret)).toBe(false);
    });
});

describe('parseCheckoutCompleted', () => {
    it('extracts account + credits from a completed checkout event', () => {
        const out = parseCheckoutCompleted({
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_123',
                    client_reference_id: 'acct-1',
                    metadata: { pack_id: 'plus', credits: '1200' },
                },
            },
        });
        expect(out).toEqual({
            accountId: 'acct-1',
            credits: 1200,
            packId: 'plus',
            stripeSessionId: 'cs_123',
        });
    });

    it('ignores unrelated event types', () => {
        expect(parseCheckoutCompleted({ type: 'payment_intent.created' })).toBeUndefined();
    });
});

describe('packById', () => {
    it('looks up known packs', () => {
        expect(packById('starter')?.credits).toBe(50);
        expect(packById('nope')).toBeUndefined();
    });
});

describe('custom amounts', () => {
    it('floors at the smallest preset and caps at the ceiling', () => {
        const smallestPreset = Math.min(...CREDIT_PACKS.map((p) => p.credits));
        expect(MIN_CUSTOM_CREDITS).toBe(smallestPreset);
        expect(isValidCustomCredits(MIN_CUSTOM_CREDITS)).toBe(true);
        expect(isValidCustomCredits(MIN_CUSTOM_CREDITS - 1)).toBe(false); // below smallest pack
        expect(isValidCustomCredits(MAX_CUSTOM_CREDITS)).toBe(true);
        expect(isValidCustomCredits(MAX_CUSTOM_CREDITS + 1)).toBe(false);
        expect(isValidCustomCredits(80.5)).toBe(false); // whole credits only
    });

    it('prices at the flat list rate (cost x markup), rounded to the cent', () => {
        expect(CUSTOM_CENTS_PER_CREDIT).toBeCloseTo(12.5); // $0.05 x 2.5
        const pack = customPack(100);
        expect(pack).toMatchObject({ id: 'custom', credits: 100, priceUsdCents: 1250 });
        // Odd amount rounds to the nearest cent (75 x 12.5 = 937.5 → 938).
        expect(customPack(75).priceUsdCents).toBe(938);
    });
});

describe('safeReturnPath (open-redirect guard)', () => {
    it('keeps a clean app-relative path and ensures a trailing slash', () => {
        expect(safeReturnPath('/app/')).toBe('/app/');
        expect(safeReturnPath('/app')).toBe('/app/');
        expect(safeReturnPath('/')).toBe('/');
    });

    it('strips any client-supplied query/hash (server owns ?purchase)', () => {
        expect(safeReturnPath('/app/?evil=1#x')).toBe('/app/');
    });

    it('falls back to "/" for absolute, scheme-relative, or missing paths', () => {
        expect(safeReturnPath('https://evil.example/app/')).toBe('/');
        expect(safeReturnPath('//evil.example')).toBe('/');
        expect(safeReturnPath('app/')).toBe('/'); // no leading slash
        expect(safeReturnPath(undefined)).toBe('/');
    });
});

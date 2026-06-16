import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
    parseCheckoutCompleted,
    parseChargeReversal,
    fetchPurchaseMetadata,
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
    /** A paid checkout.session.completed event with overridable session fields. */
    function event(object: Record<string, unknown>) {
        return {
            type: 'checkout.session.completed',
            data: {
                object: {
                    id: 'cs_123',
                    client_reference_id: 'acct-1',
                    payment_status: 'paid',
                    ...object,
                },
            },
        };
    }

    it('extracts account + credits from a paid checkout event', () => {
        const out = parseCheckoutCompleted(event({ metadata: { pack_id: 'plus', credits: '110' } }));
        expect(out).toEqual({
            accountId: 'acct-1',
            credits: 110,
            packId: 'plus',
            stripeSessionId: 'cs_123',
        });
    });

    it('refuses a session whose payment is not (yet) paid', () => {
        const meta = { metadata: { pack_id: 'plus', credits: '110' } };
        expect(parseCheckoutCompleted(event({ ...meta, payment_status: 'unpaid' }))).toBeUndefined();
        expect(parseCheckoutCompleted(event({ ...meta, payment_status: undefined }))).toBeUndefined();
    });

    it('re-derives preset-pack credits server-side, ignoring metadata credits', () => {
        // A tampered metadata blob can't inflate the grant — 'plus' is 110.
        const out = parseCheckoutCompleted(event({ metadata: { pack_id: 'plus', credits: '999999' } }));
        expect(out?.credits).toBe(110);
    });

    it('refuses an unknown pack id', () => {
        expect(parseCheckoutCompleted(event({ metadata: { pack_id: 'nope', credits: '110' } }))).toBeUndefined();
    });

    it('accepts custom-pack credits only within the checkout bounds', () => {
        const ok = parseCheckoutCompleted(event({ metadata: { pack_id: 'custom', credits: '75' } }));
        expect(ok?.credits).toBe(75);
        // Out of bounds / non-integer custom amounts are refused outright.
        expect(
            parseCheckoutCompleted(event({ metadata: { pack_id: 'custom', credits: String(MAX_CUSTOM_CREDITS + 1) } }))
        ).toBeUndefined();
        expect(parseCheckoutCompleted(event({ metadata: { pack_id: 'custom', credits: '80.5' } }))).toBeUndefined();
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

describe('parseChargeReversal', () => {
    it('full refund → fraction 1, keyed on the charge', () => {
        const r = parseChargeReversal({
            type: 'charge.refunded',
            data: { object: { id: 'ch_1', payment_intent: 'pi_1', amount: 1200, amount_refunded: 1200 } },
        });
        expect(r).toEqual({ kind: 'refund', paymentIntentId: 'pi_1', ref: 'refund:ch_1', fraction: 1 });
    });

    it('partial refund → proportional fraction', () => {
        const r = parseChargeReversal({
            type: 'charge.refunded',
            data: { object: { id: 'ch_2', payment_intent: 'pi_2', amount: 1200, amount_refunded: 600 } },
        });
        expect(r?.fraction).toBeCloseTo(0.5);
    });

    it('dispute → full clawback keyed on the dispute id', () => {
        const r = parseChargeReversal({
            type: 'charge.dispute.created',
            data: { object: { id: 'dp_1', payment_intent: 'pi_3' } },
        });
        expect(r).toEqual({ kind: 'dispute', paymentIntentId: 'pi_3', ref: 'dispute:dp_1', fraction: 1 });
    });

    it('ignores unrelated events and no-op (zero-refund) charges', () => {
        expect(
            parseChargeReversal({ type: 'checkout.session.completed', data: { object: {} } })
        ).toBeUndefined();
        expect(
            parseChargeReversal({
                type: 'charge.refunded',
                data: { object: { id: 'ch', payment_intent: 'pi', amount: 1000, amount_refunded: 0 } },
            })
        ).toBeUndefined();
    });
});

describe('fetchPurchaseMetadata', () => {
    const okFetch = (metadata: Record<string, string>) =>
        (async () => new Response(JSON.stringify({ metadata }), { status: 200 })) as unknown as typeof fetch;

    it('reads accountId + credits + gift flag from the PI metadata', async () => {
        const meta = await fetchPurchaseMetadata(
            'pi_1',
            'sk_test',
            okFetch({ account_id: 'acct-9', credits: '110', gift: '1' })
        );
        expect(meta).toEqual({ accountId: 'acct-9', credits: 110, isGift: true });
    });

    it('returns undefined on a non-ok response or missing fields', async () => {
        const bad = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
        expect(await fetchPurchaseMetadata('pi_x', 'sk', bad)).toBeUndefined();
        expect(await fetchPurchaseMetadata('pi_x', 'sk', okFetch({}))).toBeUndefined();
    });
});

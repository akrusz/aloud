import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
    parseCheckoutCompleted,
    verifyStripeSignature,
    packById,
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

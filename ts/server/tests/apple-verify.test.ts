/**
 * verifyAppleIdToken (meditation-pal-s75) — claim extraction + config gating.
 * The JWT signature check (jose against Apple's JWKS) is exercised live; here we
 * inject a fake verifier to assert how we read sub/email/email_verified and that
 * an empty APPLE_CLIENT_IDS disables Apple sign-in.
 */

import { describe, it, expect, vi } from 'vitest';
import { verifyAppleIdToken } from '../src/auth/apple.js';
import type { JWTPayload } from 'jose';

function fakeVerifier(payload: JWTPayload) {
    return vi.fn(async () => ({ payload, protectedHeader: { alg: 'RS256' } })) as never;
}

describe('verifyAppleIdToken', () => {
    it('extracts sub/email and reads email_verified as boolean or "true"', async () => {
        const out = await verifyAppleIdToken(
            'tok',
            ['app.aloud.web'],
            fakeVerifier({ sub: 'apple-sub-1', email: 'a@privaterelay.appleid.com', email_verified: 'true' })
        );
        expect(out).toEqual({ sub: 'apple-sub-1', email: 'a@privaterelay.appleid.com', emailVerified: true });
    });

    it('tolerates a missing email (Apple omits it on later sign-ins)', async () => {
        const out = await verifyAppleIdToken(
            'tok',
            ['app.aloud.web'],
            fakeVerifier({ sub: 'apple-sub-2', email_verified: true })
        );
        expect(out).toEqual({ sub: 'apple-sub-2', email: '', emailVerified: true });
    });

    it('throws when no Apple client ids are configured (sign-in disabled)', async () => {
        await expect(
            verifyAppleIdToken('tok', [], fakeVerifier({ sub: 'x' }))
        ).rejects.toThrow(/no APPLE_CLIENT_IDS/);
    });

    it('throws when the token has no sub', async () => {
        await expect(
            verifyAppleIdToken('tok', ['app.aloud.web'], fakeVerifier({ email: 'a@b.com' }))
        ).rejects.toThrow(/missing sub/);
    });
});

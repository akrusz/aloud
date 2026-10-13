/**
 * verifyGoogleIdToken: claim extraction. The JWT signature check (jose against
 * Google's JWKS) is exercised live; here a fake verifier stands in so we can
 * assert what we read off the payload, the `clients` the beta bonus keys on
 * (meditation-pal-bb4k) in particular.
 */

import { describe, it, expect, vi } from 'vitest';
import { verifyGoogleIdToken } from '../src/auth/google.js';
import type { JWTPayload } from 'jose';

function fakeVerifier(payload: JWTPayload) {
    return vi.fn(async () => ({ payload, protectedHeader: { alg: 'RS256' } })) as never;
}

const BASE = { sub: 'g-1', email: 'a@example.com', email_verified: true };

describe('verifyGoogleIdToken', () => {
    it('extracts sub/email and reads email_verified as boolean or "true"', async () => {
        const out = await verifyGoogleIdToken(
            'tok',
            ['web-client'],
            fakeVerifier({ ...BASE, email_verified: 'true', aud: 'web-client' })
        );
        expect(out).toEqual({ sub: 'g-1', email: 'a@example.com', emailVerified: true, clients: ['web-client'] });
    });

    it('names the presenter beside the audience when a native app asked for the token', async () => {
        const out = await verifyGoogleIdToken(
            'tok',
            ['web-client'],
            fakeVerifier({ ...BASE, aud: 'web-client', azp: 'android-client' })
        );
        expect(out.clients).toEqual(['web-client', 'android-client']);
    });

    it('lists a client once when it is both audience and presenter (web, iOS)', async () => {
        const out = await verifyGoogleIdToken(
            'tok',
            ['ios-client'],
            fakeVerifier({ ...BASE, aud: 'ios-client', azp: 'ios-client' })
        );
        expect(out.clients).toEqual(['ios-client']);
    });

    it('throws when no Google client ids are configured', async () => {
        await expect(verifyGoogleIdToken('tok', [], fakeVerifier(BASE))).rejects.toThrow(/no GOOGLE_CLIENT_IDS/);
    });

    it('throws when the token has no sub or email', async () => {
        await expect(
            verifyGoogleIdToken('tok', ['web-client'], fakeVerifier({ sub: 'g-1' }))
        ).rejects.toThrow(/missing sub\/email/);
    });
});

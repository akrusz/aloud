import { describe, it, expect } from 'vitest';
import { signInThanks } from '../ui/src/sign-in-thanks.js';
import type { AuthResponse } from '../ui/src/cloud-auth.js';

function auth(granted?: AuthResponse['granted']): AuthResponse {
    return {
        token: 'tok',
        isNewAccount: false,
        account: { id: 'a', email: 'a@example.com', emailVerified: true, creditsRemaining: 0, providers: ['google'] },
        ...(granted ? { granted } : {}),
    };
}

describe('signInThanks', () => {
    it('says nothing when the sign-in added nothing', () => {
        expect(signInThanks(auth())).toBeNull();
        expect(signInThanks(auth({ connect: 0, beta: 0 }))).toBeNull();
    });

    it('thanks for connecting an account', () => {
        expect(signInThanks(auth({ connect: 20, beta: 0 }))).toBe(
            'Thanks for connecting an account! 20\u2601 added to your balance.'
        );
    });

    it('thanks for the beta, with the total when both land at once', () => {
        expect(signInThanks(auth({ connect: 0, beta: 40 }))).toBe(
            'Thanks for joining the beta! 40\u2601 added to your balance.'
        );
        expect(signInThanks(auth({ connect: 20, beta: 40 }))).toBe(
            'Thanks for joining the beta! 60\u2601 added to your balance.'
        );
    });
});

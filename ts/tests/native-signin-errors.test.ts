import { describe, it, expect } from 'vitest';
import { describeAuthError, nativeAuthErrorMessage } from '../ui/src/native-signin.js';

describe('nativeAuthErrorMessage', () => {
    it('names the code when the plugin gives no message', () => {
        // The Play-signed regression: Android status 10 (package + signing-cert
        // mismatch) arrived with an empty message and painted a blank error.
        expect(nativeAuthErrorMessage({ code: 10, message: '' }, 'Google')).toBe(
            'Google sign-in failed (code 10). Try again, or use email below.'
        );
    });

    it('still says something when there is no message and no code', () => {
        expect(nativeAuthErrorMessage({}, 'Google')).toBe(
            'Google sign-in failed. Try again, or use email below.'
        );
        expect(nativeAuthErrorMessage(undefined, 'Apple')).toBe(
            'Apple sign-in failed. Try again, or use email below.'
        );
    });

    it('never surfaces a stringified object', () => {
        const msg = nativeAuthErrorMessage({ message: '[object Object]', code: 16 }, 'Google');
        expect(msg).toBe('Google sign-in failed (code 16). Try again, or use email below.');
    });

    it('keeps a real message and appends the code once', () => {
        expect(nativeAuthErrorMessage({ message: 'DEVELOPER_ERROR', code: 10 }, 'Google')).toBe(
            'DEVELOPER_ERROR (code 10)'
        );
        expect(nativeAuthErrorMessage({ message: 'failed with 10', code: 10 }, 'Google')).toBe(
            'failed with 10'
        );
    });

    it('passes an Error message through untouched', () => {
        expect(nativeAuthErrorMessage(new Error('network unreachable'), 'Google')).toBe(
            'network unreachable'
        );
    });

    it('leaves a neutral trace on a claimed cancellation', () => {
        // Never silent: the plugin reports a missing Android OAuth client as
        // "cancelled by user" too (meditation-pal-7bi9), and the message it
        // writes can't tell the two apart. True either way.
        const line = "Sign-in didn't complete.";
        expect(nativeAuthErrorMessage({ message: 'activity is cancelled by the user' }, 'Google')).toBe(line);
        expect(nativeAuthErrorMessage({ code: '12501' }, 'Google')).toBe(line);
        expect(nativeAuthErrorMessage({ code: 1001 }, 'Apple')).toBe(line);
        expect(
            nativeAuthErrorMessage({ code: 'USER_CANCELLED', message: 'Google Sign-In cancelled by user' }, 'Google')
        ).toBe(line);
    });

    it('describeAuthError renders a plugin rejection instead of [object Object]', () => {
        expect(describeAuthError({ code: 'USER_CANCELLED', message: 'cancelled by user' })).toBe(
            'code=USER_CANCELLED message=cancelled by user'
        );
        expect(describeAuthError('boom')).toBe('boom');
    });

    it('does not treat a missing-account failure as a cancellation', () => {
        // GMS CANCELED (16) is also what "no Google account on this device"
        // surfaces as; swallowing it would recreate the silent failure.
        expect(nativeAuthErrorMessage({ code: 16 }, 'Google')).not.toBeNull();
        expect(nativeAuthErrorMessage({ message: 'NoCredentialException' }, 'Google')).not.toBeNull();
    });
});

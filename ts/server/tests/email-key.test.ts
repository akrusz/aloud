/**
 * Email grant-key normalization (meditation-pal-8jc) — the farming-resistant key
 * that gates the free grant and survives account deletion. Verifies the common
 * "same inbox, different string" tricks collapse to one key while genuinely
 * different addresses stay distinct.
 */

import { describe, it, expect } from 'vitest';
import { normalizeEmail, emailGrantKey } from '../src/auth/email-key.js';

describe('normalizeEmail', () => {
    it('lower-cases and trims', () => {
        expect(normalizeEmail('  John.Doe@Example.COM ')).toBe('john.doe@example.com');
    });

    it('strips +tag sub-addressing on any domain', () => {
        expect(normalizeEmail('john+promo@example.com')).toBe('john@example.com');
        expect(normalizeEmail('john+a+b@work.org')).toBe('john@work.org');
    });

    it('ignores dots and the googlemail alias for Gmail only', () => {
        expect(normalizeEmail('j.o.h.n@gmail.com')).toBe('john@gmail.com');
        expect(normalizeEmail('john@googlemail.com')).toBe('john@gmail.com');
        // Dots are significant on non-Gmail domains — must NOT be stripped.
        expect(normalizeEmail('j.o.h.n@example.com')).toBe('j.o.h.n@example.com');
    });

    it('leaves non-email-shaped strings as a lower-cased fallback key', () => {
        expect(normalizeEmail('not-an-email')).toBe('not-an-email');
        expect(normalizeEmail('trailing@')).toBe('trailing@');
    });
});

describe('emailGrantKey', () => {
    it('is stable across the collapsed variants', () => {
        const canonical = emailGrantKey('johndoe@gmail.com');
        expect(emailGrantKey('John.Doe@gmail.com')).toBe(canonical);
        expect(emailGrantKey('john.doe+newsletter@googlemail.com')).toBe(canonical);
    });

    it('differs for genuinely different mailboxes', () => {
        expect(emailGrantKey('a@example.com')).not.toBe(emailGrantKey('b@example.com'));
        // dots ARE significant off-Gmail, so these are different people
        expect(emailGrantKey('a.b@example.com')).not.toBe(emailGrantKey('ab@example.com'));
    });

    it('is a hex sha-256 digest, not the address itself', () => {
        const key = emailGrantKey('a@example.com');
        expect(key).toMatch(/^[0-9a-f]{64}$/);
        expect(key).not.toContain('example.com');
    });
});

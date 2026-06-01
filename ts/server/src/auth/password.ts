/**
 * Password hashing for email/password sign-in (meditation-pal-s75). scrypt via
 * node:crypto — no external dependency, memory-hard, and the stored format is
 * self-describing so parameters can evolve without a migration:
 *
 *   scrypt$N$r$p$<salt-hex>$<hash-hex>
 *
 * Email accounts are an UNTRUSTED identity (no free credits until they connect
 * Google/Apple — see quota/freetier.ts), so this protects the password at rest;
 * it isn't load-bearing for abuse economics.
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// scrypt cost params. N=2^15 is a sane interactive default (~tens of ms).
const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;
// 128*N*r ≈ 32MiB at these params, which equals Node's default scrypt maxmem and
// trips "memory limit exceeded" — bump the ceiling so the params are usable.
const MAXMEM = 64 * 1024 * 1024;

export function hashPassword(password: string): string {
    const salt = randomBytes(SALT_BYTES);
    const hash = scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
    return `scrypt$${N}$${R}$${P}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** Constant-time verify. Returns false on any malformed/mismatched input rather
 *  than throwing, so a corrupt stored hash can't 500 a login. */
export function verifyPassword(password: string, stored: string): boolean {
    try {
        const parts = stored.split('$');
        if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
        const [, n, r, p, saltHex, hashHex] = parts;
        const salt = Buffer.from(saltHex!, 'hex');
        const expected = Buffer.from(hashHex!, 'hex');
        const actual = scryptSync(password, salt, expected.length, {
            N: Number(n),
            r: Number(r),
            p: Number(p),
            maxmem: MAXMEM,
        });
        return expected.length === actual.length && timingSafeEqual(expected, actual);
    } catch {
        return false;
    }
}

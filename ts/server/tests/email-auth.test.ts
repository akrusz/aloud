/**
 * Email/password sign-in (meditation-pal-s75) + the scrypt credential helper.
 * Email accounts are an UNTRUSTED identity: signup creates an account with NO
 * free credits (you must connect Google/Apple to get them — meditation-pal-116).
 */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { AuthResponse } from '../src/contract.js';
import { hashPassword, verifyPassword } from '../src/auth/password.js';

function app() {
    return createApp(buildDeps(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ALOUD_FREE_SIGNUP_CREDITS: '20' })));
}

async function post(a: ReturnType<typeof createApp>, path: string, body: unknown) {
    return a.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('hashPassword / verifyPassword', () => {
    it('round-trips and rejects the wrong password', async () => {
        const stored = await hashPassword('correct horse battery');
        expect(stored.startsWith('scrypt$')).toBe(true);
        expect(await verifyPassword('correct horse battery', stored)).toBe(true);
        expect(await verifyPassword('wrong', stored)).toBe(false);
    });

    it('returns false (never throws) on a malformed stored hash', async () => {
        expect(await verifyPassword('x', 'garbage')).toBe(false);
        expect(await verifyPassword('x', '')).toBe(false);
    });

    it('uses a fresh salt per hash (same password → different stored value)', async () => {
        expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
    });
});

describe('POST /cloud/v1/auth/email/signup', () => {
    it('creates an account with NO free credits (untrusted identity)', async () => {
        const res = await post(app(), '/cloud/v1/auth/email/signup', {
            email: 'New@Example.com',
            password: 'hunter2hunter2',
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as AuthResponse;
        expect(body.isNewAccount).toBe(true);
        expect(body.account.email).toBe('new@example.com'); // normalized
        expect(body.account.creditsRemaining).toBe(0); // the whole point of 116
    });

    it('rejects a bad email or a too-short password', async () => {
        const a = app();
        expect((await post(a, '/cloud/v1/auth/email/signup', { email: 'nope', password: 'longenough' })).status).toBe(400);
        expect((await post(a, '/cloud/v1/auth/email/signup', { email: 'a@b.co', password: 'short' })).status).toBe(400);
    });

    it('rejects a duplicate email', async () => {
        const a = app();
        await post(a, '/cloud/v1/auth/email/signup', { email: 'dup@example.com', password: 'password1' });
        const res = await post(a, '/cloud/v1/auth/email/signup', { email: 'dup@example.com', password: 'password2' });
        expect(res.status).toBe(400);
    });
});

describe('POST /cloud/v1/auth/email/login', () => {
    it('logs in with the right password and the token authenticates', async () => {
        const a = app();
        await post(a, '/cloud/v1/auth/email/signup', { email: 'log@example.com', password: 'goodpassword' });
        const res = await post(a, '/cloud/v1/auth/email/login', { email: 'log@example.com', password: 'goodpassword' });
        expect(res.status).toBe(200);
        const body = (await res.json()) as AuthResponse;
        expect(body.isNewAccount).toBe(false);
        const me = await a.request('/cloud/v1/me', { headers: { authorization: `Bearer ${body.token}` } });
        expect(me.status).toBe(200);
    });

    it('rejects a wrong password or unknown email with one generic 401', async () => {
        const a = app();
        await post(a, '/cloud/v1/auth/email/signup', { email: 'log2@example.com', password: 'goodpassword' });
        expect((await post(a, '/cloud/v1/auth/email/login', { email: 'log2@example.com', password: 'nope' })).status).toBe(401);
        expect((await post(a, '/cloud/v1/auth/email/login', { email: 'ghost@example.com', password: 'whatever1' })).status).toBe(401);
    });

    it('rate-limits repeated attempts per IP (429 after the burst)', async () => {
        const a = app();
        const attempt = (ip: string) =>
            a.request('/cloud/v1/auth/email/login', {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
                body: JSON.stringify({ email: 'brute@example.com', password: 'guess-me-not' }),
            });
        // The guard allows 10/min per IP — burn the budget, then expect 429.
        for (let i = 0; i < 10; i++) {
            expect((await attempt('203.0.113.9')).status).toBe(401);
        }
        expect((await attempt('203.0.113.9')).status).toBe(429);
        // A different IP is unaffected (the key is the IP, not the route).
        expect((await attempt('198.51.100.4')).status).toBe(401);
    });
});

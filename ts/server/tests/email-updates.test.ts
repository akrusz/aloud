/**
 * Email-updates opt-in: strictly opt-in product-news flag on the account,
 * settable at email signup and toggled via PATCH /cloud/v1/me.
 */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { AccountView, AuthResponse } from '../src/contract.js';

function makeApp(): ReturnType<typeof createApp> {
    return createApp(buildDeps(loadConfig({ ALOUD_ENABLE_DEV_AUTH: '1' })));
}

async function signup(
    app: ReturnType<typeof createApp>,
    body: Record<string, unknown>
): Promise<AuthResponse> {
    const res = await app.request('/cloud/v1/auth/email/signup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as AuthResponse;
}

describe('email-updates opt-in', () => {
    it('defaults off and is set by the signup checkbox', async () => {
        const app = makeApp();
        const plain = await signup(app, { email: 'quiet@example.com', password: 'password1' });
        expect(plain.account.emailUpdates).toBe(false);

        const optedIn = await signup(app, {
            email: 'news@example.com',
            password: 'password1',
            emailUpdates: true,
        });
        expect(optedIn.account.emailUpdates).toBe(true);

        // Persisted, not just echoed: /me reads it back from the store.
        const me = await app.request('/cloud/v1/me', {
            headers: { authorization: `Bearer ${optedIn.token}` },
        });
        expect(((await me.json()) as AccountView).emailUpdates).toBe(true);
    });

    it('PATCH /cloud/v1/me toggles it both ways', async () => {
        const app = makeApp();
        const { token } = await signup(app, { email: 'toggle@example.com', password: 'password1' });
        const patch = (emailUpdates: boolean): Promise<Response> =>
            app.request('/cloud/v1/me', {
                method: 'PATCH',
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                body: JSON.stringify({ emailUpdates }),
            });

        const on = await patch(true);
        expect(on.status).toBe(200);
        expect(((await on.json()) as AccountView).emailUpdates).toBe(true);

        const off = await patch(false);
        expect(((await off.json()) as AccountView).emailUpdates).toBe(false);

        const me = await app.request('/cloud/v1/me', {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(((await me.json()) as AccountView).emailUpdates).toBe(false);
    });

    it('PATCH rejects a missing flag and requires auth', async () => {
        const app = makeApp();
        const { token } = await signup(app, { email: 'strict@example.com', password: 'password1' });
        const empty = await app.request('/cloud/v1/me', {
            method: 'PATCH',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({}),
        });
        expect(empty.status).toBe(400);

        const unauthed = await app.request('/cloud/v1/me', {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ emailUpdates: true }),
        });
        expect(unauthed.status).toBe(401);
    });
});

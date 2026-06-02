/**
 * DELETE /cloud/v1/me — account self-deletion (meditation-pal-8jc). Confirms the
 * endpoint soft-deletes and that the session token is dead afterward (a
 * tombstoned account must not authenticate).
 */

import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { AuthResponse } from '../src/contract.js';

async function signIn(app: ReturnType<typeof createApp>): Promise<string> {
    const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    expect(res.status).toBe(200);
    return ((await res.json()) as AuthResponse).token;
}

describe('DELETE /cloud/v1/me', () => {
    it('deletes the account and kills the session token', async () => {
        // Non-strict so the dev sign-in route is available to mint a token.
        const app = createApp(buildDeps(loadConfig({ ALOUD_FREE_SIGNUP_CREDITS: '10' })));
        const token = await signIn(app);
        const authed = { headers: { authorization: `Bearer ${token}` } };

        // The account is live first.
        expect((await app.request('/cloud/v1/me', authed)).status).toBe(200);

        const del = await app.request('/cloud/v1/me', { method: 'DELETE', ...authed });
        expect(del.status).toBe(200);
        expect(await del.json()).toEqual({ deleted: true });

        // The same token no longer authenticates.
        expect((await app.request('/cloud/v1/me', authed)).status).toBe(401);
    });

    it('requires auth', async () => {
        const app = createApp(buildDeps(loadConfig({})));
        expect((await app.request('/cloud/v1/me', { method: 'DELETE' })).status).toBe(401);
    });
});

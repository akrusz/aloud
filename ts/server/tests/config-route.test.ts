/**
 * The public `GET /cloud/v1/config` route — build-agnostic bits a client needs
 * before sign-in (the Google OAuth web client id), so any install can render the
 * sign-in button for whatever server it's pointed at. See routes in app.ts /
 * meditation-pal-rfb.
 */
import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';

function app(env: Record<string, string>) {
    return createApp(buildDeps(loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ...env })));
}

describe('GET /cloud/v1/config', () => {
    it('advertises the first Google + Apple ids and the desktop client id when configured', async () => {
        const res = await app({
            GOOGLE_CLIENT_IDS: 'web-client-1,ios-client-2',
            GOOGLE_DESKTOP_CLIENT_ID: 'desktop-client-3',
            APPLE_CLIENT_IDS: 'app.aloud.web',
        }).request('/cloud/v1/config');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            googleClientId: 'web-client-1',
            googleDesktopClientId: 'desktop-client-3',
            appleClientId: 'app.aloud.web',
        });
    });

    it('returns empty ids when none are configured (client keeps dev sign-in)', async () => {
        const res = await app({}).request('/cloud/v1/config');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            googleClientId: '',
            googleDesktopClientId: '',
            appleClientId: '',
        });
    });

    it('needs no auth (it runs before sign-in)', async () => {
        const res = await app({ GOOGLE_CLIENT_IDS: 'web-client-1' }).request('/cloud/v1/config');
        expect(res.status).toBe(200);
    });
});

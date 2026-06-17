/**
 * exchangeGoogleCode — the desktop (Tauri) loopback PKCE token exchange
 * (meditation-pal-fae). The client secret lives server-side; the app sends the
 * authorization code it caught on its loopback and the server redeems it. We
 * inject a fake fetch so this stays hermetic (no call to Google).
 */
import { describe, it, expect } from 'vitest';
import { exchangeGoogleCode } from '../src/auth/google.js';

const params = {
    code: 'auth-code',
    codeVerifier: 'pkce-verifier',
    redirectUri: 'http://127.0.0.1:54321',
    clientId: 'desktop-client-id',
    clientSecret: 'desktop-secret',
};

function fakeFetch(status: number, body: unknown): typeof fetch {
    return (async () =>
        new Response(typeof body === 'string' ? body : JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch;
}

describe('exchangeGoogleCode', () => {
    it('posts the code + PKCE verifier + secret as form-encoded and returns the id_token', async () => {
        let seen: { url: string; init?: RequestInit } | null = null;
        const capturing = (async (url: string, init?: RequestInit) => {
            seen = { url, init };
            return new Response(JSON.stringify({ id_token: 'the.id.token' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as unknown as typeof fetch;

        const idToken = await exchangeGoogleCode(params, capturing);
        expect(idToken).toBe('the.id.token');

        expect(seen!.url).toBe('https://oauth2.googleapis.com/token');
        const sent = new URLSearchParams(String(seen!.init?.body));
        expect(sent.get('code')).toBe('auth-code');
        expect(sent.get('code_verifier')).toBe('pkce-verifier');
        expect(sent.get('client_id')).toBe('desktop-client-id');
        expect(sent.get('client_secret')).toBe('desktop-secret');
        expect(sent.get('redirect_uri')).toBe('http://127.0.0.1:54321');
        expect(sent.get('grant_type')).toBe('authorization_code');
    });

    it('throws on a non-OK token response (e.g. a bad/expired code)', async () => {
        await expect(
            exchangeGoogleCode(params, fakeFetch(400, { error: 'invalid_grant' }))
        ).rejects.toThrow(/token exchange failed \(400\)/);
    });

    it('throws when the response carries no id_token', async () => {
        await expect(
            exchangeGoogleCode(params, fakeFetch(200, { access_token: 'only-this' }))
        ).rejects.toThrow(/missing id_token/);
    });
});

/**
 * POST /cloud/v1/billing/checkout — the custom-amount path (type your own
 * credits). Stripe is stubbed via global fetch so we can read the line item the
 * server built without hitting the network.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { MIN_CUSTOM_CREDITS } from '../src/billing/stripe.js';
import type { AuthResponse } from '../src/contract.js';

const realFetch = globalThis.fetch;
let stripeForm: URLSearchParams | null = null;

beforeEach(() => {
    stripeForm = null;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        if (String(url).includes('api.stripe.com/v1/checkout/sessions')) {
            stripeForm = new URLSearchParams(init?.body as string);
            return new Response(JSON.stringify({ url: 'https://stripe.test/checkout/cs_1' }), { status: 200 });
        }
        return realFetch(url, init);
    }) as typeof fetch;
});
afterEach(() => {
    globalThis.fetch = realFetch;
});

function app() {
    const config = loadConfig({
        ALOUD_ENABLE_DEV_AUTH: '1',
        STRIPE_SECRET_KEY: 'sk_test',
        ALOUD_CORS_ORIGINS: 'https://app.test',
        ALOUD_FREE_SIGNUP_CREDITS: '0',
    });
    return createApp(buildDeps(config));
}

async function token(a: ReturnType<typeof createApp>): Promise<string> {
    const res = await a.request('/cloud/v1/auth/dev', { method: 'POST' });
    return ((await res.json()) as AuthResponse).token;
}

function checkout(a: ReturnType<typeof createApp>, tok: string, body: unknown) {
    return a.request('/cloud/v1/billing/checkout', {
        method: 'POST',
        headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
    });
}

describe('POST /cloud/v1/billing/checkout — custom amount', () => {
    it('prices a custom credit amount server-side and forwards it to Stripe', async () => {
        const a = app();
        const tok = await token(a);
        const res = await checkout(a, tok, { credits: 100, channel: 'web_stripe' });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { checkoutUrl: string }).checkoutUrl).toContain('stripe.test');

        // 100 credits × 12.5¢ = $12.50; credits ride in metadata for the webhook.
        expect(stripeForm?.get('line_items[0][price_data][unit_amount]')).toBe('1250');
        expect(stripeForm?.get('metadata[credits]')).toBe('100');
        expect(stripeForm?.get('metadata[pack_id]')).toBe('custom');
    });

    it('rejects an amount below the smallest preset (never reaches Stripe)', async () => {
        const a = app();
        const tok = await token(a);
        const res = await checkout(a, tok, { credits: MIN_CUSTOM_CREDITS - 1, channel: 'web_stripe' });
        expect(res.status).toBe(400);
        expect(stripeForm).toBeNull(); // validated before any Stripe call
    });

    it('rejects a fractional amount', async () => {
        const a = app();
        const tok = await token(a);
        const res = await checkout(a, tok, { credits: 80.5, channel: 'web_stripe' });
        expect(res.status).toBe(400);
    });

    it('still accepts a preset packId', async () => {
        const a = app();
        const tok = await token(a);
        const res = await checkout(a, tok, { packId: 'plus', channel: 'web_stripe' });
        expect(res.status).toBe(200);
        expect(stripeForm?.get('metadata[pack_id]')).toBe('plus');
    });
});

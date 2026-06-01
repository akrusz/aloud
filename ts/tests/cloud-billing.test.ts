/**
 * cloud-billing.ts — the browser half of the buy-credits flow (meditation-pal-8sj).
 * Hermetic: a MemoryKv supplies (or withholds) the session token and global
 * fetch is stubbed, so we assert the request shape and error handling without a
 * server or a real Stripe round-trip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fetchPacks, startCheckout } from '../ui/src/cloud-billing.js';
import { setCloudAuthBackend } from '../ui/src/cloud-auth.js';
import type { KvStorage } from '../src/platform/storage.js';

class MemoryKv implements KvStorage {
    private m = new Map<string, string>();
    async get(k: string) {
        return this.m.get(k) ?? null;
    }
    async set(k: string, v: string) {
        this.m.set(k, v);
    }
    async delete(k: string) {
        this.m.delete(k);
    }
    async keys() {
        return [...this.m.keys()];
    }
    async clear() {
        this.m.clear();
    }
}

let kv: MemoryKv;

beforeEach(() => {
    kv = new MemoryKv();
    setCloudAuthBackend(kv);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('fetchPacks', () => {
    it('returns the server packs', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response(JSON.stringify({ packs: [{ id: 'plus', credits: 110, priceUsdCents: 1200, label: '110 — $12' }] }), { status: 200 }))
        );
        const packs = await fetchPacks();
        expect(packs).toHaveLength(1);
        expect(packs[0]).toMatchObject({ id: 'plus', credits: 110 });
    });

    it('throws a friendly message on a non-OK response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
        await expect(fetchPacks()).rejects.toThrow(/couldn't load credit packs/i);
    });
});

describe('startCheckout', () => {
    it('refuses without a session token (sign-in required)', async () => {
        vi.stubGlobal('fetch', vi.fn());
        await expect(startCheckout('plus')).rejects.toThrow(/sign in/i);
    });

    it('POSTs packId + channel + returnPath with the bearer token and returns the url', async () => {
        await kv.set('server:token', 'tok-abc');
        let seen: { url: string; init?: RequestInit } | null = null;
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init?: RequestInit) => {
                seen = { url: String(url), init };
                return new Response(JSON.stringify({ checkoutUrl: 'https://checkout.stripe.com/c/abc' }), { status: 200 });
            })
        );

        const url = await startCheckout('plus');

        expect(url).toBe('https://checkout.stripe.com/c/abc');
        expect(seen!.url).toMatch(/\/cloud\/v1\/billing\/checkout$/);
        expect(seen!.init?.method).toBe('POST');
        expect((seen!.init?.headers as Record<string, string>)['authorization']).toBe('Bearer tok-abc');
        const body = JSON.parse(String(seen!.init?.body)) as Record<string, unknown>;
        expect(body['packId']).toBe('plus');
        expect(body['channel']).toBe('web_stripe');
        expect(typeof body['returnPath']).toBe('string'); // BASE_URL, '/' in tests
    });

    it('maps a 500 to a try-again-later message', async () => {
        await kv.set('server:token', 'tok-abc');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
        await expect(startCheckout('plus')).rejects.toThrow(/temporarily unavailable/i);
    });
});

/**
 * Buy-credits flow — the browser half of billing (meditation-pal-8sj). The
 * server owns the money: this fetches the published packs, starts a Stripe
 * Checkout session (authed), and redirects the tab to Stripe. Fulfilment is the
 * signature-verified webhook server-side; the client only learns the outcome
 * from the `?purchase=` param Stripe appends on return (consumePurchaseReturn).
 */

import { cloudUrl } from './cloud-base.js';
import { getCloudToken } from './cloud-auth.js';

/** Mirrors the server's CreditPack (ts/server/src/billing/stripe.ts). */
export interface CreditPack {
    id: string;
    credits: number;
    priceUsdCents: number;
    label: string;
}

/** GET /cloud/v1/me/packs — the packs for sale (public). Throws on a non-OK
 *  response so the caller can surface "couldn't load packs". */
export async function fetchPacks(): Promise<CreditPack[]> {
    const res = await fetch(cloudUrl('/me/packs'));
    if (!res.ok) throw new Error(`Couldn't load credit packs (${res.status}).`);
    const data = (await res.json()) as { packs?: CreditPack[] };
    return data.packs ?? [];
}

/**
 * Start a purchase: POST /cloud/v1/billing/checkout with the session token and
 * return the Stripe Checkout URL for the caller to navigate to. `returnPath` is
 * this build's app base (import.meta.env.BASE_URL — '/app/' on the hosted
 * subpath, '/' in dev/desktop) so Stripe bounces the user back into the app.
 * Throws if not signed in or the server declines (e.g. billing not configured);
 * the caller shows the message. Side-effect-free (no redirect) so it's testable
 * and the redirect stays at the call site.
 */
export async function startCheckout(packId: string): Promise<string> {
    const token = await getCloudToken();
    if (!token) throw new Error('Sign in to buy credits.');
    const res = await fetch(cloudUrl('/billing/checkout'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
            packId,
            channel: 'web_stripe',
            returnPath: import.meta.env.BASE_URL ?? '/',
        }),
    });
    if (!res.ok) {
        const msg =
            res.status === 503 || res.status === 500
                ? 'Purchasing is temporarily unavailable. Please try again later.'
                : `Couldn't start checkout (${res.status}).`;
        throw new Error(msg);
    }
    const data = (await res.json()) as { checkoutUrl?: string };
    if (!data.checkoutUrl) throw new Error('Checkout did not return a URL.');
    return data.checkoutUrl;
}

/**
 * Read and clear the `?purchase=` param Stripe appended on return. Returns
 * 'success' | 'cancel' | null, and strips the param from the URL (replaceState)
 * so a refresh doesn't re-trigger the toast. Call once at boot.
 */
export function consumePurchaseReturn(): 'success' | 'cancel' | null {
    if (typeof window === 'undefined') return null;
    const url = new URL(window.location.href);
    const value = url.searchParams.get('purchase');
    if (value !== 'success' && value !== 'cancel') return null;
    url.searchParams.delete('purchase');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
    return value;
}

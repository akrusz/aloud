/**
 * Buy-credits flow, the browser half of billing (meditation-pal-8sj). The server
 * owns the money: this fetches the published packs, starts an authed Stripe
 * Checkout session, and redirects the tab to Stripe. Fulfilment is the
 * signature-verified webhook server-side; the client only learns the outcome
 * from the `?purchase=` param Stripe appends on return.
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

/** Whether the x402 (USDC-on-Base) pay option is available, and on which network. */
export interface X402Capability {
    enabled: boolean;
    network?: 'base' | 'base-sepolia';
}

/** Custom "type your own amount" pricing: the shared volume curve so the client
 *  can preview a price (card only; the server re-prices authoritatively).
 *  Mirrors the server's /me/packs `custom`. `curve` is the quadratic in dollars
 *  (credits = a·d² + b·d + c) with a flat rate beyond capSpendCents. */
export interface CustomCredits {
    baseCentsPerCredit: number;
    curve: {
        a: number;
        b: number;
        c: number;
        capSpendCents: number;
        capCreditsPerDollar: number;
    };
    minCredits: number;
    maxCredits: number;
}

/** Packs for sale plus the available alternative payment channels. */
export interface BillingPacks {
    packs: CreditPack[];
    x402: X402Capability;
    /** Present when the server allows custom amounts (older servers omit it). */
    custom?: CustomCredits;
}

/** GET /cloud/v1/me/packs: packs for sale + channel availability (public).
 *  Throws on non-OK so the caller can surface "couldn't load packs". */
export async function fetchPacks(): Promise<BillingPacks> {
    const res = await fetch(cloudUrl('/me/packs'));
    if (!res.ok) throw new Error(`Couldn't load credit packs (${res.status}).`);
    const data = (await res.json()) as {
        packs?: CreditPack[];
        x402?: X402Capability;
        custom?: CustomCredits;
    };
    return {
        packs: data.packs ?? [],
        x402: data.x402 ?? { enabled: false },
        ...(data.custom ? { custom: data.custom } : {}),
    };
}

/**
 * POST /cloud/v1/billing/checkout and return the Stripe Checkout URL for the
 * caller to navigate to. `returnPath` is this build's app base ('/app/' hosted,
 * '/' in dev/desktop) so Stripe bounces the user back into the app. Throws if
 * not signed in or the server declines (e.g. billing unconfigured). Performs no
 * redirect itself, so it stays testable and the redirect lives at the call site.
 */
export async function startCheckout(
    selection: { packId: string } | { credits: number },
    giftToEmail?: string
): Promise<string> {
    const token = await getCloudToken();
    if (!token) throw new Error('Sign in to buy credits.');
    const res = await fetch(cloudUrl('/billing/checkout'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
            // A preset pack id or a custom credit amount (server-priced).
            ...selection,
            channel: 'web_stripe',
            returnPath: import.meta.env.BASE_URL ?? '/',
            // Gifting: the payment clears now, but the clouds become a pending
            // gift the recipient accepts on next sign-in.
            ...(giftToEmail ? { giftToEmail } : {}),
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
 * Read the `?purchase=` param Stripe appended on return, stripping it via
 * replaceState so a refresh doesn't re-trigger the toast. Call once at boot.
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

// ---- Gift clouds (meditation-pal-bd5) -------------------------------------

/** A pending gift addressed to the signed-in account. Mirrors server GiftView. */
export interface GiftView {
    id: string;
    credits: number;
    fromEmail?: string;
    createdAt: number;
}

async function authed(path: string, init?: RequestInit): Promise<Response> {
    const token = await getCloudToken();
    if (!token) throw new Error('Sign in required.');
    return fetch(cloudUrl(path), {
        ...init,
        headers: { ...(init?.headers ?? {}), authorization: `Bearer ${token}` },
    });
}

/** GET /cloud/v1/gifts. Returns [] on any error so a hiccup never blocks the app. */
export async function fetchGifts(): Promise<GiftView[]> {
    try {
        const res = await authed('/gifts');
        if (!res.ok) return [];
        return ((await res.json()) as { gifts?: GiftView[] }).gifts ?? [];
    } catch {
        return [];
    }
}

/** Accept a gift; its clouds land in the signed-in account. */
export async function acceptGift(id: string): Promise<void> {
    const res = await authed(`/gifts/${encodeURIComponent(id)}/accept`, { method: 'POST' });
    if (!res.ok) throw new Error('This gift is no longer available.');
}

/** Decline a gift; it bounces back to the buyer as a returned gift. */
export async function declineGift(id: string): Promise<void> {
    const res = await authed(`/gifts/${encodeURIComponent(id)}/decline`, { method: 'POST' });
    if (!res.ok) throw new Error('This gift is no longer available.');
}

/** A bounced gift the signed-in BUYER can re-gift or claim. Mirrors the server's
 *  ReturnedGiftView (meditation-pal-bd5). */
export interface ReturnedGiftView {
    id: string;
    credits: number;
    toEmail: string;
    createdAt: number;
}

/** GET /cloud/v1/gifts/returned. Returns [] on any error, like fetchGifts. */
export async function fetchReturnedGifts(): Promise<ReturnedGiftView[]> {
    try {
        const res = await authed('/gifts/returned');
        if (!res.ok) return [];
        return ((await res.json()) as { gifts?: ReturnedGiftView[] }).gifts ?? [];
    } catch {
        return [];
    }
}

/** Re-gift a returned gift to a new recipient (no new charge). Prefers the
 *  server's message (e.g. bad email). */
export async function regiftReturned(id: string, email: string): Promise<void> {
    const res = await authed(`/gifts/${encodeURIComponent(id)}/regift`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    if (!res.ok) {
        let msg = 'Could not re-gift this.';
        try {
            msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg;
        } catch {
            /* non-JSON */
        }
        throw new Error(msg);
    }
}

/** Claim a returned gift to the signed-in account's own balance. */
export async function claimReturnedGift(id: string): Promise<void> {
    const res = await authed(`/gifts/${encodeURIComponent(id)}/claim`, { method: 'POST' });
    if (!res.ok) throw new Error('This gift is no longer available.');
}

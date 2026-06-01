/**
 * Free-tier gating + abuse controls (meditation-pal-2yb). The web demo has a
 * wide-open abuse surface (no app-store gating), so this is load-bearing.
 *
 * Two cheap levers implemented here; the heavier ones (device fingerprinting,
 * disposable-domain blocklists, velocity scoring) attach at these same seams:
 *   1. The free grant is gated on CONNECTING a TRUSTED, VERIFIED identity
 *      (Google/Apple) — not on signing up (meditation-pal-116). A bare email
 *      signup, or an unverified/untrusted identity, gets an account but zero
 *      free credits, and the grant fires at most once per account and once per
 *      identity ever (decideConnectGrant, applied in auth/identity.ts). So
 *      farming throwaway emails — or re-using one Google login across many aloud
 *      accounts — yields nothing spendable.
 *   2. A per-account request-rate ceiling caps burst abuse and runaway clients.
 *      In-memory sliding window here; swap for Redis when the backend goes
 *      multi-instance (meditation-pal-a3u notes sticky-sessions/Redis only
 *      matter once stateful).
 */

import type { IdentityProvider } from '../credits/store.js';

/** Providers trusted enough to be worth a free grant — minting one at scale is
 *  real friction, unlike a throwaway email. Connecting one of these (verified)
 *  is what unlocks credits; a bare 'email' signup gets none (meditation-pal-116). */
export const TRUSTED_IDENTITY_PROVIDERS: readonly IdentityProvider[] = ['google', 'apple'];

export function isTrustedProvider(provider: IdentityProvider): boolean {
    return TRUSTED_IDENTITY_PROVIDERS.includes(provider);
}

export interface GrantDecision {
    grantCredits: number;
    reason: string;
}

/**
 * Decide the free-credit grant when an identity is connected to an account
 * (meditation-pal-116). Granted only when ALL hold:
 *   - the provider is TRUSTED (Google/Apple — not a bare email signup),
 *   - the provider asserts a VERIFIED email,
 *   - the account has not already been granted (one grant per account), and
 *   - this identity has not granted before (one grant per identity, ever).
 * This is the "credits come from connecting a hard-to-mint identity, not from
 * signing up" lever — email accounts get nothing until they connect Google/Apple.
 */
export function decideConnectGrant(params: {
    provider: IdentityProvider;
    emailVerified: boolean;
    accountAlreadyGranted: boolean;
    identityAlreadyGranted: boolean;
    freeCredits: number;
}): GrantDecision {
    const { provider, emailVerified, accountAlreadyGranted, identityAlreadyGranted, freeCredits } =
        params;
    if (!isTrustedProvider(provider)) {
        return {
            grantCredits: 0,
            reason: `untrusted_provider:${provider}: connect Google or Apple for free credits`,
        };
    }
    if (!emailVerified) {
        return { grantCredits: 0, reason: 'email_unverified: no free credits until verified' };
    }
    if (accountAlreadyGranted) {
        return { grantCredits: 0, reason: 'account_already_granted: one free grant per account' };
    }
    if (identityAlreadyGranted) {
        return { grantCredits: 0, reason: 'identity_already_granted: one free grant per identity' };
    }
    return { grantCredits: freeCredits, reason: `verified ${provider} connect grant` };
}

/**
 * Global free-grant circuit breaker (meditation-pal-kq4) — the emergency brake
 * the dev wants "in the pocket". Tracks free credits granted across ALL signups
 * in a rolling window; once the budget is hit, further grants are refused until
 * the window drains. Deliberately lean: in-memory sliding sum, no persistence
 * (a restart resets it, which is fine for a brake whose whole job is to blunt a
 * live flood). Multi-instance would move this to Redis — not needed at trial
 * scale.
 */
export class FreeGrantBreaker {
    private grants: Array<{ ts: number; credits: number }> = [];

    constructor(
        private budgetPerWindow: number,
        private readonly windowMs = 3_600_000, // 1 hour
        private readonly now: () => number = Date.now
    ) {}

    /** Current per-window budget (for the admin config view). */
    get budget(): number {
        return this.budgetPerWindow;
    }

    /** Retune the budget live (admin panel). 0 halts all free grants. Clamped
     *  to non-negative. */
    setBudget(credits: number): void {
        this.budgetPerWindow = Math.max(0, credits);
    }

    /** Reserve `credits` against the budget. Returns true if within budget (and
     *  records them), false if the grant would exceed it (caller grants 0). */
    tryConsume(credits: number): boolean {
        const cutoff = this.now() - this.windowMs;
        this.grants = this.grants.filter((g) => g.ts > cutoff);
        const used = this.grants.reduce((sum, g) => sum + g.credits, 0);
        if (used + credits > this.budgetPerWindow) return false;
        this.grants.push({ ts: this.now(), credits });
        return true;
    }
}

/** Simple in-memory sliding-window rate limiter, keyed by account id. */
export class RateGuard {
    private hits = new Map<string, number[]>();

    constructor(
        private readonly maxRequests = 60,
        private readonly windowMs = 60_000,
        private readonly now: () => number = Date.now
    ) {}

    /** Returns true if allowed (and records the hit), false if over the limit. */
    allow(accountId: string): boolean {
        const t = this.now();
        const cutoff = t - this.windowMs;
        const recent = (this.hits.get(accountId) ?? []).filter((ts) => ts > cutoff);
        if (recent.length >= this.maxRequests) {
            this.hits.set(accountId, recent);
            return false;
        }
        recent.push(t);
        this.hits.set(accountId, recent);
        return true;
    }
}

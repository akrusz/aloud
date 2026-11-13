/**
 * Bearer-auth middleware for Hono: verify the session token, load the account,
 * stash it on the context. 401 when absent/invalid.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import type { Deps } from '../deps.js';
import type { Config } from '../config.js';
import type { RateGuard } from '../quota/freetier.js';
import {
    REFRESH_AFTER_SECONDS,
    issueSessionToken,
    tokenStillValid,
    verifySessionToken,
    type SessionClaims,
} from './session.js';
import type { Account } from '../credits/store.js';
import { errorJson, tooManyRequests } from '../http.js';

export interface AuthVars {
    account: Account;
}

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

export function bearer(c: Context): string | undefined {
    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    if (!header) return undefined;
    const [scheme, token] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/** Best-effort client IP. The configured header when there is one
 *  (config.clientIpHeader: `fly-client-ip` on Fly, which the proxy overwrites
 *  on every request). Otherwise X-Forwarded-For's first hop, which is only as
 *  good as the proxy: one that appends to a client-sent header (Fly does)
 *  leaves the first hop to the client, and every limit keyed on it with it. */
export function forwardedIp(c: Context, config: Pick<Config, 'clientIpHeader'>): string | undefined {
    if (config.clientIpHeader) {
        const trusted = c.req.header(config.clientIpHeader)?.trim();
        if (trusted) return trusted;
    }
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    return fwd || c.req.header('x-real-ip') || undefined;
}

/** forwardedIp for rate-limit keying: falls back to a shared 'unknown' bucket
 *  rather than skipping the limit, so a deploy without the header still has
 *  SOME ceiling. */
export function clientIp(c: Context, config: Pick<Config, 'clientIpHeader'>): string {
    return forwardedIp(c, config) ?? 'unknown';
}

/** Per-IP sliding-window rate limit for pre-auth surfaces (sign-in endpoints,
 *  unauthenticated forwarders) where there's no account id to key on. Same
 *  refusal shape as the per-account guard so clients handle both identically. */
export function ipRateLimit(guard: RateGuard, config: Pick<Config, 'clientIpHeader'>): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        if (!guard.allow(clientIp(c, config))) return tooManyRequests(c);
        await next();
    };
}

export interface TokenSession {
    account: Account;
    claims: SessionClaims;
}

/**
 * The live account a session token stands for, or undefined. One place for
 * every way a well-signed token can still be nobody's: no such account, a
 * soft-deleted one (the row stays for ledger FKs but must not authenticate,
 * meditation-pal-8jc), or a token issued before the account's sessions were
 * revoked (session.ts tokenStillValid). Every surface that honours a session
 * token goes through here - requireAuth, the admin gate, and the sign-in
 * routes' "link to the caller's account" - so none can honour one the others
 * would refuse.
 */
export async function sessionForToken(deps: Deps, token: string | undefined): Promise<TokenSession | undefined> {
    const claims = token ? await verifySessionToken(token, deps.config.sessionSecret) : undefined;
    const account = claims ? await deps.store.getAccountById(claims.accountId) : undefined;
    if (!claims || !account || account.deletedAt != null || !tokenStillValid(claims, account)) return undefined;
    return { account, claims };
}

export function requireAuth(deps: Deps): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        const session = await sessionForToken(deps, bearer(c));
        if (!session) return errorJson(c, 'unauthenticated', 'sign in required');
        const { account, claims } = session;
        // Sliding session: a day-old token gets a fresh 90-day one in a response
        // header, adopted client-side (cloud-auth.ts fetchMe), so weekly users
        // never see a re-sign-in. Set BEFORE next(): the LLM proxy streams its
        // body, and headers can't change once it starts.
        if (nowSeconds() - claims.issuedAtSeconds > REFRESH_AFTER_SECONDS) {
            c.header(
                'X-Session-Refresh',
                await issueSessionToken(account.id, deps.config.sessionSecret)
            );
        }
        c.set('account', account);
        await next();
    };
}

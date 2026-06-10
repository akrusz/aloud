/**
 * Bearer-auth middleware for Hono. Pulls the session token, verifies it, loads
 * the account, and stashes it on the request context for downstream handlers.
 * Returns 401 when absent/invalid.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { Deps } from '../deps.js';
import type { RateGuard } from '../quota/freetier.js';
import { verifySessionToken } from './session.js';
import type { Account } from '../credits/store.js';

/** Context variables set by the middleware. */
export interface AuthVars {
    account: Account;
}

function bearer(c: Context): string | undefined {
    const header = c.req.header('authorization') ?? c.req.header('Authorization');
    if (!header) return undefined;
    const [scheme, token] = header.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}

/** Best-effort client IP for rate-limit keying. x-forwarded-for is set by the
 *  proxy in front of us (Fly/Render) — first hop is the caller. Falls back to a
 *  shared 'unknown' bucket rather than skipping the limit, so a deploy without
 *  the header still has SOME ceiling instead of none. */
export function clientIp(c: Context): string {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    return fwd || c.req.header('x-real-ip') || 'unknown';
}

/** Per-IP sliding-window rate limit (pre-auth surfaces: sign-in endpoints and
 *  unauthenticated forwarders, where there's no account id to key on). Same
 *  refusal shape as the per-account guard so clients handle both identically. */
export function ipRateLimit(guard: RateGuard): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        if (!guard.allow(clientIp(c))) {
            return c.json(apiError('quota_exceeded', 'too many requests; slow down'), ERROR_STATUS.quota_exceeded);
        }
        await next();
    };
}

export function requireAuth(deps: Deps): MiddlewareHandler {
    return async (c: Context, next: Next) => {
        const token = bearer(c);
        const claims = token ? await verifySessionToken(token, deps.config.sessionSecret) : undefined;
        const account = claims ? await deps.store.getAccountById(claims.accountId) : undefined;
        // A deleted (soft-deleted) account keeps its row for ledger FKs but must
        // not authenticate — treat its still-valid-signature token as signed out
        // (meditation-pal-8jc).
        if (!account || account.deletedAt != null) {
            return c.json(apiError('unauthenticated', 'sign in required'), ERROR_STATUS.unauthenticated);
        }
        c.set('account', account);
        await next();
    };
}

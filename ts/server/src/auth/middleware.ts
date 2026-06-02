/**
 * Bearer-auth middleware for Hono. Pulls the session token, verifies it, loads
 * the account, and stashes it on the request context for downstream handlers.
 * Returns 401 when absent/invalid.
 */

import type { Context, MiddlewareHandler, Next } from 'hono';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { Deps } from '../deps.js';
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

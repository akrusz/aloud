/** Response helpers shared by the route modules. */

import type { Context } from 'hono';
import { ERROR_STATUS, apiError, type ErrorCode } from './contract.js';

/** The standard error response: an `apiError` body at its code's status. */
export function errorJson(c: Context<any>, code: ErrorCode, message: string) {
    return c.json(apiError(code, message), ERROR_STATUS[code]);
}

/** The rate-guard refusal, one shape for per-account and per-IP limits. */
export function tooManyRequests(c: Context<any>) {
    return errorJson(c, 'quota_exceeded', 'too many requests; slow down');
}

/** A client-sent session id (usage/incident grouping), or null. */
export function sessionIdOf(v: unknown): string | null {
    return typeof v === 'string' && v ? v : null;
}

/**
 * POST /cloud/v1/incidents - the app reports a cloud failure it handled
 * quietly (meditation-pal-xtgh), so the operator can still see it in the
 * admin panel. Authenticated and rate-guarded like the metered routes; the
 * kind must be one of CLIENT_INCIDENT_KINDS and the detail is clipped, so a
 * client can neither spoof a server-observed kind nor stuff the table.
 *
 * Never carries meditation content: the client sends a kind, an optional
 * one-line detail (an error message), and the provider/model/session ids.
 */

import { Hono } from 'hono';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { isClientIncidentKind, recordIncident } from '../credits/incidents.js';

export interface ClientIncidentRequest {
    kind: string;
    detail?: string;
    provider?: string;
    model?: string;
    sessionId?: string;
}

const MAX_FIELD = 120;

function shortString(v: unknown): string {
    return typeof v === 'string' ? v.slice(0, MAX_FIELD) : '';
}

export function incidentRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.post('/', requireAuth(deps), async (c) => {
        const account = c.get('account');
        if (!deps.rateGuard.allow(account.id)) {
            return c.json(apiError('quota_exceeded', 'too many requests; slow down'), ERROR_STATUS.quota_exceeded);
        }
        const body = (await c.req.json().catch(() => ({}))) as Partial<ClientIncidentRequest>;
        if (!isClientIncidentKind(body.kind)) {
            return c.json(apiError('bad_request', 'unknown incident kind'), ERROR_STATUS.bad_request);
        }
        await recordIncident(deps.store, {
            accountId: account.id,
            kind: body.kind,
            source: 'client',
            provider: shortString(body.provider),
            model: shortString(body.model),
            sessionId: shortString(body.sessionId) || null,
            detail: typeof body.detail === 'string' ? body.detail : '',
        });
        return c.body(null, 204);
    });

    return app;
}

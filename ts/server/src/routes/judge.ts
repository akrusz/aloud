/**
 * POST /v1/judge, the typed-judgment path for the silence classifiers (v36y).
 * The client names a classifier and sends one utterance; the question itself
 * comes from core (JUDGE_SPECS), so this can't be driven as an open Jev proxy.
 * Returns P(yes) and leaves the threshold to the client, where the A/B reads it.
 *
 * Not charged: a call costs the server ~$0.00002, under anything the ledger can
 * express, and it stands in for a Haiku classifier call that was charged. Usage
 * is still recorded so the cost report sees the volume. Like llm.ts this sees
 * meditation content: forwarded, never stored or logged.
 */

import { Hono } from 'hono';
import { JUDGE_SPECS, isClassifierId, judgeState } from '@aloud/core/facilitation';
import { ERROR_STATUS, apiError, type JudgeRequest, type JudgeResponse } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { recordUsage } from '../credits/usage.js';
import { askNoul, JEV_USD_PER_INPUT_TOKEN } from '../providers/typesafe.js';
import { log } from '../logger.js';

/** One spoken utterance. Anything longer is not what this route is for. */
const MAX_UTTERANCE_CHARS = 2000;

export function judgeRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.post('/', requireAuth(deps), async (c) => {
        const account = c.get('account');

        const apiKey = deps.config.typesafeApiKey;
        if (!apiKey) {
            return c.json(apiError('provider_error', 'judge is not configured on this server'), ERROR_STATUS.provider_error);
        }
        if (!deps.rateGuard.allow(account.id)) {
            return c.json(apiError('quota_exceeded', 'too many requests; slow down'), ERROR_STATUS.quota_exceeded);
        }

        const body = (await c.req.json().catch(() => ({}))) as Partial<JudgeRequest>;
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!isClassifierId(body.classifier) || !text || text.length > MAX_UTTERANCE_CHARS) {
            return c.json(apiError('bad_request', 'classifier and text required'), ERROR_STATUS.bad_request);
        }

        const t0 = Date.now();
        try {
            const result = await askNoul(apiKey, judgeState(body.classifier, text), JUDGE_SPECS[body.classifier].question);
            const latencyMs = Date.now() - t0;
            log.info('judge', { classifier: body.classifier, latencyMs, model: result.model });
            await recordUsage(deps.store, {
                accountId: account.id,
                kind: 'llm',
                provider: 'typesafe',
                model: result.model,
                sessionId: typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : null,
                tokensIn: result.inputTokens,
                tokensOut: 0,
                cacheRead: 0,
                cacheCreation: 0,
                seconds: 0,
                chars: 0,
                providerCostUsd: result.inputTokens * JEV_USD_PER_INPUT_TOKEN,
                credits: 0,
            });
            return c.json({ p: result.p, model: result.model, latencyMs } satisfies JudgeResponse);
        } catch (err) {
            log.warn('judge failed', { err: String(err), classifier: body.classifier, latencyMs: Date.now() - t0 });
            return c.json(apiError('provider_error', 'upstream judge error'), ERROR_STATUS.provider_error);
        }
    });

    return app;
}

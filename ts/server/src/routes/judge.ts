/**
 * POST /v1/judge, the typed-judgment path for the silence classifiers and spoken
 * commands (v36y). The client names one (core JudgeId) and sends one utterance; the question itself
 * comes from core (JUDGE_SPECS), so this can't be driven as an open Jev proxy.
 * Returns P(yes) per ask and leaves the thresholds to the client (core
 * judgeVerdict), where the A/B reads them.
 *
 * Not charged: a silence-classifier call costs the server ~$0.00003 and a command
 * check ~$0.00018 (24 asks, ~4,200 tokens), both under anything the ledger can
 * express, and it stands in for a Haiku classifier call that was charged. Usage
 * is still recorded so the cost report sees the volume. Like llm.ts this sees
 * meditation content: forwarded, never stored or logged.
 */

import { Hono } from 'hono';
import { isJudgeId, judgeQuestions, judgeState } from '@aloud/core/facilitation';
import type { JudgeRequest, JudgeResponse } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { recordUsage } from '../credits/usage.js';
import { recordIncident } from '../credits/incidents.js';
import { askNouls, JEV_USD_PER_INPUT_TOKEN } from '../providers/typesafe.js';
import { log } from '../logger.js';
import { errorJson, sessionIdOf, tooManyRequests } from '../http.js';

/** One spoken utterance. Anything longer is not what this route is for. */
const MAX_UTTERANCE_CHARS = 2000;
const MAX_EARLIER_ITEMS = 50;

/** One judge_error row a minute, however many calls fail. */
const INCIDENT_WINDOW_MS = 60_000;

/**
 * What failed, with nothing of what was said. The thrown message can carry an
 * upstream response body, and a validation error could quote its input, so only
 * the status code or the error's name gets through.
 */
function failureLabel(err: unknown): string {
    const status = /typesafe (\d{3})/.exec(String(err))?.[1];
    if (status) return `http_${status}`;
    return err instanceof Error ? err.name : 'error';
}

export function judgeRoutes(deps: Deps, now: () => number = Date.now): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    // An outage fails every judge call from every session at once; one row per
    // window with a count says the same thing as hundreds. Per app instance, not
    // module-level, so tests don't share it.
    let windowStart = 0;
    let suppressed = 0;
    function noteFailure(accountId: string, classifier: string, sessionId: string | null, err: unknown): void {
        if (now() - windowStart < INCIDENT_WINDOW_MS) {
            suppressed++;
            return;
        }
        const earlier = suppressed;
        windowStart = now();
        suppressed = 0;
        void recordIncident(deps.store, {
            accountId,
            kind: 'judge_error',
            source: 'server',
            provider: 'typesafe',
            model: classifier,
            sessionId,
            detail: `${failureLabel(err)}${earlier ? ` (+${earlier} more since the last row)` : ''}`,
        });
    }

    app.post('/', requireAuth(deps), async (c) => {
        const account = c.get('account');

        const apiKey = deps.config.typesafeApiKey;
        if (!apiKey) return errorJson(c, 'provider_error', 'judge is not configured on this server');
        if (!deps.judgeGuard.allow(account.id)) return tooManyRequests(c);
        // The daily cap is the cost ceiling on accounts that pay nothing. One with
        // credits is never cut off (the per-minute guard still bounds it), and
        // isn't billed either: a credit funds ~1,000 calls, so there is nothing
        // per-call to charge. The balance is only read once the cap is spent.
        if (!deps.judgeDailyCap.allow(account.id) && (await deps.ledger.balance(account.id)) <= 0) {
            return errorJson(c, 'quota_exceeded', 'daily judge limit reached');
        }

        const body = (await c.req.json().catch(() => ({}))) as Partial<JudgeRequest>;
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!isJudgeId(body.classifier) || !text || text.length > MAX_UTTERANCE_CHARS) {
            return errorJson(c, 'bad_request', 'classifier and text required');
        }

        // judgeState clamps it; this only keeps non-strings and an oversized
        // array from getting that far.
        const earlier = Array.isArray(body.earlier)
            ? body.earlier.filter((e): e is string => typeof e === 'string').slice(-MAX_EARLIER_ITEMS)
            : [];

        const sessionId = sessionIdOf(body.sessionId);
        const t0 = Date.now();
        try {
            const result = await askNouls(
                apiKey,
                judgeState(body.classifier, text, { earlier }),
                judgeQuestions(body.classifier)
            );
            const latencyMs = Date.now() - t0;
            log.info('judge', { classifier: body.classifier, latencyMs, model: result.model });
            // Not awaited: it never throws, and the meditator is waiting on this
            // response, not on a telemetry write.
            void recordUsage(deps.store, {
                accountId: account.id,
                kind: 'llm',
                provider: 'typesafe',
                model: result.model,
                sessionId,
                tokensIn: result.inputTokens,
                providerCostUsd: result.inputTokens * JEV_USD_PER_INPUT_TOKEN,
                credits: 0,
            });
            return c.json({ answers: result.answers, model: result.model, latencyMs } satisfies JudgeResponse);
        } catch (err) {
            log.warn('judge failed', { err: failureLabel(err), classifier: body.classifier, latencyMs: Date.now() - t0 });
            noteFailure(account.id, body.classifier, sessionId, err);
            return errorJson(c, 'provider_error', 'upstream judge error');
        }
    });

    return app;
}
